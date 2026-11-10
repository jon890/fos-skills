// 열린 PR 조회(틱 2): gh pr list 한 번으로 읽어 보드, CI, tick, 자동 머지, 충돌 처리, 최신화가 함께 쓴다. 내 PR 은 lib/gh.ts 의 ownAuthors 와 isOwnPr 로 가린다

import { isObject } from '../../core/json.ts'
import { apiTarget, ghJson, isOwnPr, ownAuthors } from '../../lib/gh.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { oneLine } from './shared.ts'
import type { OwnPr, Prs } from './shared.ts'

const PR_FIELDS = 'number,author,url,title,headRefName,headRefOid,isDraft,baseRefName,statusCheckRollup'

function openPrs(repo: string): Prs {
  const got = ghJson<unknown>(['pr', 'list', '--state', 'open', '--limit', '200', '--json', PR_FIELDS], { cwd: repo, cache: false })
  if (!got.ok) return got
  if (!Array.isArray(got.data)) return { ok: false, error: 'gh pr list 의 출력이 목록이 아니다' }
  const authors = new Map<string, string[]>()
  const mine: OwnPr[] = []
  for (const pr of got.data) {
    if (!isObject(pr) || !Number.isInteger(pr.number)) return { ok: false, error: 'gh pr list 의 행을 읽지 못했다' }
    const url = typeof pr.url === 'string' ? pr.url : ''
    const target = apiTarget(url)
    const host = target?.host
    if (!target || !host) return { ok: false, error: `PR #${pr.number} 의 URL 을 읽지 못했다` }
    if (!authors.has(host)) {
      const own = ownAuthors(repo, host)
      if (!own) return { ok: false, error: `내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다` }
      authors.set(host, own)
    }
    const login = isObject(pr.author) && typeof pr.author.login === 'string' ? pr.author.login : ''
    if (!login || !isOwnPr({ author: { login } }, authors.get(host) ?? [])) continue
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    mine.push({
      number: pr.number as number,
      title: typeof pr.title === 'string' ? pr.title : null,
      branch: text(pr.headRefName),
      head: text(pr.headRefOid),
      author: login,
      draft: pr.isDraft === true,
      base: text(pr.baseRefName),
      url,
      host,
      slug: target.slug,
      rollup: pr.statusCheckRollup,
    })
  }
  return { ok: true, mine }
}

// 내 열린 PR 번호. 읽지 못했으면 null 이다
export function openNumbers(prs: Prs): number[] | null {
  return prs.ok ? prs.mine.map((pr) => pr.number) : null
}

export async function readOpenPrs(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { report, errors } = reporter(ctx)
  // 2. 열린 PR 은 한 번만 읽어 보드, CI 감시와 tick 이벤트가 함께 쓴다
  let prs: Prs
  try {
    prs = openPrs(ctx.repo)
  } catch (e) {
    prs = { ok: false, error: oneLine(e) }
  }
  report('prs', prs.ok ? null : oneLine(prs.error))
  return { errors, prs }
}
