// 루프 부모가 하루 한 번 설치된 Codex CLI 의 모델 목록을 읽어 새 모델과 같은 계열의 새 세대를 알아챈다(스펙 REQ1, REQ3).
// 계약은 docs/features/model-auto-routing/spec.md 와 design.md 다. 이름 꼴과 세대 비교는 lib/model-generation.ts 가 소유한다.
//
// 기록: <머신 폴더>/model-watch.json(lib/machine.ts). Codex CLI 와 계정이 머신에 하나라 목록 읽기는 머신에 한 번이다.
//     { checked_at, baseline, models, found, repos: { <저장소>: { checked_at, announced, tables: { "<키>": { at } } } } }
//     checked_at 은 목록을 마지막으로 읽은 시각(ms), models 는 그때 읽은 목록, found 는 기준점 뒤에 나타난 현재 세대 모델이다.
//     repos 는 저장소마다 마지막으로 본 시각, 알린 모델(announced), 보드에 쓴 모델(boarded), 표에서 다룬 바꿈이다. 옆 잠금 파일 안에서 읽고 rename 으로 쓴다.
// 주기: 머신의 checked_at 에서 WATCH_MS(24시간)가 지나면 어느 저장소의 루프든 목록을 다시 읽는다. 읽지 못해도(codex 없음, 실패) checked_at 을 쓴다.
//     저장소의 checked_at 이 머신의 checked_at 보다 이르면 그 저장소의 루프가 저장된 목록으로 자기 일(알림, 보드, 표)을 한다.
//     다른 저장소의 루프가 먼저 목록을 읽어도 fos-skills 의 루프가 같은 목록으로 표를 본다.
// 새 모델: 첫 목록에 보이는(visibility list) 모델을 기준점으로 남긴다. 단 FIRST_COMPARE 는 기준점에 넣지 않는다(스펙 DECISION15).
//     그 뒤 목록에 보이고 현재 세대(isCurrent)인데 기준점에 없는 모델을 found 에 넣는다.
//     저장소마다 announced 에 없는 found 모델을 한 번 알린다. `MODEL-NEW <모델> <설명>` 을 등록된 Run 에 보내고,
//     그 저장소의 보드 파일이 있으면 decide 항목 `model-new-<모델>`(제목 「새 모델 <모델>」)을 더한다. 보드에 쓰지 못하면 `MODEL-BOARD-FAIL <모델>: <이유>` 다.
//     보드 쓰기에 성공한 모델은 boarded 에 따로 둔다. 실패한 모델은 다음에 목록을 읽을 때 같은 항목 ID 로 보드 쓰기만 다시 한다.
//     보내지 못해도 announced 에 넣는다. 같은 모델을 다시 알리지 않는다는 스펙을 따른다. 루프 로그에는 남는다.
// 낡은 표 행: 저장된 목록으로 모델 표의 행마다 launch 와 같은 기준(staleRows, lib/model-generation.ts)으로 새 세대를 본다.
//     표 문서는 이 저장소에 있으면(fos-skills) origin 기본 브랜치를 받아 그 것을, 없으면 번들의 것을 읽는다.
//     옛 세대를 가리키는 행마다 `MODEL-TABLE-STALE <행> <옛> → <새>` 를 한 번 보내고, 새 세대마다 보드에 decide 항목
//     `model-table-<새>`(제목 「모델 표를 <새> 로 바꿀 때」)를 한 번 더한다. 보드에 쓰지 못하면 `MODEL-BOARD-FAIL` 이고 다음에 목록을 읽을 때 다시 한다.
//     루프는 표를 고치지 않는다. 코디네이터가 작은 worker 로 PR 을 내 고친다(스펙 REQ3, DECISION16). 띄우기는 그동안에도 launch 가 새 세대로 바꾼다.
//     tables 에 `stale:<행>:<옛>><새>` 와 `board:<새>` 로 알린 것을 둔다.
// 테스트는 상태 파일, 시각, 명령 실행기, 알림을 주입한다. 실제 codex 와 gh 를 부르지 않는다.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { defaultBase } from '../lib/git.ts'
import { machineDir } from '../lib/machine.ts'
import { codexBin, isCurrent, parseCodexModels, staleRows, type CodexModel } from '../lib/model-generation.ts'
import { boardPath } from '../lib/board-file.ts'
import { BOARD_BIN } from '../lib/board.ts'
import { run, scriptCommand } from '../lib/proc.ts'
import type { RunOptions, RunResult } from '../lib/proc.ts'
import { readSelectionTable } from '../lib/usage-boost.ts'

