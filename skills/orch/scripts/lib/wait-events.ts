// 사건 대기(docs/features/board-feature-items/design.md 「사건 대기」). 루프의 느린 틱이 부른다(loop/steps/wait-events.ts).
//
// 줄: 끝나지 않은 항목의 끝나지 않은 단계 가운데 `N. [wait: 사건 <이름>] …` 줄이다. 이름은 core/step-ready.ts 의 waitEventOf 가 읽는다.
// 맡는 저장소: 줄마다 한 루프만 명령을 돌린다.
//   항목에 dispatch 가 있는 worker 줄이 있으면 그 dispatch 를 띄운 저장소(lib/board.ts 의 boardOwnership)가 맡는다. 다른 루프는 건너뛴다.
//   없으면(보드 명령으로 직접 만든 항목) 보드 파일이 든 저장소(lib/main-guard.ts 의 boardRepo)가 맡는다.
//   그 자리가 git 저장소가 아니면(홈 보드) 아무도 돌리지 않고 「확인할 저장소 없음」 으로 한 번 알린다.
//   명령은 맡은 저장소의 설정(board.wait_events, core/wait-events.ts)에서만 찾는다.
// 실행: 같은 이름은 한 번만, 이름들은 동시에 lib/proc.ts 의 runGroup 으로 주 checkout 에서 `sh -c` 로 돌린다.
//   시간 상한은 core/wait-events.ts 의 waitEventLimitMs, 출력 한도는 WAIT_EVENT_MAX_OUTPUT(1MB)이다. 느린 틱의 남은 시간이 모자라면 이번 틱에는 돌리지 않는다(실패가 아니다).
// 결과: 0 이면 `board.ts step <id> <번호>` 로 그 줄만 끝내고 WAIT-EVENT <id> <번호> <이름> 을 주 Run 에 보낸다. 항목 상태는 그대로다.
//   1 이면 그대로다. 설정에 이름이 없음, 확인할 저장소 없음, 그 밖의 종료 코드, 시간 초과, 출력 초과, 실행 실패, 남은 프로세스는
//   줄을 그대로 두고 WAIT-EVENT-ERROR <id> <번호> <이름>: <이유> 를 한 번 보낸다.
// 한 번 알림 기록: <머신 폴더>/wait-events.json 의 { boards: { <보드 실경로>: { "<id>#<줄 글>": <실패 종류> } } }.
//   잠금 안에서 읽고, 줄을 끝내고, 보내고, 쓴다. 같은 보드를 여러 저장소의 루프가 봐도 기록이 하나다.
//   줄이 끝나거나 글이 바뀌면(보드에 그 열린 사건 줄이 없으면) 기록을 지운다. 같은 줄에서 실패 종류가 바뀌면 다시 알린다.
//   「아직」 이 나오면 기록을 지운다. 그 뒤의 실패는 새 실패로 알린다.
//   보드 파일이 없어진 기록은 쓸 때 지운다.
// 줄을 끝낸 뒤 WAIT-EVENT 전송이 실패하면 다시 보내지 않고 failed 로 돌려준다. 단계가 오류 줄(wait-events@<주 Run>)에 남긴다.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock } from '../../../../modules/file-lock.ts'
import { parseStepMark } from '../../../../extensions/work-board/hooks/step-marks.js'
import { stageTag } from '../../../../extensions/work-board/hooks/event-tags.js'
import { boardWorkerRows } from '../core/board-workers.ts'
import { isObject } from '../core/json.ts'
import { waitEventOf } from '../core/step-ready.ts'
import { waitEventLimitMs, waitEventsOf, waitVerdict } from '../core/wait-events.ts'
import type { WaitEvent, WaitFailure, WaitVerdict } from '../core/wait-events.ts'
import { BOARD_BIN, boardOwnership, boardSteps, readBoard } from './board.ts'
import { boardPath } from './board-file.ts'
import { loadConfig } from './config.ts'
import { mainCheckout } from './git.ts'
import { machineDir } from './machine.ts'
import { boardRepo } from './main-guard.ts'
import { run, runGroup, scriptCommand } from './proc.ts'
import { boardKey } from './step-ready.ts'

