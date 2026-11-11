// 보드와 근거, worker·PR 을 읽어 자동 진행 여부를 확인한다. 확인만으로 상태를 쓰지 않는다.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { hideEventTag, parseEventTag, stageTag } from '../../../../extensions/work-board/hooks/event-tags.js'
import { parseStepMark } from '../../../../extensions/work-board/hooks/step-marks.js'
import { ADVANCE_REASONS as R, autoAdvanceOf, eventDone, itemBusy, judgeAdvance } from '../core/auto-advance.ts'
import type { AdvanceInput, AdvanceVerdict, BoardView } from '../core/auto-advance.ts'
import { parseEvidence } from '../core/evidence.ts'
import { BOARD_BIN, boardSteps, prNumbers, readBoard } from './board.ts'
import { boardPath } from './board-file.ts'
import { loadConfig } from './config.ts'
import { ghJson } from './gh.ts'
import { mainCheckout } from './git.ts'
import { registeredRuns } from './loop.ts'
import { stagesOf } from './milestones.ts'
import { openRows, worktreeOf } from './movement.ts'
import { confirmProblem } from './spec-confirm.ts'
import { appendStepLaunch, stepLaunches } from './step-launches.ts'
import { workerRows, worktreePaths } from './workers.ts'

export type PendingStep = { number: number; mark: 'auto' | 'ask' | 'wait' | null; condition: string | null; text: string; key: string; body: string }

export function firstPendingStep(file: string, item: Record<string, unknown>): PendingStep | null {
  const steps = boardSteps(process.env.BOARD_BIN || BOARD_BIN, String(item.id), file)
  if (!steps) throw new Error(`단계 목록을 읽지 못했다: ${item.id}`)
  const step = steps.find(row => !row.done)
  if (!step) return null
  const parsed = parseStepMark(step.text)
  const event = Object.values(stagesOf(item) ?? {}).includes(step.number) || stageTag(step.text) !== null
  return { number: step.number, mark: event ? null : parsed?.mark ?? null, condition: event ? null : parsed?.condition ?? null,
    text: step.text, key: hideEventTag(step.text), body: parsed?.body ?? step.text }
}

function boardViews(file: string, items: Record<string, unknown>[], pr: string): BoardView[] {
  // 단계 고르기는 보드 도구가 맡되, 해당 PR 의 근거가 될 수 있는 항목만 조회한다.
  const related = items.filter(item => prNumbers(item.pr).has(pr) || prNumbers(item['merged-pr']).has(pr) ||
    JSON.stringify([item.details, item.next]).includes(`(#${pr} `))
  return related.map(item => ({
    pr: [...prNumbers(item.pr)], mergedPr: [...prNumbers(item['merged-pr'])], stages: stagesOf(item),
    steps: (stagesOf(item) || JSON.stringify([item.details, item.next]).includes('(#') ?
      boardSteps(process.env.BOARD_BIN || BOARD_BIN, String(item.id), file) ?? [] : [])
      .map(step => ({ ...step, tag: parseEventTag(step.text) })),
  }))
}

function busyOf(repo: string, item: Record<string, unknown>, launches: ReturnType<typeof stepLaunches>, run?: string): boolean | null {
  const runs = new Set([...registeredRuns(repo).map(row => row.run), ...(run ? [run] : [])])
  if (!runs.size) return null
  const live = { paths: new Set<string>(), dispatches: new Set<string>() }
  for (const id of runs) {
    const got = workerRows(id, undefined, { strict: true, requireShape: true })
    if (!got.ok) return null
    for (const row of openRows(got.rows)) {
      const path = worktreeOf(row)
      if (path) live.paths.add(path)
      live.dispatches.add(String(row.dispatchId))
    }
  }
  const prs = ghJson<Array<{ number: number; headRefName: string }>>(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName'], { cwd: repo, cache: false })
  if (!prs.ok || !Array.isArray(prs.data) || prs.data.some(pr => !pr || !Number.isInteger(pr.number) || pr.number < 1 || typeof pr.headRefName !== 'string' || !pr.headRefName.trim())) return null
  const value = (key: string) => typeof item[key] === 'string' ? (item[key] as string).trim() || null : null
  return itemBusy({ worktree: value('worktree'), branch: value('branch'), pr: [...prNumbers(item.pr)] }, launches, live, worktreePaths(repo), prs.data.map(pr => ({ number: String(pr.number), branch: pr.headRefName })))
}

export function checkAdvance(repo: string, id: string, opts: { board?: string; run?: string } = {}): { verdict: AdvanceVerdict; step: PendingStep | null; checks: Array<{ text: string; problem: string | null }> } {
  const autoAdvance = autoAdvanceOf(loadConfig(repo))
  const file = boardPath(repo, opts.board)
  let items: Record<string, unknown>[] = []
  if (existsSync(file)) {
    try { items = readBoard(file) }
    catch (e) { throw new Error(`보드를 읽지 못했다: ${file}: ${(e as Error).message}`) }
  }
  const item = items.find(row => row.id === id)
  const step = item ? firstPendingStep(file, item) : null
  const input: AdvanceInput = { autoAdvance, status: item ? String(item.status ?? '') : null, step, busy: null, launched: false, evidence: [] }
  if (autoAdvance && item && ['doing', 'wait'].includes(input.status!) && step?.mark === 'auto') {
    const launches = stepLaunches(repo, id, step.key)
    input.launched = launches.length > 0
    input.busy = busyOf(repo, item, launches, opts.run)
    const views = new Map<string, BoardView[]>()
    input.evidence = parseEvidence(step.body).map(evidence => {
      let problem: string | null = null
      if (evidence.kind === 'event') {
        if (!views.has(evidence.pr)) views.set(evidence.pr, boardViews(file, items, evidence.pr))
        if (!eventDone(views.get(evidence.pr)!, evidence.pr, evidence.event)) problem = R.eventPending
      } else {
        const expanded = evidence.path.startsWith('~/') ? join(homedir(), evidence.path.slice(2)) : evidence.path
        const target = isAbsolute(expanded) ? expanded : join(mainCheckout(repo), expanded)
        let stat
        try { stat = statSync(target) } catch { /* 읽을 수 없는 경로는 근거가 아니다 */ }
        if (evidence.kind === 'plan') {
          if (!stat || (!stat.isFile() && !stat.isDirectory())) problem = R.noPlan
        } else if (!stat?.isFile()) problem = R.noSpec
        else {
          try { if (confirmProblem(readFileSync(target, 'utf8'))) problem = R.unconfirmed }
          catch { problem = R.noSpec }
        }
      }
      return { text: evidence.text, problem }
    })
  }
  return { verdict: judgeAdvance(input), step, checks: input.evidence }
}

// 보드 갱신보다 먼저 부른다. 갱신 실패 뒤에도 중복 실행을 막을 기록은 남아야 한다.
export function recordStepLaunch(repo: string, item: string, dispatch: string, branch: string | null, number: number | null): boolean {
  if (number === null) return false
  const file = boardPath(repo)
  if (!existsSync(file)) return false
  const found = readBoard(file).find(row => row.id === item)
  const step = found ? firstPendingStep(file, found) : null
  if (step?.mark !== 'auto' || step.number !== number) return false
  appendStepLaunch(repo, { item, number: step.number, step: step.key, dispatch, branch })
  return true
}
