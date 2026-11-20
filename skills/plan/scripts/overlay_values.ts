// 레포 설정(오버레이)의 표에서 이름 붙은 값을 읽는다.
//
// 값의 이름과 형식은 references/monorepo.md 의 「스크립트가 직접 읽는 값」 이 소유한다.
// 파일을 찾는 순서는 overlay_paths.ts 가 정한다. 값 하나마다 그 순서로 찾고, 앞의 파일에 있으면 그것을 쓴다.
// verify_task.ts 와 run_doc_checks.ts 가 모듈로 불러 쓴다. 단독 실행 명령은 없다.

import { escapeRegExp, PyRegExp, pyRepr } from './pylike.ts'
import { isExpected, readTextFile, ValueError } from './io.ts'
import { resolveTargets, searchOrder, subprojects } from './overlay_paths.ts'
import { pyInt, pyStrip } from './kit/py.ts'

// 경로가 속한 하위 프로젝트 목록이다. 단일 저장소이거나 정하지 못하면 [null] 이다(루트만 본다)
export function targets(root: string, paths: string[]): (string | null)[] {
  const subs = subprojects(root)
  const [found] = resolveTargets(root, root, subs, null, null, paths)
  return found.length > 0 ? found : [null]
}

// `| <name> | <값> |` 행의 값 칸이다. 표가 어느 절에 있든 행 이름으로 찾는다
export function cell(text: string, name: string): string | null {
  const found = new PyRegExp(`(?<![^\\n])\\|\\s*${escapeRegExp(name)}\\s*\\|\\s*(.*?)\\s*\\|\\s*(?![^\\n])`).exec(text)
  return found ? found[1] : null
}

// [값 칸, 찾은 파일의 루트 기준 경로] 를 낸다. 없으면 [null, null] 이다.
// skills 는 앞에서부터 찾을 스킬 이름이다. 스킬마다 overlay_paths 의 탐색 순서를 따른다
export function lookup(root: string, skills: string[], name: string, sub: string | null = null): [string | null, string | null] {
  for (const skill of skills) {
    for (const rel of searchOrder(root, skill, sub)) {
      if (rel.startsWith('(없음)')) continue
      const value = cell(readTextFile(`${root}/${rel}`), name)
      if (value !== null && pyStrip(value)) return [value, rel]
    }
  }
  return [null, null]
}

// 값 칸의 인라인 코드 조각들이다. 인라인 코드가 없으면 칸 전체를 하나로 본다
export function codes(value: string): string[] {
  const found = [...value.matchAll(/`([^`]+)`/g)].map((m) => pyStrip(m[1])).filter((c) => c !== '')
  return found.length > 0 ? found : [pyStrip(value)]
}

// 정수, `<JSON 파일>#<키.키>`, 또는 `<JS·TS 파일>#<상수 이름>` 이 가리키는 정수를 낸다. 읽지 못하면 ValueError 다.
// JS·TS 파일은 `const 이름 = 정수` 선언 한 줄을 읽는다. 저장소의 크기 검사 스크립트가 상한을 상수로 둘 때 쓴다
export function number(root: string, value: string): number {
  const text = codes(value)[0]
  if (/^\p{Nd}+$/u.test(text)) return pyInt(text)
  const at = text.indexOf('#')
  const rel = at < 0 ? text : text.slice(0, at)
  const keys = at < 0 ? '' : text.slice(at + 1)
  if (at < 0 || !keys) throw new ValueError(`정수나 \`<JSON 파일>#<키>\` 가 아니다: ${text}`)
  if (/\.[cm]?[jt]sx?$/.test(rel)) return constant(root, rel, keys)
  let data: unknown
  try {
    data = JSON.parse(readTextFile(`${root}/${rel}`))
  } catch (error) {
    if (!isExpected(error)) throw error
    throw new ValueError(`${rel} 을 읽지 못했다: ${error.message}`)
  }
  for (const key of keys.split('.')) {
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !(key in data)) throw new ValueError(`${rel} 에 ${keys} 가 없다`)
    data = (data as Record<string, unknown>)[key]
  }
  if (typeof data === 'boolean' || typeof data !== 'number' || !Number.isInteger(data)) throw new ValueError(`${rel} 의 ${keys} 가 정수가 아니다: ${pyRepr(data)}`)
  return data
}

// JS·TS 파일에서 `const <name> = <정수>` 선언의 값을 읽는다. `export` 와 `: number` 표기, 숫자 구분자 `_` 를 받는다
function constant(root: string, rel: string, name: string): number {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new ValueError(`${rel} 의 상수 이름이 아니다: ${name}`)
  let text: string
  try {
    text = readTextFile(`${root}/${rel}`)
  } catch (error) {
    if (!isExpected(error)) throw error
    throw new ValueError(`${rel} 을 읽지 못했다: ${error.message}`)
  }
  const found = new RegExp(`^\\s*(?:export\\s+)?const\\s+${escapeRegExp(name)}\\s*(?::\\s*number\\s*)?=\\s*(\\d[\\d_]*)\\s*;?\\s*(?://.*)?$`, 'm').exec(text)
  if (!found) throw new ValueError(`${rel} 에 정수 상수 ${name} 이 없다`)
  return pyInt(found[1].replaceAll('_', ''))
}
