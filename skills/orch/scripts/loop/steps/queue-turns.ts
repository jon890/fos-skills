// 큐 기록: 열린 PR 과 상관없이 틱마다 돈다. lib/queue-turn.ts 의 차례 기록을 읽는다. 명령줄에 `merge_queue.` 가 든 프로세스의 기록은 도는 큐,
//     아닌 pid 의 기록은 끝난 큐다. 두 쪽의 held 가운데 아직 옮기지 않은 항목마다 `QUEUE-DROPPED #<PR> pid <pid>: <이유>` 를 로그에 쓴다.
//     옮긴 항목은 state/queue-dropped.json 의 `<pid>:<PR>` 키로 기억한다. 끝난 큐의 기록은 옮긴 뒤 지우고 그 pid 의 키도 지운다.
//     머지 큐가 뺀 PR 과 이유를, 누가 큐를 걸었든 loop.log 하나에서 보게 하려는 것이다. 코디네이터가 고쳐야 다시 큐에 오르므로 주 Run 에 QUEUE-DROPPED(pr 은 PR 번호, text 는 `#<PR> <이유>`)를
//     바로 보낸다. 같은 PR 의 같은 이유는 `reason:<PR>:<이유>` 키로 기억해 큐를 다시 돌려도 한 번만 보낸다. 보내지 못하면 기록하지 않아 다음 틱이 다시 보낸다.
//     PS 를 읽지 못하면 errors 의 queue-turn 에 `프로세스 목록을 읽지 못했다` 를 둔다

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isObject } from '../../core/json.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { processes } from '../../lib/queue-process.ts'
import type { Proc } from '../../lib/queue-process.ts'
import { finishedTurns, readTurns } from '../../lib/queue-turn.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { iso, log, oneLine } from './shared.ts'

export { processes } from '../../lib/queue-process.ts'
export type { Proc } from '../../lib/queue-process.ts'

// 차례 기록(lib/queue-turn.ts)의 pid 가 지금 머지 큐 프로세스인지. 명령줄로 본다. pid 를 다른 프로세스가 다시 받았을 수 있다
export function queueTurns(repo: string, list: Proc[]): ReturnType<typeof readTurns> {
  return readTurns(repo, (pid) => list.some((p) => p.pid === pid && p.command.includes('merge_queue.')))
}

// 머리 주석의 「큐 기록」. 차례 기록의 held 가운데 아직 옮기지 않은 것을 QUEUE-DROPPED 줄로 로그에 쓰고, 끝난 큐의 기록을 지운다.
// 옮긴 것은 state/queue-dropped.json 의 `<pid>:<PR>` 키로 기억한다. 기록을 지운 pid 의 키는 함께 지운다
function watchQueueTurns(repo: string, run: string | null): string | null {
  const list = processes()
  if (!list) return '프로세스 목록을 읽지 못했다'
  const isQueue = (pid: number) => list.some((p) => p.pid === pid && p.command.includes('merge_queue.'))
  const file = join(pathOf('state', repo), 'queue-dropped.json')
  let seen: Record<string, string> = {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (isObject(raw)) seen = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  } catch {
    // 없거나 깨졌으면 빈 기록이다. 다시 옮겨도 로그 줄이 겹칠 뿐이다
  }
  const before = JSON.stringify(seen)
  // 모두 옮겼으면 true. 보내지 못한 항목이 있으면 false 라 호출한 쪽이 차례 기록을 지우지 않고 다음 틱이 다시 보낸다
  const copy = (turn: ReturnType<typeof readTurns>[number]): boolean => {
    let all = true
    for (const held of turn.held) {
      const key = `${turn.pid}:${held.pr}`
      if (Object.hasOwn(seen, key)) continue
      log(`QUEUE-DROPPED #${held.pr} pid ${turn.pid}: ${held.reason}`)
      // 코디네이터가 고쳐야 다시 큐에 오르므로 바로 보낸다. 같은 PR 의 같은 이유는 큐를 다시 돌려도 한 번만 보낸다
      const same = `reason:${held.pr}:${held.reason}`
      if (!Object.hasOwn(seen, same)) {
        try { sendNotice('QUEUE-DROPPED', held.pr, `#${held.pr} ${held.reason}`, run, repo) }
        catch (e) { log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`); all = false; continue }
        seen[same] = iso()
      }
      seen[key] = iso()
    }
    return all
  }
  for (const turn of readTurns(repo, isQueue)) copy(turn)
  for (const { file: turnFile, turn } of finishedTurns(repo, isQueue)) {
    if (turn && !copy(turn)) continue
    rmSync(turnFile, { force: true })
    const pid = basename(turnFile).replace(/\.json$/, '')
    for (const key of Object.keys(seen)) if (key.startsWith(`${pid}:`)) delete seen[key]
  }
  if (JSON.stringify(seen) !== before) {
    makeParent(file, repo)
    writeFileSync(file, `${JSON.stringify(seen, null, 2)}\n`, 'utf8')
  }
  return null
}

export async function relayQueueTurns(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { primary } = ctx
  const { report, errors } = reporter(ctx)
  // 8-1. 큐 기록. 머지 큐가 뺀 PR 과 이유를 루프 로그에 옮기고 끝난 큐의 기록을 지운다
  try {
    report('queue-turn', watchQueueTurns(ctx.repo, primary))
  } catch (e) {
    report('queue-turn', oneLine(e))
  }
  return { errors }
}
