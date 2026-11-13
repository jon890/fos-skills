// worker 띄우기와 루프가 함께 쓰는 보드 연동. 쓰기는 board.ts 에 맡긴다.
// 지시서에 `중간 과정:` 줄이 있으면 띄울 때 항목을 만들지 않고 그 PR 의 기존 항목에 한 줄만 남긴다.
// `보드 항목 id:` 로 정한 항목이 done 이면 doing 으로 다시 열고 지난 단계 뒤에 새 단계를 잇는다(ADR-015).
// id 는 백틱 안의 글이나 공백 앞 첫 토큰이다(lib/spec.ts 의 boardIdOf). 설명이 붙었는데 보드에 없는 id 면 항목을 만들지 않는다
// 새 단계는 지시서의 「할 일」 이 아니라 사용자 마일스톤 단계다(lib/milestones.ts, ADR-018)

import { normalizeRef, urlFromLine } from '../core/task-adapters.ts'
import type { TaskAdapter } from '../core/task-adapters.ts'
import { taskAdapter } from './task-adapters.ts'
import { INTERIM, prNumbers, NOTE, detailText, detailArgs } from '../core/board.ts'
import { linesRev } from '../../../../extensions/work-board/bin/board.ts'
import type { BoardItem, BoardDetail, BoardStep } from '../core/board.ts'
import { parseEventTag } from '../../../../extensions/work-board/hooks/event-tags.js'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardSettings, DEFAULT_STEPS, DEFAULT_TASK_LINE, milestoneLines, specSteps, stagesOf, stagesText } from './milestones.ts'
import { section } from '../core/config.ts'
import { FINISH_KEYS } from '../core/finish-options.ts'
import { rulesFrom } from './last-pr.ts'
import { loadConfig } from './config.ts'
import { boardPath } from './board-file.ts'
import { NO_LIMIT_MS, run, scriptCommand } from './proc.ts'
import { boardIdOf, boardNewOf, workerRoleOf, interimOf } from './spec.ts'
import { boardWorkerRows } from '../core/board-workers.ts'
import type { WorkerRole } from '../core/board-workers.ts'
import { reviewPrOfSpec, isReviewItem, reviewOriginsByItem } from './review.ts'
import { launchHistory } from './launch-history.ts'
import { ghJson } from './gh.ts'
import { workerRows } from './workers.ts'
import { isLive } from './worker-state.ts'
import { workerEnds } from '../core/board-workers.ts'

export const BOARD_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../extensions/work-board/bin/board.ts')
export function readBoard(file: string): BoardItem[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')).items
  if (!raw || typeof raw !== 'object') throw new Error('보드 items 가 목록이나 객체가 아니다')
  return Array.isArray(raw) ? raw : Object.values(raw)
}

// 지시서 머리의 `중간 과정:` 줄은 lib/spec.ts 의 interimOf 가 읽는다. spec-lint 도 같은 판정을 써서 그쪽에 둔다
export { interimOf }

// board.ts 가 하위 항목 앞에 붙이는 완료 표시. hooks/register.js 의 STEP 과 같은 표시다
const LEAD_MARK = /^\s*(?:✓|\[[xX ]\]|▶|◇)\s*/

// 띄운 worker 의 역할을 정하고 같은 항목에 줄로 붙인다. 설계의 「역할 정하기」와 「대표 칸」이 원본이다.
// 리뷰·검증은 같은 워크트리, 명시한 id, 대상 PR, head 브랜치 순으로 찾고 상태·단계를 바꾸지 않는다.
// 구현·후속은 중간 과정, id, 같은 워크트리·브랜치, 업무 번호 순이다. 새로 요청은 자동 찾기를 끈다.
// 기존 항목의 대표 칸은 worker-add 가 잠금 안에서 쓰고, 실패할 때만 set 으로 돌아간다.
// 앞 PR 이 열린 마일스톤 항목에 새 브랜치의 후속 worker 가 붙으면 PR·머지 두 단계를 다음 번호로 더하고(step-add, 글 뒤에 `(<워크트리>)`),
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
  const eligible = items.filter((item) => !['decide', 'goal'].includes(String(item.status)))
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

