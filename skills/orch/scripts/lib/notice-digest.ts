// 루프 알림을 바로 보낼 것과 모아 보낼 것으로 가른다. 코디네이터 채팅에 깨움이 너무 자주 끼어들어서 할 일만 바로 깨운다(사용자 결정 2026-11-10).
//
// 바로 보내는 kind(코디네이터가 무언가 해야 한다): CI-FAILED, QUEUE-CONFLICT, CONFLICT-*, WORKER-LOST, UNANSWERED, WORKER-STALLED, WORKER-IDLE,
//   DONE-SUSPECT, LOOP-DEAD 류, LOOP-UPDATED, LOOP-UPDATE-FAIL, DECISION-PENDING, HEAVY-SLOT-HELD, FINISH-MISSING. 이 파일에 없는 kind 도 바로 보낸다. 새 kind 를 놓치지 않으려는 것이다.
// 모아 보내는 kind(DIGEST_KINDS): WATCH-ERROR, LEGACY-NOTICE, STAGE-STALLED, LOOP-RESTARTED. 안내이거나 다음 틱에 풀리는 일이다.
//   loop.log 에는 그 틱에 남고(호출자가 쓴다), Run 메시지는 state/notice-digest/<runKey>.json 에 쌓았다가 주기(pipeline.digest_sec, 기본 1800초)마다 DIGEST 하나로 보낸다.
//   모을 것이 없으면 보내지 않는다. 마지막으로 보낸 시각(sent_at)은 처음 쌓은 시각으로 시작한다.
//   같은 WATCH-ERROR 가 연속 세 번째 틱에(streaks) 그 틱에 바로 한 번 보낸다.
// 파일: { sent_at: ISO, items: [{ kind, text, at }], streaks: { <키>: { reason, count, sent } } }. 보낸 뒤에만 items 를 비운다.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeParent, pathOf } from './paths.ts'
import { runKey } from './loop.ts'
import { notifyRun } from './run-notice.ts'

export const DEFAULT_DIGEST_SEC = 1800
export const DIGEST_KINDS: ReadonlySet<string> = new Set(['WATCH-ERROR', 'LEGACY-NOTICE', 'STAGE-STALLED', 'LOOP-RESTARTED'])
export const STREAK_LIMIT = 3

type Item = { kind: string; text: string; at: string }
type Streak = { reason: string; count: number; sent: boolean }
type Digest = { sent_at: string; items: Item[]; streaks: Record<string, Streak> }

const fileOf = (repo: string, run: string) => join(pathOf('state', repo), 'notice-digest', `${runKey(run)}.json`)

function load(repo: string, run: string): Digest | null {
  const file = fileOf(repo, run)
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data && typeof data === 'object' && Array.isArray(data.items)) return { sent_at: String(data.sent_at ?? ''), items: data.items, streaks: data.streaks && typeof data.streaks === 'object' ? data.streaks : {} }
  } catch { /* 깨진 파일은 새로 쓴다 */ }
  return null
}

function save(repo: string, run: string, data: Digest): void {
  const file = fileOf(repo, run)
  makeParent(file, repo)
  writeFileSync(`${file}.tmp`, JSON.stringify(data))
  renameSync(`${file}.tmp`, file)
}

// 모아 보낼 kind 의 알림을 쌓는다
export function queueDigest(repo: string, run: string, kind: string, text: string, now = Date.now()): void {
  const data = load(repo, run) ?? { sent_at: new Date(now).toISOString(), items: [], streaks: {} }
  if (!data.sent_at) data.sent_at = new Date(now).toISOString()
  data.items.push({ kind, text: text.replace(/\s+/g, ' ').trim(), at: new Date(now).toISOString() })
  save(repo, run, data)
}

// 오류가 이어진 틱 수를 센다. 연속 세 번째 틱에 true 를 낸다(markStreakSent 로 보낸 것을 확정하면 오류가 풀릴 때까지 다시 내지 않는다). reason 이 null 이면 풀린 것이다
export function watchStreak(repo: string, key: string, reason: string | null): boolean {
  const data = load(repo, '__streaks__') ?? { sent_at: '', items: [], streaks: {} }
  const current = data.streaks[key]
  if (reason === null) {
    if (!current) return false
    delete data.streaks[key]; save(repo, '__streaks__', data); return false
  }
  const next: Streak = current && current.reason === reason ? { ...current, count: current.count + 1 } : { reason, count: 1, sent: false }
  data.streaks[key] = next
  save(repo, '__streaks__', data)
  // 보낸 것으로 확정하는 것은 markStreakSent 다. 전송이 실패하면 다음 틱도 true 를 낸다
  return next.count >= STREAK_LIMIT && !next.sent
}

// 연속 오류의 바로 보내기가 성공한 뒤 불러 같은 오류가 풀릴 때까지 다시 보내지 않게 한다
export function markStreakSent(repo: string, key: string): void {
  const data = load(repo, '__streaks__')
  if (!data?.streaks[key]) return
  data.streaks[key].sent = true
  save(repo, '__streaks__', data)
}

// 주기가 지났고 쌓인 것이 있으면 DIGEST 하나로 보낸다. 보내지 못하면 남겨 다음 틱이 다시 보낸다. 보냈으면 true
export function flushDigest(repo: string, run: string, intervalSec: number, now = Date.now()): boolean {
  const data = load(repo, run)
  if (!data || data.items.length === 0) return false
  if (now - Date.parse(data.sent_at) < intervalSec * 1000) return false
  const lines = data.items.map((item) => `- ${item.at.slice(11, 16)} ${item.kind} ${item.text}`)
  const sent = notifyRun(run, 'DIGEST', `${data.items.length}건\n${lines.join('\n')}`)
  if (!sent.ok) { console.log(`NOTICE-FAIL DIGEST ${sent.error}`); return false }
  data.items = []
  data.sent_at = new Date(now).toISOString()
  save(repo, run, data)
  return true
}
