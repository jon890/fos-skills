import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stepRows, waitReasons } from '../../../extensions/work-board/hooks/register.js'
import { parseStepMark } from '../../../extensions/work-board/hooks/step-marks.js'
import { prNumbers, type BoardItem } from '../scripts/core/board.ts'
import { boardWorkerRows } from '../scripts/core/board-workers.ts'
import { subjectOf } from '../scripts/core/message-fields.ts'
import { brief } from '../scripts/core/questions.ts'
import { isObject } from '../scripts/core/json.ts'
import { readApprovals } from '../scripts/lib/approvals.ts'
import { readBoard } from '../scripts/lib/board.ts'
import { boardPath } from '../scripts/lib/board-file.ts'
import { mainCheckout } from '../scripts/lib/git.ts'
import { orcaJson } from '../scripts/lib/orca.ts'
import { runAsync } from '../scripts/lib/proc.ts'
import { snapshot } from '../scripts/lib/questions.ts'
import { workerRows } from '../scripts/lib/workers.ts'
import { completionMessages } from '../scripts/loop/completion-watch.ts'
import { overdueTechnicalQuestions } from '../scripts/loop/steps/unanswered.ts'

const LIST_LIMIT = 6
const READ_BUDGET_MS = 6_000

function coordinatorRun(handle: string): string | null {
  type Run = { id?: unknown; coordinator_handle?: unknown }
  const current = orcaJson<{ run?: Run | null; runId?: unknown }>(['orchestration', 'run-current'])
  if (!current.ok) return null
  const run = current.data?.run?.id ?? current.data?.runId
  if (typeof run !== 'string' || !run) return null
  const currentHandle = current.data?.run?.coordinator_handle
  if (currentHandle !== undefined) return currentHandle === handle ? run : null
  const shown = orcaJson<{ run?: Run }>(['orchestration', 'run-show', '--id', run])
  return shown.ok && shown.data?.run?.id === run && shown.data.run.coordinator_handle === handle ? run : null
}

function limited<T>(items: T[], max: number, render: (item: T) => string, more = ''): string[] {
  const lines = items.slice(0, max).map(render)
  if (items.length > max) lines.push(`${items.length - max}개 더${more ? `, ${more}` : ''}`)
  return lines
}

function boardLine(item: BoardItem): string {
  const rows = stepRows(item) as { text: string; step: boolean; state: string }[]
  const steps = rows.filter(row => row.step && row.state !== 'done').map(row => row.text)
  const conditions = steps.flatMap(step => {
    const mark = parseStepMark(step)
    return mark?.condition ? [mark.condition] : []
  })
  if (item.status === 'wait') conditions.push(...(waitReasons(item) as string[]).filter(reason => !steps.includes(reason)))
  if (item.status === 'wait' && !conditions.length && steps.length) conditions.push(steps[0])
  const prs = prNumbers(item.pr)
  const linked = boardWorkerRows(item)
  const workers = linked.map(worker => {
    if (worker.pr) prs.add(String(worker.pr))
    return brief([worker.role, worker.worktree, worker.dispatch, worker.status].filter(Boolean).join(' '))
  })
  if (!Array.isArray(item.workers) && item.worktree) workers.push(brief(item.worktree))
  const summarize = (entries: string[], max: number) => limited(entries, max, entry => Array.from(brief(entry)).slice(0, 100).join('')).join(' / ')
  return [
    `- ${brief(item.id)} [${item.status}] ${brief(item.title)}`,
    `  남은 단계: ${summarize(steps, 3) || '없음'}`,
    ...(conditions.length || item.status === 'wait' ? [`  대기 조건: ${summarize([...new Set(conditions)], 2) || '기록 없음'}`] : []),
    `  PR: ${summarize([...prs].map(pr => `#${pr}`), 3) || '없음'} · worker: ${summarize(workers, 2) || '없음'}`,
  ].join('\n')
}

function collect(cwd: string, handle: string): string {
  const run = coordinatorRun(handle)
  if (!run) return ''
  const repo = mainCheckout(cwd)
  const items = readBoard(boardPath(repo))
  if (items.some(item => !isObject(item) || typeof item.id !== 'string' || typeof item.status !== 'string')) return ''

  const board = items.filter(item => item.status === 'doing' || item.status === 'wait')
  const sections: string[] = []
  if (board.length) sections.push('진행 중인 보드 항목', ...limited(board, LIST_LIMIT, boardLine, '`orch board list`'))

  try {
    const approvals = readApprovals(repo).entries.filter(entry => entry.run === run && entry.state === 'open').sort((a, b) => a.version - b.version)
    if (approvals.length) sections.push('대기 중인 보드 승인', ...limited(approvals, LIST_LIMIT,
      entry => `- ${brief(entry.id)} v${entry.version} [${entry.kind}] ${brief(entry.title)}`, '`orch board approval list`'))
  } catch { /* 보드와 질문은 여전히 읽을 수 있다. */ }

  try {
    const rows = workerRows(run)
    if (rows.ok) {
      const { pending } = snapshot(run, { rows, done: completionMessages(run), refreshClosed: false })
      const questions = overdueTechnicalQuestions(pending).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      if (questions.length) sections.push('미답변 메시지 (UNANSWERED)', ...limited(questions, LIST_LIMIT,
        question => `- ${brief(question.id)} ${brief(question.body) || brief(subjectOf(question))}`, '`orca orchestration check --all --full`'))
    }
  } catch { /* 답변 여부를 확인할 수 없으면 질문을 싣지 않는다. */ }

  return sections.length ? ['압축 직후 orch 상태', ...sections].join('\n') : ''
}

try {
  const handle = process.env.ORCA_TERMINAL_HANDLE
  if (handle && process.argv[2] === '--collect') {
    process.stdout.write(collect(process.cwd(), handle))
  } else if (handle) {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    if (input?.hook_event_name === 'SessionStart' && input.source === 'compact' && typeof input.cwd === 'string') {
      // 동기 파일 읽기와 여러 CLI 조회를 한 프로세스 그룹으로 묶어 훅 종료 전에 끊는다.
      const result = await runAsync([process.execPath, fileURLToPath(import.meta.url), '--collect'], {
        cwd: input.cwd, group: true, timeoutMs: READ_BUDGET_MS, maxBuffer: 1024 * 1024,
      })
      if (result.code === 0 && result.stdout) process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.stdout },
      }) + '\n')
    }
  }
} catch { /* 복구 문맥을 읽지 못해도 세션 시작을 계속한다. */ }
