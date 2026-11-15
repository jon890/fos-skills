// 리뷰 worker 지시서(templates/spec-review.md)를 PR 정보로 채우는 한 벌이다. `orch spec review <PR>`(spec/review-spec.ts)가 쓴다.
//
// 사람이 채우면 번호가 틀어진다. 리뷰 지시서 9개를 쓰는 동안 #258 리뷰 worker 가 「리뷰 PR: #257」 로 떠 멈추고 다시 띄운 일이 있었다.
// 기계가 아는 값(PR 번호, 제목, 브랜치 이름, 구현 worker 의 제공자와 다른 제공자의 모델)만 채우고, 사람이 판단할 두 곳은 자리표시로 남긴다.
//
// 자리표시: `{{채울 것: <설명>}}`. 「배경」 의 첫 줄과 「특히 볼 것」 절에 하나씩 둔다. spec-lint 가 남은 자리표시를 `채움` 경고로 알린다.
// 틀에 알 수 없는 `{{...}}` 가 남으면 틀이 이 코드보다 새것이라는 뜻이라 지시서를 만들지 않고 이름을 알린다.
//
// 리뷰 제공자: 구현 worker 가 claude 면 codex, codex 면 claude 다. 둘 밖의 제공자는 고르지 않는다(--impl-agent 로 알려 준다).
//     모델과 effort 는 agent-selection.md 의 `review` 행(구현한 쪽과 다른 제공자의 모델, medium)을 따른다.
//     review 행은 모델 후보와 effort 상한을 검사하지 않아도(lib/selection.ts) 비교한 후보와 이유는 줄에 남긴다.
// 구현 worker: 영구 이력(lib/launch-history.ts)에서 브랜치가 PR head 인 행 가운데 가장 늦은 것이다. 리뷰 브랜치(`review/pr-N`)는 뺀다.

import type { LaunchHistory } from './launch-history.ts'
import { reviewPrOfBranch } from './review.ts'

export type Implementer = { agent: string; model: string | null; effort: string | null; dispatch: string }
export type Reviewer = { agent: string; model: string; effort: string; compare: string; reason: string }

export const FILL = '채울 것'

// 구현 worker 의 제공자. 행의 effective 를 먼저 보고 없으면 요청한 값이다
export function implementerOf(history: LaunchHistory[], branch: string): { found: Implementer | null; agents: string[] } {
  if (reviewPrOfBranch(branch) !== null) return { found: null, agents: [] }
  const rows = history.filter((row) => row.branch === branch).sort((a, b) => a.at.localeCompare(b.at))
  const known = rows.flatMap((row) => {
    const agent = row.effective?.agent ?? row.agent
    return agent ? [{ agent, model: row.effective?.model ?? row.model ?? null, effort: row.effective?.effort ?? row.effort ?? null, dispatch: row.dispatch }] : []
  })
  return { found: known.at(-1) ?? null, agents: [...new Set(known.map((row) => row.agent))] }
}

// 구현 제공자와 다른 제공자의 리뷰 worker. 고를 수 없으면 null 이다
export function reviewerFor(agent: string): Reviewer | null {
  if (agent === 'claude') {
    return { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', compare: 'Claude Sonnet 5.5 medium', reason: '구현 worker 가 Claude 라 다른 제공자인 Codex 로 고른다. review 행은 구현한 쪽과 다른 제공자의 모델을 medium 으로 쓴다' }
  }
  if (agent === 'codex') {
    return { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', compare: '`gpt-6.1-sol` medium', reason: '구현 worker 가 Codex 라 다른 제공자인 Claude 로 고른다. review 행은 구현한 쪽과 다른 제공자의 모델을 medium 으로 쓴다' }
  }
  return null
}

const BACKGROUND_LINE = /^- \{\{PR 이 하는 일 한 줄과 링크\}\}$/m
const TASK_HEADING = /^## 할 일[ \t]*$/m
const SEE_HEADING = /^## 특히 볼 것[ \t]*$/m
const COMMENT_LINE = /^<!--.*-->[ \t]*\n/gm

export type Fill = {
  number: number; title: string; url: string; specsDir: string
  implementer: Implementer; reviewer: Reviewer
}

// 틀의 `{{...}}` 를 채운다. 알 수 없는 자리표시가 남으면 던진다
export function fillReviewSpec(template: string, fill: Fill): string {
  const { number, title, url, specsDir, implementer, reviewer } = fill
  const built = `${implementer.agent}${implementer.model ? ` ${implementer.model}` : ''}${implementer.effort ? ` effort ${implementer.effort}` : ''}`
  const values: Record<string, string> = {
    'PR 제목': title.replace(/\s+/g, ' ').trim(),
    N: String(number),
    SPECS_DIR: specsDir,
    에이전트: reviewer.agent,
    모델: reviewer.model,
    effort: reviewer.effort,
    '다른 후보': reviewer.compare,
    '구현한 제공자와 다른 제공자를 고른 이유': reviewer.reason.replace(/[.\s]+$/, ''),
    '에이전트와 모델': built,
  }
  // 틀 위쪽의 안내 주석(복사해 채우라는 말)은 만든 지시서에 필요 없다
  let text = template.replace(COMMENT_LINE, '').replace(/^(# [^\n]*)\n\n+/, '$1\n\n')
  text = text.replace(BACKGROUND_LINE, `- {{${FILL}: PR 이 하는 일 한 줄}} ([PR #${number}](${url}))`)
  if (!SEE_HEADING.test(text)) {
    if (!TASK_HEADING.test(text)) throw new Error('틀에 `## 할 일` 절이 없어 「특히 볼 것」 을 넣을 곳을 찾지 못했다')
    text = text.replace(TASK_HEADING, `## 특히 볼 것\n\n- {{${FILL}: 리뷰어가 특히 볼 곳과 이유}}\n\n## 할 일`)
  }
  text = text.replace(/\{\{([^}]*)\}\}/g, (whole, name: string) => name.startsWith(`${FILL}:`) ? whole : name in values ? values[name] : whole)
  const left = [...text.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]).filter((name) => !name.startsWith(`${FILL}:`))
  if (left.length) throw new Error(`틀에 채우지 못한 자리표시가 있다: ${[...new Set(left)].join(', ')}. 틀이 이 명령보다 새것이면 명령을 고친다`)
  return text
}

// 지시서에 남은 「채울 것」 자리표시의 설명 목록
export function unfilled(text: string): string[] {
  return [...text.matchAll(new RegExp(`\\{\\{${FILL}:\\s*([^}]*)\\}\\}`, 'g'))].map((m) => m[1].trim())
}
