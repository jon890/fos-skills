// 보드에서 쓰는 worker 목록. mod 에서도 가져올 수 있게 JS 로 두고 명령 실행은 호출자가 맡는다.

const LIVE_DISPATCH = new Set(['pending', 'dispatched', 'running'])

// 끝난 dispatch. 새 모양은 outcome 이 succeeded·failed 이거나 state 가 abandoned 다
const ENDED_OUTCOME = new Set(['succeeded', 'failed'])

// 일하는 dispatch 인가. 옛 모양은 dispatchStatus, structured 모드의 새 모양은 outcome 과 state 로 본다.
function isLiveWorker(w) {
  if (!w || typeof w !== 'object') return false
  if (w.dispatchStatus !== undefined) return LIVE_DISPATCH.has(w.dispatchStatus)
  if (w.outcome === undefined && w.state === undefined) return false
  return !ENDED_OUTCOME.has(w.outcome) && w.state !== 'abandoned'
}

function boardWorkers(workers) {
  return workers
    .filter(isLiveWorker)
    .map((w) => {
      const tree = (w.resource && w.resource.worktreeId) || w.workspace || ''
      const path = tree.includes('::') ? tree.split('::').pop() : tree
      return {
        id: w.dispatchId,
        terminal: w.agentTerminalHandle || w.terminal || '',
        state: w.workerState || (w.dispatchStatus === undefined ? w.state : '') || '',
        worktree: path.split('/').filter(Boolean).pop() || '',
      }
    })
}

// worker-list 는 페이지를 나눌 수 있다. 한 페이지만 읽어 살아 있는 dispatch 를 빠뜨리면 닫힌 질문이 보드에 남는다.
export async function readBoardWorkers(runId, run) {
  const workers = []
  const cursors = new Set()
  let cursor = ''
  for (;;) {
    const args = ['orca', 'orchestration', 'worker-list', '--run', runId, '--full', '--json']
    if (cursor) args.splice(-1, 0, '--cursor', cursor)
    const data = JSON.parse(await run(args))
    if (data?.ok === false) throw new Error('worker 목록 조회 실패')
    const result = data?.result || data
    const rows = result.workers || result.dispatches
    if (!Array.isArray(rows)) throw new Error('worker 목록을 읽지 못했어요')
    workers.push(...rows)
    cursor = result.page?.nextCursor || ''
    if (!cursor) break
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('worker 목록의 다음 페이지가 앞 페이지와 같아요')
    cursors.add(cursor)
  }
  return boardWorkers(workers)
}
