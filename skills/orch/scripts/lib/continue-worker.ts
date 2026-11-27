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
//
// 멈춘 worker 이어 보내기(stopped 옵션. `orch worker continue` 가 켜고 상주 루프는 켜지 않는다):
//     PR 을 열기 전에 보고 없이 턴을 끝낸 worker 도 이어 가게 한다. 후속 지시 끝의 세 줄(send-to-worker 의 FOLLOW_UP_TURN)이 닿고,
//     첫머리에 「확인만 하고 끝내지 않는다」 를 둔 지시도 Codex 는 파일을 몇 개 읽고 「진행하겠습니다」 로 턴을 끝냈다
//     (2026-11-27 ai-analysis ctx_1138929eaecc 의 rollout 기록). 문구로는 막히지 않아 멈춘 뒤 다시 보내는 길을 둔다.
//     열린 PR 이 없으면 같은 브랜치의 MERGED PR 을 본다. 이 worker 를 띄운 뒤에 머지된 것이 있으면 끝난 일이라 대상이 아니고, 없으면 PR 없는 대상(pr null)이다.
//     띄운 시각은 영구 이력에서 같은 지시서와 브랜치로 띄운 가장 이른 행의 at 이다(후속 Task 로 이어 맡은 dispatch 도 처음 띄운 시각을 쓴다).
//     같은 브랜치 이름을 다시 쓴 새 worker 가 예전 머지 때문에 건너뛰지 않게 하려는 것이다(loop/completion-watch.ts 의 branchMerged 와 같은 기준).
//     띄운 시각을 모르면 머지된 PR 이 하나라도 있을 때 끝난 일로 본다. 조회가 실패하면 판단하지 않는다.
//     dispatch 가 살아 있어도 Orca 가 턴이 끝났다고 보면(worker-show 의 projection.stage.activity 가 done 이고 backgroundWait 가 없다) 대상이다.
//     그 dispatch 에 본문만 보낸다(send-to-worker --no-reply --body). 작업 중(working)이거나 백그라운드 작업을 기다리면 지금처럼 건너뛴다.
//     끝난 dispatch 는 PR 이 없어도 --spec --note 로 후속 Task 를 연다.
//     이 길로 보낸 횟수는 브랜치와 단계(PR 없음, PR 번호)마다 <orch 루트>/state/continue-stops.json 에 센다. STOP_LIMIT 번이면 더 보내지 않는다.
//     전송이 성공한 뒤에만 센다. PR 이 열리면 단계가 바뀌어 처음부터 센다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isObject } from '../core/json.ts'
import { NAMES, orchDir } from './paths.ts'
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
export type Target = { dispatch: string; run: string | null; spec: string; branch: string; pr: OpenPr | null }
export type Continued =
  | { kind: 'ok'; target: Target; dispatch: string; task: string; line: string; tries?: number }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string; target?: Target }

// 보내기를 기다리는 한도. send-to-worker 는 새 터미널을 띄우므로 조회보다 오래 걸린다
const SEND_MS = 180_000
const FOLLOW_UP = /^FOLLOW-UP (\S+) (\S+) (\S+)$/m
// 멈춘 worker 에게 같은 브랜치와 단계로 다시 보내는 횟수 상한
export const STOP_LIMIT = 2

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

// 보고 없이 턴을 끝낸 worker 에게 보내는 글. 할 일을 첫머리에 둔다
export function stoppedNote(pr: number | null): string {
  const head = '앞 턴이 보고 없이 끝났다. 이 턴에서 바로 지시서의 남은 할 일을 이어 한다. 계획이나 「이어 가겠다」 만 쓰고 턴을 끝내지 않는다. '
  const tail = pr === null
    ? '아직 PR 이 없다. 구현과 검증을 마쳐 PR 을 열고 지시서의 완료 조건을 채운 뒤 worker_done 을 보낸다.'
    : `PR #${pr} 이 열려 있다. 머지될 때까지 맡고, PR 이 MERGED 인 것을 확인한 뒤에만 worker_done 을 보낸다.`
  return `${head}${tail} 막혔으면 ask 를, 의도한 대기면 status 에 대기라고 적는다.`
}

