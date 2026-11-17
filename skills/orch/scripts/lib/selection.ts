// 지침 표와 지시서의 선택 계약. lint 와 launch 차례 0 이 같은 검사를 쓴다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import { selectionsOf, type Candidate } from './spec.ts'
import type { CandidateOverride } from './launched.ts'

type ModelPolicy = { workers: Candidate[] }

// ## 모델 절의 id | Task 성격 | 에이전트 | 모델 | effort 표만 읽는다.
// review 행은 구현 제공자에 따라 고르는 두 조합을 같은 순서로 적는다.
export function modelPolicies(table: string): Map<string, ModelPolicy> {
  const lines = table.split('\n')
  const start = lines.indexOf('## 모델')
  if (start === -1) return new Map()
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,6} /.test(line))
  const policies = new Map<string, ModelPolicy>()
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    const id = /^`([a-z][a-z0-9-]*)`$/.exec(cells[0] ?? '')?.[1]
    if (!id) continue
    const values = cells.slice(2).map(cell => [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]))
    const [agents = [], models = [], efforts = []] = values
    const count = id === 'review' ? 2 : 1
    const valid = cells.length === 5 && values.every(v => v.length === count)
      && agents.every(v => ['claude', 'codex'].includes(v))
      && efforts.every(v => ['기본', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(v))
    policies.set(id, { workers: valid ? models.map((model, i) => ({ agent: agents[i], model, effort: efforts[i] })) : [] })
  }
  return policies
}

export function modelRows(table: string): Map<string, string[]> {
  return new Map([...modelPolicies(table)].map(([id, policy]) => [id, policy.workers.map(w => w.model!)]))
}
export function modelRowIds(table: string): string[] { return [...modelRows(table).keys()] }

function readModelPolicies(file = join(bundleRoot(), 'references', 'agent-selection.md')): Map<string, ModelPolicy> {
  return modelPolicies(readFileSync(file, 'utf8'))
}

function sameWorker(a: Candidate, b: Candidate): boolean {
  return a.agent === b.agent && a.model === b.model && a.effort === b.effort
}

export function candidateOverrideOf(text: string): CandidateOverride | null {
  const [selection] = selectionsOf(text)
  if (!selection?.outsideReason) return null
  const workers = readModelPolicies().get(selection.row ?? '')?.workers
  if (!workers?.length || workers.some(w => sameWorker(selection, w))) return null
  const expected = workers.find(w => w.agent === selection.agent && w.model === selection.model)
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
    if (/비교\s*:/.test(text.split(/\r?\n/)[selection.no - 1])) errors.push('새 지시서에는 `비교:` 칸을 쓰지 않는다')
    if (/^\s*(?:[-*]\s+)?(?:\*\*)?experiment\s*:/m.test(text)) errors.push('새 지시서에는 `experiment:` 줄을 쓰지 않는다')
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
