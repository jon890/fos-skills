// 머지 전에 worker_done 을 보낸 worker 와, PR 을 열기 전이나 머지 전에 보고 없이 턴을 끝낸 worker 를 같은 워크트리에서 이어 맡긴다. 상주 루프는 같은 일을 스스로 하고(loop/completion-watch.ts),
// 이 명령은 루프가 못 했거나 코디네이터가 직접 할 때 쓴다. 판정과 전송은 lib/continue-worker.ts 가 소유한다.
//
// 사용법: continue-worker.ts --dispatch ID [--run ID] [--repo DIR]   (진입점: orch worker continue --dispatch <id>)
//
//     --dispatch  worker_done 으로 끝났거나 보고 없이 턴을 끝낸(「Worker stopped without reporting」) dispatch
//     --run       후속 Task 를 붙일 Run. 없으면 띄우기 기록의 Run 이다
//
// 하는 일: 열린 PR 이 있고 dispatch 가 끝났으면 send-to-worker --spec --note 로 「PR 이 아직 열려 있다. 머지될 때까지 맡는다」 를 보낸다.
// Orca 가 끝난 dispatch 에 후속 Task(delivery: follow_up, reopened)를 열어 같은 워크트리에서 worker 가 다시 일한다. 새 dispatch 가 생긴다.
// PR 이 아직 없거나, dispatch 가 살아 있어도 Orca 가 턴이 끝났다고 보면 「남은 할 일을 이 턴에서 이어 한다」 를 보낸다.
// 살아 있는 dispatch 에는 본문만 보내고(--no-reply --body), 끝난 dispatch 에는 후속 Task 를 연다. 같은 브랜치와 단계에 STOP_LIMIT 번까지다.
// 판정은 lib/continue-worker.ts 머리 주석의 「멈춘 worker 이어 보내기」 가 소유한다.
//
// 출력 줄:
//     CONTINUED <앞 dispatch> <새 dispatch> <새 Task> pr=#<번호>   이어 맡겼다. 종료 코드 0
//         멈춘 worker 에게 보냈으면 PR 이 없을 때 pr=- 이고, 끝에 tries=<보낸 횟수>/<상한> 이 붙는다. 살아 있는 dispatch 면 새 dispatch 는 앞 dispatch, 새 Task 는 - 다
//     CONTINUE-SKIP <dispatch> <이유>                              이어 맡길 대상이 아니다(머지됐다, 리뷰 worker 다, 작업 중이다, 상한에 닿았다). 종료 코드 3
//     CONTINUE-FAIL <dispatch> <이유>                              조회나 전송이 실패했다. 종료 코드 1. 같은 명령을 다시 부른다
// 사용법 오류는 2 다.

import { dispatchRepo, guardWrite, MAIN_GUARD_OPTIONS } from '../lib/main-guard.ts'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { continueWorker, STOP_LIMIT } from '../lib/continue-worker.ts'
import { mainCheckout } from '../lib/git.ts'
import { readLaunch } from '../lib/launched.ts'
import { oneLine } from '../lib/output.ts'

const USAGE = '사용법: continue-worker.ts --dispatch ID [--run ID] [--repo DIR]'

export async function main(argv: string[]): Promise<number> {
  const options = { ...MAIN_GUARD_OPTIONS, dispatch: { type: 'string' }, run: { type: 'string' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const
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
  const fallbackRepo = mainCheckout(values.repo ?? process.cwd())
  const repo = dispatchRepo(fallbackRepo, values.dispatch)
  if (!repo) {
    if (!readLaunch(fallbackRepo, values.dispatch)) {
      process.stdout.write(`CONTINUE-SKIP ${values.dispatch} 이 dispatch 가 없다\n`); return 3
    }
    process.stderr.write('MAIN-TARGET-UNKNOWN 실제 worker 저장소를 확인하지 못했다\n'); return 1
  }
  const mainGuard = guardWrite(repo, 'worker continue', values['not-main'], { dispatch: values.dispatch })
  if (mainGuard.code !== 0) return mainGuard.code
  const result = await continueWorker(repo, values.dispatch, { run: values.run ?? null, notMain: values['not-main'], stopped: true })
  if (result.kind === 'ok') {
    const pr = result.target.pr ? `#${result.target.pr.number}` : '-'
    const tries = result.tries === undefined ? '' : ` tries=${result.tries}/${STOP_LIMIT}`
    process.stdout.write(`CONTINUED ${values.dispatch} ${result.dispatch} ${result.task || '-'} pr=${pr}${tries}\n`)
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
