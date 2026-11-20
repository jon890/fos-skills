// 대체 리뷰(틱 5-2): queue.auto_review.fallback 이 있고 열린 PR 을 읽은 틱에만 돈다. 리뷰 봇이 실행 장애로 실패한 Ready PR 에
//     코디네이터를 기다리지 않고 리뷰 worker 를 띄운다. 장애 판정과 지시서 채우기는 core/review-fallback.ts 가 소유한다.
//     기록은 state/review-fallback.json 의 { "<PR>@<HEAD>": { at, check, sec, value, spec, log, why } } 이다. 이번 틱의 내 열린 PR 이 아닌 항목은 지운다.
//     같은 (PR, HEAD) 에는 한 번만 띄운다. 실패도 기록해 틱마다 다시 시도하지 않는다. 새 push 로 HEAD 가 바뀌면 리뷰 봇이 다시 돌므로 다시 본다.
//     대상: 내 열린 PR 가운데 draft 가 아니고, 이번 틱 CI 감시의 그 HEAD 항목이 필수 체크로 passed(항목의 required, 없으면 state)이며,
//     롤업이 장애(reviewOutage)인 PR 이다. 필수 체크가 끝나기 전에는 띄우지 않는다. 리뷰 worker 가 실패한 코드를 리뷰하지 않게 한다.
//     띄우기:
//     1. Run 은 그 PR 워크트리의 worker 를 띄운 Run(shared.ts 머리 주석의 「worker 찾기」), 모르면 주 Run 이다. 지시서 폴더는 그 Run 의 등록,
//        없으면 finish.specs_dir 이다. 둘 다 없으면 `지시서 폴더가 없다` 로 실패다
//     2. REVIEW_SPEC(기본 orch spec review 의 스크립트) <PR> --repo <repo> --specs-dir <폴더> --out <폴더>/spec-review-pr-<PR>-fb<HEAD 앞 8자리>.md 를 부른다.
//        0 이 아니면 출력의 REVIEW-SPEC-FAIL 줄(없으면 종료 코드)로 실패다. 구현 worker 를 이력에서 못 찾는 PR(직접 띄운 PR)이 여기서 멈춘다
//     3. 만든 지시서를 fallbackSpec 으로 채워 다시 쓰고, 지시서의 `worker 선택:` 줄(lib/spec.ts 의 selectionsOf)로 worker 인자를 정한다
//     4. LAUNCH_WORKER(기본 launch-worker) --spec <지시서> --repo <repo> --name review-pr-<PR>-fb<앞 8자리> [--run <Run>] --watch 0 -- --agent <a> --model <m> [--effort <e>]
//        를 분리해(detached, unref) 띄우고 출력은 state/review-fallback/<PR>-<YYYYMMDDTHHMMSSZ>.log 에 둔다. worker 를 띄우는 데 몇 분이 걸려 틱을 막지 않으려는 것이다.
//        effort 가 `기본` 이면 --effort 를 주지 않는다
//     띄웠으면 value 가 launched 이고 REVIEW-FALLBACK(pr 그 PR, text `<check> 이 HEAD <앞 8자리> 에서 <초>초 만에 실패해 대체 리뷰 worker 를 띄웠다.
//     지시서 <경로>, 로그 <경로>`)를 그 Run 에 쓴다. 실패면 value 가 failed 이고 REVIEW-FALLBACK-FAIL(text `<check> 이 HEAD <앞 8자리> 에서 <초>초 만에
//     실패했지만 대체 리뷰를 띄우지 못했다: <이유>. 독립 리뷰를 직접 맡긴다`)을 쓴다. 코디네이터는 지금처럼 독립 리뷰를 맡긴다.
//     오류 이유(기록을 읽거나 쓰지 못함)는 errors 의 review-fallback 에 둔다(errors.ts 머리 주석의 「오류 줄 억제」)

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isObject } from '../../core/json.ts'
import { fallbackSpec, reviewOutage } from '../../core/review-fallback.ts'
import type { ReviewFallback } from '../../core/auto-merge.ts'
import { scriptPath } from '../../lib/commands.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { selectionsOf } from '../../lib/spec.ts'
import { worktreePaths } from '../../lib/workers.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { iso, log, oneLine, ownerOf, primaryRun } from './shared.ts'
import type { OwnPr } from './shared.ts'

const SPEC_MS = 120_000

type FallbackRecord = { at: string; check: string; sec: number; value: 'launched' | 'failed'; spec?: string; log?: string; why?: string }

function recordFile(repo: string): string {
  return join(pathOf('state', repo), 'review-fallback.json')
}

