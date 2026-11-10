// 정리(틱 4): Run 마다 cleanup-sweep --repo <repo> --kill-holders [--remote-branches] --apply [--run <run>] [--specs-dir <그 Run 의 dir>].
//     --remote-branches 는 저장소 공유 일이라 주 Run 의 차례에서만 준다.
//     정리 출력의 `FINISH-MISSING #<PR> <글>` 줄(cleanup-sweep 머리 주석의 「마무리 빠짐」)은 그 Run 에 Orca 메시지로 FINISH-MISSING(pr 그 PR,
//     text `<글>. 마무리를 뒤늦게 돌리려면 orch.ts finish-pr <PR> --repo <repo> [--run <Run>]`)으로 옮긴다. 같은 PR 은
//     state/finish-missing.json 에 적어 한 번만 쓴다. 워크트리를 치우지 못해 다음 틱이 같은 줄을 내도 다시 깨우지 않는다

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isObject } from '../../core/json.ts'
import { orchWord, scriptPath } from '../../lib/commands.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { shQuote } from '../../lib/py.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { iso, lines, log, oneLine, relay, SWEEP_TIMEOUT_MS } from './shared.ts'

// 머리 주석의 「마무리 빠짐」. 정리 출력의 FINISH-MISSING 줄을 그 Run 에 Orca 메시지로 옮긴다. 같은 PR 은 한 번만 쓴다
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
  // 4. 정리. Run 마다 그 Run 범위로 돈다. 원격 브랜치 정리는 저장소 공유 일이라 주 Run 의 차례에서만 한다
  for (const [i, { run, specsDir }] of runs.entries()) {
    try {
      const sweep = process.env.CLEANUP_SWEEP || scriptPath('cleanup-sweep')
      const args = ['--repo', ctx.repo, '--kill-holders', ...(i === 0 ? ['--remote-branches'] : []), '--apply']
      if (run) args.push('--run', run)
      if (specsDir) args.push('--specs-dir', specsDir)
      const done = await runAsync(scriptCommand(sweep, args), { cwd: ctx.repo, timeoutMs: SWEEP_TIMEOUT_MS })
      relay(done)
      relayFinishMissing(ctx.repo, done.stdout, run)
      report('cleanup', done.code === 0 ? null : `종료 코드 ${done.code}`, { run })
    } catch (e) {
      report('cleanup', oneLine(e), { run })
    }
  }
  return { errors }
}
