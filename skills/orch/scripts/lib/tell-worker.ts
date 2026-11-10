// 브랜치의 워크트리에 붙은 살아 있는 worker 에게 글 하나를 보내는 한 벌이다. 머지 큐가 worker 가 고쳐야 하는 보류를 알릴 때 쓴다.
// 상주 루프는 여러 Run 의 worker 행을 틱 안에서 한 번만 읽으므로 자기 찾기(loop/steps/shared.ts 의 ownerOf)를 쓴다.
// 보내는 명령은 SEND_TO_WORKER 환경 변수, 없으면 이 폴더의 부모 폴더의 send-to-worker.ts 다.
// send-to-worker 의 0, 1, 4 는 보낸 것으로 본다(살아 있는 dispatch 에 1 은 깨우지 못한 것이다. notify-conflicts.ts 머리 주석의 표).

import { SEND_MS } from './conflicts.ts'
import { runAsync, scriptCommand } from './proc.ts'
import { LIVE_DISPATCH, workerFor, workerRows, worktreePaths } from './workers.ts'
import { scriptPath } from './commands.ts'

export async function tellBranchWorker(repo: string, branch: string, run: string, body: string): Promise<{ sent: string } | { skipped: string }> {
  const path = worktreePaths(repo).get(branch)
  if (!path) return { skipped: '워크트리 없음' }
  const rows = workerRows(run)
  if (!rows.ok) return { skipped: `worker 목록을 읽지 못했다: ${rows.error.replaceAll('\n', ' ')}` }
  const row = workerFor(rows.rows, path)
  if (!row || !LIVE_DISPATCH.has(String(row.dispatchStatus))) return { skipped: '살아 있는 dispatch 없음' }
  const dispatch = String(row.dispatchId)
  const send = process.env.SEND_TO_WORKER || scriptPath('send-to-worker')
  const sent = await runAsync(scriptCommand(send, ['--dispatch', dispatch, '--body', body, '--no-reply', '--run', run]), { cwd: repo, timeoutMs: SEND_MS })
  if (sent.code === 0 || sent.code === 1 || sent.code === 4) return { sent: dispatch }
  return { skipped: `${dispatch} 에 보내지 못했다(send-to-worker 종료 코드 ${sent.code})` }
}
