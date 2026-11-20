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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { machineDir } from './machine.ts'
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

// home 은 CODEX_HOME 으로 줄 폴더다. null 이면 부른 셸의 환경 그대로다(ORCH_WORKER_CODEX_HOME 이 빈 값일 때뿐). failure 면 어느 계정인지 모른다
export type WorkerHome = { home: string | null; failure: string | null }
let workerHome: WorkerHome | null = null

// Orca 가 새 Codex worker 에 쓸 계정의 홈.
//     관리 계정(activeAccountId)이면 ORCA_CODEX_ACCOUNTS(없으면 ~/Library/Application Support/Orca/codex-accounts) 아래 <id>/home 이다.
//     system(activeAccountId 가 null)이면 Codex 의 기본 홈(ORCH_SYSTEM_CODEX_HOME, 없으면 ~/.codex)이다. 부른 셸에 남은 CODEX_HOME 을 쓰지 않는다.
//     계정을 조회하지 못했거나 관리 계정의 홈이 없으면 failure 다. 그때 모델 목록은 읽지 못한 것으로 본다
export function workerCodexHome(): WorkerHome {
  const fixed = process.env.ORCH_WORKER_CODEX_HOME
  if (fixed !== undefined) return { home: fixed || null, failure: null }
  if (workerHome) return workerHome
  const listed = orcaJson<Record<string, any>>(['account', 'list', '--agent', 'codex'], { timeoutMs: 10_000 })
  let value: WorkerHome
  if (!listed.ok) value = { home: null, failure: 'Orca 가 새 worker 에 쓸 Codex 계정을 확인하지 못했' }
  else {
    const codex = listed.data?.codex ?? listed.data
    const id = typeof codex?.activeAccountId === 'string' ? codex.activeAccountId : null
    const root = process.env.ORCA_CODEX_ACCOUNTS || join(homedir(), 'Library/Application Support/Orca/codex-accounts')
    if (id === null) value = { home: process.env.ORCH_SYSTEM_CODEX_HOME || join(homedir(), '.codex'), failure: null }
    else if (/^[\w-]+$/.test(id) && existsSync(join(root, id, 'home'))) value = { home: join(root, id, 'home'), failure: null }
    else value = { home: null, failure: `Orca 의 Codex 계정 ${id} 의 홈을 찾지 못했` }
  }
  workerHome = value
  return value
}

// 실패는 `<실행 파일> debug models <failure>다` 로 읽히는 조각이다(model-check 의 경고 문장)
export function readCodexModels(bin = codexBin(), worker: WorkerHome = workerCodexHome()): CodexList {
  if (worker.failure) return { models: null, failure: `를 부르지 않았다. ${worker.failure}` }
  const cacheKey = `${bin}\0${worker.home ?? ''}`
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const done = run([bin, 'debug', 'models'], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024, ...(worker.home ? { env: { CODEX_HOME: worker.home } } : {}) })
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
export type Choice = { kind: 'upgrade' | 'kept' | 'fallback'; generation: Generation }