function readRecords(file: string): Record<string, FallbackRecord> {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(raw) ? (raw as Record<string, FallbackRecord>) : {}
  } catch {
    return {}
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function launchDetached(argv: string[], cwd: string, fd: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', fd, fd], detached: true })
    child.once('error', (e) => resolve({ ok: false, error: e.message }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

// 머리 주석의 「띄우기」 2~4. 실패면 why 를 낸다
async function launch(ctx: StepContext, pr: OwnPr, fallback: ReviewFallback, outage: NonNullable<ReturnType<typeof reviewOutage>>, run: string | null, dir: string): Promise<{ spec: string; log: string } | { why: string }> {
  const tail = `fb${pr.head.slice(0, 8)}`
  const spec = join(dir, `spec-review-pr-${pr.number}-${tail}.md`)
  const made = await runAsync(scriptCommand(process.env.REVIEW_SPEC || scriptPath('review-spec'), [String(pr.number), '--repo', ctx.repo, '--specs-dir', dir, '--out', spec]), { cwd: ctx.repo, timeoutMs: SPEC_MS })
  if (made.code !== 0) {
    const line = `${made.stdout}\n${made.stderr}`.split('\n').find((row) => row.startsWith('REVIEW-SPEC-FAIL ') || row.startsWith('REVIEW-SPEC-EXISTS '))
    return { why: line ? oneLine(line) : `orch spec review 가 종료 코드 ${made.code} 로 끝났다` }
  }
  let text: string
  try {
    text = fallbackSpec(readFileSync(spec, 'utf8'), { pr: pr.number, head: pr.head, outage, fallback })
    writeFileSync(spec, text)
  } catch (e) {
    return { why: `리뷰 지시서를 채우지 못했다: ${oneLine(e)}` }
  }
  const chosen = selectionsOf(text)[0]
  if (!chosen?.agent || !chosen.model || !chosen.effort) return { why: '리뷰 지시서에 worker 선택 줄이 없다' }
  const worker = ['--agent', chosen.agent, '--model', chosen.model, ...(chosen.effort === '기본' ? [] : ['--effort', chosen.effort])]
  const logFile = join(pathOf('state', ctx.repo), 'review-fallback', `${pr.number}-${stamp()}.log`)
  mkdirSync(join(pathOf('state', ctx.repo), 'review-fallback'), { recursive: true })
  const args = ['--spec', spec, '--repo', ctx.repo, '--name', `review-pr-${pr.number}-${tail}`, ...(run ? ['--run', run] : []), '--watch', '0', '--', ...worker]
  const fd = openSync(logFile, 'a')
  try {
    const started = await launchDetached(scriptCommand(process.env.LAUNCH_WORKER || scriptPath('launch-worker'), args), ctx.repo, fd)
    if (!started.ok) return { why: `launch-worker 를 띄우지 못했다: ${started.error}` }
  } finally {
    closeSync(fd)
  }
  return { spec, log: logFile }
}

export async function startReviewFallback(ctx: StepContext, state: StepState): Promise<StepResult> {
  const fallback = ctx.autoMerge.review?.fallback
  const { prs, ci } = state
  if (!fallback || !prs.ok) return {}
  const { report, errors } = reporter(ctx)
  try {
    const file = recordFile(ctx.repo)
    const records = readRecords(file)
    const open = new Set(prs.mine.map((pr) => String(pr.number)))
    for (const key of Object.keys(records)) if (!open.has(key.split('@')[0])) delete records[key]
    for (const pr of prs.mine) {
      const key = `${pr.number}@${pr.head}`
      if (pr.draft || records[key]) continue
      const entry = ci?.[String(pr.number)]
      if (entry?.head !== pr.head || (entry.required ?? entry.state) !== 'passed') continue
      const outage = reviewOutage(pr.rollup, fallback.check, fallback.failWithinSec)
      if (!outage) continue
      ctx.lookup.paths ??= worktreePaths(ctx.repo)
      const path = ctx.lookup.paths.get(pr.branch)
      const owner = path ? ownerOf(path, ctx.lookup) : null
      const run = (owner?.ok && owner.found?.run) || primaryRun(ctx.lookup)
      const dir = ctx.runs.find((entry) => entry.run === run)?.specsDir ?? ctx.specsDir
      const head = pr.head.slice(0, 8)
      const done = dir ? await launch(ctx, pr, fallback, outage, run, dir) : { why: '지시서 폴더가 없다(finish.specs_dir)' }
      const base = { at: iso(), check: outage.check, sec: outage.sec }
      if ('why' in done) {
        records[key] = { ...base, value: 'failed', why: done.why }
        log(`REVIEW-FALLBACK-FAIL #${pr.number} ${done.why}`)
        sendNotice('REVIEW-FALLBACK-FAIL', pr.number, `${outage.check} 이 HEAD ${head} 에서 ${outage.sec}초 만에 실패했지만 대체 리뷰를 띄우지 못했다: ${done.why}. 독립 리뷰를 직접 맡긴다`, run)
      } else {
        records[key] = { ...base, value: 'launched', spec: done.spec, log: done.log }
        log(`REVIEW-FALLBACK #${pr.number} ${outage.check} ${outage.sec}초 spec=${done.spec} log=${done.log}`)
        sendNotice('REVIEW-FALLBACK', pr.number, `${outage.check} 이 HEAD ${head} 에서 ${outage.sec}초 만에 실패해 대체 리뷰 worker 를 띄웠다. 지시서 ${done.spec}, 로그 ${done.log}`, run)
      }
    }
    makeParent(file, ctx.repo)
    writeFileSync(`${file}.tmp`, `${JSON.stringify(records, null, 2)}\n`)
    renameSync(`${file}.tmp`, file)
    report('review-fallback', null)
  } catch (e) {
    report('review-fallback', oneLine(e))
  }
  return { errors }
}
