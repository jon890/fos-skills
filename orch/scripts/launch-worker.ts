// 워크트리를 만들거나 확인한 뒤 허락 줄이 있는 지시서로 Orca worker 를 띄운다.
//
// 사용법:
//     launch-worker.ts --spec FILE (--repo DIR --name NAME | --worktree DIR)
//         [--base BRANCH] [--resume-remote] [--run ID] [--watch SEC] -- WORKER_ARGS...
//
//     --spec           지시서. spec-line 으로 첫 지시 줄을 만든다. `허락:` 줄이 없으면 거부한다
//     --repo, --name   새 워크트리를 make-worktree 로 만든다. --base, --resume-remote 는 make-worktree 에 넘긴다
//     --worktree       기존 워크트리(`path:` 접두를 받는다). 그 경로에 터미널이 남아 있으면 목록을 보이고 거부한다.
//                      같은 워크트리에 이어 띄우면 앞 세션이 닫히지 않고 쌓인다. --terminal 로 이어 쓰는 터미널은 세지 않는다
//     --run            worker-start 와 다시 띄우기에 줄 Run. 없으면 코디네이터에 묶인 Run 이다
//     --watch          띄운 뒤 worker-show 의 단계를 볼 초. 기본 90. 0 이면 보지 않는다
//     WORKER_ARGS      worker-start 에 그대로 넘긴다(--agent, --model, --effort, --terminal, --task 같은 것).
//                      --terminal 은 --agent, --model, --effort 와 함께 쓰지 못한다
//
// 차례:
//     1. spec-line --require-permission 으로 첫 지시 줄을 만든다
//     2. 워크트리를 만들거나 확인한다
//     3. before-launch 이벤트를 낸다. 결과가 pass 나 none 이 아니면(거부, 실패, 시간 초과, 잠금 실패) 띄우지 않고 1 이다.
//        거부만 보고 실패를 지나치면 죽은 핸들러가 막으려던 띄우기를 하게 된다(docs/flow.md 「갈래」 의 「거부처럼 멈춘다」)
//     4. `orca worktree list` 에 그 경로가 보일 때까지 기다린다
//     5. worker-start 로 띄우고 --watch 초 동안 단계를 본다
//        실패하면 출력의 error 를 `worker-start 오류: <code>: <message>` 한 줄로 낸다
//     6. `LAUNCHED <dispatch id> <워크트리>` 를 낸 뒤 worker-launched 이벤트를 낸다. 그 실패는 종료 코드를 바꾸지 않는다.
//        그에 앞서 띄운 worker 의 터미널 handle, dispatch id, 워크트리를 orch 상태 폴더에 기록한다(lib/launched.ts).
//        cleanup-sweep 이 그 터미널을 코디네이터의 것으로 알아보는 근거다. 다시 띄우기와 `--terminal` 이어 쓰기도 새 dispatch 로 기록한다.
//        기록 실패는 stderr 로만 알리고 LAUNCHED 와 종료 코드는 유지한다.
//        보드가 있으면 지시서의 항목 id, 제목과 마일스톤 단계(lib/milestones.ts)로 doing 항목을 갱신한다. 실패는 stderr 로 알리고 LAUNCHED 는 유지한다.
//        설정이 보드를 가리키는데 파일이 없으면 그 사실을 알린다.
//        핸들러의 실패와 이벤트 실행기의 예외(설정 파일 오류, state 폴더를 쓰지 못함 같은 것)가 모두 그렇다.
//        stderr 에 `worker-launched 를 내지 못했다: <이유>` 를 남긴다. worker 가 이미 떠 있어 코디네이터는 LAUNCHED 를 믿고 다음 단계로 가야 한다
//     새로 만든 워크트리는 띄우지 못하고 멈춰도 남긴다. 지시서의 브랜치 이름을 다시 쓸 때 사람이 판단할 근거라서다.
//     그때 stderr 에 `--worktree` 로 이어 띄우는 명령(`node --disable-warning=ExperimentalWarning <이 파일의 절대경로> ...`)을 낸다.
//     worker-start 가 이미 성공했으면 내지 않는다(같은 일의 Task 가 하나 더 생긴다)
//
// 이벤트 입력(lib/events.ts 머리 주석의 「이벤트별 필드」):
//     repo     --repo, --worktree 로 불렀으면 그 경로의 주 checkout
//     base     --base, 없으면 origin/HEAD 의 브랜치, 그것도 없으면 빈 문자열. 앞의 `origin/` 은 뗀다(--base origin/main 도 main)
//     run      --run, 없으면 null
//     worker   task, dispatch, terminal, worktree(절대경로), spec(절대경로). before-launch 의 task 와 terminal 은 WORKER_ARGS 의
//              --task, --terminal 이고 dispatch 는 null 이다. worker-launched 의 task 는 worker-start 결과, dispatch 는 LAUNCHED 의 id,
//              terminal 은 마지막 worker-show 의 worker.agentTerminalHandle, dispatch.assigneeHandle, WORKER_ARGS 의 --terminal 순이다
//     branch   워크트리의 현재 브랜치. 없으면 null
//     agent, model, effort   WORKER_ARGS 의 값. 없으면 null
//
// 종료 코드: 0 LAUNCHED, 1 거부, 실행 실패, before-launch 가 막음, 2 사용법 오류, orch 폴더 미이전, 설정 파일 오류,
//            3 --terminal 의 터미널이 에이전트를 인식하지 못함(agent_unconfigured)
//
// 환경 변수: ORCA, SPEC_LINE, MAKE_WORKTREE 로 실행 도구를 바꾼다. 도구는 확장자로 인터프리터를 고른다(lib/proc.ts 의 scriptCommand).
//            확인 간격(초)은 LAUNCH_POLL=5, LAUNCH_WT_WAIT=30, LAUNCH_WT_POLL=2 가 기본값이다. 소수도 받는다.
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts). WORKER_ARGS 는 펼치지 않는다.

