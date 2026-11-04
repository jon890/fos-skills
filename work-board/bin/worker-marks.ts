// 보드 창(hooks/register.js)이 worker 줄에 붙일 멈춤 판정을 낸다. 읽기만 한다.
// mod 는 TypeScript 와 node:fs 를 import 하지 못해, 이 명령을 $.process.run 으로 불러 JSON 출력만 읽는다.
//
// work-board 가 orch 를 import 하는 곳은 이 파일과 bin/merge-queue.ts(상태 폴더 경로만)다. 멈춤 판정을 orch 상주 루프와 한 벌로 두려는 것이다
// (docs/features/board-decision-box/spec.md 의 D11). 판정은 orch/scripts/lib/movement.ts 머리 주석이 소유한다.
// board.ts 는 orch 를 import 하지 않는다. orch 의 lib/paths.ts 가 board.ts 를 import 해 고리가 생긴다.
//
// 사용법:
//     worker-marks.ts --repo DIR [--run ID] [--asking ID]... [--merging ID]... [--questions-unknown]
//
//     --repo               설정(pipeline.idle_min, pipeline.idle_exited)과 루프 기록(state/movement.json)을 읽을 저장소(주 checkout)
//     --run                worker 목록을 읽을 Run. 없으면 workers 는 빈 목록이고 settings 만 낸다
//     --asking             답을 기다리는 질문을 보낸 dispatch id 나 터미널 handle. 여러 번 준다
//     --merging            CI 를 통과해 머지를 기다리는 dispatch id. 여러 번 준다
//     --questions-unknown  질문을 읽지 못했다. 모든 worker 를 기다리는 것으로 본다
//
// 기다리는 이유는 orch-loop.ts 의 watchMovement 안 waitingOf 와 같은 순서와 문구다. 질문은 부르는 쪽(보드)이 이미 읽은 것을 받는다.
// 화면 변화는 루프가 적은 movement.json 의 screens 를 읽기만 한다. 루프가 없으면 파일 수정 시각과 커밋 시각만 본다.
//
// 출력(stdout 한 줄 JSON):
//     {"settings": {"idleMin": n, "exited": b}, "workers": [WorkerMark...], "error": null | "<worker 목록을 읽지 못한 이유>"}
//     WorkerMark = {"dispatch", "terminal", "worktree", "reason": "idle"|"exited"|null, "idleMin": n|null,
//                   "movedAt": ms|null, "workedAt": ms|null, "waiting": string|null}
//     movedAt 은 판정에 쓴 마지막 움직임(파일, 커밋, 화면)이다. workedAt 은 파일과 커밋만의 마지막 시각이다.
//     보드는 오류 알림 뒤에 움직였는지를 workedAt 으로 본다. 오류 알림 자체가 화면을 바꾸기 때문이다
//
// 종료 코드: 0 냈다(worker 목록을 못 읽어도 error 에 이유를 두고 0), 1 예기치 못한 오류, 2 사용법이나 설정 오류(stderr 에 이유)

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigError } from '../../orch/scripts/lib/config.ts'
import { real } from '../../orch/scripts/lib/fs.ts'
import { judgeWorker, lastCommitMs, latestMtime, movementSettings, openRows, readRecords, worktreeOf } from '../../orch/scripts/lib/movement.ts'
import type { MovementSettings, ScreenMark } from '../../orch/scripts/lib/movement.ts'
import { pathOf } from '../../orch/scripts/lib/paths.ts'
import { workerRows } from '../../orch/scripts/lib/workers.ts'

type Json = Record<string, unknown>

export type WorkerMark = {
  dispatch: string
  terminal: string
  worktree: string | null
  reason: 'idle' | 'exited' | null
  idleMin: number | null
  movedAt: number | null
  workedAt: number | null
  waiting: string | null
}

const USAGE = '사용법: worker-marks.ts --repo DIR [--run ID] [--asking ID]... [--merging ID]... [--questions-unknown]'

// orch-loop.ts 의 waitingOf 와 같은 순서와 문구다
function waitingOf(row: Json, asking: ReadonlySet<string>, merging: ReadonlySet<string>, questionsUnknown: boolean): string | null {
  const dispatch = String(row.dispatchId ?? '')
  if (questionsUnknown) return '질문을 읽지 못했다'
  if (asking.has(dispatch) || asking.has(String(row.agentTerminalHandle ?? ''))) return '질문의 답을 기다린다'
  return merging.has(dispatch) ? 'CI 를 통과해 머지를 기다린다' : null
}

// 열린 dispatch 마다 판정한다. 워크트리 폴더가 없으면 파일과 커밋 시각을 읽지 않는다(lib/movement.ts 의 collectWorkers 와 같다)
export function markWorkers(input: {
  rows: Json[]
  settings: MovementSettings
  now: number
  screens: Readonly<Record<string, ScreenMark>>
  asking: ReadonlySet<string>
  merging: ReadonlySet<string>
  questionsUnknown: boolean
}): WorkerMark[] {
  return openRows(input.rows).map((row) => {
    const path = worktreeOf(row)
    const exists = path !== null && existsSync(path)
    const mtime = exists ? latestMtime(path as string) : null
    const commit = exists ? lastCommitMs(path as string) : null
    const worked = [mtime, commit].filter((v): v is number => typeof v === 'number')
    const verdict = judgeWorker({
      run: '',
      row,
      now: input.now,
      settings: input.settings,
      mtime,
      commit,
      screen: input.screens[String(row.dispatchId)],
      waiting: waitingOf(row, input.asking, input.merging, input.questionsUnknown),
    })
    return {
      dispatch: verdict.dispatch,
      terminal: verdict.terminal,
      worktree: verdict.worktree,
      reason: verdict.reason,
      idleMin: verdict.idleMin,
      movedAt: verdict.movedAt,
      workedAt: worked.length > 0 ? Math.max(...worked) : null,
      waiting: verdict.waiting,
    }
  })
}

// 루프가 적은 화면 기록. 없거나 깨졌으면 빈 기록이다
function screens(repo: string): Record<string, ScreenMark> {
  try {
    return readRecords(JSON.parse(readFileSync(join(pathOf('state', repo), 'movement.json'), 'utf8'))).screens
  } catch {
    return {}
  }
}

function main(argv: string[]): number {
  const options = {
    repo: { type: 'string' },
    run: { type: 'string' },
    asking: { type: 'string', multiple: true },
    merging: { type: 'string', multiple: true },
    'questions-unknown': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options, allowPositionals: false }))
  } catch (e) {
    process.stderr.write(`${USAGE}\nworker-marks: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.repo) {
    process.stderr.write(`${USAGE}\nworker-marks: --repo 가 필요하다\n`)
    return 2
  }
  const repo = real(values.repo)
  let settings: MovementSettings
  try {
    settings = movementSettings(repo)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`worker-marks: ${e.message}\n`)
    return 2
  }
  let workers: WorkerMark[] = []
  let error: string | null = null
  if (values.run) {
    const rows = workerRows(values.run)
    if (rows.ok) {
      workers = markWorkers({
        rows: rows.rows,
        settings,
        now: Date.now(),
        screens: screens(repo),
        asking: new Set(values.asking ?? []),
        merging: new Set(values.merging ?? []),
        questionsUnknown: values['questions-unknown'] ?? false,
      })
    } else {
      error = rows.error
    }
  }
  process.stdout.write(`${JSON.stringify({ settings, workers, error })}\n`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`worker-marks: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  }
}
