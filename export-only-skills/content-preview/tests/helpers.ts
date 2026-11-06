// content-preview 명령 경계 테스트의 공용 helper. 임시 폴더, 명령 실행, 가짜 실행 파일을 둔다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다. 실제 브라우저와 드라이버에는 닿지 않는다.

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export type Result = { code: number | null; stdout: string; stderr: string }
type T = { after(fn: () => void): void }

export const SKILL_DIR = join(import.meta.dirname, '..')
export const SCRIPTS_DIR = join(SKILL_DIR, 'scripts')

const roots: string[] = []
process.on('exit', () => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

export function tempDir(prefix: string, t?: T): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  t?.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function run(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Result {
  const env = { ...(opts.env ?? process.env) }
  delete env.NODE_TEST_CONTEXT
  const done = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd, env, input: opts.input, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

export function write(path: string, text: string, mode = 0o644): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

// 가짜 실행 파일은 프로세스에서 한 번만 만들고 테스트마다 심볼릭 링크로 놓는다.
// macOS 는 새로 만든 실행 파일을 처음 실행할 때 0.3초 안팎을 검사하는 데 쓴다. 파일을 테스트마다 만들면 그 비용이 쌓이고, 링크는 비용이 없다.
// 동작은 파일 내용이 아니라 환경 변수로 정한다. FAKE_LOG 에 호출 기록을 남긴다.
const FAKES: Record<string, string> = {
  // 호출마다 `<이름> <인자들> BD=<BROWSER_DRIVER>` 를 남기고, FAKE_<서브명령> 에 든 셸 조각을 돈다. 조각이 끝내지 않으면 종료 코드 1 이다
  driver: `echo "$(basename "$0") $* BD=$BROWSER_DRIVER" >> "$FAKE_LOG"
var="FAKE_$(echo "$1" | tr 'a-z-' 'A-Z_')"
eval "$(printenv "$var")"
exit 1`,
  uname: `echo "$(basename "$0") $* BD=$BROWSER_DRIVER" >> "$FAKE_LOG"
echo "\${FAKE_UNAME:-Darwin}"`,
  open: `echo "$(basename "$0") $* BD=$BROWSER_DRIVER" >> "$FAKE_LOG"
exit "\${OPEN_RC:-0}"`,
  'xdg-open': `echo "$(basename "$0") $* BD=$BROWSER_DRIVER" >> "$FAKE_LOG"
exit "\${XDG_RC:-0}"`,
  // 스크립트(stdin)를 FAKE_OSA_IN 에 모으고 앱 이름에 맞는 응답을 낸다
  osascript: `echo "$(basename "$0") $* BD=$BROWSER_DRIVER" >> "$FAKE_LOG"
in=$(cat)
printf '%s\\n=====\\n' "$in" >> "$FAKE_OSA_IN"
case "$in" in
*'process "Google Chrome"'*) echo "\${CHROME:-absent}";;
*'process "Microsoft Edge"'*) echo "\${EDGE:-absent}";;
*'process "Brave Browser"'*) echo "\${BRAVE:-absent}";;
*'process "Safari"'*) echo "\${SAFARI:-absent}";;
*) echo absent;;
esac`,
  // 불린 경로와 인자를 대괄호로 묶어 stdout 에 낸다. FAKE_CAT 이 있으면 stdin 도 낸다. 종료 코드는 FAKE_RC
  check: `printf '%s:' "$0"
for a in "$@"; do printf '[%s]' "$a"; done
printf '\\n'
[ -n "$FAKE_CAT" ] && cat
exit "\${FAKE_RC:-0}"`,
}

const made: Record<string, string> = {}
function shared(kind: string): string {
  return (made[kind] ??= write(join(sharedDir(), kind), `#!/bin/sh\n${FAKES[kind]}\n`, 0o755))
}
let sharedRoot: string | undefined
function sharedDir(): string {
  return (sharedRoot ??= tempDir('content-preview-fakes-'))
}

// path 에 가짜 실행 파일(kind: driver, uname, open, xdg-open, osascript, check)의 링크를 놓는다. 이미 있으면 바꾼다
export function linkFake(path: string, kind: keyof typeof FAKES): string {
  mkdirSync(dirname(path), { recursive: true })
  rmSync(path, { force: true })
  symlinkSync(shared(kind), path)
  return path
}

export function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

// 스킬의 scripts 폴더를 <root>/skills/content-preview/scripts 로 복사한다.
// 스크립트가 자기 위치에서 위로 올라가며 tools/ 와 형제 스킬을 찾으므로 배치를 임시 폴더에 만든다
export function copyScripts(root: string): string {
  const dest = join(root, 'skills', 'content-preview', 'scripts')
  cpSync(SCRIPTS_DIR, dest, { recursive: true, filter: (src) => !src.includes('__pycache__') })
  return dest
}

// 실제 python3 실행 파일. 옛 셸 구현이 설정 파일을 읽을 때 쓴다. 없으면 null
let python: string | null | undefined
export function realPython(): string | null {
  if (python === undefined) {
    const done = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
    python = done.status === 0 ? done.stdout.trim() : null
  }
  return python
}

export function linkTools(bin: string, names: string[]): void {
  for (const name of names) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
    if (!found) continue
    const target = name === 'python3' ? (realPython() ?? found) : found
    symlinkSync(target, join(bin, name))
  }
}