import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { registerBoard } from './lib/board.ts'
import { expandArgs } from './lib/args.ts'
import { ConfigError } from './lib/config.ts'
import { fire } from './lib/events.ts'
import type { FireContext } from './lib/events.ts'
import { realPath } from './lib/fs.ts'
import { defaultBase, git, mainCheckout } from './lib/git.ts'
import { recordLaunch } from './lib/launched.ts'
import { orca, orcaBin, repoVisibility, repoVisibilityActions } from './lib/orca.ts'
import { requireMigrated } from './lib/paths.ts'
import { runAsync, scriptCommand } from './lib/proc.ts'
import type { RunResult } from './lib/proc.ts'
import { shQuote } from './lib/py.ts'

const USAGE = [
  '사용법: launch-worker.ts --spec FILE (--repo DIR --name NAME | --worktree DIR)',
  '            [--base BRANCH] [--resume-remote] [--run ID] [--watch SEC] -- WORKER_ARGS...',
].join('\n')
const HERE = dirname(fileURLToPath(import.meta.url))
// worker-start 는 에이전트가 뜰 때까지, make-worktree 는 fetch 와 worktree add 가 끝날 때까지 기다린다. 기본 60초로는 모자랄 수 있다
const LONG_MS = 600_000

class Stop extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function seconds(name: string, fallback: string): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < 0) throw new Stop(`${name} 는 0 이상의 초여야 한다: ${process.env[name]}`, 2)
  return value
}

