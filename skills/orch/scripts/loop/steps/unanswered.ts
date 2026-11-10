// 미답변 질문 확인: 600초 넘은 기술 질문 id 묶음이 바뀔 때 UNANSWERED 를 Run 에 보낸다.

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUserDecision } from '../../lib/decisions.ts'
import { runKey } from '../../lib/loop.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { poll } from '../../lib/questions.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { REMIND_AFTER_SEC } from './questions.ts'
import { oneLine } from './shared.ts'

// 머리 주석의 「미답변 질문 확인」. 묶음이 바뀌었을 때만 알리고 기록을 쓴다. pending 이 null 이면 그 Run 의 질문을 읽지 못한 틱이라 아무것도 하지 않는다
async function watchUnanswered(repo: string, run: string, pending: ReturnType<typeof poll>['pending'] | null): Promise<void> {
  if (pending === null) return
  const ids = pending.filter(m => !isUserDecision(m) && Date.now() - Date.parse(String(m.created_at ?? m.createdAt ?? '')) >= REMIND_AFTER_SEC * 1000).map(m => String(m.id)).sort()
  const file = join(pathOf('state', repo), 'unanswered', `${runKey(run)}.json`)
  const hash = createHash('sha256').update(JSON.stringify(ids)).digest('hex')
  let previous = ''
  try { previous = JSON.parse(readFileSync(file, 'utf8')).hash } catch { /* 처음 확인한다 */ }
  if (previous === hash) return
  if (ids.length) sendNotice('UNANSWERED', null, ids.join(', '), run)
  makeParent(file, repo)
  writeFileSync(`${file}.tmp`, JSON.stringify({ hash, ids }))
  renameSync(`${file}.tmp`, file)
}

export async function checkUnanswered(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { runs } = ctx
  const pendingDecisions = state.pending
  const { report, errors } = reporter(ctx)
  // 11. 미답변 질문 확인. 질문 조회에 성공한 Run 에서 오래 남은 기술 질문 묶음을 알린다
  for (const { run } of runs) {
    if (!run) continue
    try {
      report('waiter', (await watchUnanswered(ctx.repo, run, pendingDecisions.get(run) ?? null), null), { run })
    } catch (e) {
      report('waiter', oneLine(e), { run })
    }
  }
  return { errors }
}
