#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// orch 스크립트를 경로 없이 부르는 진입점이다. 부를 때마다 설치 기록에서 지금 설치된 번들을 읽어 그 번들의 스크립트를 실행한다.
//
// 플러그인 경로는 프로필과 버전마다 바뀐다(`<설정 폴더>/plugins/cache/<마켓플레이스>/<플러그인>/<해시>/`).
// 저장소 스크립트나 기억해 둔 명령이 그 경로를 박으면 갱신 뒤 옛 스크립트를 부른다. 이 진입점은 자기 위치가 아니라 설치 기록을 따라가므로,
// 옛 번들이나 저장소 체크아웃에 있는 사본으로 불러도 지금 설치된 번들의 스크립트가 돈다. 의존이 Node 내장 모듈뿐이라 파일 하나만 복사해 써도 된다.
//
// 사용법:
//     orch.ts NAME [인자...]       orch/scripts/NAME.ts 를 node 로 실행한다. NAME 은 `wait-important` 나 `wait-important.ts` 꼴이다
//     orch.ts --path [NAME]        스크립트 폴더를, NAME 을 주면 그 스크립트 파일 경로를 한 줄로 낸다. 실행하지 않는다
//     orch.ts --help
//
// 번들을 고르는 차례:
//     1. ORCH_SCRIPTS_DIR 환경 변수. 고치는 중인 체크아웃의 `orch/scripts` 를 테스트할 때 준다
//     2. `$CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)의 `plugins/installed_plugins.json` 에서 `fos-skills@fos-skills` 의 항목.
//        scope 가 user 인 항목을 먼저 보고, 그중 `<installPath>/orch/scripts` 가 실제로 있는 첫 항목을 쓴다
//     3. 설치 기록에 쓸 항목이 없으면 이 진입점이 든 번들의 `../scripts`. 어느 번들을 썼는지 stderr 에 알린다
//
// 자식 프로세스는 이 진입점의 작업 폴더를 그대로 물려받고, 표준 입출력과 종료 신호를 그대로 잇는다.
// 신호(SIGINT, SIGTERM, SIGHUP)를 받으면 자식에게 전하고 자식이 끝나기를 기다린다.
//
// 종료 코드:
//     자식의 종료 코드(신호로 끝나면 128 + 신호 번호)
//     2  사용법 오류이거나 그 이름의 스크립트가 없다
//     3  스크립트 폴더를 찾지 못했다

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = 'fos-skills@fos-skills'
const USAGE = ['사용법: orch.ts NAME [인자...]', '        orch.ts --path [NAME]'].join('\n')
// 스크립트 이름으로 받는 글자. 경로 구분자와 `..` 을 막아 scripts 폴더 밖을 부르지 못하게 한다
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// 설치 기록의 installPath 후보. user scope 가 먼저이고 같은 scope 안에서는 기록 순서를 지킨다
function installPaths(configDir: string): string[] {
  let entries: unknown
  try {
    entries = (JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> }).plugins?.[PLUGIN]
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  const rows = entries.filter((e): e is { scope?: unknown; installPath: string } => typeof e?.installPath === 'string' && e.installPath !== '')
  return [...rows.filter((e) => e.scope === 'user'), ...rows.filter((e) => e.scope !== 'user')].map((e) => e.installPath)
}

// 스크립트 폴더를 정한다. 못 찾으면 null 이고 이유를 stderr 에 냈다
function scriptsDir(): string | null {
  const forced = process.env.ORCH_SCRIPTS_DIR
  if (forced) {
    if (isDir(forced)) return forced
    process.stderr.write(`orch: ORCH_SCRIPTS_DIR 가 폴더가 아니다: ${forced}\n`)
    return null
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  for (const path of installPaths(configDir)) {
    const dir = join(path, 'orch', 'scripts')
    if (isDir(dir)) return dir
  }
  const own = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
  if (isDir(own)) {
    process.stderr.write(`orch: ${join(configDir, 'plugins', 'installed_plugins.json')} 에서 ${PLUGIN} 의 설치본을 찾지 못해 이 진입점이 든 번들을 쓴다: ${own}\n`)
    return own
  }
  process.stderr.write(`orch: ${PLUGIN} 의 orch/scripts 를 찾지 못했다. ${join(configDir, 'plugins', 'installed_plugins.json')} 를 확인하거나 claude plugin install ${PLUGIN} 을 한다\n`)
  return null
}

// NAME 또는 NAME.ts 로 scripts 폴더의 .ts 파일을 찾는다. 없으면 null 이고 이유를 stderr 에 냈다
function scriptFile(dir: string, given: string): string | null {
  const name = given.endsWith('.ts') ? given.slice(0, -'.ts'.length) : given
  if (!NAME.test(name)) {
    process.stderr.write(`${USAGE}\norch: 스크립트 이름이 아니다: ${given}\n`)
    return null
  }
  const file = join(dir, `${name}.ts`)
  if (existsSync(file)) return file
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -'.ts'.length))
    .sort()
  process.stderr.write(`orch: ${file} 가 없다. 쓸 수 있는 이름: ${names.join(' ')}\n`)
  return null
}

function main(argv: string[]): Promise<number> | number {
  const [first, ...rest] = argv
  if (first === undefined || first === '--help' || first === '-h') {
    ;(first === undefined ? process.stderr : process.stdout).write(`${USAGE}\n`)
    return first === undefined ? 2 : 0
  }
  const printing = first === '--path'
  if (!printing && first.startsWith('-')) {
    process.stderr.write(`${USAGE}\norch: 모르는 옵션: ${first}\n`)
    return 2
  }
  if (printing && rest.length > 1) {
    process.stderr.write(`${USAGE}\norch: --path 는 이름을 하나만 받는다\n`)
    return 2
  }
  const dir = scriptsDir()
  if (dir === null) return 3
  if (printing && rest.length === 0) {
    process.stdout.write(`${dir}\n`)
    return 0
  }
  const file = scriptFile(dir, printing ? rest[0] : first)
  if (file === null) return 2
  if (printing) {
    process.stdout.write(`${file}\n`)
    return 0
  }
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...rest], { stdio: 'inherit' })
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, forward(signal))
  return new Promise((resolve) => {
    child.on('error', (e) => {
      process.stderr.write(`orch: ${file} 를 실행하지 못했다: ${e.message}\n`)
      resolve(1)
    })
    child.on('close', (code, signal) => resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)))
  })
}

Promise.resolve(main(process.argv.slice(2))).then((code) => {
  process.exitCode = code
})
