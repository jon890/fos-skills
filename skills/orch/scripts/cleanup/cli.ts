// 사용법 (기본은 dry-run. 무엇을 할지만 낸다):
//     cleanup-sweep.ts --repo DIR [--repo DIR ...] [--base main] [--run RUN_ID] [--specs-dir DIR] [--kill-holders]
//                      [--agent-glob 'agent-*'] [--close-own-taken-over] [--remote-branches] [--trash DIR] [--wait SEC] [--poll-interval SEC] [--apply]
//
//     --repo        대상 저장소의 기본 체크아웃. 여러 번 줄 수 있다. 여기서 git worktree 목록과 gh 를 읽는다.
//                   하나를 읽지 못해도 나머지는 돌고, 종료 코드만 2 가 된다
//     --base        기준 브랜치. 없으면 저장소마다 origin/HEAD 를 읽고, 그것도 없으면 main
//     --run         worker 를 찾을 Orca Run. 없으면 worker 확인과 release 를 건너뛰고 터미널만 경로로 찾는다.
//                   주면 다른 Run 의 worker 터미널이 있는 경로는 건너뛴다(아래 「다른 Run」)
//     --specs-dir   지시서 폴더(저장소 기준 상대경로 또는 절대경로). worktree 이름과 같은
//                   `<이름>.md` 와 `spec-<이름>.md` 를 지운다. 없으면 지시서는 건드리지 않는다.
//                   살아 있는 dispatch 의 `--spec` 줄이 가리키는 지시서는 지우지 않는다(lib/spec.ts 의 liveSpecPaths).
//                   그 목록을 읽지 못하면 이번 실행에서는 지시서와 PR 본문을 하나도 지우지 않는다.
//                   같은 폴더의 부모(`<specs-dir>/..`)에 있는 그 PR 의 옛 위치 본문 파일 `pr-<이름>.md` 도 지운다(지금 PR 본문은 worker 세션 임시 폴더에 둔다).
//                   이름은 worktree 이름, 브랜치의 `/` 를 `-` 로 바꾼 것, 브랜치의 첫 `/` 뒤, PR 번호다.
//                   `브랜치:` 줄이 머지된 브랜치를 가리키는 지시서도 이름과 관계없이 지운다(lib/spec.ts 의 specsOnBranch).
//                   앞 워크트리를 이어 쓴 후속 지시서처럼 이름이 워크트리와 다른 지시서가 남지 않게 한다
//                   고르기와 지우기는 lib/spec.ts 의 specCandidates, specsOnBranch 와 deleteSpecs 다
//                   워크트리를 지우면 launch-worker 가 그 워크트리에 준 지시서(lib/launched.ts 의 기록. 이어받기, 충돌 해소, 후속 지시서처럼
//                   이름이 다른 것도 든다)를 --trash 로 옮기고 그 기록을 지운다. 살아 있는 dispatch 가 가리키는 지시서는 남긴다
//                   워크트리가 먼저 지워져 위 순회가 만나지 못한 지시서도 치운다(아래 「워크트리 없는 지시서」)
//     --kill-holders  터미널을 닫은 뒤에도 그 경로를 쓰는 프로세스를 끈다(아래 「남은 프로세스 끄기」)
//     --agent-glob  하위 에이전트 워크트리 폴더 이름의 glob. 기본 `agent-*`(아래 「하위 에이전트 워크트리」)
//     --close-own-taken-over
//                   --run 과 함께 줄 때만 쓴다. 이 Run 의 끝난 dispatch 가 쓴 터미널이 `user_takeover` 로 남았어도
//                   아래 「넘겨받은 터미널」 조건을 모두 채우면 닫고 정리한다. 없으면 예전처럼 남긴다
//     --remote-branches
//                   저장소마다 워크트리와 로컬 브랜치 정리가 끝난 뒤, 로컬 브랜치가 없어도 내 PR 의 원격 브랜치를 지운다
//                   (아래 「원격 브랜치 삭제」 의 --remote-branches). 없으면 하지 않는다
//     --trash       머지 큐 로그(아래 「머지 큐 로그」)와 기록된 지시서(--specs-dir)를 옮길 휴지통 폴더. 기본 ~/.Trash/orch-cleanup-<날짜>
//     --wait        터미널을 닫은 뒤 프로세스가 빠지기를 기다리는 초. 0 이상의 유한한 수. 기본 5
//     --poll-interval  프로세스 확인 간격(초). 0 초과의 유한한 수. 기본 1
//     --apply       실제로 정리한다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// worker 목록과 터미널 소유는 `orca orchestration ... --full` 로 읽는다(lib/orca.ts 의 withFull). Orca 1.4.246 의 줄인 보기에는
//     resource.worktreeId 가 없어 워크트리의 worker 를 하나도 찾지 못했고, 끝난 dispatch 를 반납하지 않아 그 프로세스가 워크트리를 쥔 채 남았다
//
// ORCA, GH, ORCH_KILL 환경 변수로 실행 파일을 바꾼다. 기본 orca, gh, kill.
// ORCH_HOOK_WAIT(정수 초, 기본 180)에 60초를 더한 만큼 remove-worktree.ts 를 기다린다. 그 명령이 session-end hook 을 그만큼 기다린다.
//
// 종료 코드:
//     0  돌았다. 건너뛴 항목이 있어도 0 이다
//     2  사용법 오류, 또는 저장소를 읽지 못했다. --specs-dir 없이 orch 작업 폴더를 옮기기 전인 저장소를 만나도
//        그 저장소를 건너뛰고 2 다(lib/paths.ts 의 requireMigrated). 설정 파일 오류(lib/config.ts 의 ConfigError)도
//        그 저장소를 거기서 멈추고 2 다. 내 PR 의 작성자나 --remote-branches 의 후보를 읽지 못해도
//        그 동작만 하지 않고 2 다
//
// 테스트가 waitFree, stopHolders 를
import type { Args, Log, Terminal } from './shared.ts'
import { LookupError, runWorkers, workerSnapshot } from '../lib/ownership.ts'
import type { SweepContext } from './output.ts'
import type { WorkerRow } from '../lib/ownership.ts'
import { err } from './shared.ts'
import { expandArgs } from '../lib/args.ts'
import { foreignHandles, liveTerminals } from './terminals.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { liveSpecPaths } from '../lib/spec.ts'
import { parseArgs } from 'node:util'
import { realPath } from '../lib/fs.ts'
import { short } from '../lib/output.ts'
import { sweepLine } from './output.ts'

