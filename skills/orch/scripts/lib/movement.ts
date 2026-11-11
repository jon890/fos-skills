// 움직임으로 멈춘 worker 와 worker 없이 멈춘 보드 단계를 찾는 한 벌이다.
// 사용처: stalled-workers.ts(코디네이터가 부르는 조회), loop/steps/movement.ts(틱의 「움직임 확인」), extensions/work-board/bin/worker-marks.ts(보드 worker 줄의 멈춤 표시).
// 판정 함수는 조회하지 않는다.
// 화면 상태로 보는 멈춤(lib/screen.ts, loop/steps/stalls.ts 의 「멈춤 확인」)과 따로 돈다. Orca 의 structured worker 는 화면이 대화 기록 꼴이라
// 입력란을 찾지 못해 화면 상태가 늘 unknown 이다. 그래서 상태가 아니라 무엇이 바뀌었는지로 본다.
//
// 움직임(movedAt): 열린 dispatch 의 워크트리에서 아래 가운데 가장 늦은 시각(ms)이다.
//   - 워크트리 파일의 마지막 수정 시각(latestMtime). SKIP_DIRS 의 폴더는 들어가지 않고, 파일을 MTIME_BUDGET 개까지만 본다
//   - 브랜치의 마지막 커밋 시각(lastCommitMs. git log -1 --format=%ct)
//   - 터미널 화면 끝 줄(lib/screen.ts 의 screenTail)이 마지막으로 바뀐 시각(screen.changedAt). 화면 hash 를 틱마다 적어 두는
//     orch-loop 만 이 값을 안다. stalled-workers 는 루프가 적은 값(movement.json 의 screens)을 읽기만 한다.
//     같은 기록의 background 는 그 틱 화면의 백그라운드 작업 표시(lib/screen.ts 의 backgroundWork)다. 없으면 빠진다
// 멈춤 판정(judgeWorker. 위에서부터 처음 걸린 것):
//   1. Orca 의 liveness(projection.liveness.verdict)가 exited 이고 settings.exited 가 true 면 exited. 프로세스가 끝났는데 dispatch 가 열려 있다
//   2. 부르는 쪽이 기다리는 이유(waiting)를 주면 멈춤이 아니다. 루프는 그 Run 의 질문을 읽지 못한 것, 그 dispatch 가 보낸 미답변 질문,
//      그 워크트리 브랜치의 열린 PR 의 CI 가 통과한 것(머지를 기다린다)을 준다. 뒤의 둘은 코디네이터의 차례다.
//      이유가 없어도 화면 기록(screen.background)에 백그라운드 작업 표시가 있으면 `백그라운드 작업을 기다린다(<표시>)` 로 멈춤이 아니다.
//      백그라운드 셸이나 모니터가 끝나면 하네스가 worker 의 턴을 깨운다(lib/screen.ts 의 「백그라운드 작업」). 2026-11-04 에 멈춤 16건 가운데
//      13건이 이런 worker 였다
//   3. settings.idleMin 이 0 이면 보지 않는다. 멈춘 단계도 보지 않는다
//   4. 움직임을 하나도 모르면(워크트리가 없고 화면 기록도 없다) 멈춤이 아니다. 모르는 것을 멈춤으로 알리지 않는다
//   5. 움직임에서 idleMin 분이 지났으면 idle
// 멈춘 단계(stalledStages): 표시 없는 줄은 아래 규칙을 따른다. 단계는 details 에서 done 이 아닌 첫 줄이다.
//   - status 가 doing 이다. todo, wait, done, decide, goal 은 보지 않는다(wait 는 일부러 기다리는 항목이다)
//   - 끝나지 않은 단계가 있다
//   - worktree 나 branch 칸이 있다. 둘 다 없는 항목은 worker 를 띄운 적이 없는, 코디네이터나 사용자가 맡은 일이다
//   - 그 worktree(이름이나 경로의 끝 이름)나 branch 의 워크트리에 살아 있는 dispatch 가 없다
//   - 그 워크트리 폴더가 있으면 그 파일이 idleMin 분 안에 바뀌지 않았다. 맡은 Run 밖의 worker 가 일하는 중일 수 있다
//   - 표시를 읽은 줄은 기능을 꺼도 첫 미완료 번호 단계 글을 알린다.
//   - [wait] 는 항상 건너뛴다. 자동 진행이 켜졌으면 [ask] 와 띄운 기록 없는 [auto] 도 건너뛴다.
//   - 띄운 [auto] 는 doing/wait 와 빈 worktree·branch 도 본다. 그 단계의 dispatch·브랜치와 항목 필드로 worker·PR 을 찾는다.
//     열린 PR 목록을 모르면 보류한다. 표시의 첫 미완료 단계는 board.ts steps 로 읽고, 띄운 기록은 사건 꼬리표를 뗀 글로 맞춘다.
// 알림 기록(idleNotices, stageNotices): 같은 멈춤을 틱마다 다시 알리지 않으려는 것이다.
//   worker 는 알린 때의 reason 과 movedAt 을 둔다. reason 이 바뀌거나 그 뒤에 움직였다 다시 멈추면 다시 알린다.
//   단계는 처음 본 시각(since)과 단계 글을 둔다. 같은 단계가 idleMin 분 넘게 이어지면 한 번 알리고, 단계 글이 바뀌면 새로 센다.
//   지금 멈추지 않은 것의 기록은 지운다.
// 조회(collectWorkers, collectStages)는 worker 목록, 워크트리 파일, git, 보드를 읽어 판정 함수에 넘긴다. 쓰지 않는다.

