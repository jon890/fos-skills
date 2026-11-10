// 머지 알림: 열린 PR 을 읽은 틱에만 돈다. 앞 틱의 ci(loop.json)에 있었는데 이번 틱의 내 열린 PR 에 없는 PR 마다 gh pr view 로 상태를 읽는다.
//     MERGED 이고 그 브랜치의 워크트리에 살아 있는 dispatch(shared.ts 머리 주석의 「worker 찾기」)가 있으면 send-to-worker --no-reply 로
//     `PR #<N> 이 MERGED 됐다(머지 커밋 <SHA>). … 머지 뒤 할 일이 없으면 worker_done 을 보내고 끝낸다` 를 보낸다(core/merge-notice.ts). 로그에 `MERGED-NOTIFY #<N> <dispatch> 종료 코드 <n>` 을 쓴다.
//     머지 알림을 받지 못한 worker 의 dispatch 가 열린 채 남아 정리가 그 워크트리를 「살아 있는 worker」 로 건너뛰었다(2026-11-02 #945, #288).
//     마무리(finish-pr)가 돈 PR(lib/finish-marks.ts)은 마무리가 같은 알림을 보내므로 보지 않는다. 판정한 PR 은 결과와 함께
//     state/merged-notified.json 에 적어 다시 보지 않는다. 보내지 못해도 적는다. 닫힌 PR 은 다음 틱의 ci 에 없어 다시 볼 수 없다.
//     PR 이나 worker 목록을 읽지 못하면 그 PR 은 적지 않고 errors 의 merged@<주 Run> 에 이유를 둔다(errors.ts 머리 주석의 「오류 줄 억제」)

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isObject } from '../../core/json.ts'
import { mergeNotice } from '../../core/merge-notice.ts'
import { scriptPath } from '../../lib/commands.ts'
import { SEND_MS } from '../../lib/conflicts.ts'
import { finishStarted } from '../../lib/finish-marks.ts'
import { ghJson } from '../../lib/gh.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { LIVE_DISPATCH, worktreePaths } from '../../lib/workers.ts'
import type { Context, StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { ciEntries, iso, log, oneLine, ownerOf, relay } from './shared.ts'
import type { CiEntry, Lookup, OwnPr } from './shared.ts'

// 머리 주석의 「머지 알림」. 오류가 있으면 이유를 `; ` 로 이어 내고, 없으면 null 이다
async function tellMerged(ctx: Context, mine: OwnPr[], previous: Record<string, CiEntry>, lookup: Lookup): Promise<string | null> {
  const open = new Set(mine.map((pr) => String(pr.number)))
  const gone = Object.keys(previous).filter((n) => !open.has(n) && !finishStarted(ctx.repo, n))
  if (gone.length === 0 || !lookup.runs.some((entry) => entry.run)) return null
  const file = join(pathOf('state', ctx.repo), 'merged-notified.json')
  let seen: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(parsed)) seen = parsed
  } catch {
    seen = {}
  }
  const errors: string[] = []
  let changed = false
  const note = (n: string, value: string) => {
    seen[n] = `${value} ${iso()}`
    changed = true
  }
  for (const n of gone) {
    if (Object.hasOwn(seen, n)) continue
    const got = ghJson<Record<string, unknown>>(['pr', 'view', n, '--json', 'state,headRefName,mergeCommit'], { cwd: ctx.repo })
    if (!got.ok || !isObject(got.data)) {
      errors.push(`#${n}: ${got.ok ? 'PR 을 읽지 못했다' : oneLine(got.error)}`)
      continue
    }
    const data = got.data
    if (data.state !== 'MERGED') {
      note(n, String(data.state))
      continue
    }
    lookup.paths ??= worktreePaths(ctx.repo)
    const path = lookup.paths.get(String(data.headRefName ?? ''))
    const owner = path ? ownerOf(path, lookup) : { ok: true as const, found: null }
    if (!owner.ok) {
      errors.push(`#${n}: worker 목록을 읽지 못했다`)
      continue
    }
    const found = owner.found
    if (!found || !found.run || !LIVE_DISPATCH.has(String(found.row.dispatchStatus))) {
      note(n, 'MERGED 살아 있는 dispatch 없음')
      continue
    }
    const dispatch = String(found.row.dispatchId)
    const commit = isObject(data.mergeCommit) ? String(data.mergeCommit.oid ?? '') : ''
    const body = mergeNotice(n, commit)
    const send = process.env.SEND_TO_WORKER || scriptPath('send-to-worker')
    const sent = await runAsync(scriptCommand(send, ['--dispatch', dispatch, '--body', body, '--run', found.run, '--no-reply']), { cwd: ctx.repo, timeoutMs: SEND_MS })
    relay(sent)
    log(`MERGED-NOTIFY #${n} ${dispatch} 종료 코드 ${sent.code}`)
    // 보내지 못해도 적는다. 닫힌 PR 은 다음 틱의 ci 에 없어 다시 볼 수 없고, 같은 PR 을 틱마다 다시 보내지 않게 한다
    note(n, `MERGED ${dispatch} 종료 코드 ${sent.code}`)
    if (sent.code !== 0 && sent.code !== 4) errors.push(`#${n}: ${dispatch} 에 머지를 알리지 못했다(종료 코드 ${sent.code})`)
  }
  if (changed) {
    makeParent(file, ctx.repo)
    writeFileSync(`${file}.tmp`, `${JSON.stringify(seen)}\n`)
    renameSync(`${file}.tmp`, file)
  }
  return errors.length ? errors.join('; ') : null
}

export async function notifyMerged(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { loaded, lookup } = ctx
  const { prs } = state
  const { report, errors } = reporter(ctx)
  // 5-1. 머지 알림. 앞 틱에 본 내 열린 PR 이 닫혔으면 그 브랜치의 열린 dispatch 에 머지를 알린다
  if (prs.ok) {
    try {
      report('merged', await tellMerged(ctx, prs.mine, ciEntries(loaded?.ci), lookup))
    } catch (e) {
      report('merged', oneLine(e))
    }
  }
  return { errors }
}