export const WATCH_MS = 24 * 60 * 60 * 1000
export const FIRST_COMPARE: readonly string[] = ['gpt-6.2-astra']
export const TABLE_PATH = 'skills/orch/references/agent-selection.md'

export type RepoWatch = { checked_at: number | null; announced: string[]; boarded: string[]; tables: Record<string, { at: number }> }
export type WatchState = {
  checked_at: number | null
  baseline: string[] | null
  models: CodexModel[] | null
  found: string[]
  repos: Record<string, RepoWatch>
}
export type Notice = { kind: string; text: string }
type Exec = (argv: string[], opts?: RunOptions) => RunResult
// board 는 보드에 항목을 더한다. 성공하면 null, 보드가 없어 건너뛰었으면 BOARD_SKIPPED, 실패하면 이유를 낸다.
// 건너뛴 것은 기록하지 않는다. 보드를 나중에 만든 저장소도 다음에 목록을 읽을 때 항목을 받는다
export const BOARD_SKIPPED = Symbol('board-skipped')
type BoardResult = string | null | typeof BOARD_SKIPPED
export type WatchOptions = { stateFile?: string; now?: number; exec?: Exec; notify: (notice: Notice) => void; board?: (id: string, title: string) => BoardResult }

export function watchFile(): string {
  return join(machineDir(), 'model-watch.json')
}

const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)
const object = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {})

export function readWatch(file: string): WatchState {
  let raw: Record<string, any> = {}
  try { raw = object(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* 없거나 깨졌으면 처음부터 */ }
  const repos: Record<string, RepoWatch> = {}
  for (const [repo, value] of Object.entries(object(raw.repos))) {
    const r = object(value)
    repos[repo] = { checked_at: typeof r.checked_at === 'number' ? r.checked_at : null, announced: list(r.announced) ?? [], boarded: list(r.boarded) ?? list(r.announced) ?? [], tables: object(r.tables) }
  }
  return {
    checked_at: typeof raw.checked_at === 'number' ? raw.checked_at : null,
    baseline: list(raw.baseline),
    models: Array.isArray(raw.models) ? raw.models as CodexModel[] : null,
    found: list(raw.found) ?? [],
    repos,
  }
}

function writeWatch(file: string, state: WatchState): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, file)
}

// 기준점과 기준점 뒤에 나타난 현재 세대 모델(found). 상태를 바꾼 사본이다
export function newModels(state: WatchState, models: CodexModel[]): WatchState {
  const listed = models.filter((m) => m.visibility === 'list').map((m) => m.slug)
  const baseline = state.baseline ?? listed.filter((slug) => !FIRST_COMPARE.includes(slug))
  const found = [...state.found]
  for (const model of models.filter(isCurrent)) if (!baseline.includes(model.slug) && !found.includes(model.slug)) found.push(model.slug)
  return { ...state, baseline, found, models }
}

// 보드에 새 모델 항목을 더한다. 보드 파일이 없는 저장소는 건너뛴다
export function boardWriter(repo: string, exec: Exec): (id: string, title: string) => BoardResult {
  return (id, title) => {
    let file: string
    try { file = boardPath(repo) } catch (e) { return (e as Error).message }
    if (!existsSync(file)) return BOARD_SKIPPED
    const done = exec(scriptCommand(process.env.BOARD_BIN || BOARD_BIN, ['set', id, 'decide', '--title', title, '--file', file]), { timeoutMs: 30_000 })
    return done.code === 0 ? null : (done.stderr || done.stdout).trim().split('\n').pop() || `종료 코드 ${done.code}`
  }
}

