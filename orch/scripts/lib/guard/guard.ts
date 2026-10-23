// 핸들러가 부르는 orca 와 gh 의 가드다. 이벤트 실행기(lib/events.ts)가 이 폴더를 핸들러 PATH 맨 앞에 두고,
// 같은 폴더의 확장자 없는 shim(orca, gh)이 main 을 부른다.
//
// 가드는 핸들러 작성자가 코어 전용 호출(머지, base 합치기, worker 터미널 입력)을 모르고 쓰는 실수를 막는 장치다.
// 보안 경계가 아니다. 진짜 실행 파일의 경로(ORCH_REAL_ORCA, ORCH_REAL_GH)가 핸들러 환경에 보이므로 일부러 부르면 우회된다.
//
// 거부:
//   orca  위치 인자 가운데 terminal 뒤 어디든 send 가 온다. 대상과 무관하다. worker 에게 보내는 일은 코어 명령(send-to-worker)이 한다.
//         대상이 worker 인지 보려면 shim 안에서 orca 를 다시 조회해야 하고, 그 조회가 실패하면 결국 거부해야 해서 모두 거부한다
//   gh    pr merge, pr update-branch
//   gh    api 의 경로가 repos/<o>/<r>/pulls/<번호>/update-branch 다. 메서드와 무관하다
//   gh    api 의 경로가 repos/<o>/<r>/pulls/<번호>/merge 이고 메서드가 GET 이 아니다(PUT 이 PR 머지다)
//         메서드는 -X/--method 값이고, 없으면 -f/-F/--field/--raw-field/--input 이 있을 때 POST, 아니면 GET 이다(gh api 의 규칙)
//   gh    api 의 경로가 /merges 로 끝난다(브랜치 merge API)
//   gh    api graphql 의 인자에 mergePullRequest, updatePullRequestBranch, enablePullRequestAutoMerge 가 든다.
//         --input 을 주거나 -f/-F/--field/--raw-field 의 값이 @ 로 시작하면(파일에서 읽는다) 내용을 확인할 수 없어 거부한다
//   api 경로는 앞의 / 와 ? 뒤를 떼고 비교한다. {owner} 같은 gh 자리 표시자도 한 경로 조각으로 본다.
//
// 하위 명령은 플래그를 건너뛴 위치 인자로 정한다. `gh pr -R o/r merge 1` 과 `gh -R o/r pr merge 1` 이 모두 pr merge 다.
// - 로 시작하는 낱말은 플래그다. --name=value 는 한 낱말이다. 값을 받는 플래그는 다음 낱말도 건너뛴다.
// 값을 받는 짧은 플래그에 글자가 붙은 꼴(-XPUT)은 붙은 글자가 값이다.
//
// 종료 코드: 거부하면 stderr 에 이유와 「코어 명령을 쓴다」 를 내고 126 이다.
// ORCH_REAL_<도구> 가 없거나, 절대경로가 아니거나, 실경로가 가드 폴더 안이면 이유와 함께 126 이다.
// 가드 폴더 안을 막는 것은 shim 이 자기 자신을 다시 불러 node 프로세스가 끝없이 생기지 않게 하기 위해서다.
// 통과면 진짜 실행 파일을 같은 인자와 stdin 으로 실행하고 그 종료 코드를 낸다. 시그널로 죽으면 128 + 신호 번호다.

import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inside, real } from '../fs.ts'
import { signalCode } from '../proc.ts'

export type Tool = 'orca' | 'gh'

const GUARD_DIR = dirname(fileURLToPath(import.meta.url))
const DENIED = 126

const GH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-R',
  '--repo',
  '--hostname',
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--input',
  '-p',
  '--preview',
  '--cache',
])
const GH_FIELD_FLAGS: ReadonlySet<string> = new Set(['-f', '-F', '--field', '--raw-field', '--input'])
const GH_KEY_VALUE_FLAGS: ReadonlySet<string> = new Set(['-f', '-F', '--field', '--raw-field'])
const GRAPHQL_DENIED: readonly string[] = ['mergePullRequest', 'updatePullRequestBranch', 'enablePullRequestAutoMerge']

type Flag = { name: string; value: string | null }
type Parsed = { positionals: string[]; flags: Flag[] }

function parse(argv: string[], valueFlags: ReadonlySet<string>): Parsed {
  const positionals: string[] = []
  const flags: Flag[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (word === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!word.startsWith('-') || word === '-') {
      positionals.push(word)
      continue
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      if (eq >= 0) flags.push({ name: word.slice(0, eq), value: word.slice(eq + 1) })
      else if (valueFlags.has(word)) flags.push({ name: word, value: argv[++i] ?? null })
      else flags.push({ name: word, value: null })
      continue
    }
    const short = word.slice(0, 2)
    if (valueFlags.has(short)) {
      // -XPUT 처럼 값이 붙은 꼴은 붙은 글자가 값이다. -f=x 꼴도 gh(pflag)는 = 뒤를 값으로 읽는다.
      const attached = word.slice(2)
      if (attached) flags.push({ name: short, value: attached.startsWith('=') ? attached.slice(1) : attached })
      else flags.push({ name: short, value: argv[++i] ?? null })
    } else {
      flags.push({ name: word, value: null })
    }
  }
  return { positionals, flags }
}