export type WaitLine = { id: string; number: number; text: string; name: string; owner: 'mine' | 'other' | 'none' }
export type WaitEventsOptions = {
  // 느린 틱이 끊기는 시각(ms). 없으면 명령마다 timeout_sec 만 쓴다
  deadline: number | null
  now?: () => number
  // 알림 전송. 실패하면 던진다
  notify: (kind: 'WAIT-EVENT' | 'WAIT-EVENT-ERROR', text: string) => void
  log: (line: string) => void
}
export type WaitEventsResult = { done: string[]; failed: string[] }

// 사건 명령의 출력 한도(바이트, stdout 과 stderr 각각). 확인 명령은 종료 코드로 답하므로 출력이 많으면 잘못 돈 것으로 본다
export const WAIT_EVENT_MAX_OUTPUT = 1024 * 1024
const bin = () => process.env.BOARD_BIN || BOARD_BIN
export const waitEventsFile = (): string => join(machineDir(), 'wait-events.json')
const recordKey = (line: { id: string; text: string }) => `${line.id}#${line.text}`
const oneLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()

// 보드의 열린 사건 대기 줄과 맡는 저장소
export function waitLines(repo: string, board: string): WaitLine[] {
  const items = readBoard(board).filter((item) => item.status !== 'done' && JSON.stringify([item.details, item.next]).includes('[wait:'))
  if (!items.length) return []
  const { ownItems } = boardOwnership(repo, items as Record<string, unknown>[])
  const holder = boardRepo(repo, board)
  const here = mainCheckout(repo)
  let holderIsRepo: boolean | null = null
  const lines: WaitLine[] = []
  for (const item of items) {
    const id = String(item.id)
    const steps = boardSteps(bin(), id, board)
    if (steps === null) throw new Error(`단계 목록을 읽지 못했다: ${id}`)
    const launched = boardWorkerRows(item as Record<string, unknown>).some((row) => row.dispatch)
    let owner: WaitLine['owner']
    if (ownItems.has(id)) owner = 'mine'
    else if (launched) owner = 'other'
    else if (holder === here) owner = 'mine'
    else {
      holderIsRepo ??= run(['git', '-C', holder, 'rev-parse', '--git-dir']).code === 0
      owner = holderIsRepo ? 'other' : 'none'
    }
    for (const step of steps) {
      if (step.done || stageTag(step.text) !== null) continue
      const mark = parseStepMark(step.text)
      const name = mark?.mark === 'wait' ? waitEventOf(mark.condition) : null
      if (name) lines.push({ id, number: step.number, text: step.text, name, owner })
    }
  }
  return lines
}

