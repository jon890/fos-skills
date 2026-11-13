// 업무 주소 채우기(틱 3-1). 저장된 번호로 업무 주소를 만든다.
import { fillTaskUrls } from '../../lib/task-links.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine } from './shared.ts'
export async function fillTaskLinks(ctx: StepContext, _state: StepState): Promise<StepResult> {
  const { report, errors } = reporter(ctx)
  try {
    await fillTaskUrls(ctx.repo, { log })
    // 새 오류 칸을 매 틱 더하지 않고, 앞 틱의 실패만 해제한다. 설정 없는 저장소의 틱 출력은 그대로다.
    if (Object.keys(ctx.previous).some(key => key === 'task-links' || key.startsWith('task-links@'))) report('task-links', null)
  }
  catch (e) { report('task-links', oneLine(e)) }
  return { errors }
}
