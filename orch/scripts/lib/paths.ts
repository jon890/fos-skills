// orch 작업 폴더의 경로를 한 곳에서 정한다. orch 명령은 경로 문자열을 따로 갖지 않고 이 모듈에서 받는다.
//
// 루트는 ORCH_DIR 환경 변수다. 상대경로면 주 checkout 기준이다. 없으면 <주 checkout>/.orch 다.
// 주 checkout 은 lib/git.ts 의 mainCheckout 이 정한다. 워크트리에서 불러도 같은 폴더를 가리켜, 워크트리를 지울 때
// 지시서와 큐가 함께 사라지지 않는다. git 밖이거나 bare 저장소면 주어진 폴더를 그대로 쓴다.
// ORCH_DIR 을 쓰면 orch 명령을 부르는 모든 환경(코디네이터 셸, 훅)에 같은 값을 둔다.
//
// 이름과 경로 (루트 기준):
//   overlay      overlay.md         사람이 읽는 저장소 규칙
//   config       config.json        명령이 읽는 저장소 값. 읽기는 lib/config.ts 가 맡는다
//   specs        specs/             지시서와 spec-common.md. PR 본문 pr-<이름>.md 는 그 부모(루트)에 둔다
//   queue        queue/             머지 큐와 마무리 출력, pid
//   state        state/             대기와 알림이 기억하는 것
//   heavy-slot   state/heavy-slot/  무거운 검사 대기열의 상태
//   hooks        hooks/             저장소의 이벤트 핸들러
//   hooks-state  state/hooks/       이벤트 핸들러의 잠금
//   bin          bin/               저장소 포장 스크립트
//
// 보드는 work-board 소유라 여기 없다. boardPath 는 work-board 의 규칙을 옮겨 쓴다.
//
// 옛 구조: .claude/orch-overlay.md, .claude/orch-finish.json, .omc/orch/, .omc/handoffs/specs/ 가 남아 있으면
// (폴더는 안에 파일이 있을 때만 센다) requireMigrated 가 옮기는 명령(migrate-orch-dir.py)을 알린다.
// 옛 위치를 읽는 분기는 두지 않는다. 옮길 쌍의 기본 표 DEFAULT_MOVES 도 여기 둔다.
//
// git 무시: 루트가 저장소 안에 있고 git 이 아직 무시하지 않으면 `git rev-parse --git-path info/exclude` 파일에
// /<루트>/ 한 줄을 더한다. 저장소의 .gitignore 는 바꾸지 않는다. 그 파일은 워크트리끼리 함께 쓴다.

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inside, real } from './fs.ts'
import { git, mainCheckout } from './git.ts'

const DEFAULT_ROOT = '.orch'

export const NAMES: Readonly<Record<string, string>> = Object.freeze({
  overlay: 'overlay.md',
  config: 'config.json',
  specs: 'specs',
  queue: 'queue',
  state: 'state',
  'heavy-slot': 'state/heavy-slot',
  hooks: 'hooks',
  'hooks-state': 'state/hooks',
  bin: 'bin',
})

// 폴더가 아니라 파일인 이름. ensure 가 그 부모 폴더만 만든다.
export const FILES: ReadonlySet<string> = new Set(['overlay', 'config'])

// (옛 경로, 새 경로). 옛 경로는 주 checkout 기준, 새 경로는 루트 기준이다. 앞의 쌍이 먼저 옮긴다.
export const DEFAULT_MOVES: ReadonlyArray<readonly [string, string]> = [
  ['.claude/orch-overlay.md', 'overlay.md'],
  ['.claude/orch-finish.json', 'config.json'],
  ['.omc/orch/scripts', 'bin'],
  ['.omc/orch', ''],
  ['.omc/handoffs/specs', 'specs'],
  ['.omc/handoffs/queue', 'queue'],
  ['.omc/state/wait-important-lost.json', 'state/wait-important-lost.json'],
  ['.omc/state/notify-conflicts.json', 'state/notify-conflicts.json'],
]

// 남아 있으면 옮기기 전이라고 보는 옛 위치. 설정과 지시서가 여기 있으면 명령이 그 값 없이 돌게 된다.
export const LEGACY_MARKERS: readonly string[] = ['.claude/orch-overlay.md', '.claude/orch-finish.json', '.omc/orch', '.omc/handoffs/specs']

const MIGRATE = fileURLToPath(new URL('../migrate-orch-dir.py', import.meta.url))
const DEFAULT_BYPASS = '설정 파일을 --config 로 직접 준다'

