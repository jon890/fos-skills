// 열린 dispatch 마다 마지막 움직임을 보고 멈춘 worker 와, worker 없이 멈춘 보드 단계를 낸다. 읽기만 한다.
// 상주 루프(orch-loop.ts)가 틱마다 같은 판정으로 알린다(그 머리 주석의 「움직임 확인」). 이 명령은 코디네이터가 지금 상태를 직접 볼 때 쓴다.
//
// 사용법:
//     stalled-workers.ts --repo DIR [--run ID]... [--idle-min N] [--json]
//
//     --repo      대상 저장소. 설정, 보드, 루프 기록을 이 저장소에서 읽는다
//     --run       볼 Run. 여러 번 준다. 없으면 상주 루프에 등록된 Run(lib/loop.ts 의 registeredRuns), 그것도 없으면
//                 config.json 의 finish.run 이다. 셋 다 없으면 사용법 오류다
//     --idle-min  idle 로 볼 분. 없으면 pipeline.idle_min(기본 30). 0 이면 idle 과 멈춘 단계를 보지 않는다
//     --json      아래 줄 대신 한 줄 JSON {"workers": [...], "stages": [...], "errors": {<Run>: <이유>}} 을 낸다.
//                 workers 의 항목은 lib/movement.ts 의 WorkerVerdict, stages 의 항목은 StageVerdict 다
//
// 판정은 lib/movement.ts 머리 주석이 소유한다. 화면이 바뀐 시각은 상주 루프가 적은 <orch 루트>/state/movement.json 의 screens 를
// 읽기만 한다. 루프가 없으면 파일 수정 시각과 커밋 시각만 본다. 미답변 질문은 보지 않는다. 루프의 알림은 질문을 보낸 worker 를 뺀다.
//
// 출력(탭으로 나눈다. 멈춘 worker, 움직이는 worker, 멈춘 단계 순서이고 같은 묶음 안에서는 오래 멈춘 것이 먼저다):
//     STALLED <dispatch> <idle 또는 exited> <움직임 뒤 지난 분 또는 -> <워크트리 이름 또는 -> <Run>
//     MOVING  <dispatch> - <움직임 뒤 지난 분 또는 -> <워크트리 이름 또는 -> <Run>
//     STAGE   <보드 항목 id> <worktree 칸, 없으면 branch 칸> <끝나지 않은 첫 단계>
//     worker 목록을 읽지 못한 Run 은 stderr 에 `stalled-workers: <Run>: <이유>` 를 낸다.
//     보드를 읽지 못하면 stderr 에 `stalled-workers: 보드를 읽지 못했다: <이유>` 를 내고 단계는 비운다
//
// 종료 코드: 0 멈춘 것이 없다, 3 멈춘 worker 나 단계가 있다, 1 worker 목록이나 보드를 하나라도 읽지 못했다(멈춘 것이 있어도 1),
//           2 사용법이나 설정 오류

import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError, loadConfig, section } from './lib/config.ts'
import { FINISH_KEYS } from './lib/finish-options.ts'
import { real } from './lib/fs.ts'
import { registeredRuns } from './lib/loop.ts'
import { collectStages, collectWorkers, movementSettings, screenMarks, stageLine, workerLine } from './lib/movement.ts'
import type { StageVerdict, WorkerVerdict } from './lib/movement.ts'
import { short } from './lib/output.ts'
import { workerRows } from './lib/workers.ts'

const USAGE = '사용법: stalled-workers.ts --repo DIR [--run ID]... [--idle-min N] [--json]'

class Usage extends Error {}

function runsOf(repo: string, given: string[]): string[] {
  if (given.length > 0) return [...new Set(given)]
  const registered = registeredRuns(repo).map((entry) => entry.run)
  if (registered.length > 0) return registered
  const run = section<Record<string, unknown>>(loadConfig(repo), 'finish', FINISH_KEYS).run
  if (typeof run === 'string' && run) return [run]
  throw new Usage('--run 이 필요하다. 루프에 등록된 Run 도 finish.run 도 없다')
}

function main(argv: string[]): number {
  const options = {
    repo: { type: 'string' },
    run: { type: 'string', multiple: true },
    'idle-min': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    ;({ values } = parseArgs({ args: expandArgs(argv, options, ['repo', 'run', 'idle-min']), options, allowPositionals: false }))
  } catch (e) {
    process.stderr.write(`${USAGE}\nstalled-workers: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.repo) {
    process.stderr.write(`${USAGE}\nstalled-workers: --repo 가 필요하다\n`)
    return 2
  }
  const repo = real(values.repo)
  let runs: string[]
  let settings
  try {
    settings = movementSettings(repo)
    if (values['idle-min'] !== undefined) {
      const n = Number(values['idle-min'])
      if (!values['idle-min'].trim() || !Number.isFinite(n) || n < 0) throw new Usage('--idle-min 은 0 이상의 수다')
      settings = { ...settings, idleMin: n }
    }
    runs = runsOf(repo, values.run ?? [])
  } catch (e) {
    if (!(e instanceof Usage) && !(e instanceof ConfigError)) throw e
    process.stderr.write(`stalled-workers: ${e.message}\n`)
    return 2
  }
  const now = Date.now()
  const workers = collectWorkers({ runs, rowsOf: (run) => workerRows(run), settings, now, screens: screenMarks(repo) })
  let failed = workers.errors.size > 0
  for (const [run, reason] of workers.errors) process.stderr.write(`stalled-workers: ${run}: ${reason}\n`)
  let stages: StageVerdict[] = []
  try {
    stages = collectStages(repo, workers.live, settings, now)
  } catch (e) {
    process.stderr.write(`stalled-workers: 보드를 읽지 못했다: ${(e as Error).message}\n`)
    failed = true
  }
  // 멈춘 것이 먼저, 같은 묶음 안에서는 오래 멈춘 것(움직임을 모르는 것 포함)이 먼저다
  const order = (v: WorkerVerdict) => [v.reason ? 0 : 1, -(v.idleMin ?? Number.MAX_SAFE_INTEGER)]
  const sorted = [...workers.verdicts].sort((a, b) => {
    const [x, y] = [order(a), order(b)]
    return x[0] - y[0] || x[1] - y[1]
  })
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ workers: sorted, stages, errors: Object.fromEntries(workers.errors) })}\n`)
  } else {
    // 짧은 출력(orch loop stalled)은 멈춘 것만 낸다. MOVING 은 --full 이다
    for (const v of sorted) if (!short() || v.reason) process.stdout.write(`${workerLine(v)}\n`)
    for (const s of stages) process.stdout.write(`${stageLine(s)}\n`)
  }
  if (failed) return 1
  return sorted.some((v) => v.reason) || stages.length > 0 ? 3 : 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`stalled-workers: ${(e as Error)?.stack ?? String(e)}\n`)
  process.exitCode = 1
}
