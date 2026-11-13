// 설정 경로 편집과 새 문제 선택. 외부 상태와 검사표 의존 없이 입력 값만 다룬다.
import { ConfigError } from './config.ts'
import { isObject } from './json.ts'

export function parsePath(text: string, min = 2): string[] {
  const names = text.split('.')
  if (names.length < min || names.some(name => !name)) throw new ConfigError(`경로는 ${min === 1 ? '절 또는 절.키' : '절.키'} 꼴로 준다: ${text}. 절 조회는 show <절>을 쓴다`)
  return names
}

export const within = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`)

export function distinctPaths(paths: readonly string[][]): void {
  const texts = paths.map(names => names.join('.'))
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    if (within(texts[i], texts[j]) || within(texts[j], texts[i])) throw new ConfigError(`겹치는 경로는 함께 줄 수 없다: ${texts[i]}, ${texts[j]}`)
  }
}

export function getAt(raw: unknown, names: readonly string[]): unknown {
  let value = raw
  for (const name of names) {
    if (!isObject(value) || !Object.hasOwn(value, name)) return undefined
    value = value[name]
  }
  return value
}

// defineProperty 는 __proto__ 같은 이름도 자기 속성으로 쓴다.
const put = (body: Record<string, unknown>, name: string, value: unknown) => Object.defineProperty(body, name, { value, enumerable: true, writable: true, configurable: true })

export function setAt(raw: Record<string, unknown>, names: readonly string[], value: unknown): void {
  let body = raw
  for (const name of names.slice(0, -1)) {
    if (!Object.hasOwn(body, name)) put(body, name, {})
    const next = body[name]
    if (!isObject(next)) throw new ConfigError(`경로의 중간 값은 객체여야 한다: ${names.join('.')}`)
    body = next
  }
  put(body, names.at(-1)!, value)
}

export function unsetAt(raw: Record<string, unknown>, names: readonly string[]): boolean {
  const name = names[0]
  if (!Object.hasOwn(raw, name)) return false
  if (names.length === 1) { delete raw[name]; return true }
  const body = raw[name]
  if (!isObject(body)) throw new ConfigError(`경로의 중간 값은 객체여야 한다: ${names.join('.')}`)
  const changed = unsetAt(body, names.slice(1))
  if (changed && Object.keys(body).length === 0) delete raw[name]
  return changed
}

type Issue = { path: string; reason: string; kind: string }
type PairKeys = Readonly<Record<string, readonly { keys: readonly string[] }[] | undefined>>

export function touched(problem: Issue, paths: readonly string[][], pairs: PairKeys): boolean {
  return paths.some(names => {
    const key = names.slice(0, 2).join('.')
    if (within(problem.path, key)) return true
    return problem.kind === 'pair' && (pairs[names[0]] ?? []).some(pair =>
      problem.path === `${names[0]}.${pair.keys[0]}` && (names.length === 1 || pair.keys.includes(names[1])))
  })
}

export function rejectedProblems<T extends Issue>(before: readonly T[], after: readonly T[], paths: readonly string[][], pairs: PairKeys): T[] {
  return after.filter(problem => touched(problem, paths, pairs) ||
    paths.some(names => within(problem.path, names[0])) && !before.some(old => old.path === problem.path && old.reason === problem.reason))
}
