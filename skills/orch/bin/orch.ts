#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// orch 명령의 진입점이다. 부를 때마다 설치 기록에서 지금 설치된 번들을 골라, 이 진입점이 그 번들의 것이 아니면 그 번들의 진입점에 넘긴다.
// 명령 해석(새 꼴과 옛 이름), 옛 꼴 안내, 자식 실행을 맡는다. 이름과 경로의 원본은 ../scripts/lib/commands.ts 의 명령 표다.
// PATH 에서는 플러그인 루트의 실행기 `bin/orch`(또는 그 사본 `~/.local/bin/orch`)가 이 파일을 부른다.
//
// 사용법:
//     orch <묶음> <동작> [인자...]   새 꼴. 명령 표가 스크립트와 앞 인자를 정한다. `orch --help` 가 목록을 낸다
//     orch.ts NAME [인자...]         옛 꼴. 명령 표가 NAME 을 푼 scripts/<묶음>/NAME.ts 를 같은 인자로 실행하고 stderr 에 새 꼴을 한 줄 안내한다
//     orch.ts --path [NAME]          옛 꼴. 스크립트 폴더를, NAME 을 주면 그 스크립트 파일 경로를 한 줄로 낸다. 실행하지 않는다
//     orch.ts --help
//
// 번들을 고르는 차례:
//     1. ORCH_SCRIPTS_DIR 환경 변수. 고치는 중인 체크아웃의 `skills/orch/scripts` 를 줄 때 쓴다.
//        그 폴더의 `../bin/orch.ts` 가 이 파일이 아니면 그 진입점에 넘긴다. 명령 표가 그 체크아웃의 것이어야 하기 때문이다
//     2. 설치 기록. 규칙은 ../scripts/lib/install-record.ts 의 selectBundle 이다(user 범위 항목이 있으면 그것만 본다)
//     3. 고른 번들이 이 진입점의 번들과 다르면(실경로 비교) 그 번들의 진입점에 ORCH_ENTRY_HOP=1 로 넘긴다. 넘겨받은 진입점은 다시 넘기지 않는다.
//        그 번들에 진입점이나 명령 표가 없으면(이 기능 이전 번들) 넘기지 않고 3 이다
//        이 진입점이 저장소 checkout(번들 루트에 .git)에 있는데 설치본으로 넘기면 stderr 에 한 줄 알린다. 동작은 그대로다
// 이 파일은 내장 모듈만 정적으로 import 한다. lib 는 번들을 정한 뒤 동적으로 읽어, 옛 번들의 진입점이 넘길 때 그 번들의 lib 가 돌지 않게 한다.
// 그래서 이 파일 하나만 복사해 쓸 수 없다. 저장소에 복사해 둘 것은 플러그인 루트의 실행기 `bin/orch` 다.
//
// 자식 프로세스는 이 진입점의 작업 폴더를 그대로 물려받고, 표준 입출력과 종료 신호를 그대로 잇는다.
// 신호(SIGINT, SIGTERM, SIGHUP)를 받으면 자식에게 전하고 자식이 끝나기를 기다린다. 스크립트 자식의 환경에서는 ORCH_ENTRY_HOP 을 지운다.
// 새 꼴은 ../scripts/lib/context.ts 가 빠진 문맥 인자(--repo, --run, --specs-dir, --loop-repo)를 채우고, 채운 출처를 stderr 한 줄과
// 자식 환경 ORCH_CONTEXT(`run=run-current loop-repo=registered` 꼴)로 알린다. 스크립트는 lib/bundle.ts 의 orchContext() 로 읽는다.
// 짧은 출력: 새 꼴과 옛 꼴 모두 자식 환경에 ORCH_OUTPUT=short 를 넣어 판정 줄만 내게 한다(../scripts/lib/output.ts).
// 첫 `--` 앞의 `--full` 은 떼고 ORCH_OUTPUT=full 을 넣어 지금 출력을 낸다(대기는 이 값으로 NEXT_WAIT 에 --full 을 잇는다).
// 진입점은 스크립트의 옵션 표를 몰라 옵션 값으로 준 `--full`(`--body --full`)도 뗀다. 그런 값은 `--body=--full` 꼴로 준다. 감싼 명령(명령 표의 passthrough: slot heavy, slot mem)은 신호를 넣지 않고
// `--full` 도 떼지 않는다. 부모 환경의 ORCH_OUTPUT 은 먼저 지운다.
//
// 종료 코드:
//     자식의 종료 코드(신호로 끝나면 128 + 신호 번호)
//     2  사용법 오류이거나 그 이름의 스크립트가 없다
//     3  스크립트 폴더나 넘길 진입점을 찾지 못했다

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const SKILL = resolve(dirname(SELF), '..')
const OWN_SCRIPTS = join(SKILL, 'scripts')
// skills/orch 의 두 단계 위가 번들(플러그인 루트, 체크아웃 루트)이다
const OWN_BUNDLE = resolve(SKILL, '..', '..')
const USAGE = ['사용법: orch <묶음> <동작> [인자...]', '        orch.ts NAME [인자...]', '        orch.ts --path [NAME]', '        orch --help'].join('\n')
// 스크립트 이름으로 받는 글자. 경로 구분자와 `..` 을 막아 scripts 폴더 밖을 부르지 못하게 한다
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/

