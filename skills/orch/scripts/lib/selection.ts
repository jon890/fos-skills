// 지침 표와 지시서의 선택 계약. lint 와 launch 차례 0 이 같은 검사를 쓴다.
import { selectionsOf, type Candidate } from './spec.ts'
import type { CandidateOverride } from './launched.ts'
import { outsideFences } from './common-rules.ts'
import { sameFamily } from './model-generation.ts'
import { gradeCandidates, readSelectionTable } from './limit-table.ts'
import { LINE_BREAK } from '../core/text.ts'

type ModelPolicy = { grade: string | null; workers: Candidate[]; alternates: boolean }

// 행의 등급과 effort, 한도 표의 모델 쌍을 함께 읽는다.
export function modelPolicies(table: string): Map<string, ModelPolicy> {
  const lines = table.split('\n')
  const start = lines.indexOf('## 모델')
  if (start === -1) return new Map()
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,6} /.test(line))
  const policies = new Map<string, ModelPolicy>()
  const grades = gradeCandidates(table)
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    const id = /^`([a-z][a-z0-9-]*)`$/.exec(cells[0] ?? '')?.[1]
    if (!id) continue
    const grade = cells[2]?.match(/^`([a-z][a-z0-9-]*)`$/)?.[1] ?? null
    const effort = cells[3]?.match(/^`(기본|low|medium|high|xhigh|max|ultra)`$/)?.[1]
    const candidates = grade ? grades.get(grade) : undefined
    // 이 표의 두 모델 칸에 적힌 effort 가 행의 값보다 먼저다. 같은 등급을 쓰는 행끼리 한 모델의 effort 만 다르게 둘 수 있다
    const shown = new Map([...(cells[4] ?? '').matchAll(/`([a-z][a-z0-9.-]*)` `(기본|low|medium|high|xhigh|max|ultra)`/g)].map(([, model, e]) => [model, e]))
    const workers = cells.length === 5 && effort && candidates ? candidates
      .filter(worker => id !== 'security-review' || worker.agent === 'claude')
      .map(worker => ({ ...worker, effort: worker.effort ?? shown.get(worker.model!) ?? effort })) : []
    policies.set(id, { grade, workers, alternates: workers.length === 2 && id !== 'review' })
  }
  return policies
}

export function modelRows(table: string): Map<string, string[]> {
  return new Map([...modelPolicies(table)].map(([id, policy]) => [id, policy.workers.map(w => w.model!)]))
}
export function modelRowIds(table: string): string[] { return [...modelRows(table).keys()] }

function readModelPolicies(file?: string): Map<string, ModelPolicy> {
  return modelPolicies(readSelectionTable(file))
}

// 모델은 같은 계열이면 세대가 달라도 같은 worker 로 본다. 띄울 때 launch-worker 가 그 계열의 최신 세대로 바꾼다(lib/model-generation.ts)
function sameWorker(a: Candidate, b: Candidate): boolean {
  return a.agent === b.agent && sameFamily(a.model, b.model) && a.effort === b.effort
}

export function turnPolicy(selection: ReturnType<typeof selectionsOf>[number], continuation: boolean): ModelPolicy | null {
  if (selection.outsideReason) return null
  const policy = readModelPolicies().get(selection.row ?? '')
  return policy?.alternates && (continuation || policy.workers.some(worker => sameWorker(worker, selection))) ? policy : null
}

export function acceptsTurnCandidate(policy: ModelPolicy, candidate: Candidate): boolean {
  const selected = { ...candidate, effort: candidate.effort ?? '기본' }
  return candidate.effort !== '기본' && policy.workers.some(worker => sameWorker(worker, selected))
}

export function candidateOverrideOf(text: string): CandidateOverride | null {
  const [selection] = selectionsOf(text)
  if (!selection?.outsideReason) return null
  const workers = readModelPolicies().get(selection.row ?? '')?.workers
  if (!workers?.length || workers.some(w => sameWorker(selection, w))) return null
  const expected = workers.find(w => w.agent === selection.agent && sameFamily(w.model, selection.model))
  return { row: selection.row, agent: selection.agent, model: selection.model, effort: selection.effort,
    reason: selection.outsideReason, ...(expected && expected.effort !== selection.effort ? { effortLimit: expected.effort } : {}),
  }
}

function describe(worker: Candidate): string { return `${worker.agent} ${worker.model} effort ${worker.effort}` }

export function selectionVerdict(text: string, _repo: string, options: { launch?: boolean; table?: string; retry?: boolean; continuation?: boolean } = {}): string[] {
  const choices = selectionsOf(text)
  if (!choices.length) return ['`worker 선택:` 줄이 없다']
  const selection = choices[0]
  const errors = choices.length > 1 ? ['`worker 선택:` 줄은 하나만 둔다'] : []
  // 이미 떠 있는 worker 의 같은 지시서·설정 이어하기는 옛 형식을 그대로 받는다.
  errors.push(...selection.problems.filter(p => !(options.continuation && p === '행')).map(p => `${p} 가 빠졌거나 형식이 틀렸다`))
  if (!options.continuation) {
    const visible = outsideFences(text.split(LINE_BREAK))
    // 이유와 후보 밖 이유가 시작된 뒤의 「비교:」 는 설명의 일부다.
    const head = visible[selection.no - 1].split(/(?:^|\s)(?:이유|후보 밖)\s*:/, 1)[0]
    if (/(?:^|\s)비교\s*:/.test(head)) errors.push('새 지시서에는 `비교:` 칸을 쓰지 않는다')
    if (visible.some(line => /^\s*(?:[-*]\s+)?(?:\*\*)?experiment\s*:/.test(line))) errors.push('새 지시서에는 `experiment:` 줄을 쓰지 않는다')
  }
  let rows: Map<string, ModelPolicy>
  try { rows = readModelPolicies(options.table) }
  catch { return [...errors, '모델 표를 읽지 못했다'] }
  const ids = [...rows.keys()]
  if (!ids.length) errors.push('모델 표를 읽지 못했다')
  else if (selection.row && !ids.includes(selection.row)) {
    const modelName = selection.row === selection.model || /^(claude|gpt|codex|gemini|o\d)-/.test(selection.row)
    errors.push(`행 id 가 모델 표에 없다: ${selection.row}. 모델 표의 행 id: ${ids.join(', ')}${modelName ? '. 행에는 작업 종류 id 를 쓴다' : ''}`)
  }
  const policy = rows.get(selection.row ?? '')
  if (options.continuation) return errors
  if (policy) {
    if (!policy.workers.length) errors.push(`행 ${selection.row} 의 worker 를 읽지 못했다`)
    else if (!policy.workers.some(w => sameWorker(selection, w)) && !selection.outsideReason) {
      errors.push(`행 ${selection.row} 의 worker: ${policy.workers.map(describe).join(' / ')}. 다른 worker 면 \`worker 선택:\` 줄에 \`후보 밖: <이유>\` 를 적는다`)
    }
  }
  return errors
}

// 지시서의 `worker 선택:` 이 `후보 밖:` 으로 모델을 정했는지. 정했으면 launch 가 세대를 바꾸지 않는다(사람이 고른 모델을 지킨다)
export function pinnedSelection(text: string): boolean {
  return !!selectionsOf(text)[0]?.outsideReason
}
