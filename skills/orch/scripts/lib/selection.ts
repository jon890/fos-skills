// 지침 표와 지시서의 선택 계약. lint 와 launch 차례 0 이 같은 판정을 쓴다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import { launchHistory } from './launch-history.ts'
import { readLaunch } from './launched.ts'
import { experimentOf, selectionsOf, type Candidate, type Selection } from './spec.ts'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
type ModelPolicy = { models: string[]; limits: Map<string, string | null>; defaults: Map<string, string> }

// 모델 목록과 상한을 같은 행에서 읽는다. 모델 별칭은 id 에서 만들고 상한값은 표에만 둔다.
export function modelPolicies(table: string): Map<string, ModelPolicy> {
  const lines = table.split('\n')
  const start = lines.indexOf('## 모델')
  if (start === -1) return new Map()
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,6} /.test(line))
  const policies = new Map([...(end === -1 ? rest : rest.slice(0, end)).join('\n').matchAll(/^\| `([a-z][a-z0-9-]*)` \|[^|]*\|([^|]*)\|([^|]*)\|/gm)].map(m => {
    const models = [...m[2].matchAll(/`((?:gpt|claude)-[^`]+)`|Claude ([A-Za-z]+) (\d+(?:\.\d+)+)/g)]
      .map(model => model[1] ?? `claude-${model[2].toLowerCase()}-${model[3].replaceAll('.', '-')}`)
    const aliases = models.map(model => model.startsWith('claude-') ? model.split('-')[1] : model.split('-').at(-1)!)
    const named = aliases.some(alias => new RegExp(`\\b${alias}\\b`, 'i').test(m[3]))
    const limits = new Map<string, string | null>()
    const defaults = new Map<string, string>()
    models.forEach((model, index) => {
      // 쉼표와 마침표로 나눈 모델별 설명에서 첫 effort 가 상한이다. 이름이 없는 칸은 모든 후보에 적용한다.
      const clause = named ? m[3].split(/,|\.\s/).find(part => new RegExp(`\\b${aliases[index]}\\b`, 'i').test(part)) : m[3]
      const effort = /`(low|medium|high|xhigh|max|ultra)`/.exec(clause ?? '')?.[1]
      if (effort) limits.set(model, /에서 시작/.test(clause ?? '') ? null : effort)
      const defaultEffort = /`(low|medium|high|xhigh|max|ultra)`\s*\(기본\)|기본값\s*`(low|medium|high|xhigh|max|ultra)`/.exec(clause ?? '')
      if (defaultEffort) defaults.set(model, defaultEffort[1] ?? defaultEffort[2])
    })
    return [m[1], { models, limits, defaults }]
  }))
  // 기본값은 모델의 속성이다. 어느 행에서든 명시된 기본값을 같은 모델에 적용한다.
  const defaults = new Map([...policies.values()].flatMap(policy => [...policy.defaults]))
  return new Map([...policies].map(([id, policy]) => [id, { ...policy, defaults }]))
}

function resolvedEffort(selection: Selection, policy: ModelPolicy | undefined): string | null {
  return selection.effort === '기본' ? policy?.defaults.get(selection.model ?? '') ?? null : selection.effort
}

export function modelRows(table: string): Map<string, string[]> {
  return new Map([...modelPolicies(table)].map(([id, policy]) => [id, policy.models]))
}
export function modelRowIds(table: string): string[] { return [...modelRows(table).keys()] }

function readModelPolicies(file = join(bundleRoot(), 'references', 'agent-selection.md')): Map<string, ModelPolicy> {
  return modelPolicies(readFileSync(file, 'utf8'))
}

function effortExceeded(selection: Selection, policy: ModelPolicy | undefined, experiment = false): string | null {
  if (selection.row === 'review') return null
  const limit = policy?.limits.get(selection.model ?? '')
  if (!limit) return null
  // hard-design 의 Opus 고effort 는 기존 high 근거 검사에서 따로 검증한다.
  if (selection.row === 'hard-design' && selection.model?.startsWith('claude-opus-') && (selection.highReason || experiment) && ['high', 'xhigh', 'max'].includes(selection.effort ?? '')) return null
  const effort = resolvedEffort(selection, policy)
  return effort && EFFORTS.indexOf(effort) > EFFORTS.indexOf(limit) ? limit : null
}

function outsideCandidate(selection: Selection, candidates: string[] | undefined): boolean {
  return selection.row !== 'review' && !!candidates?.length && !candidates.includes(selection.model ?? '')
}

export function candidateOverrideOf(text: string): { row: string | null; model: string | null; reason: string; effort?: string | null; effortLimit?: string } | null {
  const [selection] = selectionsOf(text)
  if (!selection?.outsideReason) return null
  const policy = readModelPolicies().get(selection.row ?? '')
  const effortLimit = effortExceeded(selection, policy, !!experimentOf(text))
  if (!outsideCandidate(selection, policy?.models) && !effortLimit) return null
  return { row: selection.row, model: selection.model, reason: selection.outsideReason,
    ...(effortLimit ? { effort: resolvedEffort(selection, policy), effortLimit } : {}),
  }
}

export function selectionVerdict(text: string, repo: string, options: { launch?: boolean; table?: string; retry?: boolean; continuation?: boolean } = {}): string[] {
  const choices = selectionsOf(text)
  if (!choices.length) return ['`worker 선택:` 줄이 없다']
  const selection = choices[0]
  const errors = choices.length > 1 ? ['`worker 선택:` 줄은 하나만 둔다'] : []
  errors.push(...selection.problems.filter(p => !(options.continuation && p === '행')).map(p => `${p} 가 빠졌거나 형식이 틀렸다`))
  let rows: Map<string, ModelPolicy>
  try { rows = readModelPolicies(options.table) }
  catch { return [...errors, '모델 표를 읽지 못했다'] }
  const ids = [...rows.keys()]
  if (!ids.length) errors.push('모델 표를 읽지 못했다')
  else if (selection.row && !ids.includes(selection.row)) {
    // 모델 이름(claude-haiku-5-5, gpt-6-luna)을 행 id 로 쓴 실수가 잦다. 쓸 수 있는 id 목록과 함께 알린다
    const modelName = selection.row === selection.model || /^(claude|gpt|codex|gemini|o\d)-/.test(selection.row)
    errors.push(`행 id 가 모델 표에 없다: ${selection.row}. 모델 표의 행 id: ${ids.join(', ')}${modelName ? '. 행에는 작업 종류 id 를 쓴다' : ''}`)
  }
  const experiment = experimentOf(text)
  const policy = rows.get(selection.row ?? '')
  const candidates = policy?.models
  if (options.launch && candidates && selection.row !== 'review') {
    if (!candidates.length) errors.push(`행 ${selection.row} 의 후보 목록을 읽지 못했다`)
    else if (outsideCandidate(selection, candidates) && !selection.outsideReason) {
      const line = text.split('\n')[selection.no - 1]
      const terra = selection.model === 'gpt-6.1-terra' && candidates.includes('claude-sonnet-5-5')
      // 표시 바로 뒤에 괄호나 쉼표가 와도 읽는다. 숫자, 영문자, 슬래시가 이어지면(1/50) 다른 표시다
      if (!terra || !/(?:^|\s)Terra 실험 [1-5]\/5(?![0-9A-Za-z/])/.test(line)) {
        errors.push(`행 ${selection.row} 의 후보: ${candidates.join(', ')}. 후보 밖이면 \`worker 선택:\` 줄에 \`후보 밖: <이유>\` 를 적는다`)
      }
    }
  }
  if (options.launch && !options.continuation && candidates?.includes(selection.model ?? '') && selection.row !== 'review' && policy?.limits.get(selection.model ?? '') !== null) {
    if (!policy?.limits.has(selection.model ?? '')) errors.push(`행 ${selection.row} 의 ${selection.model} effort 상한을 읽지 못했다`)
    if (!EFFORTS.includes(resolvedEffort(selection, policy) ?? '')) {
      errors.push(`effort 상한을 검사하려면 명시한 effort 나 표의 기본값이 필요하다: ${selection.effort}`)
    }
    const limit = effortExceeded(selection, policy, !!experiment)
    if (limit && !selection.outsideReason) {
      errors.push(`행 ${selection.row} 의 ${selection.model} effort 상한: ${limit} (요청: ${selection.effort}). 꼭 필요하면 \`worker 선택:\` 줄에 \`후보 밖: <이유>\` 를 적는다`)
    }
  }
  const effortOf = (value: string | null | undefined) => value === '기본' ? null : value ?? null
  const same = (a: Partial<Candidate>, b: Partial<Candidate>) =>
    a.agent === b.agent && a.model === b.model && effortOf(a.effort) === effortOf(b.effort)
  if (experiment) {
    errors.push(...experiment.problems)
    if (!experiment.candidates.some(c => same(c, selection))) errors.push('worker 선택이 experiment 후보 밖이다')
  }
  try {
    if (/^claude-opus-/.test(selection.model ?? '') && ['high', 'xhigh', 'max'].includes(selection.effort ?? '') && !experiment) {
      const reason = selection.highReason
      if (!reason) errors.push('Opus high 이상은 high 근거가 필요하다')
      else if (reason.kind === 'user') {
        const date = new Date(`${reason.date}T00:00:00Z`)
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== reason.date) errors.push('high 근거 날짜가 틀렸다')
      } else {
        const history = launchHistory(repo).find(row => row.dispatch === reason.id)
        const prior = history ?? readLaunch(repo, reason.id)
        const model = prior?.effective?.model ?? prior?.model
        const effort = prior?.effective?.effort ?? prior?.effort
        if (!prior || (history && !model) || (model && (!/^claude-opus-/.test(model) || effort !== 'medium'))) errors.push(`high 근거 dispatch 가 Opus medium 이 아니다: ${reason.id}`)
      }
    }
    if (options.launch && experiment && !experiment.problems.length && !options.retry) {
      const history = launchHistory(repo).filter(row => row.experiment === experiment.name && !row.retry_of)
      const counts = experiment.candidates.map(c => history.filter(row => same(row, c)).length)
      const next = experiment.candidates[counts.indexOf(Math.min(...counts))]
      if (!same(next, selection)) errors.push(`다음 experiment 후보: ${next.agent} ${next.model} effort ${next.effort}`)
    }
  } catch (e) { errors.push(`띄우기 이력을 읽지 못했다: ${(e as Error).message}`) }
  return errors
}
