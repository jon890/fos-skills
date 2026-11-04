// 머지 큐의 차례 기록 한 벌이다. 머지 큐(merge_queue.ts)가 쓰고 상주 루프(orch-loop.ts)가 읽는다.
//
// 파일: <orch 루트>/state/queue-turn/<pid>.json. 머지 큐 프로세스 하나에 파일 하나다. 누가 큐를 걸었는지(루프의 자동 머지,
//   코디네이터의 merge-with-finish)와 상관없이 같은 자리에 쓴다. 루프가 코디네이터가 건 큐도 같은 방법으로 읽게 하려는 것이다.
//   값: { pid, prs, pr, phase, since, held }
//     pid    머지 큐 프로세스
//     prs    아직 끝나지 않은 PR 번호. 큐의 순서이고 차례 PR 이 맨 앞이다. 머지했거나 뺀 PR 은 들지 않는다
//     pr     차례 PR. 큐가 PR 을 보기 전과 마지막 PR 뒤에는 null 이다
//     phase  차례 PR 의 단계 이름(TURN_PHASES)
//     since  그 단계를 시작한 시각(ISO 8601 UTC)
//     held   이번 실행에서 큐에서 뺀 PR 과 이유([{pr, reason}]). 이유는 STOP, CONFLICT, SKIP 줄의 본문이다. 옛 기록에 없으면 빈 목록이다
//   쓰기는 옆 파일에 쓰고 rename 한다. 읽는 쪽이 반쯤 쓴 파일을 읽지 않게 하려는 것이다.
//   큐는 끝나도 지우지 않는다. 끝난 뒤 들어온 틱이 held 를 루프 로그에 옮긴 뒤 지운다(orch-loop.ts 머리 주석의 「큐 기록」).
//   읽는 쪽은 pid 가 지금 머지 큐 프로세스인지로 도는 큐와 끝난 큐를 구분한다(readTurns 의 isQueue, finishedTurns).
//
// 쓰기 실패는 큐를 멈추지 않는다. 기록은 루프의 로그와 최신화 판정을 돕는 것이라, 쓰지 못해도 머지 결과는 같다.
// 부르는 쪽(merge_queue.ts)이 첫 실패만 stderr 에 한 줄 남긴다.

import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeParent, pathOf } from './paths.ts'

// 단계 이름. 루프 로그의 AUTO-MERGE-HELD 줄에 그대로 나온다
export const TURN_PHASES = {
  start: '차례 시작',
  checks: '체크 대기',
  updated: 'update-branch 뒤 체크 대기',
  verify: '합친 사본 검사',
  before: '머지 전 명령',
  merge: '머지',
  after: '머지 뒤 정리',
  overtake: '앞지르기 확인',
  end: '끝',
} as const

export type Held = { pr: number; reason: string }
export type QueueTurn = { pid: number; prs: number[]; pr: number | null; phase: string; since: string; held: Held[] }

export function turnDir(repo: string): string {
  return join(pathOf('state', repo), 'queue-turn')
}

export function turnFile(repo: string, pid: number): string {
  return join(turnDir(repo), `${pid}.json`)
}

// 폴더를 만들고 git 이 무시하게 한 뒤 쓴다. 쓴 파일 경로를 낸다. 같은 큐가 다시 쓸 때는 writeTurnAt 으로 git 호출 없이 쓴다
export function writeTurn(repo: string, turn: QueueTurn): string {
  const file = turnFile(repo, turn.pid)
  makeParent(file, repo)
  writeTurnAt(file, turn)
  return file
}

export function writeTurnAt(file: string, turn: QueueTurn): void {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(turn)}\n`, 'utf8')
  renameSync(temporary, file)
}

export function clearTurn(repo: string, pid: number): void {
  rmSync(turnFile(repo, pid), { force: true })
}

function parseTurn(text: string): QueueTurn | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (!Number.isInteger(row.pid) || !Array.isArray(row.prs) || !row.prs.every((n) => Number.isInteger(n))) return null
  if (!(row.pr === null || Number.isInteger(row.pr)) || typeof row.phase !== 'string' || typeof row.since !== 'string') return null
  const held = Array.isArray(row.held)
    ? row.held.filter((h): h is Held => typeof h === 'object' && h !== null && Number.isInteger((h as Held).pr) && typeof (h as Held).reason === 'string')
    : []
  return { pid: row.pid as number, prs: row.prs as number[], pr: row.pr as number | null, phase: row.phase, since: row.since, held }
}

// 살아 있는 머지 큐의 차례 기록. isQueue 는 그 pid 가 지금 머지 큐 프로세스인지 판정한다(루프는 ps 의 명령줄로 본다).
// 폴더가 없거나 읽지 못하는 파일, 형식이 틀린 파일, 머지 큐가 아닌 pid 의 파일은 넘어간다. 지우지 않는다
export function readTurns(repo: string, isQueue: (pid: number) => boolean): QueueTurn[] {
  return allTurns(repo).filter((turn) => isQueue(turn.pid))
}

// 끝난 머지 큐의 차례 기록(pid 가 머지 큐가 아니다). 형식이 틀린 파일은 file 만 있고 turn 이 null 이다. 지우는 것은 부르는 쪽이다
export function finishedTurns(repo: string, isQueue: (pid: number) => boolean): { file: string; turn: QueueTurn | null }[] {
  let names: string[]
  try {
    names = readdirSync(turnDir(repo))
  } catch {
    return []
  }
  const found: { file: string; turn: QueueTurn | null }[] = []
  for (const name of names.filter((n) => /^\d+\.json$/.test(n)).sort()) {
    if (isQueue(Number(name.slice(0, -'.json'.length)))) continue
    const file = join(turnDir(repo), name)
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const turn = parseTurn(text)
    found.push({ file, turn: turn && `${turn.pid}.json` === name ? turn : null })
  }
  return found
}

function allTurns(repo: string): QueueTurn[] {
  let names: string[]
  try {
    names = readdirSync(turnDir(repo))
  } catch {
    return []
  }
  const turns: QueueTurn[] = []
  for (const name of names.filter((n) => /^\d+\.json$/.test(n)).sort()) {
    let text: string
    try {
      text = readFileSync(join(turnDir(repo), name), 'utf8')
    } catch {
      continue
    }
    const turn = parseTurn(text)
    if (turn && `${turn.pid}.json` === name) turns.push(turn)
  }
  return turns
}

// 루프 로그의 한 줄 본문: `pid <pid> #<차례> <단계> <분>분 남은 #a #b`. 차례가 없으면 `차례 없음` 이다
export function turnLine(turn: QueueTurn, nowMs: number): string {
  const since = Date.parse(turn.since)
  const minutes = Number.isFinite(since) ? `${Math.max(0, Math.floor((nowMs - since) / 60_000))}분` : '?분'
  const head = turn.pr === null ? '차례 없음' : `#${turn.pr}`
  const left = turn.prs.length > 0 ? turn.prs.map((n) => `#${n}`).join(' ') : '없음'
  return `pid ${turn.pid} ${head} ${turn.phase} ${minutes} 남은 ${left}`
}
