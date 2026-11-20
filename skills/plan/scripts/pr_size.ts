// 계획의 변경 파일 표로 PR 의 줄 수를 추정하고, 레포 설정의 「PR 줄 수 상한」 과 비교한다.
//
// 계수와 그 근거 실측은 references/plan-size.md 의 「줄 수 추정」 이 소유한다. 여기 값을 바꾸면 그 절도 고친다.
// 파일 분류(운영 코드, 테스트, 문서)와 변경 파일 표 읽기는 verify_task.ts 가 하고, 이 모듈은 줄 수만 계산한다.
// verify_task.ts 가 모듈로 불러 쓴다. 단독 실행 명령은 없다.

import { readFileSync } from 'node:fs'
import { pjoin } from './pylike.ts'
import { normalizeNewlines, pySplitLines } from './kit/py.ts'

export type Kind = 'production' | 'tests' | 'docs'

// 신규 파일 하나의 추정 줄 수다. 코드 파일은 확장자로 정하고, 그 밖의 파일(SQL, 설정, fixture)은 other 다
export const NEW_FILE_LINES = { production: 60, tests: 130, docs: 60, other: 10 } as const
// 수정 파일은 현재 줄의 이 비율로 센다. 파일 하나로는 실제보다 크지만 계획 밖에서 함께 바뀌는 파일을 메운다
export const MODIFIED_RATIO = 0.2
// 추정이 상한의 이 비율을 넘으면 경고한다
export const LINE_LIMIT_WARN_RATIO = 0.8

const DOC_SUFFIXES = /\.(?:md|mdx)$/i

// 파일 하나의 추정 줄 수다. action 은 그 파일이 phase 들에서 받은 변경 종류를 이은 것이다.
// 한 phase 에서 만들고 뒤 phase 에서 고친 파일은 신규로 센다. 읽지 못한 수정·삭제 파일은 null 이다
export function fileLines(repo: string, rel: string, action: string, kind: Kind, code: boolean): number | null {
  if (!action.includes('신규') && (action.includes('수정') || action.includes('삭제'))) {
    try {
      const current = pySplitLines(normalizeNewlines(readFileSync(pjoin(repo, rel), 'utf8'))).length
      return action.includes('삭제') ? current : Math.ceil(current * MODIFIED_RATIO)
    } catch {
      return null
    }
  }
  if (kind === 'docs') return DOC_SUFFIXES.test(rel) ? NEW_FILE_LINES.docs : NEW_FILE_LINES.other
  return code ? NEW_FILE_LINES[kind] : NEW_FILE_LINES.other
}

export type Estimate = { core: number; unknown: number; phases: [string, number][] }

// 레포 설정의 PR 줄 수 상한과 운영 코드 추정을 비교한 결과 한 줄이다. 넘지 않으면 null 이다.
// [종류, 문장] 의 종류가 violation 이면 상한을 넘었고, warning 이면 상한의 80% 를 넘었다
export function lineLimitFinding(path: string, estimate: Estimate, cap: number, source: string): ['violation' | 'warning', string] | null {
  const floor = Math.floor(cap * LINE_LIMIT_WARN_RATIO)
  if (estimate.core <= floor) return null
  const split = estimate.phases.map(([phase, lines]) => `${phase} ${lines}줄`).join(', ')
  const unknown = estimate.unknown ? ` 줄 수를 모르는 ${estimate.unknown}개는 빼고 셌다.` : ''
  const head = `${path} — 운영 코드 추정 ${estimate.core}줄이 저장소의 PR 줄 수 상한(${cap}줄, ${source})`
  if (estimate.core > cap) return ['violation', `${head}을 넘는다. phase 별 추정: ${split}.${unknown} 나눌 선을 정해 plan 을 나누고 뒤의 일은 deferred 에 둔다`]
  return ['warning', `${head}의 ${Math.round(LINE_LIMIT_WARN_RATIO * 100)}%(${floor}줄)를 넘는다. phase 별 추정: ${split}.${unknown} 추정 오차로 구현 뒤 상한을 넘을 수 있으니 자를 선을 미리 정한다`]
}
