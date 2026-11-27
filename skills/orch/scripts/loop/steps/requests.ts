// 답 없는 요청 알림(스펙 REQ9, ADR-035): 이 저장소가 받은 요청 가운데 sent 인 채로 pipeline.request_ack_sec(기본 1800초)가 지났고
//     아직 알리지 않은 것(core/main-coordinator.ts 의 ackOverdue)을 찾아, 답 대상(lib/requests.ts 의 replyRunOf)에 REQUEST-NO-ACK 를 한 번 보낸다.
//     보낸 세션에 루프가 없어도 받은 저장소의 루프가 재므로 간다. 보내기가 성공한 뒤에만 기록의 ack_notice_at 을 쓴다. 실패하면 다음 틱이 다시 한다.
//     다시 보낼지는 보낸 메인이 정한다(스펙 DECISION10). 저장소 공유 일이라 틱마다 한 번 돈다. 요청 기록이 없으면 Orca 를 부르지 않는다.
// 자동 완료 다시 보내기: finish-pr 이 보내지 못해 pending_done 을 남긴 요청은 같은 단계가 lib/requests.ts 의 answerRequest 로 done 을 다시 보낸다.

import { ackOverdue, isClosed } from '../../core/main-coordinator.ts'
import { answerRequest, listRequests, replyRunOf, repoName, requestLabel, requestNotice, markAckNoticed } from '../../lib/requests.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { log, oneLine } from './shared.ts'

export async function notifyUnacked(ctx: StepContext, _state: StepState): Promise<StepResult> {
  const errors: Record<string, string | null> = {}
  try {
    const now = Date.now()
    for (const record of listRequests(ctx.repo)) {
      if (record.pending_done && !isClosed(record.state)) {
        const done = answerRequest(ctx.repo, record.number, 'done', record.pending_done.reason, ctx.primary, new Date(now).toISOString())
        log(done.ok ? `REQUEST-DONE ${record.id} to=${done.target}` : `REQUEST-DONE-FAIL ${record.id} ${done.line}`)
        continue
      }
      if (!ackOverdue(record.state, record.created_at, record.ack_notice_at, now, ctx.requestAckSec)) continue
      const target = replyRunOf(record)
      const minutes = Math.floor((now - Date.parse(record.created_at)) / 60_000)
      const text = `${repoName(record.repo)} 에 보낸 ${requestLabel(record)}(「${record.title}」)이 ${minutes}분째 받음·보류·거절 답이 없다. 받은 당시 메인 Run: ${record.to_run}. 다시 보낼지 정한다`
      const sent = requestNotice(target, 'REQUEST-NO-ACK', record, text)
      if (!sent.ok) {
        log(`NOTICE-FAIL REQUEST-NO-ACK ${record.id} ${oneLine(sent.error)}`)
        continue
      }
      markAckNoticed(ctx.repo, record.number, new Date(now).toISOString())
      log(`REQUEST-NO-ACK ${record.id} to=${target}`)
    }
    // 앞 틱에 오류를 남겼을 때만 지운다. 오류가 없던 저장소의 결과 줄은 그대로다
    if (typeof ctx.previous?.requests === 'string') errors.requests = null
  } catch (e) {
    log(`orch-loop: 요청 기록을 읽지 못했다: ${oneLine(e)}`)
    errors.requests = oneLine(e)
  }
  return { errors }
}
