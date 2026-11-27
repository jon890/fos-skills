// worker 띄우기와 루프가 함께 쓰는 보드 연동. 쓰기는 board.ts 에 맡긴다.
// 지시서에 `중간 과정:` 줄이 있으면 띄울 때 항목을 만들지 않고 그 PR 의 기존 항목에 한 줄만 남긴다.
// `보드 항목 id:` 로 정한 항목이 done 이면 doing 으로 다시 열고 지난 단계 뒤에 새 단계를 잇는다(ADR-015).
// id 는 백틱 안의 글이나 공백 앞 첫 토큰이다(lib/spec.ts 의 boardIdOf). 설명이 붙었는데 보드에 없는 id 면 항목을 만들지 않는다
// 새 단계는 지시서의 「할 일」 이 아니라 사용자 마일스톤 단계다(lib/milestones.ts, ADR-018). 기본은 「PR 머지」 한 줄이다.
// PR 없는 지시서(core/completion.ts 의 noPrInstruction)만 「할 일」 의 번호 줄을 단계로 쓴다(todoSteps)
// 이미 있는 항목의 제목은 바꾸지 않는다. 새 항목도 set --create-only 로 만들어 그 사이 생긴 같은 id 를 덮지 않는다

import { normalizeRef, urlFromLine } from '../core/task-adapters.ts'
import type { TaskAdapter } from '../core/task-adapters.ts'
import { taskAdapter } from './task-adapters.ts'
import { INTERIM, prNumbers, NOTE, detailText, detailArgs, WORKER_REPORT_STEP } from '../core/board.ts'
import { linesRev } from '../../../../modules/work-board/item.ts'
import type { BoardItem, BoardDetail, BoardStep } from '../core/board.ts'
import { parseEventTag } from '../../../../extensions/work-board/hooks/event-tags.js'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { mainCheckout } from './git.ts'
import { featureStageText } from '../core/feature-stages.ts'
import { boardSettings, DEFAULT_STEPS, DEFAULT_TASK_LINE, milestoneLines, specSteps, stagesOf, stagesText } from './milestones.ts'
import type { MilestoneStep } from './milestones.ts'
import { section } from '../core/config.ts'
import { FINISH_KEYS } from '../core/finish-options.ts'
import { rulesFrom } from './last-pr.ts'
import { loadConfig } from './config.ts'
import { BOARD_BIN, boardPath, staleBoardWrite } from './board-file.ts'
import { NO_LIMIT_MS, run, scriptCommand } from './proc.ts'
import { findBoardItem, hasTask, type BoardQuery } from '../core/board-find.ts'
import { boardIdOf, boardNewOf, boardNoneOf, branchesOf, featureFolderOf, featureSpecTarget, featureStagesOf, taskFirstLine, workerRoleOf, interimOf } from './spec.ts'
import { noPrInstruction } from '../core/completion.ts'
import { boardWorkerRows } from '../core/board-workers.ts'
import type { WorkerRole } from '../core/board-workers.ts'
import { reviewPrOfSpec, isReviewItem, reviewOriginsByItem } from './review.ts'
import { launchHistory } from './launch-history.ts'
import { ghJson } from './gh.ts'
import { workerRows } from './workers.ts'
import { isLive } from './worker-state.ts'
import { workerEnds } from '../core/board-workers.ts'
import { matchBoardItems } from '../core/merge-readiness.ts'
import type { BoardMatch } from '../core/merge-readiness.ts'

export { BOARD_BIN, staleBoardWrite } from './board-file.ts'
export function readBoard(file: string): BoardItem[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')).items
  if (!raw || typeof raw !== 'object') throw new Error('보드 items 가 목록이나 객체가 아니다')
  const items: BoardItem[] = Array.isArray(raw) ? raw : Object.values(raw)
  for (const item of items) {
    if (item?.status === 'goal') item.status = 'doing'
  }
  return items
}

// 띄우기 이력으로 공유 보드의 항목 주인을 찾는다. 워크트리 이름이 겹치거나 이력을 읽지 못하면 끊김 판정에서 남의 워크트리라고 단정하지 않는다.
export function boardOwnership(repo: string, items: Record<string, unknown>[]): { ownItems: Set<string>; foreignWorktrees: Set<string> } {
  const ownItems = new Set<string>()
  const foreignWorktrees = new Set<string>()
  let dispatches: Set<string>
  try { dispatches = new Set(launchHistory(repo).map((row) => row.dispatch)) }
  catch { return { ownItems, foreignWorktrees } }
  if (dispatches.size === 0) return { ownItems, foreignWorktrees }
  const localWorktrees = new Set<string>()
  for (const item of items) {
    for (const row of boardWorkerRows(item)) {
      if (row.dispatch && dispatches.has(row.dispatch)) ownItems.add(String(item.id))
      if (!row.dispatch || dispatches.has(row.dispatch)) localWorktrees.add(row.worktree)
      else foreignWorktrees.add(row.worktree)
    }
  }
  for (const worktree of localWorktrees) foreignWorktrees.delete(worktree)
  return { ownItems, foreignWorktrees }
}

