// PR 이 열린 채 worker_done 을 보낸 worker 에게 「머지될 때까지 맡는다」 를 되돌려 보내 같은 워크트리에서 이어 맡게 한다.
// 상주 루프(loop/completion-watch.ts)와 `orch worker continue`(worker/continue-worker.ts)가 같은 판정과 전송을 쓴다.
//
// 왜 새 명령(relaunch)이 아니라 send-to-worker 의 후속 지시인가: 끝난 dispatch 에 Orca send 를 보내면 같은 워크트리에 새 터미널과
// 새 Task·dispatch 가 열린다(delivery: reopened 또는 follow_up. docs/features/orch-lib-layers/design.md 「설계 단계 실측」 2번).
// 그래서 completed dispatch 도 이어 맡길 수 있다. 막힌 것은 본문만 보내는 길이 닫힌 터미널을 ENDED 로 돌려보내는 것이었다.
// 지시서를 함께 주면(--spec) 후속 Task 가 되고, 띄우기 기록·보드·이벤트도 send-to-worker 가 남긴다. 여기서는 그 길에 이유(--note)를 붙인다.
//
// 대상 판정(continueTarget):
//     띄우기 기록(없으면 영구 이력)에서 지시서와 브랜치를 읽는다. 브랜치는 기록의 branch, 없으면 지시서의 첫 `브랜치:` 줄이다.
//     리뷰 dispatch(`리뷰 PR:` 지시서)와 PR 없는 dispatch(completion: none)는 PR 을 열지 않으므로 대상이 아니다.
//     그 브랜치의 열린 PR 이 있어야 한다. 이미 MERGED 이거나 PR 이 없으면 worker_done 이 맞다. 조회가 실패하면 판단하지 않는다.
//     dispatch 가 아직 살아 있으면(pending, dispatched, running) worker_done 이 정리되기 전이라 보내지 않는다.
//     exclude 에 든 PR 은 대상에서 뺀다. 루프가 같은 PR 을 되돌린 뒤 이어 맡은 worker 가 또 일찍 끝내도 끝없이 되돌리지 않으려는 것이다.
// 결과(Continued): ok 면 새 dispatch 와 PR, skip 이면 이어 맡길 대상이 아닌 이유, fail 이면 전송 실패와 수동 명령이다.

import { readFileSync } from 'node:fs'
import { ghJson } from './gh.ts'
import { launchHistory } from './launch-history.ts'
import { readLaunch } from './launched.ts'
import type { Launch } from './launched.ts'
import { orcaJson } from './orca.ts'
import { runAsync, scriptCommand } from './proc.ts'
import { scriptPath } from './commands.ts'
import { reviewPrOfSpec } from './review.ts'
import { branchesOf } from './spec.ts'
import { LIVE_DISPATCH } from './workers.ts'

export type OpenPr = { number: number; title: string; url: string; branch: string }
export type Target = { dispatch: string; run: string | null; spec: string; branch: string; pr: OpenPr }
export type Continued =
  | { kind: 'ok'; target: Target; dispatch: string; task: string; line: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string; target?: Target }

// 보내기를 기다리는 한도. send-to-worker 는 새 터미널을 띄우므로 조회보다 오래 걸린다
const SEND_MS = 180_000
const FOLLOW_UP = /^FOLLOW-UP (\S+) (\S+) (\S+)$/m

type Json = Record<string, unknown>

