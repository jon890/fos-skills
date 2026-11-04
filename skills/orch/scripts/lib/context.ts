// 새 꼴 명령의 문맥 기본값. 명령 표(commands.ts)의 context 칸에 든 인자를 사용자가 주지 않았으면 「명시 > 문맥 > 설정」 순서로 채운다.
// 진입점(bin/orch.ts)만 부른다. 옛 꼴은 문맥을 읽지 않는다(스펙 DECISION18). 계약은 docs/features/orch-cli/design.md 의 「문맥 풀기」 다.
//
// 출처:
//     repo       작업 폴더가 git 저장소 안이면 그 주 checkout(mainCheckout). 밖이면 채우지 않는다
//     run        `orca orchestration run-current` 의 run.id(5초 제한), 못 읽으면 기준 저장소 설정의 finish.run.
//                runFrom 이 run-current 인 명령(worker send)은 설정으로 대신하지 않는다.
//                `--ack` 가 있는 wait 은 설정으로 대신하지 않고, 15초로 한 번 더 읽는다. 다른 Run 의 delivery 를 ack 하지 않게 한다
//     specs-dir  기준 저장소 설정의 finish.specs_dir(주 checkout 기준 상대경로), 없으면 pathOf('specs', 기준 저장소)
//     loop-repo  기준 저장소의 루프 기록에 위 Run 이 등록돼 있으면(isRegistered) 그 저장소. 루프가 살았는지와 상관없다
// 기준 저장소는 명시한 --repo 가 하나면 그 저장소, 아니면 위에서 채운 저장소다. --repo 가 둘 이상이면 specs-dir 를 채우지 않는다.
// 설정을 읽다 ConfigError 가 나면 설정 출처를 건너뛴다. 오류는 스크립트가 지금처럼 알린다.
// 채운 인자는 prepend 바로 뒤, 첫 `--` 앞에 넣는다. 그 뒤는 다른 명령에 넘어가는 인자라 읽지도 넣지도 않는다.
// 문맥 칸 인자를 줄여 쓴 옵션(`--re`, `--ru`)은 사용법 오류다. 진입점이 모르면 같은 인자가 둘 들어간다.

import { resolve } from 'node:path'
import { beforeDashes, hasFlag, type Command, type ContextName } from './commands.ts'
import { loadConfig, section } from './config.ts'
import { FINISH_KEYS } from './finish-options.ts'
import { mainCheckout } from './git.ts'
import { isRegistered } from './loop.ts'
import { orcaJson } from './orca.ts'
import { pathOf } from './paths.ts'
import { run } from './proc.ts'

// sources 는 채운 인자마다 출처(cwd, run-current, config, default, registered)다
export type Filled = { args: string[]; note: string | null; sources: Partial<Record<ContextName, string>> }

const LABEL: Record<string, string> = { cwd: '작업 폴더', 'run-current': 'run-current', config: '설정', default: '기본 위치', registered: '루프 등록' }

