// 사람용 요약 `orch status`. 저장소의 상주 루프, Run 마다의 worker, 보드를 한 번에 판정 줄로 낸다. 읽기만 하고 아무것도 쓰지 않는다.
// 계약은 docs/features/orch-cli/design.md 의 「`orch status` (PR2)」 다. 판정은 각 lib 가 소유한다(루프 lib/loop.ts, 움직임 lib/movement.ts, 보드 lib/board.ts).
//
// 사용법:
//     orch-status.ts --repo DIR [--run ID]...
//
//     --repo  대상 저장소. 루프 기록, 설정, 보드를 이 저장소의 주 checkout 에서 읽는다
//     --run   볼 Run. 여러 번 준다. 없으면 상주 루프에 등록된 Run 을 모두, 그것도 없으면 config.json 의 finish.run 을 본다.
//             셋 다 없으면 Run 줄 없이 루프와 보드만 낸다(스펙 DECISION22). 진입점은 Run 을 문맥으로 채우지 않는다
//
// 출력(한 줄에 판정 하나):
//     LOOP-ALIVE <pid> runs=<등록된 Run 을 쉼표로 또는 -> last_tick=<시각 또는 ->   루프가 살았다
//     LOOP-STALE <repo> <pid> <번들>                   살아 있지만 지금 세션의 user 설치본과 다른 번들이다(doctor 와 같은 판정)
//     LOOP-DEAD <repo> <이유>                         루프가 없거나 죽었다(lib/loop.ts 의 loopStatus. 재확인을 기다리지 않는다)
//     RUN <id> workers=<이 저장소 워크트리의 열린 dispatch 수> stalled=<멈춘 수>   같은 Run 의 다른 저장소 worker 는 세지 않는다
//     SKIP-WORKERS <Run> <이유>                       그 Run 의 worker 목록을 읽지 못했다
//     BOARD doing=<수> decide=<수>                    보드 파일이 없으면 둘 다 0 이다
//     SKIP-BOARD <이유>                               보드를 읽지 못했다
//     SKIP-STAGES <이유>                              멈춘 단계를 판정하지 못했다
//     STALLED …, STAGE …                              멈춘 worker 와 worker 없이 멈춘 보드 단계. 꼴은 stalled-workers 와 같다(lib/movement.ts 의 workerLine, stageLine)
//
// 짧은 출력과 --full 이 같다. 설명 줄이 없다.
// 종료 코드: 0 읽었다(멈춘 것이 있어도 0), 1 worker 목록이나 보드를 하나라도 읽지 못했다, 2 사용법이나 설정 오류
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { readBoard } from '../lib/board.ts'
import { ConfigError, loadConfig, section } from '../lib/config.ts'
import { FINISH_KEYS } from '../lib/finish-options.ts'
import { real } from '../lib/fs.ts'
import { mainCheckout } from '../lib/git.ts'
import { staleLoopBundles } from '../lib/loop-bundle.ts'
import { loopStatus, registeredRuns } from '../lib/loop.ts'
import { collectStages, collectWorkers, movementSettings, screenMarks, stageLine, workerLine, worktreeOf } from '../lib/movement.ts'
import { boardPath } from '../lib/paths.ts'
import { workerRows } from '../lib/workers.ts'

const USAGE = '사용법: orch-status.ts --repo DIR [--run ID]...'

class Usage extends Error {}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

// worker 행의 워크트리가 이 저장소의 것인가. Run 하나가 여러 저장소의 worker 를 맡을 수 있어(ADR-012) Run 의 행을 그대로 세면
// 다른 저장소의 worker 를 이 저장소 설정과 화면 기록으로 판정하게 된다. 폴더가 있으면 그 주 checkout 으로, 없으면 경로 접두로 가린다
function ownWorktree(repo: string, row: Record<string, unknown>): boolean {
  const path = worktreeOf(row)
  if (!path) return false
  const full = resolve(path)
  if (existsSync(full)) return mainCheckout(full) === repo
  return full === repo || full.startsWith(repo + sep)
}

function runsOf(repo: string, given: string[]): string[] {
  if (given.length > 0) return [...new Set(given)]
  const registered = registeredRuns(repo).map((entry) => entry.run)
  if (registered.length > 0) return registered
  const run = section<Record<string, unknown>>(loadConfig(repo), 'finish', FINISH_KEYS).run
  return typeof run === 'string' && run ? [run] : []
}

function main(argv: string[]): number {
  const options = { repo: { type: 'string' }, run: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } as const
  let values
  try {
    ;({ values } = parseArgs({ args: expandArgs(argv, options, ['repo', 'run']), options, allowPositionals: false }))
  } catch (e) {
    process.stderr.write(`${USAGE}\norch-status: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    out(USAGE)
    return 0
  }
  if (!values.repo) {
    process.stderr.write(`${USAGE}\norch-status: --repo 가 필요하다\n`)
    return 2
  }
  const repo = mainCheckout(real(values.repo))
  let runs: string[]
  let settings
  try {
    settings = movementSettings(repo)
    runs = runsOf(repo, values.run ?? [])
  } catch (e) {
    if (!(e instanceof Usage) && !(e instanceof ConfigError)) throw e
    process.stderr.write(`orch-status: ${e.message}\n`)
    return 2
  }
  const now = Date.now()
  const loop = loopStatus(repo, now)
  if (loop.alive) {
    const registered = registeredRuns(repo).map((entry) => entry.run)
    out(`LOOP-ALIVE ${loop.state.pid} runs=${registered.join(',') || '-'} last_tick=${loop.state.last_tick || '-'}`)
    const stale = staleLoopBundles().find((entry) => entry.pid === Number(loop.state.pid))
    if (stale) out(`LOOP-STALE ${repo} ${stale.pid} ${stale.sha}`)
  } else {
    out(`LOOP-DEAD ${repo} ${loop.reason}`)
  }
  let failed = false
  // 이 저장소의 워크트리에 있는 worker 만 센다(ownWorktree)
  const rowsOf = (run: string) => {
    const got = workerRows(run)
    return got.ok ? { ok: true as const, rows: got.rows.filter((row) => ownWorktree(repo, row)) } : got
  }
  const workers = collectWorkers({ runs, rowsOf, settings, now, screens: screenMarks(repo) })
  for (const run of runs) {
    const reason = workers.errors.get(run)
    if (reason !== undefined) {
      failed = true
      out(`SKIP-WORKERS ${run} ${reason.replace(/\s+/g, ' ')}`)
      continue
    }
    const mine = workers.verdicts.filter((v) => v.run === run)
    out(`RUN ${run} workers=${mine.length} stalled=${mine.filter((v) => v.reason).length}`)
  }
  const board = boardPath(repo)
  try {
    const items = existsSync(board) ? readBoard(board) : []
    const count = (status: string) => items.filter((item) => item.status === status).length
    out(`BOARD doing=${count('doing')} decide=${count('decide')}`)
  } catch (e) {
    failed = true
    out(`SKIP-BOARD ${(e as Error).message.replace(/\s+/g, ' ')}`)
  }
  for (const v of workers.verdicts) if (v.reason) out(workerLine(v))
  try {
    for (const s of collectStages(repo, workers.live, settings, now)) out(stageLine(s))
  } catch (e) {
    failed = true
    out(`SKIP-STAGES ${(e as Error).message.replace(/\s+/g, ' ')}`)
  }
  return failed ? 1 : 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`orch-status: ${(e as Error)?.stack ?? String(e)}\n`)
  process.exitCode = 1
}
