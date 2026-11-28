// 정리(틱 4): Run 마다 cleanup-sweep --repo <repo> --kill-holders [--remote-branches] --apply [--run <run>] [--specs-dir <그 Run 의 dir>].
//     --remote-branches 는 저장소 공유 일이라 주 Run 의 차례에서만 준다.
//     정리 출력의 `FINISH-MISSING #<PR> <글>` 줄(cleanup/steps/worktrees.ts 의 「마무리 빠짐」)은 그 Run 에 Orca 메시지로 FINISH-MISSING(pr 그 PR,
//     text `<글>. 마무리를 뒤늦게 돌리려면 orch queue finish <PR> --repo <repo> [--run <Run>]`)으로 옮긴다. 같은 PR 은
//     state/finish-missing.json 에 적어 한 번만 쓴다. 워크트리를 치우지 못해 다음 틱이 같은 줄을 내도 다시 깨우지 않는다
//
// 잠자기: 정리가 0 이 아니게 끝났는데 그동안 벽시계가 단조 시계(hrtime)보다 SLEEP_GAP_MS 넘게 더 갔으면 Mac 이 잠든 것으로 본다(sweepVerdict).
//     잠자는 동안 네트워크와 ssh 가 끊겨 시간 초과(124)나 publickey 거절로 끝나지만 다음 회차에는 대개 성공한다.
//     그래서 WATCH-ERROR 대신 loop.log 에 `WATCH-SLEPT cleanup: <이유>` 만 남기고 errors 의 `cleanup-slept@<Run>` 에 이유를 적는다.
//     다음 회차가 성공하면 둘 다 지워 알리지 않는다. 다음 회차도 실패하면 잠자기 여부와 상관없이 WATCH-ERROR 로 알린다.
//     잠자기가 아닌 시간 초과는 이유에 그때 돌던 정리 단계를 붙인다(`종료 코드 124 (시간 초과, 단계 remote-branches)`).
//     단계는 cleanup-sweep 이 ORCH_SWEEP_CACHE 폴더의 stage 파일에 적는다(cleanup/cleanup-sweep.ts 의 markStage)

import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isObject } from '../../core/json.ts'
import { orchWord, scriptPath } from '../../lib/commands.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { shQuote } from '../../lib/py.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { iso, lines, log, oneLine, relay, rowsOf, SWEEP_TIMEOUT_MS } from './shared.ts'

// 벽시계가 단조 시계보다 이만큼 더 가면 그동안 잠든 것으로 본다. 틱 하나의 지연이나 시계 보정(수 초)보다 넉넉히 크다
export const SLEEP_GAP_MS = 60_000

export type SweepVerdict = { kind: 'ok' } | { kind: 'slept'; reason: string } | { kind: 'error'; reason: string }

// 정리 한 번의 결과를 정한다(머리 주석의 「잠자기」). wallMs 와 monoMs 는 같은 구간의 벽시계와 단조 시계 경과다.
// sleptBefore 는 앞 회차가 잠자기로 넘긴 실패인지다. 그러면 이번 실패는 잠자기여도 알린다
export function sweepVerdict(done: { code: number; timedOut: boolean }, wallMs: number, monoMs: number, stage: string | null, sleptBefore: boolean): SweepVerdict {
  if (done.code === 0) return { kind: 'ok' }
  const slept = wallMs - monoMs > SLEEP_GAP_MS
  const base = `종료 코드 ${done.code}`
  if (slept && !sleptBefore) return { kind: 'slept', reason: `${base} (잠자기 ${Math.round((wallMs - monoMs) / 60_000)}분)` }
  if (done.timedOut && !slept) return { kind: 'error', reason: `${base} (시간 초과${stage ? `, 단계 ${stage}` : ''})` }
  return { kind: 'error', reason: sleptBefore ? `${base} (잠자기 뒤 다시 실패)` : base }
}

function stageOf(cacheDir: string): string | null {
  try {
    return readFileSync(join(cacheDir, 'stage'), 'utf8').trim() || null
  } catch {
    return null
  }
}

