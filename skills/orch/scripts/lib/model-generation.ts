// 모델 이름의 계열과 세대를 읽고, 설치된 Codex CLI 의 모델 목록에서 같은 계열의 새 세대를 찾는다.
// 계약은 docs/features/model-auto-routing/spec.md(REQ1~REQ5)와 design.md 다.
//
// 이름 꼴:
//     codex   `gpt-<세대>-<계열>`. 세대는 점으로 나눈 숫자다(`gpt-6.2-sol` 은 계열 sol, 세대 6.2). 꼴이 다르면(`codex-auto-review`) 계열이 없다
//     claude  `claude-<계열>-<세대>`(`claude-fable-5-2`) 이거나 계열 이름만(`fable`). 계열은 CLAUDE_FAMILIES 다
// 세대 비교는 숫자 조각을 앞에서부터 본다. 6.2 > 6.1 > 6 이다.
//
// 모델 목록: `codex debug models` 의 JSON(models[].slug, visibility, description, supported_reasoning_levels[].effort). CODEX_BIN 으로 실행 파일을 바꾼다.
//     한 프로세스 안에서는 실행 파일과 계정마다 한 번만 부른다. 목록에 보이는 모델은 visibility 가 `list` 인 것이다.
//     계정은 Orca 가 새 Codex worker 에 쓸 계정이다(workerCodexHome). `orca account list --agent codex` 의 activeAccountId 의 홈
//     (ORCA_CODEX_ACCOUNTS, 없으면 ~/Library/Application Support/Orca/codex-accounts 아래 <id>/home)을 CODEX_HOME 으로 주고 부른다.
//     Orca 관리 계정이 없거나(system) 조회하지 못하면 부른 셸의 환경 그대로다. ORCH_WORKER_CODEX_HOME 으로 홈을 정한다(빈 값이면 셸 그대로, 테스트).
//     현재 세대는 목록에 보이고 설명이 `Legacy` 나 `Previous generation` 으로 시작하지 않는 것이다(스펙 REQ1).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { orcaJson } from './orca.ts'
import { run } from './proc.ts'

export const CLAUDE_FAMILIES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable']

export type ModelName = { provider: 'codex' | 'claude'; family: string; generation: number[] | null }
export type CodexModel = { slug: string; visibility: string | null; description: string; efforts: string[] }
export type CodexList = { models: CodexModel[]; failure: null } | { models: null; failure: string }

export function parseModel(slug: string | null | undefined): ModelName | null {
  if (!slug) return null
  const codex = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(slug)
  if (codex) return { provider: 'codex', family: codex[2], generation: codex[1].split('.').map(Number) }
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(slug)
  if (claude && CLAUDE_FAMILIES.includes(claude[1])) return { provider: 'claude', family: claude[1], generation: claude[2].split('-').map(Number) }
  if (CLAUDE_FAMILIES.includes(slug)) return { provider: 'claude', family: slug, generation: null }
  return null
}

// 앞이 높으면 양수, 같으면 0, 낮으면 음수다. 세대가 없는 쪽(계열 이름만)은 늘 최신이라 가장 높다
export function compareGeneration(a: number[] | null, b: number[] | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// 같은 제공자의 같은 계열이면 세대가 달라도 같은 행의 모델로 본다(스펙 REQ2: 옛 세대가 적힌 지시서를 거절하지 않는다)
export function sameFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true
  const left = parseModel(a)
  const right = parseModel(b)
  return !!left && !!right && left.provider === right.provider && left.family === right.family
}

export function isCurrent(model: CodexModel): boolean {
  return model.visibility === 'list' && !/^(legacy|previous generation)\b/i.test(model.description.trim())
}

const cache = new Map<string, CodexList>()

export function codexBin(): string {
  return process.env.CODEX_BIN || 'codex'
}

export function parseCodexModels(stdout: string): CodexList {
  let list: unknown
  try {
    list = (JSON.parse(stdout) as { models?: unknown }).models
  } catch {
    return { models: null, failure: '의 출력이 JSON 이 아니었' }
  }
  if (!Array.isArray(list)) return { models: null, failure: '의 models 목록을 읽지 못했' }
  const models: CodexModel[] = []
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw.slug !== 'string' || !Array.isArray(raw.supported_reasoning_levels)) continue
    const efforts = raw.supported_reasoning_levels.map((level) => (level as { effort?: unknown })?.effort).filter((effort): effort is string => typeof effort === 'string')
    models.push({ slug: raw.slug, visibility: typeof raw.visibility === 'string' ? raw.visibility : null, description: typeof raw.description === 'string' ? raw.description : '', efforts })
  }
  return { models, failure: null }
}

let workerHome: { value: string | null } | null = null