type InstallRecord = typeof import('../scripts/lib/install-record.ts')
type Commands = typeof import('../scripts/lib/commands.ts')
type Context = typeof import('../scripts/lib/context.ts')

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

// 작업 폴더. 머지 뒤 정리로 셸의 폴더가 지워졌으면 process.cwd() 가 던진다.
// 그때는 셸이 남긴 PWD 에서 남아 있는 가장 가까운 윗 폴더를 쓴다(wait-important 의 startDir 와 같은 규칙)
function workDir(): string {
  try {
    return process.cwd()
  } catch {
    // PWD 가 없으면 루트다. 홈 폴더가 git 저장소인 머신에서 홈을 문맥 저장소로 읽지 않게 한다
    let dir = process.env.PWD ? resolve(process.env.PWD) : '/'
    while (!isDir(dir) && dirname(dir) !== dir) dir = dirname(dir)
    return dir
  }
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...args], { stdio: 'inherit', env })
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, forward(signal))
  return new Promise((done) => {
    child.on('error', (e) => {
      err(`orch: ${file} 를 실행하지 못했다: ${e.message}`)
      done(1)
    })
    child.on('close', (code, signal) => done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)))
  })
}

// 다른 진입점에 인자를 그대로 넘긴다. 그 진입점은 다시 넘기지 않는다
function hop(entry: string, argv: string[]): Promise<number> {
  return run(entry, argv, { ...process.env, ORCH_ENTRY_HOP: '1' })
}