// cleanup/steps/worktrees.ts 의 「마무리 빠짐」. 정리 출력의 FINISH-MISSING 줄을 그 Run 에 Orca 메시지로 옮긴다. 같은 PR 은 한 번만 쓴다
function relayFinishMissing(repo: string, stdout: string, run: string | null): void {
  const found = lines(stdout).map((line) => /^\s*FINISH-MISSING #(\d+) (.*)$/.exec(line)).filter((m) => m !== null)
  if (found.length === 0) return
  const file = join(pathOf('state', repo), 'finish-missing.json')
  let seen: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(parsed)) seen = parsed
  } catch {
    seen = {}
  }
  let changed = false
  for (const m of found) {
    if (Object.hasOwn(seen, m[1])) continue
    const hint = `마무리를 뒤늦게 돌리려면 ${orchWord()} queue finish ${m[1]} --repo ${shQuote(repo)}${run ? ` --run ${run}` : ''}`
    try {
      sendNotice('FINISH-MISSING', Number(m[1]), `${m[2]}. ${hint}`, run)
      seen[m[1]] = iso()
      changed = true
    } catch (e) {
      log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
    }
  }
  if (!changed) return
  try {
    makeParent(file, repo)
    writeFileSync(`${file}.tmp`, `${JSON.stringify(seen)}\n`)
    renameSync(`${file}.tmp`, file)
  } catch (e) {
    log(`orch-loop: 마무리 빠짐 기록을 쓰지 못했다: ${oneLine(e)}`)
  }
}

export async function sweepRuns(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { runs } = ctx
  const { report, errors } = reporter(ctx)
  const cacheDir = mkdtempSync(join(tmpdir(), 'orch-sweep-'))
  try {
    const known = Object.fromEntries([...ctx.lookup.rows].flatMap(([run, result]) => result.ok ? [[run, result.rows]] : []))
    writeFileSync(join(cacheDir, 'known-workers.json'), JSON.stringify(known))
    // 4. 정리. Run 마다 그 Run 범위로 돈다. 원격 브랜치 정리는 저장소 공유 일이라 주 Run 의 차례에서만 한다
    for (const [i, { run, specsDir }] of runs.entries()) {
      try {
        const sweep = process.env.CLEANUP_SWEEP || scriptPath('cleanup-sweep')
        const args = ['--repo', ctx.repo, '--kill-holders', ...(i === 0 ? ['--remote-branches'] : []), '--apply']
        if (run) args.push('--run', run)
        if (run) {
          const workers = rowsOf(run, ctx.lookup)
          if (!workers.ok) {
            // 같은 Orca 장애를 질문 단계가 이미 알렸으면 정리 실패로 다시 깨우지 않는다. 느린 틱은 질문 확인을 돌지 않지만 빠른 틱이 알린다
            log(`orch-loop: ${run} 의 worker 목록을 읽지 못해 정리를 건너뛴다: ${workers.error}`)
            report('cleanup', ctx.kind === 'slow' || state.waiting.get(run) === null ? null : workers.error, { run })
            continue
          }
        }
        if (specsDir) args.push('--specs-dir', specsDir)
        rmSync(join(cacheDir, 'stage'), { force: true })
        const wallStart = Date.now()
        const monoStart = process.hrtime.bigint()
        const done = await runAsync(scriptCommand(sweep, args), { cwd: ctx.repo, timeoutMs: SWEEP_TIMEOUT_MS, env: { ORCH_SWEEP_CACHE: cacheDir } })
        const monoMs = Number((process.hrtime.bigint() - monoStart) / 1_000_000n)
        relay(done)
        relayFinishMissing(ctx.repo, done.stdout, run)
        const sleptKey = run ? `cleanup-slept@${run}` : 'cleanup-slept'
        const verdict = sweepVerdict(done, Date.now() - wallStart, monoMs, stageOf(cacheDir), typeof ctx.previous[sleptKey] === 'string')
        if (verdict.kind === 'slept') {
          log(`WATCH-SLEPT cleanup: ${verdict.reason}`)
          errors[sleptKey] = verdict.reason
          continue
        }
        if (typeof ctx.previous[sleptKey] === 'string') errors[sleptKey] = null
        report('cleanup', verdict.kind === 'ok' ? null : verdict.reason, { run })
      } catch (e) {
        report('cleanup', oneLine(e), { run })
      }
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
  return { errors }
}