// 표 문서. 이 저장소에 있으면 origin 기본 브랜치를 받아 그 것, 없으면 번들의 것이다.
// 받지 않으면 다른 체크아웃이 기본 브랜치에 올린 옛 세대 행을 놓친다. 받지 못하면 마지막으로 받은 것을 읽는다
function tableOf(repo: string, exec: Exec): { text: string } | null {
  if (existsSync(join(repo, TABLE_PATH))) {
    const base = defaultBase(repo) ?? 'main'
    // refspec 를 적어야 작업 브랜치만 받은(--single-branch) 체크아웃에도 origin/<기본 브랜치> 가 생긴다
    exec(['git', '-C', repo, 'fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { timeoutMs: 60_000 })
    const shown = exec(['git', '-C', repo, 'show', `origin/${base}:${TABLE_PATH}`], { timeoutMs: 30_000 })
    return { text: shown.code === 0 ? shown.stdout : readFileSync(join(repo, TABLE_PATH), 'utf8') }
  }
  try {
    return { text: readSelectionTable() }
  } catch {
    return null
  }
}

export function watchModels(repo: string, opts: WatchOptions): void {
  const file = opts.stateFile ?? watchFile()
  const now = opts.now ?? Date.now()
  const exec = opts.exec ?? run
  const board = opts.board ?? boardWriter(repo, exec)
  mkdirSync(dirname(file), { recursive: true })
  withFileLock(file, () => {
    let state = readWatch(file)
    if (state.checked_at === null || now - state.checked_at >= WATCH_MS) {
      state = { ...state, checked_at: now }
      const listed = exec([codexBin(), 'debug', 'models'], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 })
      const parsed = listed.code === 0 ? parseCodexModels(listed.stdout) : null
      if (parsed && parsed.failure === null) state = newModels(state, parsed.models)
      writeWatch(file, state)
    }
    const mine: RepoWatch = state.repos[repo] ?? { checked_at: null, announced: [], boarded: [], tables: {} }
    if (!state.models || (mine.checked_at !== null && state.checked_at !== null && mine.checked_at >= state.checked_at)) return
    const models = state.models
    const notices: Notice[] = []
    for (const slug of state.found) {
      if (!mine.announced.includes(slug)) {
        mine.announced.push(slug)
        const description = models.find((m) => m.slug === slug)?.description ?? ''
        notices.push({ kind: 'MODEL-NEW', text: `${slug} ${description}`.trim() })
      }
      // 보드 쓰기는 성공할 때까지 목록을 읽을 때마다 같은 항목 ID 로 다시 한다. Run 알림은 다시 보내지 않는다
      if (mine.boarded.includes(slug)) continue
      const failed = board(`model-new-${slug.replace(/[^a-z0-9-]/g, '-')}`, `새 모델 ${slug}`)
      if (typeof failed === 'string') notices.push({ kind: 'MODEL-BOARD-FAIL', text: `${slug}: ${failed}` })
      else if (failed === null) mine.boarded.push(slug)
    }
    mine.checked_at = now
    // 알림을 보내기 전에 기록한다. 보내다 죽어도 같은 모델을 다시 알리지 않는다
    state = { ...state, repos: { ...state.repos, [repo]: mine } }
    writeWatch(file, state)
    for (const notice of notices) opts.notify(notice)
    const table = tableOf(repo, exec)
    if (!table) return
    // 표는 고치지 않고 알린다. 같은 행과 같은 바꿈은 한 번만, 보드 항목은 새 세대마다 하나다
    const later: Notice[] = []
    for (const stale of staleRows(table.text, models)) {
      const seen = `stale:${stale.row}:${stale.from}>${stale.to}`
      if (!mine.tables[seen]) {
        mine.tables[seen] = { at: now }
        later.push({ kind: 'MODEL-TABLE-STALE', text: `${stale.row} ${stale.from} → ${stale.to}` })
      }
      if (mine.tables[`board:${stale.to}`]) continue
      const failed = board(`model-table-${stale.to.replace(/[^a-z0-9-]/g, '-')}`, `모델 표를 ${stale.to} 로 바꿀 때`)
      if (typeof failed === 'string') later.push({ kind: 'MODEL-BOARD-FAIL', text: `${stale.to}: ${failed}` })
      else if (failed === null) mine.tables[`board:${stale.to}`] = { at: now }
    }
    writeWatch(file, { ...state, repos: { ...state.repos, [repo]: mine } })
    for (const notice of later) opts.notify(notice)
  }, { waitMs: 5_000, staleMs: 10 * 60_000 })
}