const USAGE =
  "사용법: cleanup-sweep.ts --repo DIR [--repo DIR ...] [--base main] [--run RUN_ID] [--specs-dir DIR] [--kill-holders] [--agent-glob 'agent-*'] [--close-own-taken-over] [--remote-branches] [--trash DIR] [--wait SEC] [--poll-interval SEC] [--apply]"

// argparse 의 float 와 같은 꼴만 받는다. 무한대와 NaN 도 받아 범위 검사가 거부하게 한다. 수가 아니면 null 이다
function parseFloatArg(text: string): number | null {
  const t = text.trim()
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t)
  const word = /^([+-]?)(inf|infinity|nan)$/i.exec(t)
  if (!word) return null
  if (word[2].toLowerCase() === 'nan') return Number.NaN
  return word[1] === '-' ? -Infinity : Infinity
}

// 휴지통 폴더. 안 주면 handoff-cleanup.ts 와 같은 ~/.Trash/orch-cleanup-<날짜> 다
function trashDir(given: string | undefined): string {
  if (given) return given === '~' ? homedir() : given.startsWith('~/') ? join(homedir(), given.slice(2)) : given
  const day = new Date()
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
  return join(homedir(), '.Trash', `orch-cleanup-${stamp}`)
}

type Session = { repos: string[]; args: Args; workers: WorkerRow[]; terminals: Terminal[]; log: Log; brief: boolean; tally: { removed: number; kept: number } }
export async function prepareSession(argv: string[]): Promise<Session | { code: number }> {
  const options = {
    repo: { type: 'string', multiple: true },
    base: { type: 'string' },
    run: { type: 'string' },
    'specs-dir': { type: 'string' },
    'kill-holders': { type: 'boolean', default: false },
    'agent-glob': { type: 'string', default: 'agent-*' },
    'close-own-taken-over': { type: 'boolean', default: false },
    'remote-branches': { type: 'boolean', default: false },
    trash: { type: 'string' },
    apply: { type: 'boolean', default: false },
    wait: { type: 'string', default: '5' },
    'poll-interval': { type: 'string', default: '1' },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    const expanded = expandArgs(argv, options, ['repo', 'base', 'run', 'specs-dir', 'agent-glob', 'trash', 'wait', 'poll-interval'])
    ;({ values } = parseArgs({ args: expanded, options, allowPositionals: false }))
  } catch (e) {
    err(`${USAGE}\ncleanup-sweep: ${(e as Error).message}`)
    return { code: 2 }
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return { code: 0 }
  }
  if (!values.repo?.length) {
    err(`${USAGE}\ncleanup-sweep: --repo 가 필요하다`)
    return { code: 2 }
  }
  const wait = parseFloatArg(values.wait)
  const pollInterval = parseFloatArg(values['poll-interval'])
  if (wait === null || pollInterval === null) {
    err(`${USAGE}\ncleanup-sweep: --wait 와 --poll-interval 은 수다`)
    return { code: 2 }
  }
  if (!(wait >= 0 && wait < Infinity) || !(pollInterval > 0 && pollInterval < Infinity)) {
    err('cleanup-sweep: --wait 는 0 이상, --poll-interval 은 0 초과의 유한한 수다')
    return { code: 2 }
  }
  const run = values.run || null
  if (values['close-own-taken-over'] && !run) {
    err('cleanup-sweep: --close-own-taken-over 는 --run 과 함께 쓴다')
    return { code: 2 }
  }
  const hookWait = process.env.ORCH_HOOK_WAIT ?? '180'
  if (!/^\s*[+-]?\d+\s*$/.test(hookWait)) {
    err('cleanup-sweep: ORCH_HOOK_WAIT 는 정수다')
    return { code: 2 }
  }
  const repos = [...new Set<string>(values.repo.map((repo) => realPath(repo)))]
  // 짧은 출력은 줄마다 sweepLine 으로 바꾸고 끝에 SWEEP 줄을 낸다(머리 주석의 「짧은 출력」)
  const brief = short()
  const tally = { removed: 0, kept: 0 }
  const sweepCtx: SweepContext = { path: null }
  const log: Log = (line) => {
    if (!brief) {
      process.stdout.write(`${line}\n`)
      return
    }
    for (const one of line.split('\n')) {
      const made = sweepLine(one, sweepCtx)
      if (made === null) continue
      if (/^(?:REMOVED|WOULD-REMOVE) /.test(made)) tally.removed++
      else if (made.startsWith('KEPT ')) tally.kept++
      process.stdout.write(`${made}\n`)
    }
  }

  const terminals = liveTerminals()
  if (terminals === null) {
    err('cleanup-sweep: orca terminal list 를 읽지 못해 살아 있는 worker 를 판정할 수 없다')
    return { code: 2 }
  }
  const specsDir = values['specs-dir'] || null
  const snapshot = workerSnapshot()
  const args: Args = {
    base: values.base ?? '',
    run,
    specsDir,
    killHolders: values['kill-holders'],
    agentGlob: values['agent-glob'],
    closeOwnTakenOver: values['close-own-taken-over'],
    remoteBranches: values['remote-branches'],
    trash: trashDir(values.trash),
    apply: values.apply,
    wait,
    pollInterval,
    removeTimeoutSec: Number(hookWait) + 60,
    foreign: null,
    // 정리 한 번 안에서 모든 Run 의 소유 상태를 한 번만 읽는다. 소유 확인과 다른 Run 판정이 같은 행을 쓴다
    allWorkers: snapshot.all,
    worktreeWorkers: snapshot.forWorktree,
    liveSpecs: new Set(),
  }
  let workers: WorkerRow[] = []
  if (run) {
    try {
      workers = await runWorkers(run)
      snapshot.seedRun(run, workers)
    } catch (e) {
      if (!(e instanceof LookupError)) throw e
    }
    args.foreign = await foreignHandles(run, args.allWorkers)
    if (args.foreign === null) err('cleanup-sweep: 모든 Run 의 worker 를 읽지 못해 이 Run worker 의 터미널만 닫는다')
  }
  args.liveSpecs = specsDir ? liveSpecPaths(run) : new Set()
  if (args.liveSpecs === null) err('cleanup-sweep: 살아 있는 dispatch 의 지시서 목록을 읽지 못해 지시서와 PR 본문은 지우지 않는다')
  return { repos, args, workers, terminals, log, brief, tally }
}
