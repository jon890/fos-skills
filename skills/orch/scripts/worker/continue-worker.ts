// 머지 전에 worker_done 을 보낸 worker 를 같은 워크트리에서 이어 맡긴다. 상주 루프는 같은 일을 스스로 하고(loop/completion-watch.ts),
// 이 명령은 루프가 못 했거나 코디네이터가 직접 할 때 쓴다. 판정과 전송은 lib/continue-worker.ts 가 소유한다.
//
// 사용법: continue-worker.ts --dispatch ID [--run ID] [--repo DIR]   (진입점: orch worker continue --dispatch <id>)
//
//     --dispatch  worker_done 으로 끝난 dispatch. 그 지시서의 브랜치에 열린 PR 이 있어야 한다
//     --run       후속 Task 를 붙일 Run. 없으면 띄우기 기록의 Run 이다
//
// 하는 일: 열린 PR 이 있는지 보고, 있으면 send-to-worker --spec --note 로 「PR 이 아직 열려 있다. 머지될 때까지 맡는다」 를 보낸다.
// Orca 가 끝난 dispatch 에 후속 Task(delivery: follow_up, reopened)를 열어 같은 워크트리에서 worker 가 다시 일한다. 새 dispatch 가 생긴다.
//
// 출력 줄:
//     CONTINUED <앞 dispatch> <새 dispatch> <새 Task> pr=#<번호>   이어 맡겼다. 종료 코드 0
//     CONTINUE-SKIP <dispatch> <이유>                              이어 맡길 대상이 아니다(PR 이 없거나 머지됐다, 리뷰 worker 다, 아직 살아 있다). 종료 코드 3
//     CONTINUE-FAIL <dispatch> <이유>                              조회나 전송이 실패했다. 종료 코드 1. 같은 명령을 다시 부른다
// 사용법 오류는 2 다.

import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { continueWorker } from '../lib/continue-worker.ts'
import { mainCheckout } from '../lib/git.ts'
import { oneLine } from '../lib/output.ts'

const USAGE = '사용법: continue-worker.ts --dispatch ID [--run ID] [--repo DIR]'

export async function main(argv: string[]): Promise<number> {
  const options = { dispatch: { type: 'string' }, run: { type: 'string' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv, options), options }).values
  } catch (e) {
    process.stderr.write(`${USAGE}\ncontinue-worker: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.dispatch) {
    process.stderr.write(`${USAGE}\ncontinue-worker: --dispatch 가 필요하다\n`)
    return 2
  }
  const repo = mainCheckout(values.repo ?? process.cwd())
  const result = await continueWorker(repo, values.dispatch, { run: values.run ?? null })
  if (result.kind === 'ok') {
    process.stdout.write(`CONTINUED ${values.dispatch} ${result.dispatch} ${result.task || '-'} pr=#${result.target.pr.number}\n`)
    return 0
  }
  if (result.kind === 'skip') {
    process.stdout.write(`CONTINUE-SKIP ${values.dispatch} ${oneLine(result.reason)}\n`)
    return 3
  }
  process.stdout.write(`CONTINUE-FAIL ${values.dispatch} ${oneLine(result.reason)}\n`)
  return 1
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (e: unknown) => {
    process.stderr.write(`continue-worker: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  },
)