// Orca 가 새 Codex worker 에 쓸 계정의 홈. 모르면 null(부른 셸의 계정)이다
export function workerCodexHome(): string | null {
  const fixed = process.env.ORCH_WORKER_CODEX_HOME
  if (fixed !== undefined) return fixed || null
  if (workerHome) return workerHome.value
  let value: string | null = null
  const listed = orcaJson<Record<string, any>>(['account', 'list', '--agent', 'codex'], { timeoutMs: 10_000 })
  if (listed.ok) {
    const codex = listed.data?.codex ?? listed.data
    const id = typeof codex?.activeAccountId === 'string' ? codex.activeAccountId : null
    const root = process.env.ORCA_CODEX_ACCOUNTS || join(homedir(), 'Library/Application Support/Orca/codex-accounts')
    if (id && /^[\w-]+$/.test(id) && existsSync(join(root, id, 'home'))) value = join(root, id, 'home')
  }
  workerHome = { value }
  return value
}

// 실패는 `<실행 파일><failure>다` 로 읽히는 조각이다(model-check 의 경고 문장)
export function readCodexModels(bin = codexBin(), home: string | null = workerCodexHome()): CodexList {
  const cacheKey = `${bin}\0${home ?? ''}`
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const done = run([bin, 'debug', 'models'], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024, ...(home ? { env: { CODEX_HOME: home } } : {}) })
  const list: CodexList = done.code !== 0 ? { models: null, failure: `가 종료 코드 ${done.code} 로 끝났` } : parseCodexModels(done.stdout)
  cache.set(cacheKey, list)
  return list
}

// 테스트가 실행 파일을 바꾼 뒤 다시 읽게 한다
export function forgetCodexModels(): void {
  cache.clear()
  workerHome = null
}

// 같은 계열에서 목록에 보이고 effort 를 지원하는 모델 가운데 세대가 가장 높은 것. 없으면 null 이다
export function newestOfFamily(slug: string, effort: string | null, models: CodexModel[]): CodexModel | null {
  const name = parseModel(slug)
  if (!name || name.provider !== 'codex') return null
  let best: { model: CodexModel; generation: number[] } | null = null
  for (const model of models) {
    const other = parseModel(model.slug)
    if (!other || other.provider !== 'codex' || other.family !== name.family || model.visibility !== 'list') continue
    if (effort && !model.efforts.includes(effort)) continue
    if (!best || compareGeneration(other.generation, best.generation) > 0) best = { model, generation: other.generation! }
  }
  return best?.model ?? null
}

export type Generation = { from: string; to: string; reason: string }

// 띄울 Codex 모델의 세대를 정한다(스펙 REQ2, REQ4). 바꾸지 않으면 null 이다.
//     목록의 같은 계열 최신이 더 높으면 그 세대로 올린다.
//     적힌 모델을 목록이 받지 못하면(없거나 effort 를 지원하지 않는다) 받을 수 있는 같은 계열 최신으로 이 띄우기만 내린다.
export function codexGeneration(slug: string, effort: string | null, models: CodexModel[]): Generation | null {
  const name = parseModel(slug)
  if (!name || name.provider !== 'codex') return null
  const target = newestOfFamily(slug, effort, models)
  if (!target || target.slug === slug) return null
  const accepted = models.some((m) => m.slug === slug && m.visibility === 'list' && (!effort || m.efforts.includes(effort)))
  const higher = compareGeneration(parseModel(target.slug)!.generation, name.generation) > 0
  if (higher) return { from: slug, to: target.slug, reason: '같은 계열 새 세대' }
  if (!accepted) return { from: slug, to: target.slug, reason: `${slug} 를 이 계정이 받지 못해 이 띄우기만 옛 세대로 띄웠다` }
  return null
}

// Claude 는 모델 목록을 내는 명령이 없다. 계열 이름(`fable`)으로 넘기면 Claude Code 가 그 계열의 최신 모델로 띄운다(스펙 REQ5, 근거는 design.md)
export function claudeGeneration(slug: string): Generation | null {
  const name = parseModel(slug)
  if (!name || name.provider !== 'claude' || name.generation === null) return null
  return { from: slug, to: name.family, reason: '계열 이름으로 최신' }
}

export type Skipped = { from: string; to: string; effort: string | null; reason: string }
export type TablePlan = { upgrades: Generation[]; skipped: Skipped[]; text: string }

