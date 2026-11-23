import { notifyRun } from './notice-transport.ts'
import { DIGEST_KINDS, queueDigest } from './notice-digest.ts'

export { NOTICE_PEER_SEC, notifyRun, setNoticeOwner } from './notice-transport.ts'
export type { NoticeResult } from './notice-transport.ts'

// Run 없는 옛 루프는 로그에만 남긴다. 실패를 던져 호출자가 알림 기록을 진행하지 않게 한다.
// repo 가 있고 kind 가 모아 보낼 것(lib/notice-digest.ts 의 DIGEST_KINDS)이면 바로 보내지 않고 쌓는다. now 가 true 면 모아 보낼 kind 도 바로 보낸다.
export function sendNotice(kind: string, pr: number | null, text: string, run: string | null, repo: string | null = null, now = false, options: { subject?: string } = {}): void {
  if (!run) { console.log(`${kind} ${text}`); return }
  if (repo && !now && DIGEST_KINDS.has(kind)) { queueDigest(repo, run, kind, text); return }
  const sent = notifyRun(run, kind, text, pr, { ...options, ...(kind === 'STEP-READY' && repo ? { repo } : {}) })
  if (!sent.ok) {
    console.error(`NOTICE-FAIL ${kind} ${sent.error}`)
    throw new Error(sent.error)
  }
}