function expandUser(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

export function orchDir(repo: string): string {
  const root = mainCheckout(repo)
  const env = process.env.ORCH_DIR
  if (!env) return join(root, DEFAULT_ROOT)
  const dir = expandUser(env)
  return isAbsolute(dir) ? dir : join(root, dir)
}

export function pathOf(name: string, repo: string): string {
  if (!Object.hasOwn(NAMES, name)) throw new Error(`모르는 이름: ${name}. ${Object.keys(NAMES).join(', ')} 중 하나다`)
  return join(orchDir(repo), NAMES[name])
}

// 보드 파일. explicit(명령줄이나 설정의 board)이 있으면 그것을 주 checkout 기준으로, 없으면 work-board 의 기본 위치다.
// 기본 위치는 work-board/bin/board.py 의 board_path 규칙을 옮겼다. 그 규칙이 바뀌면 여기도 같이 고친다.
// 주 checkout 이 아니라 repo 의 작업 트리 최상위(--show-toplevel) 기준이다. 원본 규칙이 그렇다.
export function boardPath(repo: string, explicit?: string | null): string {
  if (explicit) {
    const board = expandUser(explicit)
    return isAbsolute(board) ? board : join(mainCheckout(repo), board)
  }
  const cwd = real(repo)
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : cwd
  const legacy = join(root, '.omc/handoffs/board.json')
  return existsSync(legacy) ? legacy : join(root, '.omc/board.json')
}

// 루트를 git 이 무시하게 한다. 더한 줄이 있으면 그 줄, 없으면 null.
export function ensureIgnored(repo: string): string | null {
  const root = orchDir(repo)
  const top = mainCheckout(repo)
  const rel = relative(top, root)
  // 루트가 저장소 밖이면 무시할 것이 없다. 루트가 주 checkout 자신이면 저장소 전체를 무시하게 되므로 더하지 않는다.
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  const relPosix = rel.split(sep).join('/')
  if (git(top, ['rev-parse', '--git-dir']).code !== 0) return null
  if (git(top, ['check-ignore', '-q', '--no-index', `${relPosix}/`]).code === 0) return null
  const found = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
  const exclude = found.stdout.trim()
  if (found.code !== 0 || !exclude) return null
  const line = `/${relPosix}/`
  mkdirSync(dirname(exclude), { recursive: true })
  const text = existsSync(exclude) && statSync(exclude).isFile() ? readFileSync(exclude, 'utf8') : ''
  if (text.split(/\r\n|\r|\n/).includes(line)) return null
  appendFileSync(exclude, `${!text || text.endsWith('\n') ? '' : '\n'}${line}\n`, 'utf8')
  return line
}

// 이름의 폴더(파일이면 부모 폴더)를 만들고 git 이 루트를 무시하게 한다. 경로를 돌려준다.
export function ensure(name: string, repo: string): string {
  const target = pathOf(name, repo)
  mkdirSync(FILES.has(name) ? dirname(target) : target, { recursive: true })
  ensureIgnored(repo)
  return target
}

// target 의 부모 폴더를 만든다. target 이 루트 안이면 git 이 루트를 무시하게 한다.
export function makeParent(target: string, repo: string): void {
  const parent = dirname(resolve(target))
  mkdirSync(parent, { recursive: true })
  // macOS 의 임시 폴더는 /var 와 /private/var 로 갈리므로 실경로로도 비교한다.
  const full = join(real(parent), basename(target))
  const root = orchDir(repo)
  if (inside(full, root) || inside(full, real(root))) ensureIgnored(repo)
}

// 파일이거나, 안에 파일이 하나라도 있는 폴더인지. 빈 폴더만 남은 옛 위치는 옮길 것이 없다.
// 심볼릭 링크는 따라가지 않고 파일로 센다. migrate-orch-dir.ts 도 옮길지 판정할 때 쓴다.
export function hasFiles(target: string): boolean {
  let stat
  try {
    stat = lstatSync(target)
  } catch {
    return false
  }
  if (stat.isSymbolicLink() || stat.isFile()) return true
  if (!stat.isDirectory()) return false
  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some((entry) => entry.isFile() || entry.isSymbolicLink() || (entry.isDirectory() && hasFiles(join(target, entry.name))))
}

// 남아 있는 옛 위치 목록(주 checkout 기준 상대경로).
export function legacyPaths(repo: string): string[] {
  const root = mainCheckout(repo)
  return LEGACY_MARKERS.filter((rel) => hasFiles(join(root, rel)))
}

// 옛 구조가 남아 있으면 옮기는 명령을 stderr 로 알리고 false 를 돌려준다. 부르는 쪽은 종료 코드 2 로 끝난다.
// bypass 는 옮기기 전에 그 명령을 돌리는 방법이다. null 이나 빈 문자열이면 그 줄을 쓰지 않는다.
export function requireMigrated(repo: string, script: string, bypass: string | null = DEFAULT_BYPASS): boolean {
  const left = legacyPaths(repo)
  if (left.length === 0) return true
  const lines = [
    `${script}: orch 작업 폴더를 옮기기 전이다. 옛 위치가 남아 있다: ${left.join(', ')}`,
    `  새 위치(${orchDir(repo)})의 설정과 지시서만 읽으므로 이대로 돌면 저장소 값이 빠진다.`,
    `  머지 큐와 worker 가 돌지 않을 때 옮긴다: python3 ${MIGRATE} --repo ${mainCheckout(repo)} --apply`,
    '  이미 옮겼는데 다시 나오면 옮긴 포장 스크립트(bin)나 다른 도구가 옛 폴더를 다시 만든 것이다. ' +
      '그 스크립트의 옛 경로를 고친 뒤 다시 옮긴다.',
  ]
  if (bypass) lines.push(`  옮기기 전에 꼭 돌려야 하면 ${bypass}.`)
  process.stderr.write(`${lines.join('\n')}\n`)
  return false
}

// 옛 구조가 남아 있으면 알리기만 한다. 대기처럼 멈추면 옮길 수도 없게 되는 명령이 쓴다.
export function warnLegacy(repo: string, script: string): void {
  const left = legacyPaths(repo)
  if (left.length === 0) return
  process.stderr.write(
    `${script}: 옛 위치가 남아 있다(${left.join(', ')}). 대기가 끝나면 python3 ${MIGRATE} --repo ${mainCheckout(repo)} 로 옮긴다\n`,
  )
}
