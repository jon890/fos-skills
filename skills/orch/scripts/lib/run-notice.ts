// 루프와 기본 핸들러의 알림을 Run 메일함에 보낸다. 호출자가 성공한 전송만 중복 억제 기록에 남긴다.
// Run 발신이 consumer_fenced 로 거절될 때만 발신자 없이 한 번 재시도한다. 터미널 환경은 그대로 물려준다.
import { orcaJson } from './orca.ts'

type Json = Record<string, unknown>
export type NoticeResult = { ok: true; id: string } | { ok: false; error: string }
export function notifyRun(run: string, kind: string, text: string, pr: number | null = null): NoticeResult {
  const args = ['orchestration', 'send', '--to', `run:${run}`, '--type', 'status',
    '--subject', `${kind} ${text.replace(/\s+/g, ' ').slice(0, 80)}`, '--body', text,
    '--payload', JSON.stringify({ source: 'orch-loop', kind, pr })]
  let sent = orcaJson<Json>([...args, '--from', `run:${run}`])
  if (!sent.ok && sent.error.includes('consumer_fenced')) sent = orcaJson<Json>(args)
  if (!sent.ok) return sent
  const data = sent.data
  const message = data?.message as Json | undefined
  const id = message?.id ?? data?.messageId ?? data?.id
  return typeof id === 'string' && id ? { ok: true, id } : { ok: false, error: 'send 영수증에 메시지 id 가 없다' }
}

// Run 없는 옛 루프는 로그에만 남긴다. 실패를 던져 호출자가 알림 기록을 진행하지 않게 한다.
export function sendNotice(kind: string, pr: number | null, text: string, run: string | null): void {
  if (!run) { console.log(`${kind} ${text}`); return }
  const sent = notifyRun(run, kind, text, pr)
  if (!sent.ok) {
    console.error(`NOTICE-FAIL ${kind} ${sent.error}`)
    throw new Error(sent.error)
  }
}