function insideGit(cwd: string): boolean {
  const done = run(['git', '-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000 })
  return done.code === 0 && done.stdout.trim() === 'true'
}

function runCurrent(timeoutMs: number): string | null {
  const got = orcaJson<{ run?: { id?: unknown } | null }>(['orchestration', 'run-current'], { timeoutMs })
  if (!got.ok) return null
  const id = got.data?.run?.id
  return typeof id === 'string' && id ? id : null
}

function finishOf(repo: string): { run?: unknown; specs_dir?: unknown } {
  try {
    return section<{ run?: unknown; specs_dir?: unknown }>(loadConfig(repo), 'finish', FINISH_KEYS)
  } catch {
    return {}
  }
}

function valuesOf(args: string[], name: string): string[] {
  const head = beforeDashes(args)
  const out: string[] = []
  for (let i = 0; i < head.length; i++) {
    if (head[i] === `--${name}` && i + 1 < head.length) out.push(head[++i])
    else if (head[i].startsWith(`--${name}=`)) out.push(head[i].slice(name.length + 3))
  }
  return out
}

function explicit(command: Command, args: string[], name: ContextName): boolean {
  if (hasFlag(args, name)) return true
  const head = beforeDashes(args)
  // `--finish-arg=--run` 꼴과, 값을 따로 준 `--finish-arg --run` 꼴을 같은 명시로 본다
  const joined = head.map((a, i) => (/^--[a-z-]+-arg$/.test(a) && i + 1 < head.length ? `${a}=${head[i + 1]}` : a))
  return (command.explicit[name] ?? []).some((re) => joined.some((a) => re.test(a)))
}

export function fillContext(
  command: Command,
  args: string[],
  cwd: string,
  opts: { orcaTimeoutMs?: number; ackTimeoutMs?: number } = {},
): Filled | { error: string } {
  const wanted = command.context.filter((c) => !command.skip(args).includes(c))
  if (command.passthrough || wanted.length === 0) return { args, note: null, sources: {} }
  for (const token of beforeDashes(args)) {
    if (!token.startsWith('--') || token.length < 3) continue
    const name = token.includes('=') ? token.slice(2, token.indexOf('=')) : token.slice(2)
    const short = command.context.find((c) => c !== name && c.startsWith(name))
    if (short) return { error: `${token} 는 --${short} 를 줄여 쓴 것이다. 새 꼴에서는 문맥 인자를 줄여 쓰지 않는다` }
  }
  const filled: Partial<Record<ContextName, string>> = {}
  const source: Partial<Record<ContextName, string>> = {}
  const repos = valuesOf(args, 'repo')
  let repo: string | null = repos.length === 1 ? resolve(cwd, repos[0]) : null
  if (wanted.includes('repo') && !explicit(command, args, 'repo') && insideGit(cwd)) {
    repo = mainCheckout(cwd)
    filled.repo = repo
    source.repo = 'cwd'
  }
  if (repo === null && repos.length === 0 && insideGit(cwd)) repo = mainCheckout(cwd)
  const finish = repo ? finishOf(repo) : {}

  let runId: string | null = valuesOf(args, 'run')[0] ?? null
  const needRun = (wanted.includes('run') && !explicit(command, args, 'run')) || (wanted.includes('loop-repo') && runId === null)
  if (needRun && runId === null) {
    const acking = hasFlag(args, 'ack')
    let current = runCurrent(opts.orcaTimeoutMs ?? 5_000)
    if (current === null && acking) current = runCurrent(opts.ackTimeoutMs ?? 15_000)
    if (current !== null) {
      runId = current
      source.run = 'run-current'
    } else if (!acking && command.runFrom === 'any' && typeof finish.run === 'string' && finish.run) {
      runId = finish.run
      source.run = 'config'
    }
    if (runId !== null && wanted.includes('run') && !explicit(command, args, 'run')) filled.run = runId
    else if (acking && wanted.includes('run')) return { error: '--ack 를 주었는데 run-current 로 Run 을 읽지 못했다. --run <Run> 을 붙인다' }
  }

  if (wanted.includes('specs-dir') && !explicit(command, args, 'specs-dir') && repo && repos.length <= 1) {
    if (typeof finish.specs_dir === 'string' && finish.specs_dir) {
      // 설정은 주 checkout 의 것이라 상대경로도 주 checkout 기준이다. 명시한 --repo 가 워크트리나 하위 폴더여도 같다
      filled['specs-dir'] = resolve(mainCheckout(repo), finish.specs_dir)
      source['specs-dir'] = 'config'
    } else {
      filled['specs-dir'] = pathOf('specs', repo)
      source['specs-dir'] = 'default'
    }
  }

  if (wanted.includes('loop-repo') && !explicit(command, args, 'loop-repo') && repo && runId && isRegistered(repo, runId)) {
    filled['loop-repo'] = repo
    source['loop-repo'] = 'registered'
  }

  for (const need of command.required) {
    if (filled[need] === undefined && !explicit(command, args, need)) {
      return { error: `--${need} <${need === 'run' ? 'Run' : '값'}> 이 필요하다. 코디네이터 터미널에서 부르거나 --${need} 를 준다` }
    }
  }

  const order: ContextName[] = ['repo', 'run', 'specs-dir', 'loop-repo']
  const extra = order.flatMap((c) => (filled[c] !== undefined ? [`--${c}`, filled[c] as string] : []))
  const at = command.prepend.length
  const out = [...args.slice(0, at), ...extra, ...args.slice(at)]
  const shown = order.filter((c) => filled[c] !== undefined).map((c) => `${c}=${filled[c]}(${LABEL[source[c] as string]})`)
  const sources = Object.fromEntries(order.filter((c) => filled[c] !== undefined).map((c) => [c, source[c] as string]))
  return { args: out, note: shown.length ? `orch: 문맥 ${shown.join(' ')}` : null, sources }
}

// 진입점이 자식 환경 ORCH_CONTEXT 에 넣는 값. `run=run-current loop-repo=registered` 꼴이다
export function contextEnv(sources: Partial<Record<ContextName, string>>): string {
  return Object.entries(sources)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}