// Python 의 `{초:g}` 와 같은 꼴. 유효 숫자 여섯 자리이고 끝의 0 을 지운다. 0.1 을 세 번 더한 값이 0.30000000000000004 가 아니라 0.3 이다
function secondsText(value: number): string {
  const [mantissa, exponent] = value.toExponential(5).split('e')
  const power = Number(exponent)
  if (power < -4 || power >= 6) {
    const digits = mantissa.replace(/\.?0+$/, '')
    return `${digits}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`
  }
  const fixed = value.toFixed(Math.max(0, 5 - power))
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

// 결과 JSON 의 result 에서 key 후보를 | 로 나눠 차례로 읽는다. 처음 나온 빈 값 아닌 것을 문자열로 낸다. 없으면 빈 문자열.
// 후보를 여럿 보는 것은 Orca 버전에 따라 같은 값이 다른 자리에 오기 때문이다(dispatch.id 와 dispatchId 같은 것).
// 한 자리만 보다 놓치면 이미 뜬 worker 의 dispatch id 를 읽지 못해 실패로 알리게 된다.
function jget(text: string, keys: string): string {
  let result: unknown
  try {
    result = (JSON.parse(text) as { result?: unknown }).result
  } catch {
    return ''
  }
  for (const key of keys.split('|')) {
    let value: unknown = result
    for (const part of key.split('.')) {
      value = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[part] : undefined
    }
    if (value !== undefined && value !== null && value !== '') return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return ''
}

// worker-start 출력에서 오류를 `code: message` 한 줄로 뽑는다. 못 찾으면 빈 문자열이다
function startError(text: string): string {
  let parsed: { error?: unknown; result?: { error?: unknown } }
  try {
    parsed = JSON.parse(text)
  } catch {
    return ''
  }
  const found = parsed?.error ?? parsed?.result?.error
  if (typeof found === 'string') return found
  if (typeof found !== 'object' || found === null) return ''
  const { code, message } = found as { code?: unknown; message?: unknown }
  return [code, message].filter((part) => typeof part === 'string' && part).join(': ')
}

// WORKER_ARGS 에서 옵션의 값. 없거나 값이 빠졌으면 null.
function passValue(passthru: string[], name: string): string | null {
  const at = passthru.indexOf(name)
  return at >= 0 && at + 1 < passthru.length ? passthru[at + 1] : null
}

// 그 워크트리에 붙은 터미널(handle 과 제목). reuse 는 이어 쓸 터미널이라 뺀다. 읽지 못하면 Stop(1).
function leftTerminals(worktree: string, reuse = ''): string {
  const done = orca(['terminal', 'list', '--json'])
  if (done.code !== 0) throw new Stop('거부: orca terminal list 를 읽지 못해 남은 터미널을 확인할 수 없다', 1)
  let rows: Record<string, unknown>[]
  try {
    const list = (JSON.parse(done.stdout) as { result: { terminals?: unknown } }).result.terminals ?? []
    if (!Array.isArray(list)) throw new Error('terminals 가 목록이 아니다')
    rows = list as Record<string, unknown>[]
  } catch {
    throw new Stop('거부: 터미널 목록을 해석하지 못했다', 1)
  }
  return rows
    .filter((t) => t?.worktreePath === worktree && t?.handle !== reuse)
    .map((t) => `${t.handle} ${Array.from(String(t.title ?? '')).slice(0, 60).join('')}`)
    .join('\n')
}

// Orca 가 워크트리를 알아보지 못했을 때 원인을 짐작할 근거와 사용자 조치. 설정은 바꾸지 않는다.
function unrecognizedHelp(worktree: string, waited: number): string {
  const common = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const commonDir = common.stdout.trim()
  const repo = common.code === 0 && commonDir ? dirname(commonDir) : null
  const value = repo ? repoVisibility(repo) : ''
  const lines = [
    `Orca 가 워크트리를 알아보지 못했다. \`orca worktree list\` 로 확인한다: ${worktree} (${secondsText(waited)}초 기다림)`,
    `  만든 경로: ${worktree}`,
    `  저장소의 externalWorktreeVisibility: ${value || '(읽지 못함)'}`,
  ]
  if (value === 'hide' && repo) {
    lines.push('  hide 면 git worktree add 로 만든 워크트리를 Orca 가 외부 워크트리로 보고 숨긴다. 사용자가 아래 중 하나를 한다(스크립트는 설정을 바꾸지 않는다)')
    lines.push(repoVisibilityActions(repo))
  } else if (repo) {
    lines.push('  hide 가 아니면 Orca 가 아직 알아보지 못한 것일 수 있다. 잠시 뒤 `orca worktree list` 를 다시 보고, 계속 안 보이면 Orca 화면에서 등록한다')
  }
  return lines.join('\n')
}

function listed(worktree: string): boolean {
  const done = orca(['worktree', 'list', '--limit', '1000', '--json'])
  if (done.code !== 0) return false
  let rows: unknown
  try {
    rows = (JSON.parse(done.stdout) as { result: { worktrees?: unknown } }).result.worktrees
  } catch {
    return false
  }
  if (!Array.isArray(rows)) return false
  const target = realPath(worktree)
  return rows.some((row) => realPath(String((row as { path?: unknown })?.path || '/nonexistent')) === target)
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

type Args = {
  spec: string
  repo: string
  name: string
  base: string
  worktree: string
  run: string
  watch: number
  resumeRemote: boolean
  passthru: string[]
}

function parse(argv: string[]): Args | 'help' {
  const split = argv.includes('--') ? argv.indexOf('--') : argv.length
  const passthru = argv.slice(split + 1)
  const options = {
    spec: { type: 'string' },
    repo: { type: 'string', default: '' },
    name: { type: 'string', default: '' },
    base: { type: 'string', default: '' },
    worktree: { type: 'string', default: '' },
    run: { type: 'string', default: '' },
    watch: { type: 'string', default: '90' },
    'resume-remote': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv.slice(0, split), options), options }).values
  } catch (e) {
    throw new Stop(`${USAGE}\nlaunch-worker: ${(e as Error).message}`, 2)
  }
  if (values.help) return 'help'
  const usage = (message: string) => new Stop(`${USAGE}\nlaunch-worker: ${message}`, 2)
  if (!values.spec) throw usage('--spec 이 필요하다')
  const watch = values.watch as string
  if (!/^\d+$/.test(watch)) throw usage('--watch 는 초 단위 정수다')
  const resumeRemote = values['resume-remote'] as boolean
  if (values.worktree && (values.repo || values.name || resumeRemote)) throw usage('--worktree 와 --repo/--name/--resume-remote 은 함께 쓰지 않는다')
  if (!values.worktree && !(values.repo && values.name)) throw usage('새 워크트리는 --repo 와 --name, 기존 워크트리는 --worktree 를 준다')
  return {
    spec: values.spec,
    repo: values.repo as string,
    name: values.name as string,
    base: values.base as string,
    worktree: values.worktree as string,
    run: values.run as string,
    watch: Number(watch),
    resumeRemote,
    passthru,
  }
}