// 「계열의 지금 세대」 를 고르는 하나뿐인 기준이다. 띄울 때(codexGeneration), 직접 고른 옛 세대 판정(pinnedCheck), 낡은 표 행 알림(staleRows)이 함께 쓴다.
//     upgrade   목록의 현재 세대(isCurrent) 가운데 같은 계열에서 그 effort 를 지원하는 가장 높은 세대가 적힌 모델보다 높다. 그 세대로 바꾼다
//     kept      더 높은 현재 세대가 있지만 그 effort 를 지원하지 않고, 적힌 모델은 받을 수 있다. 바꾸지 않고 이유를 남긴다(to 는 from 과 같다)
//     fallback  적힌 모델을 이 계정이 받지 못한다(목록에 없거나 effort 미지원). 받을 수 있는 같은 계열 최신으로 그 띄우기만 바꾼다(스펙 REQ4)
// 현재 세대가 아닌(Previous generation, Legacy) 더 높은 세대로는 올리지 않는다. 표와 띄우기가 같은 세대를 고르게 하려는 것이다
export function chooseGeneration(slug: string, effort: string | null, models: CodexModel[]): Choice | null {
  const name = parseModel(slug)
  if (!name || name.provider !== 'codex') return null
  const current = models.filter(isCurrent)
  const up = (m: CodexModel | null) => !!m && compareGeneration(parseModel(m.slug)!.generation, name.generation) > 0
  const target = newestOfFamily(slug, effort, current)
  if (up(target)) return { kind: 'upgrade', generation: { from: slug, to: target!.slug, reason: '같은 계열 새 세대' } }
  const accepted = models.some((m) => m.slug === slug && m.visibility === 'list' && (!effort || m.efforts.includes(effort)))
  if (!accepted) {
    const fallback = newestOfFamily(slug, effort, models)
    return fallback ? { kind: 'fallback', generation: { from: slug, to: fallback.slug, reason: `${slug} 를 이 계정이 받지 못해 이 띄우기만 옛 세대로 띄웠다` } } : null
  }
  const newest = newestOfFamily(slug, null, current)
  if (up(newest)) return { kind: 'kept', generation: { from: slug, to: slug, reason: `${newest!.slug} 가 effort ${effort ?? '기본'} 를 지원하지 않아 ${slug} 그대로 띄웠다` } }
  return null
}

// 띄울 Codex 모델의 세대(스펙 REQ2, REQ4). to 가 from 과 같으면 바꾸지 않고 이유만 남긴다. 판정은 chooseGeneration 이다
export function codexGeneration(slug: string, effort: string | null, models: CodexModel[]): Generation | null {
  return chooseGeneration(slug, effort, models)?.generation ?? null
}

// Claude 는 모델 목록을 내는 명령이 없다. 계열 이름(`fable`)으로 넘기면 Claude Code 가 그 계열의 최신 모델로 띄운다(스펙 REQ5, 근거는 design.md)
export function claudeGeneration(slug: string): Generation | null {
  const name = parseModel(slug)
  if (!name || name.provider !== 'claude' || name.generation === null) return null
  return { from: slug, to: name.family, reason: '계열 이름으로 최신' }
}

export type StaleRow = { row: string; from: string; to: string }

// 모델 표 줄 하나의 Codex 모델 자리와 그 자리의 effort(effort 칸의 같은 순서 값)
function occurrences(line: string): { slug: string; effort: string | null }[] {
  const cells = line.split('|').slice(1, -1)
  if (cells.length !== 5) return []
  const efforts = [...cells[4].matchAll(/`([^`]+)`/g)].map(m => (m[1] === '기본' ? null : m[1]))
  return [...cells[3].matchAll(/`([^`]+)`/g)].map((m, k) => ({ slug: m[1], effort: efforts[k] ?? efforts[0] ?? null })).filter(at => at.slug.startsWith('gpt-'))
}