// 설치본의 버전. 플러그인 매니페스트에서 읽고, 읽지 못하면 번들 폴더 이름을 쓴다
function bundleVersion(bundle: string): string {
  try {
    const version = (JSON.parse(readFileSync(join(bundle, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version
    if (typeof version === 'string' && version) return version
  } catch {
    // 매니페스트가 없으면 폴더 이름으로 갈음한다
  }
  return basename(bundle)
}

// 저장소 checkout 의 진입점이 ORCH_SCRIPTS_DIR 없이 설치본으로 넘어갈 때 stderr 에 내는 한 줄
function checkoutNotice(bundle: string): string {
  return `orch: 이 checkout 의 scripts 가 아니라 설치본 ${bundleVersion(bundle)} 을 쓴다. 이 checkout 을 쓰려면 ORCH_SCRIPTS_DIR=${OWN_SCRIPTS}`
}

// 스크립트 폴더를 정하거나, 다른 진입점에 넘긴 종료 코드를 돌려준다
async function locate(argv: string[]): Promise<{ dir: string } | { code: number }> {
  const hopped = process.env.ORCH_ENTRY_HOP === '1'
  const forced = process.env.ORCH_SCRIPTS_DIR
  if (forced) {
    if (!isDir(forced)) {
      err(`orch: ORCH_SCRIPTS_DIR 가 폴더가 아니다: ${forced}`)
      return { code: 3 }
    }
    const entry = join(forced, '..', 'bin', 'orch.ts')
    if (!hopped && existsSync(entry) && real(entry) !== real(SELF)) {
      if (!existsSync(join(forced, 'lib', 'commands.ts'))) {
        err(`orch: ORCH_SCRIPTS_DIR 의 체크아웃에 명령 표가 없다(이 기능 이전 체크아웃이다): ${forced}`)
        return { code: 3 }
      }
      return { code: await hop(entry, argv) }
    }
    return { dir: forced }
  }
  let record: InstallRecord
  try {
    record = (await import(pathToFileURL(join(OWN_SCRIPTS, 'lib', 'install-record.ts')).href)) as InstallRecord
  } catch {
    err(`orch: ${SELF} 옆에 scripts/lib/install-record.ts 가 없다. 진입점만 복사해 쓰지 않는다. 플러그인 루트의 실행기 bin/orch 를 복사하거나 orch 를 PATH 에서 부른다`)
    return { code: 3 }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const chosen = record.selectBundle(configDir, OWN_BUNDLE)
  if ('error' in chosen) {
    err(`orch: ${chosen.error}`)
    return { code: 3 }
  }
  if (chosen.source === 'own') err(`orch: ${record.recordFile(configDir)} 에서 ${record.PLUGIN} 의 설치본을 찾지 못해 이 진입점이 든 번들을 쓴다: ${OWN_SCRIPTS}`)
  if (!hopped && real(chosen.bundle) !== real(OWN_BUNDLE)) {
    const entry = record.entryOf(chosen.bundle)
    if (!existsSync(entry) || !existsSync(join(record.scriptsDirOf(chosen.bundle), 'lib', 'commands.ts'))) {
      err(`orch: 설치본 ${chosen.bundle} 에 새 진입점이 없다(이 기능 이전 번들이다). claude plugin update ${record.PLUGIN} 으로 갱신한다`)
      return { code: 3 }
    }
    // 저장소 checkout 의 진입점이 설치본으로 넘어가면 이 checkout 에서 고친 동작이 아니라 설치본의 옛 동작이 돈다. 조용히 넘기지 않고 알린다
    if (existsSync(join(OWN_BUNDLE, '.git'))) err(checkoutNotice(chosen.bundle))
    return { code: await hop(entry, argv) }
  }
  // 넘겨받은 진입점은 자기 명령 표와 같은 번들의 스크립트를 쓴다. 두 판의 고르기 규칙이 달라도 표와 스크립트가 섞이지 않는다
  return { dir: hopped ? OWN_SCRIPTS : record.scriptsDirOf(chosen.bundle) }
}

// 첫 `--` 앞의 `--full` 을 모두 뗀다. 있었는지를 함께 낸다
function stripFull(args: string[]): { args: string[]; full: boolean } {
  const cut = args.indexOf('--')
  const head = cut < 0 ? args : args.slice(0, cut)
  const tail = cut < 0 ? [] : args.slice(cut)
  const kept = head.filter((a) => a !== '--full')
  return { args: [...kept, ...tail], full: kept.length !== head.length }
}

// 옛 꼴로 부를 수 있는 이름. 명령 표의 옛 이름과 스크립트 파일 이름 가운데 그 폴더에 파일이 있는 것과 폴더 바로 아래의 .ts 다
function names(commands: Commands, dir: string): string {
  const flat = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -'.ts'.length))
  const table = [...commands.legacyNames(), ...commands.COMMANDS.map((c) => c.script.slice(c.script.lastIndexOf('/') + 1, -'.ts'.length))]
  const listed = table.filter((n) => commands.scriptIn(dir, n) !== null)
  return [...new Set([...listed, ...flat])].sort().join(' ')
}

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  if (first === undefined) {
    err(USAGE)
    return 2
  }
  const located = await locate(argv)
  if ('code' in located) return located.code
  const dir = located.dir
  const commands = (await import(pathToFileURL(join(OWN_SCRIPTS, 'lib', 'commands.ts')).href)) as Commands
  const childEnv = { ...process.env }
  delete childEnv.ORCH_ENTRY_HOP
  // 문맥 신호는 새 꼴에서만 넘긴다. 옛 꼴과 그 밖의 자식에는 물려주지 않는다
  delete childEnv.ORCH_CONTEXT
  // 짧은 출력 신호는 아래에서 이 호출의 `--full` 로 정한다. 부모 환경의 값을 물려주지 않는다
  delete childEnv.ORCH_OUTPUT

  if (first === '--help' || first === '-h') {
    process.stdout.write(commands.helpText())
    return 0
  }
  if (commands.isGroup(first)) {
    if (rest[0] === '--help' || rest[0] === '-h') {
      process.stdout.write(commands.helpText(first))
      return 0
    }
    const retired = commands.COMMANDS.find(c => c.retired && c.group === first && (c.verb === null || c.verb === rest[0]))
    if (retired) {
      const { retiredMessage } = await import('../scripts/lib/retired.ts')
      err(retiredMessage(commands.form(retired), retired.retired!.doc))
      return 2
    }
    const stripped = stripFull(rest)
    let resolved = commands.resolveNew([first, ...stripped.args])
    // 감싼 명령은 `--full` 을 떼지 않는다. 감싼 명령의 인자일 수 있다
    if (!('error' in resolved) && resolved.command.passthrough) resolved = commands.resolveNew(argv)
    if ('error' in resolved) {
      err(`orch: ${resolved.error}`)
      err(commands.helpText(first).trimEnd())
      return 2
    }
    if (resolved.command.retired) {
      const { retiredMessage } = await import('../scripts/lib/retired.ts')
      err(retiredMessage(commands.form(resolved.command), resolved.command.retired.doc))
      return 2
    }
    const file = commands.scriptIn(dir, resolved.command.script)
    if (file === null) {
      err(`orch: ${join(dir, resolved.command.script)} 가 없다`)
      return 2
    }
    const lead = commands.beforeDashes(resolved.user)[0]
    if (lead === '--help' || lead === '-h') {
      err(`${resolved.command.usage}\n옵션은 아래 스크립트 사용법을 따른다. 동작으로 바뀐 옛 모드 플래그(${resolved.command.forbid.join(', ') || '없음'})는 쓰지 않는다.`)
      return run(file, resolved.args, childEnv)
    }
    const context = (await import(pathToFileURL(join(OWN_SCRIPTS, 'lib', 'context.ts')).href)) as Context
    const filled = context.fillContext(resolved.command, resolved.args, workDir())
    if ('error' in filled) {
      err(`orch: ${filled.error}`)
      return 2
    }
    if (filled.note) err(filled.note)
    const env = context.contextEnv(filled.sources)
    if (env) childEnv.ORCH_CONTEXT = env
    if (!resolved.command.passthrough) childEnv.ORCH_OUTPUT = stripped.full ? 'full' : 'short'
    return run(file, filled.args, childEnv)
  }

  const printing = first === '--path'
  if (!printing && first.startsWith('-')) {
    err(`${USAGE}\norch: 모르는 옵션: ${first}`)
    return 2
  }
  if (printing && rest.length > 1) {
    err(`${USAGE}\norch: --path 는 이름을 하나만 받는다`)
    return 2
  }
  if (printing && rest.length === 0) {
    process.stdout.write(`${dir}\n`)
    return 0
  }
  const given = printing ? rest[0] : first
  const bare = given.endsWith('.ts') ? given.slice(0, -'.ts'.length) : given
  if (!NAME.test(bare)) {
    err(`${USAGE}\norch: 스크립트 이름이 아니다: ${given}`)
    return 2
  }
  const file = commands.scriptIn(dir, bare)
  if (file === null) {
    err(`orch: ${join(dir, `${bare}.ts`)} 가 없다. 쓸 수 있는 이름: ${names(commands, dir)}`)
    return 2
  }
  const legacy = commands.resolveLegacy(bare, printing ? [] : rest)
  if (!printing && legacy?.command.retired) {
    const { retiredMessage } = await import('../scripts/lib/retired.ts')
    err(retiredMessage(legacy.hint, legacy.command.retired.doc))
    return 2
  }
  if (legacy) err(`orch: 새 꼴: ${legacy.hint}`)
  if (printing) {
    process.stdout.write(`${file}\n`)
    return 0
  }
  // 옛 꼴도 새 꼴과 같은 짧은 출력이다(스펙 DECISION11). 감싼 명령의 옛 이름(heavy-slot, mem-gate)은 그대로 넘긴다
  const wrapped = commands.COMMANDS.some((c) => c.passthrough && c.legacy?.name === bare)
  if (wrapped) return run(file, rest, childEnv)
  const stripped = stripFull(rest)
  childEnv.ORCH_OUTPUT = stripped.full ? 'full' : 'short'
  return run(file, stripped.args, childEnv)
}

Promise.resolve(main(process.argv.slice(2))).then((code) => {
  process.exitCode = code
})