// 같은 지시서와 브랜치로 처음 띄운 시각(ms). 이력에 없으면 null
function launchedSince(repo: string, spec: string, branch: string): number | null {
  const times = launchHistory(repo)
    .filter(row => row.spec === spec && (row.branch || branch) === branch)
    .map(row => Date.parse(row.at)).filter(Number.isFinite)
  return times.length > 0 ? Math.min(...times) : null
}

// 브랜치에 since 뒤 MERGED PR 이 있는지. since 가 null 이면 머지된 PR 이 하나라도 있는지다. 조회가 실패하면 error
function mergedPrOf(repo: string, branch: string, since: number | null): { ok: true; merged: boolean } | { ok: false; error: string } {
  const got = ghJson<Json[]>(['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefName,mergedAt', '--limit', '5'], { cwd: repo })
  if (!got.ok) return got
  if (!Array.isArray(got.data)) return { ok: false, error: 'gh pr list 의 출력이 목록이 아니다' }
  return { ok: true, merged: got.data.some(item => item && typeof item.number === 'number' && item.headRefName === branch &&
    (since === null || Date.parse(String(item.mergedAt ?? '')) >= since)) }
}

// 이어 맡길 대상인지 본다. 대상이 아니면 이유를 낸다. noPr 이면 아직 PR 을 열지 않은 브랜치도 대상이다(pr null)
export function continueTarget(repo: string, dispatch: string, knownPr: number | null = null, exclude: readonly number[] = [], noPr = false): { target: Target } | { skip: string } | { error: string } {
  const spec = specOf(repo, dispatch)
  if (typeof spec === 'string') return { skip: spec }
  const open = openPrOf(repo, spec.branch)
  if (!open.ok) return { error: open.error }
  if (!open.pr && noPr) {
    const merged = mergedPrOf(repo, spec.branch, launchedSince(repo, spec.spec, spec.branch))
    if (!merged.ok) return { error: merged.error }
    if (merged.merged) return { skip: `${spec.branch} 의 PR 이 이 worker 를 띄운 뒤 이미 머지됐다` }
    return { target: { dispatch, run: spec.run, spec: spec.spec, branch: spec.branch, pr: null } }
  }
  if (!open.pr) return { skip: `${spec.branch} 의 열린 PR 이 없다(머지됐거나 아직 열지 않았다)` }
  if (exclude.includes(open.pr.number)) return { skip: `PR #${open.pr.number} 은 이미 한 번 되돌렸다. 또 되돌리지 않는다` }
  if (knownPr !== null && open.pr.number !== knownPr) return { skip: `준비 보고의 PR #${knownPr} 이 아니라 #${open.pr.number} 이 열려 있다` }
  return { target: { dispatch, run: spec.run, spec: spec.spec, branch: spec.branch, pr: open.pr } }
}

// dispatch 상태와, 턴을 끝내고 입력을 기다리는지(projection.stage.activity 가 done 이고 백그라운드 대기가 없다)
function dispatchStatus(dispatch: string): { ok: true; status: string; turnEnded: boolean } | { ok: false; error: string } {
  const shown = orcaJson<Json>(['orchestration', 'worker-show', '--dispatch', dispatch])
  if (!shown.ok) return shown
  const info = shown.data?.dispatch
  const status = info && typeof info === 'object' ? String((info as Json).status ?? '') : ''
  const projection = shown.data?.projection
  const stage = isObject(projection) && isObject(projection.stage) ? projection.stage : {}
  return { ok: true, status, turnEnded: stage.activity === 'done' && !stage.backgroundWait }
}

type Stops = Record<string, number>
const stopsFile = (repo: string): string => join(orchDir(repo), NAMES.state, 'continue-stops.json')
const stopKey = (target: Target): string => `${target.branch}#${target.pr ? `pr${target.pr.number}` : 'nopr'}`

function readStops(repo: string): Stops {
  const file = stopsFile(repo)
  if (!existsSync(file)) return {}
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(data) ? (data as Stops) : {}
  } catch {
    // 깨진 기록은 처음부터 센다
    return {}
  }
}