import { DEFAULT_IDLE_MIN, worktreeOf, judgeWorker, openRows, stalledStages, readRecords } from '../core/movement.ts'
import type { Json, MovementSettings, ScreenMark, WorkerVerdict, StageVerdict } from '../core/movement.ts'
import { firstPendingStep, mayHaveStepMark } from './auto-advance.ts'
import { autoAdvanceOf } from '../core/auto-advance.ts'
import { stepLaunches } from './step-launches.ts'
import type { StageOptions } from '../core/movement.ts'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readBoard } from './board.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, section } from './config.ts'
import { git } from './git.ts'
import { boardPath } from './board-file.ts'
import { pathOf } from './paths.ts'
import { worktreePaths } from './workers.ts'
import type { workerRows } from './workers.ts'

export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'build', 'dist', 'out', '.gradle', '.omc', '.orch', '.venv', '__pycache__', 'target'])
// 큰 워크트리에서 틱이 길어지지 않게 보는 파일 수의 상한이다. 넘으면 그때까지 본 가장 늦은 시각을 쓴다
export const MTIME_BUDGET = 4000

// config.json 의 pipeline.idle_min(0 이상의 수, 기본 30. 0 이면 idle 을 보지 않는다)과 pipeline.idle_exited(참거짓, 기본 true).
// 값이 틀리면 ConfigError 다
export function movementSettings(repo: string): MovementSettings {
  const body = section<Json>(loadConfig(repo), 'pipeline', PIPELINE_KEYS)
  const idle = body.idle_min ?? DEFAULT_IDLE_MIN
  if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) throw new ConfigError('설정 파일의 pipeline.idle_min 은 0 이상의 수다')
  const exited = body.idle_exited ?? true
  if (typeof exited !== 'boolean') throw new ConfigError('설정 파일의 pipeline.idle_exited 는 true 나 false 다')
  return { idleMin: idle, exited }
}

// 워크트리 파일의 가장 늦은 수정 시각(ms). 폴더가 없거나 읽지 못하면 null
export function latestMtime(path: string, budget = MTIME_BUDGET): number | null {
  let newest: number | null = null
  let seen = 0
  const stack = [path]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      if (dir === path) return null
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      seen += 1
      if (seen > budget) return newest
      try {
        const ms = statSync(join(dir, entry.name)).mtimeMs
        if (newest === null || ms > newest) newest = ms
      } catch {
        // 지워진 파일은 건너뛴다
      }
    }
  }
  return newest
}

// 워크트리 브랜치의 마지막 커밋 시각(ms). 읽지 못하면 null
export function lastCommitMs(path: string): number | null {
  const done = git(path, ['log', '-1', '--format=%ct'])
  const sec = Number(done.stdout.trim())
  return done.code === 0 && Number.isFinite(sec) && sec > 0 ? sec * 1000 : null
}

