// decision-pending 기본 핸들러. 저장소 핸들러가 없을 때 Run 에 결정을 묻도록 요청한다.
// 실패하면 lib/decisions.ts 의 재시도 규칙이 다시 보낸다.
import { readFileSync } from 'node:fs'
import { questionLocations } from '../lib/questions.ts'
import { notifyRun, setNoticeOwner } from '../lib/run-notice.ts'

const input = JSON.parse(readFileSync(0, 'utf8'))
if (input.event !== 'decision-pending' || typeof input.run !== 'string' || !input.run) throw new Error('결정 알림의 Run 이 없다')
// 이 핸들러는 루프와 다른 프로세스라 루프의 setNoticeOwner 가 닿지 않는다. owner 가 없으면 다른 저장소 루프의 같은 알림을 거르지 못한다
if (typeof input.repo === 'string' && input.repo) setNoticeOwner(input.repo)
// 보드 결정은 저장소마다 다르다. 본문에 저장소와 항목을 넣어 다른 저장소의 알림으로 오해받아 버려지지 않게 한다. worker 질문은 저장소가 달라도 같은 질문이면 한 번만 간다
const items: { id?: unknown; text?: unknown }[] = Array.isArray(input.items) ? input.items : []
const board = items.length ? [`보드 결정(${input.repo}): ${items.map((item) => `${String(item.id)} ${String(item.text ?? '')}`.trim()).join(' / ')}`] : []
const text = [
  `Run ${input.run} 에 사용자 결정이 남아 있다. ${questionLocations(input.questions || [])}`,
  ...board,
  'fos-skills:orch 의 replying 절차로 미답변 결정 질문과 보드 decide 항목을 다시 조회하고, 배경과 권장안을 붙여 사용자에게 물어라.',
  '이미 물어 답을 기다리는 결정은 다시 묻지 말고, 받은 답은 원래 질문에 --reply-to 로 보낸다.',
].join('\n')
const sent = notifyRun(input.run, 'DECISION-PENDING', text)
if (!sent.ok) { console.error(`NOTICE-FAIL DECISION-PENDING ${sent.error}`); process.exitCode = 1 }
