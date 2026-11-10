// JSON 객체의 형태와 기본값. 호출자의 null 과 빈 객체 차이를 지킨다.
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function objectOr(value: unknown): Record<string, any>
export function objectOr<T>(value: unknown, fallback: T): Record<string, any> | T
export function objectOr(value: unknown, fallback: unknown = {}): any {
  return isObject(value) ? value : fallback
}
// JSON 값 비교. 객체의 키 순서는 결과에 영향을 주지 않는다.
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]))
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
}