export function staleBoardWrite(command: string[], result: { code: number; stderr: string }): boolean {
  return command.includes('--if-rev') && result.code === 1 &&
    result.stderr.split('\n').some((line) => line.endsWith(`읽은 뒤 ${command[1]} 의 줄이 바뀌어 저장하지 않았다. 다시 읽어 판정한다`))
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
  const items = readBoard(file)
  const task = taskOf(text, boardSettings(repo).taskLine)
  let adapter: TaskAdapter | null = null
  if (task) {
    try { adapter = taskAdapter(repo) }
    catch (e) { process.stderr.write(`보드: 설정 board.task 를 읽지 못해 업무 번호를 맞추지 않는다: ${(e as Error).message}\n`) }
  }
  const ref = task ? normalizeRef(adapter, task.number) : null
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
  function add(item: BoardItem | undefined, id: string, role: WorkerRole, stages = ''): boolean {
    const args = ['worker-add', id, role, '--worktree', wt, ...branchArgs, ...(dispatch ? ['--dispatch', dispatch] : []), ...(reviewPr ? ['--pr', String(reviewPr)] : []), ...(stages ? ['--stages', stages] : []), ...(item ? keepArgs(item) : [])]
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
    // 결정 항목과 목표 항목은 업무 항목이 아니라 중간 과정을 붙이지 않는다
    const open = items.filter((row) => !['done', 'decide', 'goal'].includes(String(row.status)) && typeof row.id === 'string')
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
  // 지시서가 id 를 정하지 않았으면 같은 워크트리나 브랜치의 끝나지 않은 항목을 이어 쓴다.
  // 충돌 후속 지시서로 같은 워크트리에 다시 띄운 worker 가 항목을 하나 더 만들지 않게 한다
  // 그다음은 같은 업무 번호의 항목이다. 한 업무의 다음 PR 이나 확인 작업을 다른 워크트리에서 띄워도 진행률이 한 항목에 모인다
  const open = items.filter((row) => !['done', 'decide', 'goal'].includes(String(row.status)) && typeof row.id === 'string')
  const latest = (rows: BoardItem[]) => rows.map((row, index) => ({ row, index })).sort((a, b) => String(a.row.stepAt ?? '').localeCompare(String(b.row.stepAt ?? '')) || a.index - b.index).at(-1)?.row
  const same = explicit
    ? undefined
    : reviewRole ? undefined : (freshOnly ? latest(open.filter((row) => row.worktree === wt)) :
      latest(open.filter((row) => current(row))) ?? latest(open.filter((row) => row.worktree === wt || (branch && row.branch === branch))) ??
      (task ? latest(open.filter((row) => row['task-ref'] === ref)) ?? latest(open.filter((row) => !row['task-ref'] && hasTask(row.title, task.number))) : undefined))
  const id = explicit || (same?.id as string | undefined) || name || basename(worktree)
  const title = specTitle(text, { items, explicit, task, id })
  const item = items.find((row) => row.id === id)
  const r = result(item, id, reviewRole ?? (item ? 'follow' : 'impl'))
  // 지시서 절이 있으면 설정을 읽지 않는다. 기존 항목은 단계를 바꾸지 않아 다시 열 때만 단계를 만든다
  const milestones = () => {
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
  const added = item && !reviewRole ? add(item, id, r.role, !reopen && r.role === 'follow' ? followStages(item) : '') : false
  const representative = added ? [] : ['--worktree', wt, ...branchArgs]
  if (item && reopen) {
    const old = lines(item.details)
      .map(plain)
      .filter((text) => !text.startsWith(NOTE) && !text.startsWith(INTERIM))
      .map((text) => ({ text, done: true }))
    // next 에만 단계가 있던 항목도 그 번호 다음부터 잇는다
    const numbers = [...old.map((d) => d.text), ...lines(item.next).map(plain)].map((text) => Number(/^(\d+)[.)]?\s/.exec(text)?.[1] ?? 0))
    const added = milestoneLines(milestones(), Math.max(0, ...numbers) + 1)
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
  const args = ['set', id, 'doing', '--title', title, '--worktree', basename(worktree), '--branch', branch, ...(stages ? ['--stages', stages] : [])]
  for (const step of fresh.details) args.push('--detail', step)
  write([...args, ...taskArgs])
  add(undefined, id, r.role)
  return r
  // 앞 PR 이 열려 있는 마일스톤 항목에 새 브랜치의 후속 줄이 붙을 때 더할 PR·머지 단계. 더한 번호를 `pr=N,merge=M` 로 돌려준다.
  // 앞 PR 이 아직 이어지지 않았거나 이미 머지됐으면, 같은 워크트리 재시도나 같은 브랜치이면, 단계 항목이 아니면 더하지 않는다(빈 문자열)
  function followStages(item: BoardItem): string {
    const merged = prNumbers(item['merged-pr'])
    const known = new Set([item.branch, ...boardWorkerRows(item).filter((row) => row.role === 'impl' || row.role === 'follow').map((row) => row.branch)])
    if (!branch || known.has(branch) || current(item) || !stagesOf(item) || ![...prNumbers(item.pr)].some((pr) => !merged.has(pr))) return ''
    const defs = milestones()
    const numbers: number[] = []
    for (const kind of ['pr', 'merge'] as const) {
      const base = (defs.find((step) => step.kind === kind) ?? DEFAULT_STEPS.find((step) => step.kind === kind) as { text: string }).text
      const done = run(scriptCommand(bin, ['step-add', id, `${base} (${wt})`, '--file', file]), { timeoutMs: NO_LIMIT_MS })
      const number = done.code === 0 ? Number((JSON.parse(done.stdout) as { number?: unknown }).number) : NaN
      if (!Number.isInteger(number)) {
        process.stderr.write(`보드: 후속 worker 의 ${kind} 단계를 더하지 못해 단계 묶음 없이 붙인다: ${done.stderr.trim() || done.code}\n`)
        return ''
      }
      numbers.push(number)
    }
    return `pr=${numbers[0]},merge=${numbers[1]}`
  }
  function write(args: string[]): void {
    const done = run(scriptCommand(bin, [...args, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (staleBoardWrite(args, done)) throw new StaleBoardWrite(done.stderr)
    if (done.code !== 0) throw new Error(done.stderr || `보드 명령 종료 코드 ${done.code}`)
  }
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

// 제목에 업무 번호가 든 항목인지. 번호 뒤에 숫자가 이어지면(`/282` 와 `/2821`) 다른 업무다
export function hasTask(title: unknown, number: string): boolean {
  if (typeof title !== 'string') return false
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_/-])${escaped}(?!\\p{N})`, 'u').test(title)
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

// rows 는 브랜치로 찾은 항목 가운데 worker 줄로 찾은 것의 항목 id → 그 줄의 워크트리다. 줄로 찾은 항목이 없으면 이 칸이 없다
export type BoardMatch = { by: 'pr' | 'branch'; ids: string[]; rows?: Record<string, string> }

// 머지한 PR 의 보드 항목. pr 칸에 그 PR 이 든 항목을 먼저 찾고, 없으면 아래 항목을 찾는다. 둘 다 done 항목과 merged-pr 에 이미 그 PR 이 든 항목은 뺀다.
// 이미 처리한 머지 PR 을 다시 연결하지 않기 위해서다.
//   - pr 칸이 비고 branch 가 PR 브랜치이거나 worktree 가 그 워크트리 이름인 항목
//   - worker 줄(구현·후속)의 브랜치나 워크트리가 같고 그 줄의 pr 이 빈 항목. 대표가 후속 줄로 바뀌어도 앞 줄의 PR 을 찾는다(PR 묶음, core/milestones.ts)
// 어느 쪽도 없거나 보드를 읽지 못하면 null 이다. 둘 이상이면 ids 에 모두 담는다
export function findBoardItems(file: string, pr: string, branch: string, worktree: string | null): BoardMatch | null {
  let items: BoardItem[]
  try {
    items = readBoard(file).filter((i) => typeof i === 'object' && i !== null && !Array.isArray(i) && Boolean(i.id))
  } catch {
    return null
  }
  const id = (i: BoardItem) => (typeof i.id === 'string' ? i.id : JSON.stringify(i.id))
  const byPr = items.filter((i) => prNumbers(i.pr).has(pr))
  if (byPr.length > 0) return { by: 'pr', ids: byPr.map(id) }
  const open = (i: BoardItem) => i.status !== 'done' && !prNumbers(i['merged-pr']).has(pr)
  const byBranch = items.filter(
    (i) =>
      prNumbers(i.pr).size === 0 &&
      open(i) &&
      ((branch && i.branch === branch) || (worktree && i.worktree === worktree)),
  )
  const rows: Record<string, string> = {}
  const byRow = items.filter((i) => {
    if (!open(i) || byBranch.includes(i)) return false
    const row = boardWorkerRows(i).find((one) => (one.role === 'impl' || one.role === 'follow') && prNumbers(one.pr).size === 0 &&
      ((branch && one.branch === branch) || (worktree && one.worktree === worktree)))
    if (row) rows[id(i)] = row.worktree
    return row !== undefined
  })
  const ids = [...byBranch, ...byRow].map(id)
  return ids.length > 0 ? { by: 'branch', ids, ...(Object.keys(rows).length > 0 ? { rows } : {}) } : null
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
  // worker 줄로 찾았으면 항목 pr 칸에 PR 을 더하고 그 줄의 pr 도 채운다. 칸에 다른 PR 이 이미 있을 수 있다
  const list = worktree === undefined ? number : [...prNumbers(readBoard(file).find((row) => row.id === id)?.pr), number].join(', ')
  const done = run(scriptCommand(bin, ['set', id, '--pr', list, ...(ref ? ['--fill', `--task-ref=${ref}`] : []), '--file', file]), { timeoutMs: NO_LIMIT_MS })
  if (done.code !== 0) throw new Error(done.stderr.trim() || `보드 명령 종료 코드 ${done.code}`)
  if (worktree !== undefined) {
    const row = run(scriptCommand(bin, ['worker-set', id, '--worktree', worktree, '--pr', number, '--file', file]), { timeoutMs: NO_LIMIT_MS })
    if (row.code !== 0) throw new Error(row.stderr.trim() || `보드 명령 종료 코드 ${row.code}`)
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
export { GET_FIELDS, itemTitle } from '../../../../extensions/work-board/bin/board.ts'
export type { BoardItem, BoardDetail, BoardStep } from '../core/board.ts'