// 표 줄 하나에서 Codex 모델 자리와 그 자리의 effort. 모델 표는 effort 칸의 같은 순서 값, 한도 표는 모델 뒤의 `effort` 다(없으면 null)
function occurrences(line: string, modelTable: boolean): { start: number; end: number; slug: string; effort: string | null }[] {
  const found: { start: number; end: number; slug: string; effort: string | null }[] = []
  if (modelTable) {
    const cells = line.split('|').slice(1, -1)
    if (cells.length !== 5) return found
    const efforts = [...cells[4].matchAll(/`([^`]+)`/g)].map(m => (m[1] === '기본' ? null : m[1]))
    const offset = line.indexOf('|') + 1 + cells.slice(0, 3).reduce((sum, cell) => sum + cell.length + 1, 0)
    let k = 0
    for (const m of cells[3].matchAll(/`([^`]+)`/g)) {
      if (m[1].startsWith('gpt-')) found.push({ start: offset + m.index!, end: offset + m.index! + m[0].length, slug: m[1], effort: efforts[k] ?? efforts[0] ?? null })
      k++
    }
    return found
  }
  for (const m of line.matchAll(/`(gpt-[^`\s]+)`(?:\s+`([a-z]+)`)?/g)) found.push({ start: m.index!, end: m.index! + `\`${m[1]}\``.length, slug: m[1], effort: m[2] ?? null })
  return found
}

// 표 문서를 목록의 현재 세대로 맞춘 결과(스펙 REQ3). 자리마다 그 effort 를 지원하는 같은 계열 최신으로만 바꾼다.
// 띄울 때의 판정(codexGeneration)과 같은 기준이라, 표 PR 을 머지한 뒤 표와 실제로 띄우는 모델이 같다.
// 더 높은 세대가 있지만 그 effort 를 지원하지 않는 자리는 바꾸지 않고 skipped 에 이유를 남긴다.
// 한도 표에서 걸린 모델 칸이 앞 줄과 같아진 줄은 빼고, 같은 등급 대응 칸에서 걸린 모델 자신과 겹친 항목은 뺀다
export function planTable(table: string, models: CodexModel[]): TablePlan {
  const lines = table.split('\n')
  const current = models.filter(isCurrent)
  const upgrades = new Map<string, Generation>()
  const skipped = new Map<string, Skipped>()
  let section = ''
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i])) { section = lines[i]; continue }
    if (!lines[i].startsWith('|') || (section !== '## 모델' && section !== '### 사용 한도에 걸렸을 때')) continue
    let line = lines[i]
    for (const at of occurrences(line, section === '## 모델').reverse()) {
      const name = parseModel(at.slug)
      if (!name || name.provider !== 'codex') continue
      const target = newestOfFamily(at.slug, at.effort, current)
      const newest = newestOfFamily(at.slug, null, current)
      if (target && compareGeneration(parseModel(target.slug)!.generation, name.generation) > 0) {
        upgrades.set(`${at.slug}>${target.slug}`, { from: at.slug, to: target.slug, reason: '같은 계열 새 세대' })
        line = `${line.slice(0, at.start)}\`${target.slug}\`${line.slice(at.end)}`
      } else if (newest && compareGeneration(parseModel(newest.slug)!.generation, name.generation) > 0) {
        skipped.set(`${at.slug}>${newest.slug}@${at.effort}`, { from: at.slug, to: newest.slug, effort: at.effort, reason: `${newest.slug} 가 effort ${at.effort} 를 지원하지 않아 바꾸지 않았다` })
      }
    }
    lines[i] = line
  }
  const drop = new Set<number>()
  const seenFrom = new Set<string>()
  let inLimit = false
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i])) { inLimit = lines[i] === '### 사용 한도에 걸렸을 때'; continue }
    if (!inLimit || !lines[i].startsWith('|')) continue
    const cells = lines[i].split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 3 || /^-+$/.test(cells[0]) || cells[0] === '걸린 모델') continue
    if (seenFrom.has(cells[0])) { drop.add(i); continue }
    seenFrom.add(cells[0])
    const items = [...new Set(cells[1].split(/,\s*/))].filter(item => item !== cells[0])
    if (items.length && items.join(', ') !== cells[1]) lines[i] = `| ${cells[0]} | ${items.join(', ')} | ${cells[2]} |`
  }
  return { upgrades: [...upgrades.values()], skipped: [...skipped.values()], text: lines.filter((_, i) => !drop.has(i)).join('\n') }
}

// 띄울 때와 같은 기준으로 Codex 모델의 세대를 정한 값. 목록을 읽지 못하거나 codex 가 아니면 그대로다.
// relaunch 의 사전 모델 검사가 launch 의 세대 판정 뒤 값을 검사하게 한다
export function resolvedCodexModel(agent: string | null, model: string | null, effort: string | null): string | null {
  if (agent !== 'codex' || !model) return model
  const list = readCodexModels()
  if (list.failure !== null) return model
  return codexGeneration(model, effort, list.models)?.to ?? model
}
