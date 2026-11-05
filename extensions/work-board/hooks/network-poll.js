// 주기 판정은 세션 시계만 쓴다. 렌더링과 모델의 도구 실행은 사용자 입력으로 세지 않는다.
export const PR_MS = 5 * 60 * 1000
export const IDLE_MS = 10 * 60 * 1000

export function createNetworkPoll() {
  let inputAt = null
  const attempts = new Map()
  const busy = new Set()
  return {
    input(at) { inputAt = at },
    async poll(at, visible, tasks, force = false, clock = async () => at) {
      if (!force && (!visible || inputAt === null || at - inputAt >= IDLE_MS)) return
      await Promise.all(tasks.map(async ({ key, every, read }) => {
        if (busy.has(key) || (!force && attempts.has(key) && at - attempts.get(key) < every)) return
        attempts.set(key, at)
        busy.add(key)
        try { await read() } finally {
          // 캐시는 응답이 끝난 뒤 TTL 을 시작한다. 시작 시각으로 재면 다음 주기에 옛 캐시를 다시 읽을 수 있다.
          try { attempts.set(key, await clock()) } catch {}
          busy.delete(key)
        }
      }))
    },
  }
}