function apiPath(raw: string): string {
  let path = raw.split('?')[0]
  while (path.startsWith('/')) path = path.slice(1)
  while (path.endsWith('/')) path = path.slice(0, -1)
  return path
}

function apiMethod(flags: Flag[]): string {
  let method: string | null = null
  for (const flag of flags) if ((flag.name === '-X' || flag.name === '--method') && flag.value !== null) method = flag.value
  if (method) return method.toUpperCase()
  return flags.some((flag) => GH_FIELD_FLAGS.has(flag.name)) ? 'POST' : 'GET'
}

// key=@path 꼴이면 gh 가 값을 파일에서 읽는다. 키가 없는 꼴(@path)도 같이 막는다. -f 는 gh 가 파일을 읽지 않지만 함께 막는다.
function fromFile(value: string | null): boolean {
  if (value === null) return false
  const eq = value.indexOf('=')
  return value.startsWith('@') || (eq >= 0 && value.slice(eq + 1).startsWith('@'))
}

function checkGh(argv: string[]): string | null {
  const { positionals, flags } = parse(argv, GH_VALUE_FLAGS)
  const [first, second] = positionals
  if (first === 'pr' && (second === 'merge' || second === 'update-branch')) return `gh pr ${second} 는 핸들러에서 부를 수 없다`
  if (first !== 'api' || second === undefined) return null
  if (second === 'graphql') {
    if (flags.some((flag) => flag.name === '--input')) return 'gh api graphql --input 은 내용을 확인할 수 없어 핸들러에서 부를 수 없다'
    if (flags.some((flag) => GH_KEY_VALUE_FLAGS.has(flag.name) && fromFile(flag.value))) {
      return 'gh api graphql 의 @ 필드는 파일 내용을 확인할 수 없어 핸들러에서 부를 수 없다'
    }
    const found = GRAPHQL_DENIED.find((name) => argv.some((word) => word.includes(name)))
    return found ? `gh api graphql 의 ${found} 는 핸들러에서 부를 수 없다` : null
  }
  const path = apiPath(second)
  if (/^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/update-branch$/.test(path)) return `gh api ${path} 는 핸들러에서 부를 수 없다(base 합치기)`
  if (/^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(path)) {
    const method = apiMethod(flags)
    if (method !== 'GET') return `gh api -X ${method} ${path} 는 핸들러에서 부를 수 없다(PR 머지)`
  }
  if (path === 'merges' || path.endsWith('/merges')) return `gh api ${path} 는 핸들러에서 부를 수 없다(브랜치 merge)`
  return null
}

function checkOrca(argv: string[]): string | null {
  // orca 의 값 받는 플래그 목록은 두지 않는다. 그래서 플래그 값이 위치 인자로 섞여 terminal 과 send 사이에 낄 수 있다
  // (orca terminal --x y send). 플래그를 건너뛴 낱말 열에서 terminal 뒤 어디든 send 가 나오면 거부한다. 막는 쪽으로 기운 규칙이다.
  const { positionals } = parse(argv, new Set())
  const at = positionals.indexOf('terminal')
  if (at >= 0 && positionals.indexOf('send', at + 1) > at) {
    return 'orca terminal send 는 핸들러에서 부를 수 없다. worker 에게 보내는 일은 send-to-worker 가 한다'
  }
  return null
}

// 거부 이유나 null.
export function check(tool: Tool, argv: string[]): string | null {
  return tool === 'orca' ? checkOrca(argv) : checkGh(argv)
}

// 진짜 실행 파일의 경로나 거부 이유.
function realBin(tool: Tool): { ok: true; path: string } | { ok: false; error: string } {
  const key = tool === 'orca' ? 'ORCH_REAL_ORCA' : 'ORCH_REAL_GH'
  const value = process.env[key]
  if (!value) return { ok: false, error: `${key} 가 없어 진짜 ${tool} 를 찾지 못했다` }
  if (!isAbsolute(value)) return { ok: false, error: `${key} 가 절대경로가 아니다: ${value}` }
  if (inside(real(value), real(GUARD_DIR))) return { ok: false, error: `${key} 가 가드 폴더 안을 가리킨다: ${value}` }
  return { ok: true, path: value }
}

export function main(tool: Tool, argv: string[]): number {
  const reason = check(tool, argv)
  if (reason) {
    process.stderr.write(`${tool} 가드: 거부: ${reason}. 코어 명령을 쓴다\n`)
    return DENIED
  }
  const bin = realBin(tool)
  if (!bin.ok) {
    process.stderr.write(`${tool} 가드: ${bin.error}\n`)
    return DENIED
  }
  const done = spawnSync(bin.path, argv, { stdio: 'inherit' })
  if (done.error) {
    process.stderr.write(`${tool} 가드: ${bin.path} 를 실행하지 못했다: ${done.error.message}\n`)
    return (done.error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1
  }
  if (done.signal) return signalCode(done.signal)
  return done.status ?? 1
}
