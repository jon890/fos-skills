// 시작 확인 시간 초과는 action stalled 와 CONFLICT-STALLED 로 worker 의 Run 에 Orca 메시지로 쓰고 자동 재전송하지 않는다.
// 충돌 처리: 내 열린 PR 의 base 충돌을 그 PR 을 만든 기존 worker 에게 풀게 한다. notify-conflicts 와 같은 함수, 같은 기록
//     (state/notify-conflicts.json), 같은 send-to-worker 종료 코드 분류(notify-conflicts.ts 머리 주석의 표)를 쓴다(lib/conflicts.ts).
//     그래서 머지 큐 뒤의 notify-conflicts 와 틱이 차례로 실행될 때 같은 (PR, PR HEAD, 충돌 파일) 을 두 번 보내지 않는다. 둘이 겹쳐 돌면
//     둘 다 기록을 읽은 뒤 보내므로 두 번 보낼 수 있다(기록 파일에 잠금이 없다). 새 worker 는 띄우지 않는다.
//     내 열린 PR 이 없으면 git fetch 없이 끝낸다. 열린 PR 을 읽지 못한 틱은 건너뛴다.
//     1. lib/conflicts.ts 의 findConflicts(base 는 origin/HEAD 가 가리키는 브랜치, 없으면 main). 실패하면 `WATCH-ERROR conflicts: …`
//     2. 내 PR 만 남긴다. 작성자를 정하지 못하면 `WATCH-ERROR conflicts: …` 를 쓰고 그 틱의 충돌 처리를 끝낸다
//     3. 기록에 있는 (PR, PR HEAD, 충돌 파일) 은 넘어간다. 아니면 브랜치의 워크트리와 worker 행(lib/workers.ts)을 찾아 resolveConflict 와
//        concludeConflict 를 부른다. 워크트리나 dispatch 가 없으면 orphan 이다. worker-list 를 읽지 못하면 그 PR 은 기록하지 않고
//        `WATCH-ERROR conflicts: worker 목록을 읽지 못했다: …` 를 쓴다
//     4. orphan 이면 Run 에 Orca 메시지로 CONFLICT-ORPHAN(pr 은 PR 번호, text 는 이유)을 쓴다
//     5. send-to-worker 가 2(사용법 오류)로 끝나면 그 틱의 충돌 처리를 멈추고 `WATCH-ERROR conflicts: send-to-worker 사용법 오류` 를 쓴다.
//        notify-conflicts 는 2 로 끝나지만 루프는 끝내지 않는다. 끝내면 질문 확인도 멈춘다
//     resolveConflict 의 줄(`<dispatch> 에 알렸다` 따위)은 로그에 쓴다. send-to-worker 를 틱 자식 안에서 기다리는 동안에도
//     부모의 생존 타이머가 alive_at 을 쓴다.

import { concludeConflict, findConflicts, loadNotified, notifiedFile, notifiedKey, resolveConflict } from '../../lib/conflicts.ts'
import type { Found, OpenPr, WorkerFound } from '../../lib/conflicts.ts'
import { apiTarget, isOwnPr, ownAuthors } from '../../lib/gh.ts'
import { defaultBase } from '../../lib/git.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { worktreePaths } from '../../lib/workers.ts'
import type { Context, StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine, ownerOf, primaryRun } from './shared.ts'
import type { Lookup } from './shared.ts'

// 충돌 처리(머리 주석의 「충돌 처리」). 결과는 errors.conflicts 에 둘 이유다
async function handleConflicts(ctx: Context, lookup: Lookup, base: string, found: Found): Promise<string | null> {
  const { baseSha } = found
  const authors = new Map<string, string[]>()
  const mine: { pr: OpenPr; files: string[] }[] = []
  for (const item of found.found) {
    const host = apiTarget(item.pr.url)?.host
    if (!host) return `#${item.pr.number} 의 PR URL 을 읽지 못했다: ${JSON.stringify(item.pr.url ?? null)}`
    if (!authors.has(host)) {
      const own = ownAuthors(ctx.repo, host)
      if (!own) return `내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다`
      authors.set(host, own)
    }
    if (isOwnPr({ author: { login: item.pr.author?.login ?? '' } }, authors.get(host) ?? [])) mine.push(item)
  }
  const statePath = notifiedFile(ctx.repo)
  const state = loadNotified(statePath)
  const primary = primaryRun(lookup)
  const errors = new Set<string>()
  for (const { pr, files } of mine) {
    if (Object.hasOwn(state, notifiedKey(pr.number, pr.headRefOid, files))) continue
    log(`#${pr.number} CONFLICTING ${pr.headRefName}: ${files.join(' ')}`)
    lookup.paths ??= worktreePaths(ctx.repo)
    const path = lookup.paths.get(pr.headRefName)
    let target: WorkerFound
    // 그 worker 를 띄운 Run. 모르면 주 Run 이다(ADR-012)
    let run = primary
    if (!path) {
      target = { orphan: '워크트리 없음. 새 worker 는 띄우지 않는다' }
    } else {
      const owner = ownerOf(path, lookup)
      if (!owner.ok) {
        // 알리지도 기록하지도 않는다. 다음 틱이 다시 본다
        errors.add(`worker 목록을 읽지 못했다: ${oneLine(owner.error)}`)
        continue
      }
      if (owner.found) run = owner.found.run ?? primary
      target = owner.found ? { path, row: owner.found.row } : { orphan: '그 워크트리의 dispatch 없음. 새 worker 는 띄우지 않는다' }
    }
    const fireCtx = { repo: ctx.repo, base, run }
    const outcome = await resolveConflict({ repo: ctx.repo, base, baseSha, pr, files, found: target, run, dryRun: false, out: log })
    if (outcome.kind === 'usage') {
      errors.add('send-to-worker 사용법 오류')
      break
    }
    if (outcome.kind !== 'record') continue
    if (outcome.action === 'orphan' || outcome.action === 'stalled') {
      try {
        if (outcome.action === 'stalled') sendNotice('CONFLICT-STALLED', pr.number, outcome.reason ?? '', run)
        else sendNotice('CONFLICT-ORPHAN', pr.number, outcome.reason ?? '', run)
      } catch (e) {
        log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
        continue
      }
    }
    await concludeConflict(statePath, ctx.repo, fireCtx, pr, files, baseSha, outcome)
  }
  return errors.size > 0 ? [...errors].join('; ') : null
}

export async function settleConflicts(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { lookup } = ctx
  const { prs } = state
  if (!prs.ok) return {}
  const { report, errors } = reporter(ctx)
  // 9. 충돌 처리. 내 열린 PR 이 없으면 git fetch 없이 끝낸다. 열린 PR 을 읽지 못한 틱은 건너뛰고 errors.conflicts 를 그대로 둔다
  const conflictBase = defaultBase(ctx.repo) ?? 'main'
  let found: Found | null = null
  try {
    if (prs.mine.length > 0) {
      const got = findConflicts(ctx.repo, conflictBase)
      if (got.ok) found = got
      report('conflicts', got.ok ? await handleConflicts(ctx, lookup, conflictBase, got) : oneLine(got.error))
    } else {
      report('conflicts', null)
    }
  } catch (e) {
    report('conflicts', oneLine(e))
  }
  return { errors, conflictBase, found }
}
