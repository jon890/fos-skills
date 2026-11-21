// 머지 전 조건의 비공개 낱말 검사(스펙 docs/features/private-leak-guard/spec.md 의 REQ4, REQ5). gate.ts 의 gateReasons 가 부른다.
// 목록과 비교 규칙, 공개 여부의 기억은 lib/private-words.ts 가 소유한다.
//
// 목록이 비었으면 아무것도 읽지 않는다. 공개 여부는 lib/gh.ts 의 `gh repo view --json visibility` 로 읽고 머신 폴더에 기억한다.
// 비공개(PRIVATE, INTERNAL)면 보지 않고, 읽지 못하면 공개로 보고 본다.
// 보는 글: PR 본문(부르는 쪽이 이미 읽은 값), 일반 댓글(issues/<n>/comments), 리뷰 본문(pulls/<n>/reviews), 코드 줄 댓글(pulls/<n>/comments).
// 댓글은 REST 로 끝 페이지까지 캐시 없이 읽는다. 같은 HEAD 에서 댓글만 더하거나 고칠 수 있다.
// 이유는 kind private 하나에 위치를 모두 담는다. 값은 쓰지 않는다. 댓글을 읽지 못하면 kind lookup 이다(확인하지 못했으면 통과로 보지 않는다).

import { ghRepoVisibility } from '../../lib/gh.ts'
import type { PrivateWord } from '../../lib/private-words.ts'
import { findingsText, readPrivateWords, repoVisibility, textFindings } from '../../lib/private-words.ts'
import type { GateReason } from './gate.ts'
import type { StepContext, StepState } from './model.ts'
import { api } from './pr.ts'

const SOURCES = [
  { label: '일반 댓글', path: (o: string, r: string, n: string) => `repos/${o}/${r}/issues/${n}/comments?per_page=100` },
  { label: '리뷰', path: (o: string, r: string, n: string) => `repos/${o}/${r}/pulls/${n}/reviews?per_page=100` },
  { label: '코드 줄 댓글', path: (o: string, r: string, n: string) => `repos/${o}/${r}/pulls/${n}/comments?per_page=100` },
] as const

// 한 줄에 [id, body] 하나다(--jq 의 @json). 줄을 읽지 못하면 null 이다
export function commentRows(stdout: string): Array<{ id: string; body: string }> | null {
  const rows: Array<{ id: string; body: string }> = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const [id, body] = JSON.parse(line) as [unknown, unknown]
      rows.push({ id: String(id), body: typeof body === 'string' ? body : '' })
    } catch {
      return null
    }
  }
  return rows
}

export function privateReasons(stepContext: StepContext, state: StepState, body: string | null, words: PrivateWord[] = readPrivateWords()): GateReason[] {
  if (words.length === 0) return []
  if (repoVisibility(state.repoDir || state.o.repo, ghRepoVisibility) === 'private') return []
  const p = state.p
  const found = body === null ? [] : textFindings(body, words, 'PR 본문')
  const failed: string[] = []
  for (const source of SOURCES) {
    const got = api(stepContext, state, source.path(p.owner, p.repo, p.n), '--paginate', '--jq', '.[] | [.id, (.body // "")] | @json')
    const rows = got.code === 0 ? commentRows(got.stdout) : null
    if (rows === null) {
      failed.push(source.label)
      continue
    }
    for (const row of rows) {
      for (const f of textFindings(row.body, words, `${source.label} ${row.id}`)) found.push(f)
    }
  }
  const reasons: GateReason[] = []
  if (found.length > 0) reasons.push({ kind: 'private', text: `비공개 낱말 목록의 낱말이 있다(값은 보이지 않는다): ${findingsText(found)}. 그 글을 고친 뒤 다시 건다` })
  if (failed.length > 0) reasons.push({ kind: 'lookup', text: `비공개 낱말 검사: ${failed.join(', ')} 조회 실패` })
  return reasons
}