async function main(argv: string[]): Promise<number> {
  const a = parse(argv)
  if (a === 'help') {
    out(USAGE)
    return 0
  }
  const { passthru } = a
  const reuseOpts = passthru.filter((x) => x === '--agent' || x === '--model' || x === '--effort')
  if (passthru.includes('--terminal') && reuseOpts.length > 0) {
    err(`거부: --terminal 은 ${reuseOpts.join(' ')} 와 함께 쓰지 못한다(invalid_argument)`)
    return 1
  }
  if (!requireMigrated(a.repo || a.worktree.replace(/^path:/, ''), 'launch-worker', null)) return 2
  const poll = seconds('LAUNCH_POLL', '5')
  const wtWait = seconds('LAUNCH_WT_WAIT', '30')
  const wtPoll = seconds('LAUNCH_WT_POLL', '2')
  const call = (args: string[], timeoutMs?: number): Promise<RunResult> => runAsync([orcaBin(), ...args], { timeoutMs })

  const specLine = await runAsync(scriptCommand(process.env.SPEC_LINE || `${HERE}/spec-line.ts`, [a.spec, '--require-permission']))
  if (specLine.code !== 0) {
    err('거부: 첫 지시 줄을 만들지 못했다(지시서에 `허락:` 줄을 적는다)')
    return 1
  }

  const created = !a.worktree
  let worktree: string
  if (created) {
    const args = ['--repo', a.repo, '--spec', a.spec, '--name', a.name]
    if (a.base) args.push('--base', a.base)
    if (a.resumeRemote) args.push('--resume-remote')
    const made = await runAsync(scriptCommand(process.env.MAKE_WORKTREE || `${HERE}/make-worktree.ts`, args), { timeoutMs: LONG_MS })
    if (made.code !== 0) {
      err(made.stderr)
      return 1
    }
    worktree = made.stdout.trim()
    out(`워크트리를 만들었다: ${worktree}`)
  } else {
    const target = realPath(a.worktree.replace(/^path:/, ''))
    if (!isDir(target)) {
      err(`워크트리가 없다: ${target}`)
      return 1
    }
    worktree = target
    const left = leftTerminals(worktree, passValue(passthru, '--terminal') ?? '')
    if (left) {
      out(`거부: 이 워크트리에 터미널이 남아 있다. 끝났는지 보고 orca terminal close --terminal <handle> 로 닫은 뒤 다시 띄운다\n${left}`)
      return 1
    }
  }

  const repo = a.repo || mainCheckout(worktree)
  // 핸들러는 base 를 브랜치 이름으로 받는다. --base origin/main 으로 불러도 defaultBase 와 같은 꼴(main)로 넘긴다
  const ctx: FireContext = { repo, base: (a.base || defaultBase(repo) || '').replace(/^origin\//, ''), run: a.run || null }
  const branchOut = git(worktree, ['branch', '--show-current'])
  const common = {
    branch: (branchOut.code === 0 && branchOut.stdout.trim()) || null,
    agent: passValue(passthru, '--agent'),
    model: passValue(passthru, '--model'),
    effort: passValue(passthru, '--effort'),
  }
  const worker = { worktree: resolve(worktree), spec: resolve(a.spec) }

  let started = false
  try {
    const before = await fire(
      'before-launch',
      { worker: { task: passValue(passthru, '--task'), dispatch: null, terminal: passValue(passthru, '--terminal'), ...worker }, ...common },
      ctx,
    )
    if (before.result !== 'pass' && before.result !== 'none') {
      err(`before-launch 가 ${before.result} 로 끝나 worker 를 띄우지 않는다`)
      return 1
    }

    let waited = 0
    while (!listed(worktree)) {
      if (waited >= wtWait) {
        err(unrecognizedHelp(worktree, waited))
        return 1
      }
      await sleep(wtPoll * 1000)
      waited += wtPoll || 1
    }
    err(`Orca 가 워크트리를 알아보기까지 ${secondsText(waited)}초 기다렸다`)

    const start = async (args: string[]): Promise<RunResult> => {
      let result = await call(['orchestration', 'worker-start', ...args, '--json'], LONG_MS)
      // worktree list 에 보인 직후에도 Orca 가 그 워크트리를 아직 고르지 못해 selector_not_found 로 끝나는 일이 있다.
      // 그 오류만 한 번 다시 부른다. 다른 오류는 다시 불러도 같은 결과라 그대로 멈춘다.
      if (result.code !== 0 && (result.stdout + result.stderr).includes('selector_not_found')) {
        err(`worker-start 가 selector_not_found 로 끝나 ${secondsText(wtPoll)}초 뒤 한 번 다시 부른다`)
        await sleep(wtPoll * 1000)
        result = await call(['orchestration', 'worker-start', ...args, '--json'], LONG_MS)
      }
      out(result.stdout + result.stderr)
      return result
    }
    let lastShow = ''
    const watch = async (dispatch: string): Promise<boolean> => {
      let spent = 0
      for (;;) {
        lastShow = (await call(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])).stdout
        const stage = jget(lastShow, 'worker.stage')
        if (stage && stage !== 'worktree_creating') {
          out(`${dispatch} 단계: ${stage}`)
          return true
        }
        if (spent >= a.watch) {
          out(`${dispatch} 가 ${a.watch}초 동안 ${stage || '단계 없음'} 에서 넘어가지 않았다`)
          return false
        }
        await sleep(poll * 1000)
        spent += poll || 1
      }
    }

    const runArgs = a.run ? ['--run', a.run] : []
    let result = await start([...runArgs, '--spec', specLine.stdout.trim(), '--worktree', `path:${worktree}`, ...passthru])
    if (result.code !== 0) {
      const output = result.stdout + result.stderr
      if (passthru.includes('--terminal') && output.includes('agent_unconfigured')) {
        err(
          '--terminal 의 터미널이 에이전트를 인식하지 못했다(agent_unconfigured). replying.md 「이어 쓸 수 없는 터미널」 을 따른다. ' +
            '이 세션이 띄운 worker 의 작업이 push 됐는지 확인하고 orca terminal close 로 닫은 뒤 --terminal 을 빼고 --agent, --model, --effort 를 준다',
        )
        return 3
      }
      if (output.includes('agent-hooks-review-prompt')) {
        err('Codex 설치본에 .codex-plugin 이 없는 옛 버전이다: codex plugin marketplace upgrade fos-skills (docs/adr/007)')
      }
      const reason = startError(result.stdout)
      if (reason) err(`worker-start 오류: ${reason}`)
      err(`worker-start 가 종료 코드 ${result.code} 로 끝났다. launch.md 의 「첫 화면에서 멈춤」 과 「시작 직후 실패」 를 본다`)
      return 1
    }
    started = true
    const DISPATCH_KEYS = 'dispatch.id|dispatchId|worker.dispatchId'
    const TASK_KEYS = 'dispatch.taskId|taskId|task.id'
    let dispatch = jget(result.stdout, DISPATCH_KEYS)
    let task = jget(result.stdout, TASK_KEYS)
    if (!dispatch) {
      err('worker-start 출력에서 dispatch id 를 읽지 못했다')
      return 1
    }
    // worker-start 는 성공했는데 dispatch 가 worktree_creating 에서 넘어가지 않는 일이 있다. 그 dispatch 는 스스로 풀리지 않아
    // abandon 하고 같은 Task 를 --retry-of 로 한 번 다시 띄운다. 다시 띄워도 멈추면 원인이 다른 곳이라 멈춘다.
    if (a.watch > 0 && !(await watch(dispatch))) {
      if (!task) {
        err(`task id 를 몰라 다시 띄우지 못한다: ${dispatch}`)
        return 1
      }
      if ((await call(['orchestration', 'worker-abandon', '--dispatch', dispatch, '--json'])).code !== 0) return 1
      out(`${dispatch} 를 abandon 하고 같은 Task 를 path:${worktree} 로 다시 띄운다`)
      result = await start([...runArgs, '--task', task, '--retry-of', dispatch, '--worktree', `path:${worktree}`, ...passthru])
      if (result.code !== 0) {
        const reason = startError(result.stdout)
        err(`다시 띄운 worker-start 가 종료 코드 ${result.code} 로 끝났다${reason ? `: ${reason}` : ''}`)
        return 1
      }
      dispatch = jget(result.stdout, DISPATCH_KEYS)
      task = jget(result.stdout, TASK_KEYS) || task
      if (!dispatch || !(await watch(dispatch))) return 1
    }
    out(`LAUNCHED ${dispatch} ${worktree}`)

    // worker-show 결과의 터미널 키는 send-to-worker 가 읽는 키와 같다.
    const terminal = jget(lastShow, 'worker.agentTerminalHandle|dispatch.assigneeHandle') || passValue(passthru, '--terminal')
    try {
      recordLaunch(repo, { dispatch, task: task || null, terminal: terminal || null, worktree, run: a.run || null, spec: resolve(a.spec) })
    } catch (e) {
      err(`launch-worker: 띄운 worker 를 기록하지 못했다. cleanup-sweep 이 이 터미널을 코디네이터의 것으로 알아보지 못한다: ${(e as Error).message}`)
    }

    try {
      registerBoard(repo, a.spec, worktree, a.name, common.branch || '')
    } catch (e) {
      err(`launch-worker: 보드를 갱신하지 못했다: ${(e as Error).message}`)
    }

    try {
      await fire('worker-launched', { worker: { task: task || null, dispatch, terminal, ...worker }, ...common }, ctx)
    } catch (e) {
      // worker 는 이미 떴다. 어떤 예외로든 종료 코드를 바꾸면 코디네이터가 띄우기 실패로 읽고 같은 일을 다시 띄운다
      err(`launch-worker: worker-launched 를 내지 못했다: ${(e as Error)?.message ?? String(e)}`)
    }
    return 0
  } finally {
    if (created && !started) {
      const hint = ['node', '--disable-warning=ExperimentalWarning', `${HERE}/launch-worker.ts`, '--spec', a.spec, '--worktree', worktree]
      hint.push(...(a.run ? ['--run', a.run] : []), '--', ...passthru)
      err(
        `워크트리는 남아 있다: ${worktree}\n같은 --name 으로 다시 부르면 make-worktree 가 거부한다. ` +
          `이어 띄우려면 --repo/--name/--base 대신 --worktree 를 준다:\n  ${hint.map(shQuote).join(' ')}`,
      )
      try {
        const left = leftTerminals(worktree)
        if (left) err(`실패한 띄우기가 남긴 터미널을 확인한다:\n${left}`)
      } catch (e) {
        if (!(e instanceof Stop)) throw e
      }
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    if (e instanceof Stop) {
      err(e.message)
      process.exitCode = e.code
    } else if (e instanceof ConfigError) {
      err(`launch-worker: ${e.message}`)
      process.exitCode = 2
    } else {
      err(`launch-worker: ${(e as Error)?.stack ?? String(e)}`)
      process.exitCode = 1
    }
  },
)