// Run 마다 열린 dispatch 를 판정한다. rowsOf 는 Run 의 worker 목록을 낸다(루프는 틱 안에서 한 번 읽은 값을 준다).
// screens 는 dispatch 마다의 화면 기록, waiting 은 그 dispatch 를 멈춤으로 보지 않을 이유다. live 는 열린 dispatch 의 워크트리 경로다
export function collectWorkers(input: {
  runs: string[]
  rowsOf: (run: string) => ReturnType<typeof workerRows>
  settings: MovementSettings
  now: number
  screens?: Readonly<Record<string, ScreenMark>>
  waiting?: (run: string, row: Json, worktree: string | null) => string | null
}): { verdicts: WorkerVerdict[]; read: Set<string>; errors: Map<string, string>; live: Set<string> } {
  const verdicts: WorkerVerdict[] = []
  const read = new Set<string>()
  const errors = new Map<string, string>()
  const live = new Set<string>()
  for (const run of input.runs) {
    const rows = input.rowsOf(run)
    if (!rows.ok) {
      errors.set(run, rows.error)
      continue
    }
    read.add(run)
    for (const row of openRows(rows.rows)) {
      const path = worktreeOf(row)
      const exists = path !== null && existsSync(path)
      if (path && exists) live.add(path)
      const dispatch = String(row.dispatchId)
      verdicts.push(
        judgeWorker({
          run,
          row,
          now: input.now,
          settings: input.settings,
          mtime: exists ? latestMtime(path as string) : null,
          commit: exists ? lastCommitMs(path as string) : null,
          screen: input.screens?.[dispatch],
          waiting: input.waiting?.(run, row, path) ?? null,
        }),
      )
    }
  }
  return { verdicts, read, errors, live }
}

// 보드의 멈춘 단계. idleMin 이 0 이거나 보드 파일이 없으면 빈 목록이고, 읽지 못하면 Error 다
export function collectStages(repo: string, live: ReadonlySet<string>, settings: MovementSettings, now: number, context: { openPrs?: StageOptions['openPrs']; dispatches?: ReadonlySet<string>; branches?: Map<string, string> } = {}): StageVerdict[] {
  const file = boardPath(repo)
  if (settings.idleMin === 0 || !existsSync(file)) return []
  const items = readBoard(file) as Json[]
  const recent = (path: string) => {
    const ms = latestMtime(path)
    return ms !== null && now - ms < settings.idleMin * 60_000
  }
  const autoAdvance = autoAdvanceOf(loadConfig(repo))
  const steps = new Map<string, { mark: 'auto' | 'ask' | 'wait' | null; step: string; launches: ReturnType<typeof stepLaunches> }>()
  for (const item of items) {
    if (!['doing', 'wait'].includes(String(item.status)) || !mayHaveStepMark(item)) continue
    const step = firstPendingStep(file, item)
    if (step) steps.set(String(item.id), { mark: step.mark, step: step.key, launches: step.mark === 'auto' ? stepLaunches(repo, String(item.id), step.key) : [] })
  }
  return stalledStages(items, live, context.branches ?? worktreePaths(repo), recent, {
    autoAdvance, steps, openPrs: context.openPrs ?? null, dispatches: context.dispatches ?? new Set(),
  })
}

// 화면 기록(<orch 루트>/state/movement.json 의 screens)을 읽는다. 상주 루프가 쓰고 stalled-workers, orch-status 는 읽기만 한다. 없거나 읽지 못하면 빈 기록이다
export function screenMarks(repo: string): ReturnType<typeof readRecords>['screens'] {
  try {
    return readRecords(JSON.parse(readFileSync(join(pathOf('state', repo), 'movement.json'), 'utf8'))).screens
  } catch {
    return {}
  }
}

export { DEFAULT_IDLE_MIN, worktreeOf, livenessOf, tailHash, markScreen, judgeWorker, openRows, pendingStep, stalledStages, idleNotices, stageNotices, readRecords, workerLine, stageLine } from '../core/movement.ts'
export type { Json, MovementSettings, ScreenMark, WorkerVerdict, StageVerdict, IdleRecord, StageRecord } from '../core/movement.ts'
