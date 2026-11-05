// 설치 기록에서 지금 쓸 fos-skills 번들을 고르는 규칙의 원본이다. 내장 모듈만 쓰고 import 할 때 부수 효과가 없다.
// 진입점(bin/orch.ts), 직접 실행 경고(lib/bundle.ts), doctor 가 이 함수를 쓴다.
// 플러그인 루트의 실행기(bin/orch, CommonJS)와 templates/spec-common.md 의 한 줄 풀이는 이것을 import 할 수 없어 같은 규칙을 다시 쓴다.
// 세 구현은 tests/fixtures/install-records.json 의 같은 사례 표로 묶는다. 규칙을 바꾸면 세 곳과 그 표를 함께 고친다.
//
// 규칙(selectBundle):
//     1. `<설정 폴더>/plugins/installed_plugins.json` 의 `fos-skills@fos-skills` 항목 가운데 scope 가 user 인 것이 있으면 그것만 본다.
//        기록 순서로 `<installPath>/skills/orch/scripts` 가 있는 첫 항목을 쓴다. 하나도 없으면 다른 범위로 넘어가지 않고 오류다.
//        다른 프로필의 project 범위 옛 번들이 조용히 도는 일을 막으려는 것이다(2026-11-04 실측, 3.x 진입점이 user 4.0.1 을 건너뛰었다).
//     2. user 항목이 없으면 다른 범위의 항목을 기록 순서로 보고 스크립트 폴더가 있는 첫 항목을 쓴다.
//     3. 그래도 없으면(기록이 없거나 깨졌다) 부르는 쪽이 든 번들(own)을 쓴다. own 에도 스크립트 폴더가 없으면 오류다.
// 결과의 source 는 user, other, own 가운데 하나다.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PLUGIN = 'fos-skills@fos-skills'

export type Selected = { bundle: string; source: 'user' | 'other' | 'own' }
export type SelectError = { error: string }

export function canonical(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function scriptsDirOf(bundle: string): string {
  return join(bundle, 'skills', 'orch', 'scripts')
}

export function entryOf(bundle: string): string {
  return join(bundle, 'skills', 'orch', 'bin', 'orch.ts')
}

export function recordFile(configDir: string): string {
  return join(configDir, 'plugins', 'installed_plugins.json')
}

type Row = { scope?: unknown; installPath: string }

function rows(configDir: string): Row[] {
  let entries: unknown
  try {
    entries = (JSON.parse(readFileSync(recordFile(configDir), 'utf8')) as { plugins?: Record<string, unknown> }).plugins?.[PLUGIN]
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  return entries.filter((e): e is Row => typeof e?.installPath === 'string' && e.installPath !== '')
}

export function selectBundle(configDir: string, own: string): Selected | SelectError {
  const all = rows(configDir)
  const users = all.filter((e) => e.scope === 'user')
  if (users.length > 0) {
    const found = users.find((e) => isDir(scriptsDirOf(e.installPath)))
    if (found) return { bundle: found.installPath, source: 'user' }
    const first = users[0].installPath
    const old = isDir(join(first, 'orch', 'scripts')) ? ' 옛 배치(orch/scripts)의 번들이다.' : ''
    return {
      error:
        `${recordFile(configDir)} 의 user 범위 설치본 ${first} 에 skills/orch/scripts 가 없다.${old} ` +
        `다른 범위의 번들로 넘어가지 않는다. claude plugin update ${PLUGIN} 으로 갱신한다. 현재 진입점이어야 할 경로: ${entryOf(first)}`,
    }
  }
  const other = all.find((e) => isDir(scriptsDirOf(e.installPath)))
  if (other) return { bundle: other.installPath, source: 'other' }
  if (isDir(scriptsDirOf(own))) return { bundle: own, source: 'own' }
  return { error: `${PLUGIN} 의 skills/orch/scripts 를 찾지 못했다. ${recordFile(configDir)} 를 확인하거나 claude plugin install ${PLUGIN} 을 한다` }
}
