// decision-pending 기본 핸들러. 저장소 핸들러가 없을 때 Run 에 결정을 묻도록 요청한다.
// 실패하면 lib/decisions.ts 의 재시도 규칙이 다시 보낸다.
import { readFileSync } from 'node:fs'
import { questionLocations } from '../lib/questions.ts'
import { notifyRun } from '../lib/run-notice.ts'

const input = JSON.parse(readFileSync(0, 'utf8'))
if (input.event !== 'decision-pending' || typeof input.run !== 'string' || !input.run) throw new Error('결정 알림의 Run 이 없다')
const text = [
  `Run ${input.run} 에 사용자 결정이 남아 있다. ${questionLocations(input.questions || [])}`,
  'fos-skills:orch 의 replying 절차로 미답변 결정 질문과 보드 decide 항목을 다시 조회하고, 배경과 권장안을 붙여 사용자에게 물어라.',
  '이미 물어 답을 기다리는 결정은 다시 묻지 말고, 받은 답은 원래 질문에 --reply-to 로 보낸다.',
].join('\n')
const sent = notifyRun(input.run, 'DECISION-PENDING', text)
if (!sent.ok) { console.error(`NOTICE-FAIL DECISION-PENDING ${sent.error}`); process.exitCode = 1 }