type Records = Record<string, Record<string, WaitFailure>>
function readRecords(file: string): Records {
  let body: unknown
  try { body = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  if (!isObject(body) || !isObject(body.boards)) throw new Error('사건 대기 알림 기록이 객체가 아니다')
  const boards: Records = {}
  for (const [key, value] of Object.entries(body.boards)) {
    if (!isObject(value) || Object.values(value).some((kind) => typeof kind !== 'string')) throw new Error(`사건 대기 알림 기록을 읽지 못했다: ${key}`)
    boards[key] = value as Record<string, WaitFailure>
  }
  return boards
}

// 이름마다 명령을 돌린 판정. 이번 틱에 돌리지 않은 이름은 없다
async function runEvents(repo: string, names: string[], events: Record<string, WaitEvent>, opts: WaitEventsOptions): Promise<Map<string, WaitVerdict>> {
  const now = (opts.now ?? Date.now)()
  const verdicts = new Map<string, WaitVerdict>()
  await Promise.all(names.map(async (name) => {
    const event = events[name]
    if (!event) {
      verdicts.set(name, { kind: 'failed', failure: 'unknown-event', reason: '설정 board.wait_events 에 이 이름이 없다' })
      return
    }
    const limit = waitEventLimitMs(event.timeoutSec, opts.deadline, now)
    if (limit === null) {
      opts.log(`WAIT-EVENT-SKIP ${name} 느린 틱의 남은 시간이 모자라 다음 틱으로 넘긴다`)
      return
    }
    const done = await runGroup(['sh', '-c', event.command], { cwd: repo, timeoutMs: limit, maxBuffer: WAIT_EVENT_MAX_OUTPUT })
    const verdict = waitVerdict(done.outcome)
    if (verdict.kind === 'failed') {
      const tail = done.stderr.trim().split('\n').at(-1)?.trim()
      if (verdict.failure === 'exit' && tail) verdict.reason = `${verdict.reason}: ${tail}`
    }
    verdicts.set(name, verdict)
  }))
  return verdicts
}

export async function checkWaitEvents(repo: string, opts: WaitEventsOptions): Promise<WaitEventsResult> {
  const result: WaitEventsResult = { done: [], failed: [] }
  const board = boardPath(repo)
  if (!existsSync(board)) return result
  const lines = waitLines(repo, board)
  const file = waitEventsFile()
  const key = boardKey(board)
  if (!lines.length && !existsSync(file)) return result
  const mine = lines.filter((line) => line.owner === 'mine')
  const events = mine.length ? waitEventsOf(loadConfig(repo)) : {}
  const verdicts = await runEvents(repo, [...new Set(mine.map((line) => line.name))], events, opts)
  mkdirSync(dirname(file), { recursive: true })
  withFileLock(file, () => {
    const boards = readRecords(file)
    const before = boards[key] ?? {}
    // 열린 사건 줄이 아닌 기록은 지운다(줄이 끝났거나 글이 바뀌었다)
    const records: Record<string, WaitFailure> = Object.fromEntries(Object.entries(before).filter(([one]) => lines.some((line) => recordKey(line) === one)))
    // 명령을 도는 동안 줄이 바뀌었을 수 있다. 끝내기 직전에 다시 읽는다
    let fresh: WaitLine[] | null = null
    const stillOpen = (line: WaitLine) => (fresh ??= waitLines(repo, board)).some((one) => one.id === line.id && one.number === line.number && one.text === line.text)
    for (const line of lines) {
      const verdict: WaitVerdict | undefined = line.owner === 'none'
        ? { kind: 'failed', failure: 'no-owner', reason: '확인할 저장소가 없다. 보드 파일이 저장소 밖에 있고 항목을 띄운 저장소도 없다' }
        : line.owner === 'mine' ? verdicts.get(line.name) : undefined
      if (!verdict) continue
      const label = `${line.id} ${line.number} ${line.name}`
      if (verdict.kind === 'pending') { delete records[recordKey(line)]; continue }
      if (verdict.kind === 'failed') {
        if (records[recordKey(line)] === verdict.failure) continue
        try {
          opts.notify('WAIT-EVENT-ERROR', `${label}: ${verdict.reason}`)
          records[recordKey(line)] = verdict.failure
          opts.log(`WAIT-EVENT-ERROR ${label}: ${verdict.reason}`)
        } catch (e) { result.failed.push(`WAIT-EVENT-ERROR ${label}: ${oneLine(e)}`) }
        continue
      }
      if (!stillOpen(line)) continue
      const step = run(scriptCommand(bin(), ['step', line.id, String(line.number), '--file', board]))
      if (step.code !== 0) { result.failed.push(`${label} 줄을 끝내지 못했다: ${step.stderr.trim() || `종료 코드 ${step.code}`}`); continue }
      delete records[recordKey(line)]
      result.done.push(label)
      opts.log(`WAIT-EVENT ${label}`)
      try { opts.notify('WAIT-EVENT', label) }
      catch (e) { result.failed.push(`WAIT-EVENT ${label} 알림을 보내지 못했다: ${oneLine(e)}`) }
    }
    const kept = Object.fromEntries(Object.entries(boards).filter(([one]) => one !== key && existsSync(one)))
    const next = Object.keys(records).length ? { ...kept, [key]: records } : kept
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ boards: next }) + '\n')
    renameSync(tmp, file)
  }, { waitMs: 15_000, staleMs: 10 * 60_000 })
  return result
}