// 지시서 머리의 `중간 과정:` 줄은 lib/spec.ts 의 interimOf 가 읽는다. spec-lint 도 같은 판정을 써서 그쪽에 둔다
export { interimOf }

// board.ts 가 하위 항목 앞에 붙이는 완료 표시. hooks/register.js 의 STEP 과 같은 표시다
const LEAD_MARK = /^\s*(?:✓|\[[xX ]\]|▶|◇)\s*/

// 띄운 worker 의 역할을 정하고 같은 항목에 줄로 붙인다. 설계의 「역할 정하기」와 「대표 칸」이 원본이다.
// 리뷰·검증은 같은 워크트리, 명시한 id, 대상 PR, head 브랜치 순으로 찾고 상태·단계를 바꾸지 않는다.
// 구현·후속은 중간 과정, id, 같은 워크트리·브랜치, 업무 번호 순이다. 새로 요청은 자동 찾기를 끈다.
// 기존 항목의 대표 칸은 worker-add 가 잠금 안에서 쓰고, 실패할 때만 set 으로 돌아간다.
// 앞 PR 이 열린 마일스톤 항목에 새 브랜치의 후속 worker 가 붙으면 머지 단계(단계 정의에 [pr] 이 있으면 PR·머지 두 단계)를 다음 번호로 더하고(step-add, 글 뒤에 `(<워크트리>)`),
// 그 번호를 후속 줄의 stages 로 적는다(worker-add --stages). 순서는 단계 더하기, worker-add, set 이다. 규칙은 core/milestones.ts 의 「PR 묶음」 이다.
export type BoardAttach = { item: string; role: WorkerRole; attached: boolean }
export function registerBoard(repo: string, spec: string, worktree: string, name: string, branch: string, dispatch = ''): BoardAttach | null {
  const remembered: { value?: BoardAttach } = {}
  for (let attempt = 0; ; attempt++) {
    try { return registerBoardOnce(repo, spec, worktree, name, branch, dispatch, remembered) }
    catch (e) { if (!(e instanceof StaleBoardWrite) || attempt > 0) throw e }
  }
}

class StaleBoardWrite extends Error {}

function targetItem(items: BoardItem[], opts: { repo: string; worktree: string; branch: string; explicit?: string; freshOnly: boolean; reviewPr: number | null; verify: boolean; ref: string | null }): BoardItem | undefined {
  const latest = (rows: BoardItem[]) => rows.map((row, index) => ({ row, index })).sort((a, b) => String(a.row.stepAt ?? '').localeCompare(String(b.row.stepAt ?? '')) || a.index - b.index).at(-1)?.row
  const same = latest(items.filter((item) => boardWorkerRows(item).some((row) => row.worktree === opts.worktree)))
  if (same || opts.freshOnly) return same
  const explicit = items.find((item) => item.id === opts.explicit)
  if (explicit) return explicit
  const eligible = items.filter((item) => item.status !== 'decide')
  const open = eligible.filter((item) => item.status !== 'done')
  const byBranch = (branch: string) => branch ? latest(open.filter((item) => item.branch === branch || boardWorkerRows(item).some((row) => row.branch === branch))) : undefined
  if (opts.reviewPr) {
    const pr = String(opts.reviewPr)
    const linked = latest(eligible.filter((item) => prNumbers(item.pr).has(pr))) ?? latest(eligible.filter((item) => prNumbers(item['merged-pr']).has(pr)))
    if (linked) return linked
    const head = ghJson<{ headRefName?: string }>(['pr', 'view', pr, '--json', 'headRefName'], { cwd: opts.repo })
    return head.ok ? byBranch(head.data.headRefName ?? '') : undefined
  }
  if (opts.verify) return byBranch(opts.branch) ?? (opts.ref ? latest(open.filter((item) => item['task-ref'] === opts.ref)) : undefined)
  return undefined
}

