import { prNumbers, type BoardItem, type BoardStep } from './board-details.ts'
import { boardWorkerRows } from './board-workers.ts'

const ORDER = ['spec', 'technical-design', 'implementation', 'verify', 'docs-consolidate'] as const
type StageName = typeof ORDER[number]
export type FeatureStage = { name: StageName; part?: number; total?: number }

export function parseFeatureStages(text: string): FeatureStage[] | null {
  const tokens = text.trim().split(/\s+/)
  const stages: FeatureStage[] = []
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i] as StageName
    const index = ORDER.indexOf(name)
    if (index < 0 || (stages.length && index !== ORDER.indexOf(stages.at(-1)!.name) + 1)) return null
    if (name !== 'implementation') {
      stages.push({ name })
      continue
    }
    const fraction = /^([1-9]\d*)\/([1-9]\d*)$/.exec(tokens[i + 1] ?? '')
    const part = fraction ? Number(fraction[1]) : 1
    const total = fraction ? Number(fraction[2]) : 1
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(part) || part > total) return null
    if (fraction) i++
    stages.push({ name, part, total })
  }
  const impl = stages.find((stage) => stage.name === 'implementation')
  if (impl && impl.part! < impl.total! && stages.at(-1)?.name === 'docs-consolidate') return null
  return stages
}

export function featureStageText(stage: FeatureStage): string {
  return stage.name === 'implementation' ? `implementation ${stage.part}/${stage.total}` : stage.name
}

export function nextFeatureStage(covered: FeatureStage[]): FeatureStage | null {
  const impl = covered.find((stage) => stage.name === 'implementation')
  if (impl && impl.part! < impl.total!) return { ...impl, part: impl.part! + 1 }
  const last = covered.at(-1)
  const name = last && ORDER[ORDER.indexOf(last.name) + 1]
  return name === 'implementation' ? { name, part: 1, total: 1 } : name ? { name } : null
}

function stageOf(text: string): FeatureStage | undefined {
  const match = /^\s*\d+[.)]?\s+(?:\[ask\]\s+)?기능 (.+)$/.exec(text)
  const parsed = match ? parseFeatureStages(match[1]) : null
  return parsed?.length === 1 ? parsed[0] : undefined
}

export function isFeatureItem(item: Record<string, unknown>): boolean {
  return Boolean(item.feature || item['feature-final-pr'] || item['feature-final-report']) || [item.details, item.next].some((lines) =>
    (Array.isArray(lines) ? lines : String(lines ?? '').split('\n')).some((line) =>
      stageOf(String(typeof line === 'string' ? line : line?.text ?? '').replace(/^\s*(?:✓|\[[xX ]\]|▶|◇)\s*/, ''))))
}

export function finalFeatureStageFinished(item: Record<string, unknown>, steps: BoardStep[]): boolean {
  const merged = prNumbers(item['merged-pr'])
  if (item['feature-final-report'] || merged.has(String(item['feature-final-pr']))) return true
  return steps.some((step) => step.done && stageOf(step.text)?.name === 'docs-consolidate' &&
    boardWorkerRows(item).some((row) => merged.has(String(row.pr)) &&
      row['feature-steps']?.split(',').includes(String(step.number))))
}

export function featureMergePlan(item: BoardItem, steps: BoardStep[], source: string | { report: string }, files: string[]) {
  const row = boardWorkerRows(item).find((worker) => worker['feature-steps'] &&
    (typeof source === 'string' ? !worker['feature-report'] && String(worker.pr) === source :
      worker.dispatch === source.report && worker['feature-report'] === 'pending'))
  if (!row) return null
  const owned = new Set(row['feature-steps']!.split(',').map(Number))
  const covered = steps.filter((step) => owned.has(step.number)).sort((a, b) => a.number - b.number)
  const stages = covered.flatMap((step) => {
    const stage = stageOf(step.text)
    return stage ? [stage] : []
  })
  if (stages.length !== owned.size) return null
  const next = nextFeatureStage(stages)
  const add = next ? `[ask] 기능 ${featureStageText(next)}` : null
  const done = covered.filter((step) => !step.done).map((step) => step.number)
  const status = next || steps.some((step) => !step.done && !owned.has(step.number)) ? 'doing' : 'done'
  const discover = typeof source === 'string' && !item.feature && stages.some((stage) => stage.name === 'spec')
  const specs = [...new Set(files.filter((file) => /^docs\/features\/[^/]+\/spec\.md$/.test(file)))]
  return {
    done, status, lastStage: !next,
    add: add && !steps.some((step) => step.text.replace(/^\s*\d+[.)]?\s+/, '') === add) ? add : null,
    feature: discover && specs.length === 1 ? specs[0].slice(0, -'/spec.md'.length) : null,
    featureUnknown: discover && specs.length !== 1,
  }
}