// 모델 표(「## 모델」 절)에서 옛 세대를 가리키는 행(스펙 REQ3). 띄울 때와 같은 기준(chooseGeneration)이 새 세대로 올리는 자리만 낸다.
// 그 effort 를 지원하지 않는 새 세대(kept)와 목록에 없는 표의 모델(fallback)은 표를 바꿀 근거가 아니라 내지 않는다.
// 표는 루프가 고치지 않는다. 코디네이터가 이 결과를 보고 PR 로 고친다
export function staleRows(table: string, models: CodexModel[]): StaleRow[] {
  const found: StaleRow[] = []
  let section = ''
  for (const line of table.split('\n')) {
    if (/^#{1,6} /.test(line)) { section = line; continue }
    if (section !== '## 모델' || !line.startsWith('|')) continue
    const row = line.split('|')[1]?.trim().replace(/^`|`$/g, '') ?? ''
    for (const at of occurrences(line)) {
      const choice = chooseGeneration(at.slug, at.effort, models)
      if (choice?.kind === 'upgrade' && !found.some(f => f.row === row && f.from === at.slug && f.to === choice.generation.to)) found.push({ row, from: at.slug, to: choice.generation.to })
    }
  }
  return found
}

// 머신의 모델 감지 기록(loop/model-watch.ts 의 model-watch.json)이 마지막으로 읽은 목록. 없으면 빈 목록이다
export function knownModels(file = join(machineDir(), 'model-watch.json')): CodexModel[] {
  try {
    const raw = (JSON.parse(readFileSync(file, 'utf8')) as { models?: unknown }).models
    return Array.isArray(raw) ? raw.filter((m): m is CodexModel => !!m && typeof m.slug === 'string' && Array.isArray(m.efforts)) : []
  } catch {
    return []
  }
}

export type PinCheck = { kind: 'outdated'; message: string } | { kind: 'kept'; generation: Generation } | { kind: 'none'; warning: string | null }

const higher = (a: CodexModel | null, slug: string) => !!a && compareGeneration(parseModel(a.slug)!.generation, parseModel(slug)!.generation) > 0

// 지시서가 `후보 밖:` 으로 직접 고른 Codex 모델을 판정한다(스펙 REQ23, DECISION30).
//     outdated  worker 계정 목록에 같은 계열의 그 effort 를 지원하는 새 세대가 있다. 목록을 읽지 못했어도 감지 기록(knownModels)이 그런 새 세대를 알면 같다
//     kept      더 높은 세대를 알지만(목록이나 감지 기록) 그 계정이 받지 못하거나 그 effort 를 지원하지 않는다. 옛 세대를 그대로 띄우고 이유를 남긴다
//     none      더 높은 세대를 모른다. 목록을 읽지 못했으면 warning 에 이유가 있다
// remote 면 이 머신의 목록은 원격 계정의 것이 아니라 보지 않는다(읽지 못한 것과 같다)
export function pinnedCheck(agent: string | null, model: string | null, effort: string | null, opts: { remote?: boolean; known?: CodexModel[] } = {}): PinCheck {
  const name = parseModel(model)
  if (agent !== 'codex' || !model || !name || name.provider !== 'codex') return { kind: 'none', warning: null }
  const known = (opts.known ?? knownModels()).filter(isCurrent)
  const list = opts.remote ? { models: null, failure: '원격 worker 라 이 머신의 목록을 쓰지 않았' } as CodexList : readCodexModels()
  const outdated = (to: string, why: string) => ({ kind: 'outdated' as const, message: `MODEL-OUTDATED ${model} → ${to}${why}\n지시서를 새 세대로 고친다. \`후보 밖:\` 으로 옛 세대를 고를 수 있는 것은 worker 계정이 새 세대를 받지 못할 때뿐이다` })
  if (list.failure === null) {
    const choice = chooseGeneration(model, effort, list.models)
    if (choice?.kind === 'upgrade') return outdated(choice.generation.to, '')
    if (choice?.kind === 'kept') return { kind: 'kept', generation: choice.generation }
    const recorded = newestOfFamily(model, null, known)
    if (higher(recorded, model)) return { kind: 'kept', generation: { from: model, to: model, reason: `worker 계정 목록에 ${recorded!.slug} 가 없어 직접 고른 세대 그대로 띄웠다` } }
    return { kind: 'none', warning: null }
  }
  const recorded = newestOfFamily(model, effort, known)
  if (higher(recorded, model)) return outdated(recorded!.slug, ` (모델 목록을 읽지 못했지만 감지 기록에 ${recorded!.slug} 가 있다)`)
  return { kind: 'none', warning: `MODEL-CHECK-SKIP 직접 고른 ${model} 이 낡았는지 확인하지 못했다: ${codexBin()} debug models ${list.failure}다` }
}
