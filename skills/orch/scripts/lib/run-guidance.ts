// Run 이 없는 세션에 알리는 다음 명령. 진입점의 「--run 이 필요하다」(lib/context.ts), request send 의 같은 오류(request/orch-request.ts),
// Run 없이 뜬 루프의 LOOP-NO-RUN(loop/lifecycle.ts)이 함께 쓴다. 순서는 references/requests.md 의 「Run 없는 세션」 이다.
// Run 은 스스로 만들지 않는다. 묻지 않고 만들면 사용자가 의도하지 않은 Run 이 생긴다.
//
//     createSteps   Run 을 만들고 이 저장소 루프에 묶는 명령 한 줄. retry 를 주면 그 명령을 --run 으로 다시 부르는 끝을 붙인다
//     missingRun    --run 이 빠졌을 때의 안내 줄들. 이 저장소 루프에 등록된 Run 이 있으면 그 Run 으로 다시 부르는 줄을 앞에 둔다

import { orchWord } from './commands.ts'
import { registeredRuns } from './loop.ts'
import { shQuote } from './py.ts'

const NEW_RUN = '<만든 Run>'

export function createSteps(repo: string | null, retry?: string): string {
  const at = repo ? ` --repo ${shQuote(repo)}` : ''
  const again = retry ? ` 뒤 ${retry} --run ${NEW_RUN}` : ''
  return `orca orchestration run-create --objective "<목표 한 문장>" 로 Run 을 만들고 ${orchWord()} loop start --run ${NEW_RUN}${at}${again}`
}

export function missingRun(repo: string | null, retry: string): string[] {
  const known = repo ? registeredRuns(repo).map((entry) => entry.run) : []
  const lines: string[] = []
  if (known.length > 0) lines.push(`이 저장소 루프에 등록된 Run(${known.join(', ')}) 가운데 이 세션의 Run 이 있으면 그 Run 으로 다시 부른다: ${retry} --run ${known[0]}`)
  lines.push(`답을 받을 Run 이 없으면 만들고 루프에 묶는다: ${createSteps(repo, retry)}`)
  return lines
}
