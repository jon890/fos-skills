const VERSION = /^\d+\.\d+\.\d+$/

// 공개 준비 중에는 이전 1.x~20.x 배포판 뒤에 0.21.x부터 이어진다.
// 공개 시 1.x 번호를 다시 쓰기 전에 이 전환 규칙과 옛 캐시를 정리한다.
export function compareFosPluginVersions(left: string, right: string): number | null {
  if (!VERSION.test(left) || !VERSION.test(right)) return null
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  const migrated = (version: number[]) => version[0] === 0 && version[1] >= 21
  const legacy = (version: number[]) => version[0] >= 1 && version[0] <= 20
  if (legacy(a) && migrated(b)) return -1
  if (migrated(a) && legacy(b)) return 1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}
