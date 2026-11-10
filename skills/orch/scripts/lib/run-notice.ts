// 루프와 기본 핸들러의 알림을 Run 메일함에 보낸다. 호출자가 성공한 전송만 중복 억제 기록에 남긴다.
// Run 발신이 consumer_fenced 로 거절될 때만 발신자 없이 한 번 재시도한다. 터미널 환경은 그대로 물려준다.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { orcaJson } from './orca.ts'
import { machineDir } from './machine.ts'
import { DIGEST_KINDS, queueDigest } from './notice-digest.ts'

// 한 Run 에 저장소마다 상주 루프가 등록되면 루프마다 같은 Run 알림을 보낸다(2026-11-10 DECISION-PENDING, WATCH-ERROR 가 두 번씩 왔다).
// 루프는 자기 저장소(owner)를 setNoticeOwner 로 알린다. 보내기 전에 머신 폴더(lib/machine.ts)의 run-notices/<Run>/<해시> 를 본다.
//   해시는 Run, kind, 본문이다. 다른 저장소가 NOTICE_PEER_SEC(600초) 안에 쓴 기록이 있으면 그 루프가 보냈으니 보내지 않는다.
//   같은 저장소의 기록이거나 오래된 기록이면 보낸다. 같은 저장소의 되풀이 억제는 호출한 쪽의 기록이 맡는다. 보내지 못하면 기록을 지운다.
export const NOTICE_PEER_SEC = 600
let noticeOwner: string | null = null
export function setNoticeOwner(owner: string | null): void { noticeOwner = owner }
function claim(run: string, kind: string, text: string, owner: string): { peer: boolean; file: string } {
  const hash = createHash('sha1').update(`${run}\0${kind}\0${text}`).digest('hex')
  const file = join(machineDir(), 'run-notices', run.replace(/[^A-Za-z0-9_.-]/g, '_'), hash)
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < NOTICE_PEER_SEC * 1000 && readFileSync(file, 'utf8') !== owner) return { peer: true, file }
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, owner)
  } catch { /* 기록을 못 쓰면 중복 억제 없이 보낸다. 알림을 잃는 쪽이 더 나쁘다 */ }
  return { peer: false, file }
}

type Json = Record<string, unknown>
export type NoticeResult = { ok: true; id: string } | { ok: false; error: string }
export function notifyRun(run: string, kind: string, text: string, pr: number | null = null): NoticeResult {
  const mine = noticeOwner ? claim(run, kind, text, noticeOwner) : null
  if (mine?.peer) return { ok: true, id: 'peer' }
  const args = ['orchestration', 'send', '--to', `run:${run}`, '--type', 'status',
    '--subject', `${kind} ${text.replace(/\s+/g, ' ').slice(0, 80)}`, '--body', text,
    '--payload', JSON.stringify({ source: 'orch-loop', kind, pr })]
  let sent = orcaJson<Json>([...args, '--from', `run:${run}`])
  if (!sent.ok && sent.error.includes('consumer_fenced')) sent = orcaJson<Json>(args)
  if (!sent.ok) { if (mine) rmSync(mine.file, { force: true }); return sent }
  const data = sent.data
  const message = data?.message as Json | undefined
  const id = message?.id ?? data?.messageId ?? data?.id
  return typeof id === 'string' && id ? { ok: true, id } : { ok: false, error: 'send 영수증에 메시지 id 가 없다' }
}

// Run 없는 옛 루프는 로그에만 남긴다. 실패를 던져 호출자가 알림 기록을 진행하지 않게 한다.
// repo 가 있고 kind 가 모아 보낼 것(lib/notice-digest.ts 의 DIGEST_KINDS)이면 바로 보내지 않고 쌓는다. now 가 true 면 모아 보낼 kind 도 바로 보낸다.
export function sendNotice(kind: string, pr: number | null, text: string, run: string | null, repo: string | null = null, now = false): void {
  if (!run) { console.log(`${kind} ${text}`); return }
  if (repo && !now && DIGEST_KINDS.has(kind)) { queueDigest(repo, run, kind, text); return }
  const sent = notifyRun(run, kind, text, pr)
  if (!sent.ok) {
    console.error(`NOTICE-FAIL ${kind} ${sent.error}`)
    throw new Error(sent.error)
  }
}
