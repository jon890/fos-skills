// 부모 lifecycle.ts 가 쓰는 옛 번들 판정 상태와 다시 뜰 때의 판정이다. 직접 실행하지 않는다.
// 실패한 진입점과 처음 발견한 시각은 메모리에만 둔다. 사람이 다시 띄우면 다시 시도하기 위해서다.
// 넘기기(ADR-032): 생존 타이머 중지 → 새 루프 실행 → pid 잠금 교체 → 새 loop.json 확인 → 옛 루프 종료.
// 실패하면 새 루프를 끝내고 잠금을 되찾는다. 환경 값과 진입점 경로, pid 한 줄 잠금은 번들 사이 계약이다.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { bundleVersion } from '../lib/bundle.ts'
import { mainCheckout } from '../lib/git.ts'
import { pathOf } from '../lib/paths.ts'
import { run, signalCode, stopping } from '../lib/proc.ts'
import { alive, pidFileAlive } from '../lib/process.ts'
import { isLoopProcess, readLoop, registeredRuns, writeLoop } from '../lib/loop.ts'
import type { LoopState } from '../lib/loop.ts'
import { sendNotice } from '../lib/run-notice.ts'
import type { Context } from './steps/context.ts'
import { iso, log, oneLine } from './steps/shared.ts'

export const STALE_WAIT_MAX_MS = 60 * 60 * 1000
export const HANDOVER_ENV = 'ORCH_LOOP_HANDOVER'
export type SelfUpdate = { target: string | null; since: number | null; failed: string | null; waitReason: string | null }
export function newSelfUpdate(): SelfUpdate { return { target: null, since: null, failed: null, waitReason: null } }
export function heirEntry(bundle: string): string { return join(bundle, 'skills', 'orch', 'scripts', 'loop', 'orch-loop.ts') }

export function observe(s: SelfUpdate, target: string | null, now: number, own: string): string | null {
  if (target === null) { Object.assign(s, newSelfUpdate()); return null }
  if (target === s.target) return null
  s.target = target
  s.failed = null
  s.since ??= now
  return `LOOP-STALE ${bundleVersion(own) ?? '-'} ${bundleVersion(target) ?? '-'} ${heirEntry(target)}`
}

export function decide(input: { target: string | null; failed: string | null; since: number | null; now: number; busy: string | null; lastCode: number }): { kind: 'none' } | { kind: 'wait'; reason: string } | { kind: 'go' } {
  if (input.target === null || input.failed === heirEntry(input.target)) return { kind: 'none' }
  if (input.lastCode === 2 || (input.since !== null && input.now - input.since >= STALE_WAIT_MAX_MS)) return { kind: 'go' }
  return input.busy === null ? { kind: 'go' } : { kind: 'wait', reason: input.busy }
}

export function busyReason(repo: string): string | null {
  const queue = pathOf('queue', repo)
  let files: string[]
  try { files = readdirSync(queue).sort() }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return '마무리 목록을 읽지 못했다'
    files = []
  }
  for (const file of files) {
    const pr = /^finish-(\d+)\.pid$/.exec(file)?.[1]
    if (pr && pidFileAlive(join(queue, file))) return `마무리 PR ${pr}`
  }
  const ps = run([process.env.PS || 'ps', '-Ao', 'pid=,command='])
  if (ps.code !== 0) return '프로세스 목록을 읽지 못했다'
  for (const line of ps.stdout.split('\n')) {
    const found = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!found || !/merge_queue\.|merge-queue\.sh|merge-with-finish\./.test(found[2])) continue
    const target = /\s--repo\s+(\S+)/.exec(found[2])?.[1]
    if (!target || mainCheckout(target) === mainCheckout(repo)) return `머지 큐 pid ${found[1]}`
  }
  return null
}

export function updatedText(repoName: string, oldVersion: string, newVersion: string, oldBundle: string, newBundle: string): string {
  const paths = oldVersion === newVersion || oldVersion === '-' || newVersion === '-'
  const old = paths ? `${oldVersion}(${oldBundle})` : oldVersion
  const next = paths ? `${newVersion}(${newBundle})` : newVersion
  return `${repoName} 루프: ${old} → ${next} 으로 다시 떴다`
}

export function failedText(repoName: string, oldVersion: string, newVersion: string, reason: string, entry: string): string {
  return `${repoName} 루프: ${newVersion} 으로 다시 뜨지 못해 ${oldVersion} 으로 계속 돈다. ${reason}. 새 진입점: ${entry}`
}