// 멈춘 worker 에게 보낸 횟수를 하나 올린다. 쓰는 도중에 끝나도 앞 내용이 남게 임시 파일에 쓰고 이름을 바꾼다
function countStop(repo: string, key: string): number {
  const file = stopsFile(repo)
  const all = readStops(repo)
  const tries = (Number.isInteger(all[key]) ? all[key] : 0) + 1
  all[key] = tries
  mkdirSync(join(orchDir(repo), NAMES.state), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
  return tries
}

// 대상이면 send-to-worker 로 후속 지시를 보낸다. run 은 지정이 우선이고 없으면 띄우기 기록의 Run 이다
// stopped 는 `orch worker continue` 가 켠다. PR 없는 브랜치와, 살아 있지만 턴을 끝낸 dispatch 도 이어 보낸다(머리 주석의 「멈춘 worker 이어 보내기」)
export async function continueWorker(repo: string, dispatch: string, options: { notMain?: string; run?: string | null; knownPr?: number | null; exclude?: readonly number[]; stopped?: boolean } = {}): Promise<Continued> {
  const stopped = options.stopped === true
  const found = continueTarget(repo, dispatch, options.knownPr ?? null, options.exclude ?? [], stopped)
  if ('skip' in found) return { kind: 'skip', reason: found.skip }
  if ('error' in found) return { kind: 'fail', reason: `PR 상태를 읽지 못했다: ${found.error}` }
  const target = found.target
  const status = dispatchStatus(dispatch)
  if (!status.ok) return { kind: 'fail', reason: `dispatch 상태를 읽지 못했다: ${status.error}`, target }
  const live = LIVE_DISPATCH.has(status.status)
  if (live && !(stopped && status.turnEnded)) return { kind: 'skip', reason: `${dispatch} 는 아직 살아 있다(${status.status}). 끝난 뒤에 다시 한다` }
  // 상한을 세는 길: 멈춘 채 살아 있는 dispatch 와 PR 없는 브랜치. 머지 전 worker_done 을 되돌리는 길은 루프의 exclude 가 막는다
  const counted = live || target.pr === null
  const key = stopKey(target)
  const before = counted ? (readStops(repo)[key] ?? 0) : 0
  if (counted && before >= STOP_LIMIT) {
    return { kind: 'skip', reason: `${target.branch} 에 이미 ${before}번 이어 보냈다(상한 ${STOP_LIMIT}). 화면과 지시서를 코디네이터가 직접 본다` }
  }
  const run = options.run ?? target.run
  const send = process.env.SEND_TO_WORKER || scriptPath('send-to-worker')
  const note = counted ? stoppedNote(target.pr?.number ?? null) : continueNote(target.pr!.number)
  const args = live
    ? ['--dispatch', dispatch, '--no-reply', '--body', note, ...(run ? ['--run', run] : [])]
    : ['--dispatch', dispatch, '--spec', target.spec, '--note', note, ...(run ? ['--run', run] : [])]
  if (options.notMain !== undefined) args.push('--not-main', options.notMain)
  const sent = await runAsync(scriptCommand(send, args), { timeoutMs: SEND_MS })
  const shown = `${sent.stdout}${sent.stderr}`.trim()
  const tries = counted && sent.code === 0 ? countStop(repo, key) : undefined
  const follow = FOLLOW_UP.exec(sent.stdout)
  if (sent.code === 0 && follow) return { kind: 'ok', target, dispatch: follow[2], task: follow[3], line: follow[0], tries }
  // delivered(새 Task 없이 전달)와 살아 있는 dispatch 에 보낸 SENT 도 코드 0 이다. 새 dispatch 는 없거나 모른다
  if (sent.code === 0) return { kind: 'ok', target, dispatch, task: '', line: shown.split('\n').at(-1) ?? '', tries }
  return { kind: 'fail', reason: `send-to-worker 가 종료 코드 ${sent.code} 로 끝났다: ${shown.split('\n').at(-1) ?? ''}`, target }
}