function registerBoardOnce(repo: string, spec: string, worktree: string, name: string, branch: string, dispatch: string, remembered: { value?: BoardAttach }): BoardAttach | null {
  const file = boardPath(repo)
  if (!existsSync(file)) {
    const config = loadConfig(repo)
    const named = [config.finish?.board && 'finish.board', config.cleanup?.board && 'cleanup.board', config.board && 'board 절'].filter(Boolean)
    if (named.length > 0) throw new Error(`설정 파일에 ${named.join(', ')} 이 있지만 보드 파일이 없다: ${file}. {"items":[]} 로 만들면 다음부터 항목을 만든다`)
    return null
  }
  const text = readFileSync(spec, 'utf8')
  // 지시서가 보드 항목 없이 띄운다고 적었다. 이유가 빈 줄은 spec-lint 가 띄우기 전에 막는다
  if (boardNoneOf(text)) return null
  const items = readBoard(file)
  const { task, adapter, ref } = taskRefOf(repo, text)
  const url = task ? urlFromLine(adapter, task.line) : null
  let taskArgs = ref ? ['--fill', '--task-ref', ref, ...(url ? ['--task', url] : [])] : []
  if (ref && /\s/.test(ref)) { taskArgs = []; process.stderr.write('보드: 업무 번호에 공백이 있어 업무 칸을 채우지 않는다\n') }
  const bin = process.env.BOARD_BIN || BOARD_BIN
  const heading = text.match(/^#\s+(.+)$/m)?.[1].trim()
  const lines = (value: unknown): BoardDetail[] => (Array.isArray(value) ? value : value ? String(value).split('\n') : [])
  // 옛 문자열 줄은 앞에 완료 표시(✓)가 붙어 있어 떼고 본다
  const plain = (d: BoardDetail) => detailText(d).replace(LEAD_MARK, '')
  // 중간 과정과 다시 열기는 기존 항목을 고쳐, 브랜치를 읽지 못했으면 항목의 branch 칸을 지우지 않게 넘기지 않는다
  const branchArgs = branch ? ['--branch', branch] : []
  const freshOnly = boardNewOf(text)
  const reviewPr = reviewPrOfSpec(text)
  const reviewRole = workerRoleOf(text) ?? (reviewPr ? 'review' : null)
  const wt = basename(worktree)
  const current = (item: BoardItem) => boardWorkerRows(item).find((row) => row.worktree === wt)
  const result = (item: BoardItem | undefined, id: string, role: WorkerRole): BoardAttach =>
    remembered.value ??= { item: id, role: current(item ?? { id })?.role ?? role, attached: Boolean(item && !current(item) && item.worktree !== wt) }
  function keepArgs(item: BoardItem): string[] {
    if ('workers' in item || typeof item.worktree !== 'string' || !item.worktree.trim()) return []
    const role = isReviewItem(item, reviewOriginsByItem(repo, [item], dispatch)) ? 'review' : 'impl'
    const prior = launchHistory(repo).filter((row) => row.dispatch !== dispatch && basename(row.worktree) === item.worktree).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
    // 이력의 존재는 살아 있다는 증거가 아니다. 워크트리와 해당 Run 의 현재 dispatch 를 함께 확인한다.
    const listed = prior?.run && existsSync(prior.worktree) ? workerRows(prior.run, undefined, { strict: true, requireShape: true }) : null
    const row = listed?.ok ? listed.rows.find((row) => row.dispatchId === prior!.dispatch) : undefined
    const working = (listed && !listed.ok) || (row && isLive(row) && !workerEnds([row], new Set(), new Set([prior!.dispatch]))[prior!.dispatch])
    return ['--keep-current', role, ...(working ? ['--keep-dispatch', prior!.dispatch] : [])]
  }
  function add(item: BoardItem | undefined, id: string, role: WorkerRole, stages = '', todo = ''): boolean {
    const args = ['worker-add', id, role, '--worktree', wt, ...branchArgs, ...(dispatch ? ['--dispatch', dispatch] : []), ...(reviewPr ? ['--pr', String(reviewPr)] : []), ...(stages ? ['--stages', stages] : []), ...(todo ? ['--todo-steps', todo] : []), ...(item ? keepArgs(item) : [])]
    const done = run(scriptCommand(bin, [...args, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (done.code === 0) return true
    process.stderr.write(`보드: worker 줄을 쓰지 못했다: ${done.stderr.trim() || done.code}\n`)
    if (remembered.value) remembered.value.attached = false
    return false
  }
  if (reviewRole) {
    const target = targetItem(items, { repo, worktree: wt, branch, explicit: boardIdOf(text)?.id, freshOnly, reviewPr, verify: reviewRole === 'verify', ref })
    if (target) {
      const r = result(target, target.id, reviewRole)
      // 리뷰·검증은 대표 칸이 같은 옛 항목에서도 줄 추가 여부로 출력한다.
      if (!current(target) && !remembered.value?.attached && target.worktree !== wt) r.attached = true
      if (!add(target, target.id, r.role)) r.attached = false
      return r
    }
  }
  const interim = interimOf(text)
  if (interim && !reviewRole) {
    // 결정 항목은 업무 항목이 아니라 중간 과정을 붙이지 않는다
    const open = items.filter((row) => !['done', 'decide'].includes(String(row.status)) && typeof row.id === 'string')
    let found = interim.pr ? open.filter((row) => prNumbers(row.pr).has(interim.pr as string)) : []
    // CI 고침 worker 의 항목은 대개 pr 칸이 차 있어, pr 칸이 빈 항목만 보는 findBoardItems 를 쓰지 않는다
    if (found.length === 0) found = open.filter((row) => row.worktree === basename(worktree) || (branch && row.branch === branch))
    if (found.length !== 1) {
      const why = found.length === 0 ? `PR ${interim.pr ?? '번호 없음'}, 브랜치 ${branch || '없음'}, 워크트리 ${basename(worktree)} 의 항목이 없다` : `항목이 둘 이상이다: ${found.map((row) => row.id).join(', ')}`
      throw new Error(`중간 과정 지시서의 보드 항목을 찾지 못해 만들지 않는다: ${why}`)
    }
    const kept = lines(found[0].details).filter((d) => !plain(d).startsWith(INTERIM))
    const r = result(found[0], found[0].id, 'follow')
    const added = add(found[0], found[0].id, r.role)
    write(['set', found[0].id, ...(added ? [] : ['--worktree', wt, ...branchArgs]), ...detailArgs([...kept, INTERIM + (heading || basename(spec))]), ...taskArgs, '--if-rev', linesRev(found[0])])
    return r
  }
  const given = boardIdOf(text)
  const explicit = freshOnly ? undefined : given?.id
  // id 줄에 설명이 붙었는데 그 id 가 보드에 없으면 설명을 id 로 잘못 쓴 줄일 수 있어 새 항목을 만들지 않는다
  if (given?.note && !items.some((row) => row.id === given.id)) {
    throw new Error(`지시서의 \`보드 항목 id: ${given.id}\` 가 보드에 없고 뒤에 설명이 붙어 있어 항목을 만들지 않는다. id 만 적거나 설명을 다른 줄로 옮긴다`)
  }
  // 지시서가 id 를 정하지 않았으면 core/board-find.ts 의 findBoardItem 으로 붙일 항목을 고른다(같은 워크트리, 브랜치, 업무, 기능 폴더 순).
  // 충돌 후속 지시서로 같은 워크트리에 다시 띄운 worker 가 항목을 하나 더 만들지 않고, 한 업무나 기능의 다음 PR 이 한 항목에 모인다.
  // 찾지 못했거나 둘 이상이면 spec-lint 가 띄우기 전에 막는다. --lint-ack 으로 넘겼으면 지금처럼 워크트리 이름으로 만든다
  const open = items.filter((row) => !['done', 'decide'].includes(String(row.status)) && typeof row.id === 'string')
  const latest = (rows: BoardItem[]) => rows.map((row, index) => ({ row, index })).sort((a, b) => String(a.row.stepAt ?? '').localeCompare(String(b.row.stepAt ?? '')) || a.index - b.index).at(-1)?.row
  const findSame = () => {
    const found = findBoardItem(items, boardQuery(repo, text, wt, branch, { ref, task }))
    return 'item' in found ? found.item : undefined
  }
  const same = explicit || reviewRole ? undefined : freshOnly ? latest(open.filter((row) => row.worktree === wt)) : findSame()
  const id = explicit || (same?.id as string | undefined) || name || basename(worktree)
  const title = specTitle(text, { items, explicit, task, id })
  const item = items.find((row) => row.id === id)
  const r = result(item, id, reviewRole ?? (item ? 'follow' : 'impl'))
  const reportOnly = noPrInstruction(text)
  const featureStages = !reviewRole && featureSpecTarget(taskFirstLine(text)?.text ?? '') !== null ? featureStagesOf(text) : null
  if (featureStages) {
    const root = mainCheckout(repo)
    const feature = featureFolderOf(text, root)
    write(['worker-add', id, r.role, '--worktree', wt, '--title', title, ...branchArgs,
      ...(dispatch ? ['--dispatch', dispatch] : []), ...(reportOnly ? ['--feature-report'] : []), ...(item ? keepArgs(item) : []),
      ...(feature ? ['--feature', feature, '--feature-repo', root] : []),
      ...taskArgs.filter((arg, index) => index !== 0 || arg !== '--fill'),
      ...featureStages.flatMap((stage) => ['--feature-stage', `기능 ${featureStageText(stage)}`])])
    return r
  }
  // 지시서 절이 있으면 설정을 읽지 않는다. 기존 항목은 단계를 바꾸지 않아 다시 열 때만 단계를 만든다
  // PR 없는 일은 기본 단계를 붙이지 않고 「할 일」 의 번호 줄을 단계로 쓴다. 번호 줄이 없으면 보고 받기 한 줄이다.
  // worker_done 의 `steps=` 나 번호 없는 worker_done 이 이 단계를 끝낸다(board-sync.ts 의 --worker-steps)
  const milestones = (): MilestoneStep[] => {
    if (reportOnly) {
      const todo = todoSteps(text)
      return todo.length > 0 ? todo.map((line) => ({ kind: null, text: line })) : [{ kind: null, text: WORKER_REPORT_STEP }]
    }
    const given = specSteps(text)
    if (given) return given
    return boardSettings(repo).steps ?? [...DEFAULT_STEPS]
  }
  // 앞 PR 이 머지돼 단계가 모두 끝난 채 doing 으로 남은 항목에 새 브랜치의 worker 를 띄우면 그 PR 의 단계를 잇는다.
  // 같은 브랜치를 다시 띄우면(--resume-remote, 재시도) 더하지 않는다
  const nextPr =
    !!item && item.status !== 'done' && !!branch && item.branch !== branch &&
    prNumbers(item['merged-pr']).size > 0 && allStagesDone(item)
  const reopen = !!item && ((explicit && item.status === 'done') || nextPr)
  // 다시 열면 새 단계는 지난 단계 번호 다음부터다. next 에만 단계가 있던 항목도 그 번호 다음부터 잇는다
  const reopenStart = item && reopen ? Math.max(0, ...[...lines(item.details), ...lines(item.next)].map(plain).map((text) => Number(/^(\d+)[.)]?\s/.exec(text)?.[1] ?? 0))) + 1 : 1
  // PR 없는 일의 「할 일」 번호 → 보드 단계 번호(worker 줄의 todo-steps). worker_done 의 steps= 를 이 짝으로 옮긴다.
  // 새 단계를 만들지 않는 기존 항목에 붙으면 짝이 없다(빈 문자열)
  const todoMap = (start: number): string => reportOnly ? [...todoNumbered(text).keys()].map((n, i) => `${n}=${start + i}`).join(',') : ''
  const added = item && !reviewRole ? add(item, id, r.role, !reopen && r.role === 'follow' ? followStages(item) : '', reopen ? todoMap(reopenStart) : '') : false
  const representative = added ? [] : ['--worktree', wt, ...branchArgs]
  if (item && reopen) {
    const old = lines(item.details)
      .map(plain)
      .filter((text) => !text.startsWith(NOTE) && !text.startsWith(INTERIM))
      .map((text) => ({ text, done: true }))
    const added = milestoneLines(milestones(), reopenStart)
    // progress 칸에 옛 값(3/3)이 남아 있으면 단계 수보다 앞서 진행률이 100% 로 남아 지운다.
    // 제목은 사용자가 정한 마일스톤이라 이어 띄운 지시서의 머리줄로 바꾸지 않는다
    const args = ['set', id, 'doing', ...representative, '--progress', 'auto', '--stages', stagesText(added.stages)]
    const merged = [...prNumbers(item.pr)]
    if (merged.length) args.push('--pr', '', '--merged-pr', [...new Set([...merged, ...prNumbers(item['merged-pr'])])].join(', '))
    write([...args, ...detailArgs([...old, ...added.details]), ...taskArgs, '--if-rev', linesRev(item)])
    return r
  }
  // 이미 있는 끝나지 않은 항목은 제목과 단계를 그대로 두고 worker 의 워크트리와 브랜치만 바꾼다.
  // 이어 띄운 지시서(충돌 풀기, CI 고침)의 머리줄과 할 일이 마일스톤 제목과 단계를 덮지 않게 한다.
  // 단계도 progress 도 없는 항목을 doing 으로 두면 board.ts 가 거절해 status 도 그대로 둔다
  if (item) {
    const known = run(scriptCommand(bin, ['steps', id, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (known.code !== 0) throw new Error(known.stderr || '단계 목록을 읽지 못했다')
    const ready = JSON.parse(known.stdout).length > 0 || /^\s*\d+\s*\/\s*\d+\s*$/.test(String(item.progress ?? ''))
    write(['set', id, ...(ready ? ['doing'] : []), ...representative, ...taskArgs])
    return r
  }
  const fresh = milestoneLines(milestones())
  const stages = stagesText(fresh.stages)
  // 새 항목만 만든다. 읽은 뒤 같은 id 가 생겼으면 덮지 않고 다시 읽어 기존 항목 규칙으로 붙인다(제목을 지시서 머리줄로 바꾸지 않는다)
  const args = ['set', id, 'doing', '--create-only', '--title', title, '--worktree', basename(worktree), '--branch', branch, ...(stages ? ['--stages', stages] : [])]
  for (const step of fresh.details) args.push('--detail', step)
  write([...args, ...taskArgs])
  add(undefined, id, r.role, '', todoMap(1))
  return r
  // 앞 PR 이 열려 있는 마일스톤 항목에 새 브랜치의 후속 줄이 붙을 때 더할 PR·머지 단계. 더한 번호를 `pr=N,merge=M` 로 돌려준다.
  // 앞 PR 이 아직 이어지지 않았거나 이미 머지됐으면, 같은 워크트리 재시도나 같은 브랜치이면, 단계 항목이 아니면 더하지 않는다(빈 문자열)
  function followStages(item: BoardItem): string {
    if (reportOnly) return ''
    const merged = prNumbers(item['merged-pr'])
    const known = new Set([item.branch, ...boardWorkerRows(item).filter((row) => row.role === 'impl' || row.role === 'follow').map((row) => row.branch)])
    if (!branch || known.has(branch) || current(item) || !stagesOf(item) || ![...prNumbers(item.pr)].some((pr) => !merged.has(pr))) return ''
    const defs = milestones()
    const numbers: number[] = []
    // 단계 정의에 [pr] 단계가 없으면(기본 「PR 머지」 한 줄) 머지 단계 하나만 더한다.
    // 항목이 옛 두 줄(stages 에 pr 이 있다)이면 그 꼴을 따라 PR·머지 두 줄을 더한다. 단계 정의에 [pr] 이 없으면 옛 글(PR, 머지)을 쓴다
    const legacy = stagesOf(item)?.pr !== undefined && !defs.some((step) => step.kind === 'pr')
    const kinds = legacy || defs.some((step) => step.kind === 'pr') ? (['pr', 'merge'] as const) : (['merge'] as const)
    for (const kind of kinds) {
      const base = legacy ? LEGACY_STEP_TEXT[kind] : (defs.find((step) => step.kind === kind) ?? DEFAULT_STEPS.find((step) => step.kind === kind) ?? { text: LEGACY_STEP_TEXT[kind] }).text
      const done = run(scriptCommand(bin, ['step-add', id, `${base} (${wt})`, '--file', file]), { timeoutMs: NO_LIMIT_MS })
      const number = done.code === 0 ? Number((JSON.parse(done.stdout) as { number?: unknown }).number) : NaN
      if (!Number.isInteger(number)) {
        process.stderr.write(`보드: 후속 worker 의 ${kind} 단계를 더하지 못해 단계 묶음 없이 붙인다: ${done.stderr.trim() || done.code}\n`)
        return ''
      }
      numbers.push(number)
    }
    return numbers.length === 2 ? `pr=${numbers[0]},merge=${numbers[1]}` : `merge=${numbers[0]}`
  }
  function write(args: string[]): void {
    const done = run(scriptCommand(bin, [...args, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (staleBoardWrite(args, done) || (args.includes('--create-only') && /이미 있는 항목이다/.test(done.stderr))) throw new StaleBoardWrite(done.stderr)
    if (done.code !== 0) throw new Error(done.stderr || `보드 명령 종료 코드 ${done.code}`)
  }
}

// 옛 기본 단계(PR, 머지 두 줄)의 글. 옛 두 줄 항목에 후속 묶음을 더할 때 쓴다
const LEGACY_STEP_TEXT = { pr: 'PR', merge: '머지' } as const

// 지시서 「할 일」 절의 맨 앞 번호 줄 글. 들여 쓴 하위 줄과 예시 블록은 읽지 않는다. 굵게 표시와 코드 표시를 떼고
// 첫 문장만 80자 안으로 줄인다(보드 줄 규칙). 절이 없거나 번호 줄이 없으면 빈 목록이다
export function todoSteps(text: string): string[] {
  return [...todoNumbered(text).values()]
}

// 「할 일」 번호 → 보드 단계 글. todoSteps 와 같은 줄을 읽고, worker_done 의 steps= 번호를 단계 글로 옮길 때 쓴다
export function todoNumbered(text: string): Map<number, string> {
  let fence = false
  const lines = text.split('\n').filter((line) => {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) { fence = !fence; return false }
    return !fence
  })
  const at = lines.findIndex((line) => /^##\s+할 일(?:\s.*)?$/.test(line))
  const steps = new Map<number, string>()
  if (at < 0) return steps
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(line)) break
    const match = /^(\d+)[.)]\s+(.+)$/.exec(line)
    if (!match) continue
    const body = match[2]
    const plain = body.replaceAll('**', '').replace(/`([^`]*)`/g, '$1').trim()
    const sentence = plain.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? plain
    if (!steps.has(Number(match[1]))) steps.set(Number(match[1]), sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence)
  }
  return steps
}

// 번호 단계가 하나 이상이고 모두 끝났는가. 번호 없는 줄(남은 일, 자동 줄)은 보지 않는다
function allStagesDone(item: BoardItem): boolean {
  const steps = (Array.isArray(item.details) ? item.details : []).filter((d) => /^\d+[.)]\s/.test(detailText(d).replace(LEAD_MARK, '')))
  return steps.length > 0 && steps.every((d) => (typeof d === 'string' ? /^\s*(?:✓|\[[xX]\])/.test(d) : d.done === true))
}

export type SpecTask = { number: string; title: string | null; line: string }

// 지시서의 업무 연결 줄(`두레이 업무: EXAMPLE-PROJECT/282 「제목」`)에서 읽은 업무 번호와 제목. 줄이 없으면 null 이다.
// pattern 은 board.task_line(lib/milestones.ts 의 boardSettings)이고 없으면 DEFAULT_TASK_LINE 이다.
// 이름 붙은 묶음 number 가 번호, title 이 제목이다. 제목 묶음이 없거나 비었으면 title 은 null 이다
export function taskOf(text: string, pattern: RegExp | null = null): SpecTask | null {
  const p = pattern ?? DEFAULT_TASK_LINE
  const match = new RegExp(p.source, p.flags.includes('d') ? p.flags : p.flags + 'd').exec(text)
  const groups = match?.groups
  const number = groups?.number?.trim()
  if (!number) return null
  // ^\s* 가 앞 빈 줄을 먹어도 number 묶음이 든 실제 줄을 고른다.
  const at = match?.indices?.groups?.number?.[0] ?? 0
  const start = text.lastIndexOf('\n', at - 1) + 1
  const end = text.indexOf('\n', at)
  return { number, title: groups?.title?.trim() || null, line: text.slice(start, end < 0 ? undefined : end) }
}

export { hasTask }

// 지시서의 업무 연결 줄과 그 번호를 어댑터로 맞춘 task-ref. 설정을 읽지 못하면 번호를 그대로 쓰지 않고 ref 를 null 로 둔다
export function taskRefOf(repo: string, text: string): { task: SpecTask | null; adapter: TaskAdapter | null; ref: string | null } {
  const task = taskOf(text, boardSettings(repo).taskLine)
  let adapter: TaskAdapter | null = null
  if (task) {
    try { adapter = taskAdapter(repo) }
    catch (e) { process.stderr.write(`보드: 설정 board.task 를 읽지 못해 업무 번호를 맞추지 않는다: ${(e as Error).message}\n`) }
  }
  return { task, adapter, ref: task ? normalizeRef(adapter, task.number) : null }
}

// 지시서로 붙일 항목을 찾을 질의(core/board-find.ts). spec-lint 의 `보드` 발견과 registerBoard 가 같은 값을 쓴다.
// 브랜치를 주지 않으면 지시서의 `브랜치:` 줄을 쓴다. 기능 폴더의 저장소는 주 checkout 실경로다
export function boardQuery(repo: string, text: string, worktree: string, branch?: string, known?: { ref: string | null; task: SpecTask | null }): BoardQuery {
  const { task, ref } = known ?? taskRefOf(repo, text)
  const root = mainCheckout(repo)
  const path = featureFolderOf(text, root)
  return { worktree, branch: branch ?? branchesOf(text)[0] ?? '', ref, taskNumber: task?.number ?? null, feature: path ? { path, repo: root } : null }
}

// `## 목표` 절의 첫 문장. 목록 기호와 굵게 표시는 뗀다. 절이 없거나 비었으면 null 이다
export function goalSentence(text: string): string | null {
  const body = text.match(/^##\s+목표[^\n]*\n([\s\S]*?)(?=^#{1,2}\s|$(?![\s\S]))/m)?.[1]
  const line = body
    ?.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replaceAll('**', '').trim())
    .find(Boolean)
  if (!line) return null
  return line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line
}

// 새 보드 항목의 제목. 아래 순서로 처음 있는 것이다. spec-lint 의 제목 경고와 references/spec-writing.md 의 지시서 첫 줄이 이 순서를 가리킨다
//   1. 지시서의 `# ` 제목 줄
//   2. `보드 항목 id:` 가 가리키는 기존 항목의 제목. 사용자가 정한 제목이라 업무 번호를 붙이지 않는다
//   3. 업무 연결 줄의 제목
//   4. `## 목표` 절의 첫 문장
//   5. 항목 id
export function specTitle(text: string, opts: { items: BoardItem[]; explicit?: string; task: SpecTask | null; id: string }): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1].trim()
  const existing = opts.explicit ? opts.items.find((row) => row.id === opts.explicit)?.title : undefined
  if (!heading && typeof existing === 'string' && existing.trim()) return existing.trim()
  const title = heading || opts.task?.title || goalSentence(text) || opts.id
  return title
}

export type { BoardMatch } from '../core/merge-readiness.ts'

// 머지한 PR 의 보드 항목. pr 칸에 그 PR 이 든 항목을 먼저 찾고, 없으면 아래 항목을 찾는다. 둘 다 done 항목과 merged-pr 에 이미 그 PR 이 든 항목은 뺀다.
// 이미 처리한 머지 PR 을 다시 연결하지 않기 위해서다.
//   - pr 칸이 비고 branch 가 PR 브랜치이거나 worktree 가 그 워크트리 이름인 항목
//   - worker 줄(구현·후속)의 브랜치나 워크트리가 같고 그 줄의 pr 이 빈 항목. 대표가 후속 줄로 바뀌어도 앞 줄의 PR 을 찾는다(PR 묶음, core/milestones.ts)
// 어느 쪽도 없거나 보드를 읽지 못하면 null 이다. 둘 이상이면 ids 에 모두 담는다
export function findBoardItems(file: string, pr: string, branch: string, worktree: string | null, repo?: string): BoardMatch | null {
  let items: BoardItem[]
  try {
    items = readBoard(file)
  } catch {
    return null
  }
  if (repo) {
    const root = mainCheckout(repo)
    items = items.filter((item) => !item['feature-repo'] || item['feature-repo'] === root)
  }
  return matchBoardItems(items, pr, branch, worktree)
}

// 보드 명령(board.ts steps)이 판정한 단계 목록. 읽지 못하면 null 이다
export function boardSteps(bin: string, id: string, file: string): BoardStep[] | null {
  const done = run(scriptCommand(bin, ['steps', id, '--file', file]), { killSignal: 'SIGKILL' })
  if (done.code !== 0) return null
  try {
    const steps: unknown = JSON.parse(done.stdout)
    return Array.isArray(steps) ? (steps as BoardStep[]) : null
  } catch {
    return null
  }
}

// PR 제목의 업무 번호를 설정 규칙으로 읽고 어댑터의 번호 꼴로 맞춘다. 규칙이나 설정을 읽지 못하면 null 이다.
// extractTaskNumber 는 마지막 PR 판정의 기존 영문 번호 계약을 유지한다.
// 보드 번호는 한글 프로젝트도 받아야 하므로 별도로 검사한다(ADR-031, 설계 DECISION5).
// 보드 연결 기능 때문에 마지막 PR 판정의 허용 문자를 넓히지 않는다.
export function prTaskRef(repo: string, title: string): string | null {
  try {
    const finish = section<Record<string, unknown>>(loadConfig(repo), 'finish', FINISH_KEYS)
    const ref = rulesFrom(finish, repo).taskPattern?.exec(title)?.[1]
    return ref && /^[\p{L}\p{N}._/-]+$/u.test(ref) ? normalizeRef(taskAdapter(repo), ref) : null
  } catch { return null }
}

// pr 칸이 빈 항목을 브랜치로 찾아 그 PR 번호로 채운다. 채운 항목 id 를 내고, 찾지 못했거나 pr 칸에 이미 든 항목이거나
// 둘 이상이면 null 이다. 보드 명령이 실패하면 Error 다
// ref 를 주면 업무 번호도 빈 칸일 때만 함께 채운다.
export function linkBoardPr(file: string, number: string, branch: string, ref?: string | null): string | null {
  const found = findBoardItems(file, number, branch, null)
  if (!found || found.by !== 'branch' || found.ids.length !== 1) return null
  const bin = process.env.BOARD_BIN || BOARD_BIN
  const id = found.ids[0]
  const worktree = found.rows?.[id]
  // worker 줄로 찾았으면 줄의 pr 과 항목 pr 칸을 worker-link 하나로 함께 쓴다(한 잠금, 한 번 저장). 칸에 다른 PR 이 이미 있을 수 있다
  const done = worktree === undefined
    ? run(scriptCommand(bin, ['set', id, '--pr', number, ...(ref ? ['--fill', `--task-ref=${ref}`] : []), '--file', file]), { timeoutMs: NO_LIMIT_MS })
    : run(scriptCommand(bin, ['worker-link', id, '--worktree', worktree, '--pr', number, '--file', file]), { timeoutMs: NO_LIMIT_MS })
  if (done.code !== 0) throw new Error(done.stderr.trim() || `보드 명령 종료 코드 ${done.code}`)
  if (worktree !== undefined && ref) {
    const fill = run(scriptCommand(bin, ['set', id, '--fill', `--task-ref=${ref}`, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (fill.code !== 0) throw new Error(fill.stderr.trim() || `보드 명령 종료 코드 ${fill.code}`)
  }
  return id
}

// 진행률을 세는 쪽은 board.ts steps 가 정한다. 꼬리표 후보가 없는 항목은 CLI 를 부르지 않는다.
export function taggedBoardSteps(bin: string, id: string, file: string, item: Record<string, unknown>): BoardStep[] | null {
  if (!hasEventTags(item)) return []
  const steps = boardSteps(bin, id, file)
  return steps === null ? null : steps.filter((step) => parseEventTag(step.text))
}

export function hasEventTags(item: Record<string, unknown>): boolean {
  const candidates = ['details', 'next'].flatMap((key) => Array.isArray(item[key]) ? item[key] as BoardDetail[] : String(item[key] || '').split('\n'))
  return candidates.some((line) => parseEventTag(detailText(line)))
}

export { INTERIM, prNumbers, NOTE, detailText, detailArgs, noteLine, withNote, prSteps, intermediateCommands } from '../core/board.ts'
export { guardedCommands } from '../core/board.ts'
export { linesRev }
export { GET_FIELDS, itemTitle } from '../../../../modules/work-board/item.ts'
export type { BoardItem, BoardDetail, BoardStep } from '../core/board.ts'