let heir: number | null = null
export function pendingHeir(): number | null { return heir }

type HandoverOptions = {
  ctx: Context; state: LoopState; lock: string; entry: string; hadRuns: boolean
  stopTimer: () => void; startTimer: () => void
  oldVersion: string; newVersion: string; oldBundle: string; newBundle: string
  // 잠금 읽기·만들기와 인자·대기 한도는 lifecycle 의 기존 규칙을 그대로 쓴다.
  lockPid: (lock: string) => number; createLock: (lock: string) => boolean
  args: string[]; waitMs: number
}

function replaceLock(lock: string, pid: number): void {
  const temporary = `${lock}.${process.pid}.tmp`
  writeFileSync(temporary, String(pid))
  renameSync(temporary, lock)
}

function notices(opts: HandoverOptions, kind: string, text: string): void {
  for (const run of registeredRuns(opts.ctx.repo)) {
    try { sendNotice(kind, null, text, run.run, opts.ctx.repo) }
    catch (e) { log(`NOTICE-FAIL ${kind} ${oneLine(e)}`) }
  }
}

// 늦게 살아난 자식이 되찾은 잠금 뒤에 loop.json 을 덮지 않도록 종료를 확인한다.
async function endHeir(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const until = Date.now() + 5000
  while (alive(pid) && Date.now() < until) await sleep(100)
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝났다 */ } }
}

export async function handOver(opts: HandoverOptions): Promise<'handed' | 'failed' | 'lost'> {
  const { ctx, state, lock } = opts
  opts.stopTimer()
  state.alive_at = iso()
  writeLoop(ctx.repo, state)
  let reason: string | null = null
  let exited: number | null = null
  let failed: string | null = null
  let pid: number | undefined
  try {
    if (!existsSync(opts.entry)) reason = '진입점이 없다'
    else {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', opts.entry, ...opts.args, '--foreground'], {
        cwd: ctx.repo, detached: true, stdio: 'ignore',
        env: { ...process.env,
          ORCH_LOOP_BOUND: JSON.stringify('bound_run' in state ? { run: state.bound_run } : {}),
          [HANDOVER_ENV]: JSON.stringify({ from: process.pid, had_runs: opts.hadRuns }),
        },
      })
      child.on('exit', (code, signal) => { exited = code ?? signalCode(signal ?? 'SIGTERM') })
      child.on('error', e => { failed = e.message })
      child.unref()
      pid = child.pid
      heir = pid ?? null
      if (pid !== undefined) replaceLock(lock, pid)
      const until = Date.now() + opts.waitMs
      for (;;) {
        // 신호 처리기가 새 루프도 끝낸다. 이 경로에서는 잠금·상태를 다시 쓰지 않는다.
        if (stopping()) return 'lost'
        if (pid !== undefined && Number(readLoop(ctx.repo)?.pid) === pid) {
          log(`LOOP-HANDOVER ${pid} ${opts.oldVersion} ${opts.newVersion}`)
          notices(opts, 'LOOP-UPDATED', updatedText(basename(ctx.repo), opts.oldVersion, opts.newVersion, opts.oldBundle, opts.newBundle))
          heir = null
          return 'handed'
        }
        if (failed !== null) { reason = `띄우지 못했다: ${failed}`; break }
        if (exited !== null) { reason = `종료 코드 ${exited}`; break }
        if (Date.now() >= until) { reason = `${opts.waitMs / 1000}초 안에 loop.json 을 쓰지 않았다`; break }
        await sleep(100)
      }
    }
  } catch (e) { reason = `띄우지 못했다: ${oneLine(e)}` }
  if (pid !== undefined) await endHeir(pid)
  heir = null
  if (stopping()) return 'lost'
  const holder = opts.lockPid(lock)
  if (holder !== process.pid && holder !== pid && isLoopProcess(holder) !== false) {
    log(`LOOP-HANDOVER-LOST ${holder}`)
    return 'lost'
  }
  if (existsSync(lock)) replaceLock(lock, process.pid)
  else if (!opts.createLock(lock)) {
    log(`LOOP-HANDOVER-LOST ${opts.lockPid(lock)}`)
    return 'lost'
  }
  writeLoop(ctx.repo, state)
  opts.startTimer()
  log(`LOOP-UPDATE-FAIL ${reason}`)
  notices(opts, 'LOOP-UPDATE-FAIL', failedText(basename(ctx.repo), opts.oldVersion, opts.newVersion, reason!, opts.entry))
  return 'failed'
}