// 지시서를 읽어 낸다. 없거나 못 읽으면 null
function readSpec(path: string | null | undefined): string | null {
  if (!path) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function launchOf(repo: string, dispatch: string): Launch | null {
  const recorded = readLaunch(repo, dispatch)
  if (recorded) return recorded
  const found = launchHistory(repo).filter(row => row.dispatch === dispatch).at(-1)
  return found ?? null
}

// 이어 맡길 곳(지시서, 브랜치). 알아내지 못하면 이유를 낸다
export function specOf(repo: string, dispatch: string): { spec: string; text: string; branch: string; run: string | null } | string {
  const launch = launchOf(repo, dispatch)
  if (!launch) return '띄우기 기록과 이력에 이 dispatch 가 없다'
  if (launch.completion === 'none') return 'PR 없는 작업으로 띄운 dispatch 다'
  if (!launch.spec) return '지시서 경로를 모른다'
  const text = readSpec(launch.spec)
  if (text === null) return `지시서를 읽지 못했다: ${launch.spec}`
  if (reviewPrOfSpec(text) !== null) return '리뷰 worker 다. 리뷰 worker 는 PR 을 열지 않는다'
  const branch = launch.branch || branchesOf(text)[0]
  if (!branch) return '브랜치를 모른다'
  return { spec: launch.spec, text, branch, run: launch.run ?? null }
}

// 브랜치의 열린 PR. 조회가 실패하면 error, 없으면 null
export function openPrOf(repo: string, branch: string): { ok: true; pr: OpenPr | null } | { ok: false; error: string } {
  const got = ghJson<Json[]>(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title,url,headRefName', '--limit', '5'], { cwd: repo })
  if (!got.ok) return got
  if (!Array.isArray(got.data)) return { ok: false, error: 'gh pr list 의 출력이 목록이 아니다' }
  const row = got.data.find(item => item && typeof item.number === 'number' && item.headRefName === branch)
  if (!row) return { ok: true, pr: null }
  return { ok: true, pr: { number: row.number as number, title: String(row.title ?? ''), url: String(row.url ?? ''), branch } }
}

// worker 에게 되돌려 보내는 글. 지시서의 후속 지시 줄 뒤에 붙는다
export function continueNote(pr: number): string {
  return `PR #${pr} 이 아직 열려 있다. 앞서 보낸 worker_done 은 취소한다. 머지될 때까지 이 worker 가 맡는다. ` +
    `CI 실패, 충돌, 리뷰 스레드를 직접 처리하고 고쳐 push 하면 \`준비됨 #${pr}, head <40자리 SHA>\` 를 보낸다. ` +
    'PR 이 MERGED 인 것을 확인한 뒤에만 worker_done 을 다시 보낸다.'
}

// 이어 맡길 대상인지 본다. 대상이 아니면 이유를 낸다
export function continueTarget(repo: string, dispatch: string, knownPr: number | null = null, exclude: readonly number[] = []): { target: Target } | { skip: string } | { error: string } {
  const spec = specOf(repo, dispatch)
  if (typeof spec === 'string') return { skip: spec }
  const open = openPrOf(repo, spec.branch)
  if (!open.ok) return { error: open.error }
  if (!open.pr) return { skip: `${spec.branch} 의 열린 PR 이 없다(머지됐거나 아직 열지 않았다)` }
  if (exclude.includes(open.pr.number)) return { skip: `PR #${open.pr.number} 은 이미 한 번 되돌렸다. 또 되돌리지 않는다` }
  if (knownPr !== null && open.pr.number !== knownPr) return { skip: `준비 보고의 PR #${knownPr} 이 아니라 #${open.pr.number} 이 열려 있다` }
  return { target: { dispatch, run: spec.run, spec: spec.spec, branch: spec.branch, pr: open.pr } }
}

function dispatchStatus(dispatch: string): { ok: true; status: string } | { ok: false; error: string } {
  const shown = orcaJson<Json>(['orchestration', 'worker-show', '--dispatch', dispatch])
  if (!shown.ok) return shown
  const info = shown.data?.dispatch
  const status = info && typeof info === 'object' ? String((info as Json).status ?? '') : ''
  return { ok: true, status }
}

// 대상이면 send-to-worker 로 후속 지시를 보낸다. run 은 지정이 우선이고 없으면 띄우기 기록의 Run 이다
export async function continueWorker(repo: string, dispatch: string, options: { notMain?: string; run?: string | null; knownPr?: number | null; exclude?: readonly number[] } = {}): Promise<Continued> {
  const found = continueTarget(repo, dispatch, options.knownPr ?? null, options.exclude ?? [])
  if ('skip' in found) return { kind: 'skip', reason: found.skip }
  if ('error' in found) return { kind: 'fail', reason: `PR 상태를 읽지 못했다: ${found.error}` }
  const target = found.target
  const status = dispatchStatus(dispatch)
  if (!status.ok) return { kind: 'fail', reason: `dispatch 상태를 읽지 못했다: ${status.error}`, target }
  if (LIVE_DISPATCH.has(status.status)) return { kind: 'skip', reason: `${dispatch} 는 아직 살아 있다(${status.status}). 끝난 뒤에 다시 한다` }
  const run = options.run ?? target.run
  const send = process.env.SEND_TO_WORKER || scriptPath('send-to-worker')
  const args = ['--dispatch', dispatch, '--spec', target.spec, '--note', continueNote(target.pr.number), ...(run ? ['--run', run] : [])]
  if (options.notMain !== undefined) args.push('--not-main', options.notMain)
  const sent = await runAsync(scriptCommand(send, args), { timeoutMs: SEND_MS })
  const shown = `${sent.stdout}${sent.stderr}`.trim()
  const follow = FOLLOW_UP.exec(sent.stdout)
  if (sent.code === 0 && follow) return { kind: 'ok', target, dispatch: follow[2], task: follow[3], line: follow[0] }
  // delivered(새 Task 없이 전달)도 코드 0 이다. 이어 맡겼지만 새 dispatch 는 모른다
  if (sent.code === 0) return { kind: 'ok', target, dispatch, task: '', line: shown.split('\n').at(-1) ?? '' }
  return { kind: 'fail', reason: `send-to-worker 가 종료 코드 ${sent.code} 로 끝났다: ${shown.split('\n').at(-1) ?? ''}`, target }
}
