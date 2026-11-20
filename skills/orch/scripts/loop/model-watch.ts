// 루프 부모가 하루 한 번 설치된 Codex CLI 의 모델 목록을 읽어 새 모델과 같은 계열의 새 세대를 알아챈다(스펙 REQ1, REQ3).
// 계약은 docs/features/model-auto-routing/spec.md 와 design.md 다. 이름 꼴과 세대 비교는 lib/model-generation.ts 가 소유한다.
//
// 기록: <머신 폴더>/model-watch.json(lib/machine.ts). Codex CLI 와 계정이 머신에 하나라 목록 읽기는 머신에 한 번이다.
//     { checked_at, baseline, models, found, repos: { <저장소>: { checked_at, announced, tables: { "<키>": { pr, at } } } } }
//     checked_at 은 목록을 마지막으로 읽은 시각(ms), models 는 그때 읽은 목록, found 는 기준점 뒤에 나타난 현재 세대 모델이다.
//     repos 는 저장소마다 마지막으로 본 시각, 알린 모델, 표에서 다룬 바꿈이다. 옆 잠금 파일 안에서 읽고 rename 으로 쓴다.
// 주기: 머신의 checked_at 에서 WATCH_MS(24시간)가 지나면 어느 저장소의 루프든 목록을 다시 읽는다. 읽지 못해도(codex 없음, 실패) checked_at 을 쓴다.
//     저장소의 checked_at 이 머신의 checked_at 보다 이르면 그 저장소의 루프가 저장된 목록으로 자기 일(알림, 보드, 표)을 한다.
//     다른 저장소의 루프가 먼저 목록을 읽어도 fos-skills 의 루프가 같은 목록으로 표를 본다.
// 새 모델: 첫 목록에 보이는(visibility list) 모델을 기준점으로 남긴다. 단 FIRST_COMPARE 는 기준점에 넣지 않는다(스펙 DECISION15).
//     그 뒤 목록에 보이고 현재 세대(isCurrent)인데 기준점에 없는 모델을 found 에 넣는다.
//     저장소마다 announced 에 없는 found 모델을 한 번 알린다. `MODEL-NEW <모델> <설명>` 을 등록된 Run 에 보내고,
//     그 저장소의 보드 파일이 있으면 decide 항목 `model-new-<모델>`(제목 「새 모델 <모델>」)을 더한다. 보드에 쓰지 못하면 `MODEL-BOARD-FAIL <모델>: <이유>` 다.
//     보내지 못해도 announced 에 넣는다. 같은 모델을 다시 알리지 않는다는 스펙을 따른다. 루프 로그에는 남는다.
// 새 세대: 저장된 목록으로 모델 표를 planTable(lib/model-generation.ts)로 맞춘다. 자리마다 그 effort 를 지원하는 같은 계열 최신으로만 바꾼다.
//     이 저장소에 표 문서(TABLE_PATH)가 있으면(fos-skills) 표를 새 세대로 바꾸는 PR 을 열고 `MODEL-TABLE-PR <PR 주소> <옛>><새>,...` 을 보낸다.
//     표 문서는 origin 기본 브랜치의 것을 읽는다. 표 PR 은 한 번에 하나다(브랜치 `orch/model-table-<새 세대들>`).
//     열린 표 PR 이 있으면 새로 열지 않고, 기본 브랜치에서 표 전체를 다시 맞춘 커밋으로 그 브랜치를 덮어 올리고 제목과 본문을 고친다.
//     PR 은 임시 워크트리에서 표 문서와 변경 조각(skills/orch/changes/<브랜치의 orch/ 뒤>.patch.md)을 커밋해 연다. 워크트리와 로컬 브랜치는 끝나면 지운다.
//     표 문서가 없는 저장소는 그 번들의 표를 읽고 `MODEL-GENERATION <옛> <새>` 만 보낸다.
//     더 높은 세대가 그 자리의 effort 를 지원하지 않으면 그 자리는 바꾸지 않고 `MODEL-TABLE-SKIP <옛> <새> <effort>: <이유>` 를 한 번 보낸다.
//     어느 쪽이든 그 저장소의 tables 에 기록해 같은 바꿈을 다시 하지 않는다. PR 을 열지 못하면 기록하지 않고 `MODEL-TABLE-FAIL <바꿈>: <이유>` 를 보낸다.
//     다음 목록을 읽은 뒤 다시 한다. gh pr create 가 실패하면 올린 브랜치를 원격에서 지운다. 알림의 바꿈은 그 PR 이 담은 바꿈 전체다.
// 테스트는 상태 파일, 시각, 명령 실행기, 알림을 주입한다. 실제 codex 와 gh 를 부르지 않는다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import { defaultBase } from '../lib/git.ts'
import { machineDir } from '../lib/machine.ts'
import { codexBin, isCurrent, parseCodexModels, planTable, type CodexModel, type Generation, type Skipped } from '../lib/model-generation.ts'
import { boardPath } from '../lib/board-file.ts'
import { BOARD_BIN } from '../lib/board.ts'
import { run, scriptCommand } from '../lib/proc.ts'
import type { RunOptions, RunResult } from '../lib/proc.ts'
import { readSelectionTable } from '../lib/usage-boost.ts'

export const WATCH_MS = 24 * 60 * 60 * 1000
export const FIRST_COMPARE: readonly string[] = ['gpt-6.2-astra']
export const TABLE_PATH = 'skills/orch/references/agent-selection.md'

export type RepoWatch = { checked_at: number | null; announced: string[]; tables: Record<string, { pr: string | null; at: number }> }
export type WatchState = {
  checked_at: number | null
  baseline: string[] | null
  models: CodexModel[] | null
  found: string[]
  repos: Record<string, RepoWatch>
}
export type Notice = { kind: string; text: string }
type Exec = (argv: string[], opts?: RunOptions) => RunResult
// board 는 보드에 새 모델 항목을 더한다. 실패하면 이유를, 보드가 없어 건너뛰었거나 성공하면 null 을 낸다
export type WatchOptions = { stateFile?: string; now?: number; exec?: Exec; notify: (notice: Notice) => void; board?: (id: string, title: string) => string | null }

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
    repos[repo] = { checked_at: typeof r.checked_at === 'number' ? r.checked_at : null, announced: list(r.announced) ?? [], tables: object(r.tables) }
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
export function boardWriter(repo: string, exec: Exec): (id: string, title: string) => string | null {
  return (id, title) => {
    let file: string
    try { file = boardPath(repo) } catch (e) { return (e as Error).message }
    if (!existsSync(file)) return null
    const done = exec(scriptCommand(process.env.BOARD_BIN || BOARD_BIN, ['set', id, 'decide', '--title', title, '--file', file]), { timeoutMs: 30_000 })
    return done.code === 0 ? null : (done.stderr || done.stdout).trim().split('\n').pop() || `종료 코드 ${done.code}`
  }
}

function key(upgrades: Generation[]): string {
  return upgrades.map((u) => `${u.from}>${u.to}`).join(',')
}

// 변경 조각은 항목 하나다. 조각 검사(항목 5개, 항목 160자 상한)를 바꿀 모델 수와 상관없이 지킨다
export function fragmentText(upgrades: Generation[]): string {
  const line = `- 상주 루프가 새 세대를 알아채 모델 표의 ${upgrades.map((u) => `\`${u.from}\` 을 \`${u.to}\``).join(', ')} 로 바꿨다.`
  return `${line.length <= 160 ? line : `- 상주 루프가 새 세대를 알아채 모델 표의 옛 세대 ${upgrades.length}개를 같은 계열의 새 세대로 바꿨다.`}\n`
}

// 표 문서를 새 세대로 바꾸는 PR 을 열거나, 열린 표 PR(브랜치 TABLE_BRANCH_PREFIX)이 있으면 그 PR 을 갱신한다. 표 PR 은 한 번에 하나다.
// 어느 쪽이든 origin 기본 브랜치에서 새로 만든다. 표 전체를 목록으로 다시 맞춰, 앞서 연 바꿈과 새 바꿈이 같은 PR 한 곳에만 있다.
// 갱신은 그 브랜치를 기본 브랜치 위 새 커밋으로 덮어 올린다(--force-with-lease). 연 PR 주소 또는 실패 이유를 낸다
export const TABLE_BRANCH_PREFIX = 'orch/model-table-'
export function openTablePr(repo: string, models: CodexModel[], exec: Exec): { pr: string; upgrades: Generation[] } | { failure: string } {
  const base = defaultBase(repo) ?? 'main'
  const git = (cwd: string, args: string[]) => exec(['git', '-C', cwd, ...args], { timeoutMs: 120_000 })
  const gh = (args: string[], cwd = repo) => exec([process.env.GH || 'gh', ...args], { cwd, timeoutMs: 120_000 })
  const last = (r: RunResult) => (r.stderr || r.stdout).trim().split('\n').pop() ?? ''
  const fetched = git(repo, ['fetch', 'origin', base])
  if (fetched.code !== 0) return { failure: `git fetch origin ${base} 실패: ${last(fetched)}` }
  const listed = gh(['pr', 'list', '--state', 'open', '--base', base, '--json', 'number,headRefName,url', '--limit', '100'])
  if (listed.code !== 0) return { failure: `gh pr list 실패: ${last(listed)}` }
  let open: { headRefName?: string; url?: string } | undefined
  try { open = (JSON.parse(listed.stdout) as { headRefName?: string; url?: string }[]).find((pr) => pr.headRefName?.startsWith(TABLE_BRANCH_PREFIX)) }
  catch { return { failure: 'gh pr list 출력이 JSON 이 아니다' } }
  const dir = mkdtempSync(join(tmpdir(), 'orch-model-table-'))
  rmSync(dir, { recursive: true, force: true })
  const added = git(repo, ['worktree', 'add', '--detach', dir, `origin/${base}`])
  if (added.code !== 0) return { failure: `워크트리를 만들지 못했다: ${last(added)}` }
  try {
    const file = join(dir, TABLE_PATH)
    const plan = planTable(readFileSync(file, 'utf8'), models)
    if (!plan.upgrades.length) return { failure: '기본 브랜치의 표 문서에 바꿀 자리가 없다' }
    const targets = [...new Set(plan.upgrades.map((u) => u.to))]
    const branch = open?.headRefName ?? `${TABLE_BRANCH_PREFIX}${targets.join('-')}`
    writeFileSync(file, plan.text)
    const fragment = join(dir, 'skills', 'orch', 'changes', `${branch.slice('orch/'.length)}.patch.md`)
    mkdirSync(dirname(fragment), { recursive: true })
    writeFileSync(fragment, fragmentText(plan.upgrades))
    const title = `feat(orch): 모델 표를 새 세대 ${targets.join(', ')} 로 바꾼다`
    for (const args of [['switch', '-C', branch], ['add', TABLE_PATH, fragment], ['commit', '-m', title]]) {
      const done = git(dir, args)
      if (done.code !== 0) return { failure: `git ${args[0]} 실패: ${last(done)}` }
    }
    const pushed = git(dir, ['push', ...(open ? ['--force-with-lease'] : []), '-u', 'origin', branch])
    if (pushed.code !== 0) return { failure: `push 실패: ${last(pushed)}` }
    const body = [
      '## 요약',
      '',
      '상주 루프가 `codex debug models` 에서 표의 모델보다 높은 같은 계열 세대를 알아채 모델 표와 사용 한도 표를 바꿨다.',
      '띄우기는 이미 새 세대로 돌고 있고, 이 PR 이 머지되면 표와 실제로 띄우는 모델이 같아진다. 새 세대가 또 나오면 루프가 이 PR 을 기본 브랜치에서 다시 만들어 덮는다.',
      '',
      '## 바꾼 모델',
      '',
      ...plan.upgrades.map((u) => `- \`${u.from}\` → \`${u.to}\``),
      ...(plan.skipped.length ? ['', '## 바꾸지 않은 자리', '', ...plan.skipped.map((k) => `- \`${k.from}\` effort \`${k.effort ?? '기본'}\`: ${k.reason}`)] : []),
      '',
      '머지는 코디네이터가 한다. 계약은 `docs/features/model-auto-routing/spec.md` 의 REQ3 이다.',
    ].join('\n')
    if (open?.url) {
      const edited = gh(['pr', 'edit', open.url, '--title', title, '--body', body], dir)
      if (edited.code !== 0) return { failure: `gh pr edit 실패: ${last(edited)}` }
      return { pr: open.url, upgrades: plan.upgrades }
    }
    const created = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], dir)
    if (created.code !== 0) {
      // 브랜치만 남으면 다음 갱신이 열린 PR 을 찾지 못한다. 올린 브랜치를 지워 다음에 다시 열게 한다
      git(dir, ['push', 'origin', '--delete', branch])
      return { failure: `gh pr create 실패: ${last(created)}` }
    }
    return { pr: created.stdout.trim().split('\n').pop() ?? '', upgrades: plan.upgrades }
  } finally {
    git(repo, ['worktree', 'remove', '--force', dir])
    for (const line of git(repo, ['branch', '--list', `${TABLE_BRANCH_PREFIX}*`]).stdout.split('\n')) {
      const name = line.replace(/^[*+ ]+/, '').trim()
      if (name) git(repo, ['branch', '-D', name])
    }
  }
}

// 표 문서. 이 저장소에 있으면 origin 기본 브랜치의 것, 없으면 번들의 것이다
function tableOf(repo: string, exec: Exec): { text: string; own: boolean } | null {
  if (existsSync(join(repo, TABLE_PATH))) {
    const base = defaultBase(repo) ?? 'main'
    const shown = exec(['git', '-C', repo, 'show', `origin/${base}:${TABLE_PATH}`], { timeoutMs: 30_000 })
    return { text: shown.code === 0 ? shown.stdout : readFileSync(join(repo, TABLE_PATH), 'utf8'), own: true }
  }
  try {
    return { text: readSelectionTable(), own: false }
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
    const mine: RepoWatch = state.repos[repo] ?? { checked_at: null, announced: [], tables: {} }
    if (!state.models || (mine.checked_at !== null && state.checked_at !== null && mine.checked_at >= state.checked_at)) return
    const models = state.models
    const notices: Notice[] = []
    for (const slug of state.found) {
      if (mine.announced.includes(slug)) continue
      mine.announced.push(slug)
      const description = models.find((m) => m.slug === slug)?.description ?? ''
      notices.push({ kind: 'MODEL-NEW', text: `${slug} ${description}`.trim() })
      const failed = board(`model-new-${slug.replace(/[^a-z0-9-]/g, '-')}`, `새 모델 ${slug}`)
      if (failed) notices.push({ kind: 'MODEL-BOARD-FAIL', text: `${slug}: ${failed}` })
    }
    mine.checked_at = now
    // 알림을 보내기 전에 기록한다. 보내다 죽어도 같은 모델을 다시 알리지 않는다
    state = { ...state, repos: { ...state.repos, [repo]: mine } }
    writeWatch(file, state)
    for (const notice of notices) opts.notify(notice)
    const table = tableOf(repo, exec)
    if (!table) return
    const plan = planTable(table.text, models)
    const pending = plan.upgrades.filter((u) => !mine.tables[`${u.from}>${u.to}`])
    const skipped = plan.skipped.filter((k) => !mine.tables[`skip:${k.from}>${k.to}@${k.effort}`])
    for (const k of skipped) {
      mine.tables[`skip:${k.from}>${k.to}@${k.effort}`] = { pr: null, at: now }
      opts.notify({ kind: 'MODEL-TABLE-SKIP', text: `${k.from} ${k.to} ${k.effort ?? '기본'}: ${k.reason}` })
    }
    if (pending.length && table.own) {
      const opened = openTablePr(repo, models, exec)
      if ('failure' in opened) opts.notify({ kind: 'MODEL-TABLE-FAIL', text: `${key(pending)}: ${opened.failure}` })
      else {
        for (const u of opened.upgrades) mine.tables[`${u.from}>${u.to}`] = { pr: opened.pr, at: now }
        opts.notify({ kind: 'MODEL-TABLE-PR', text: `${opened.pr} ${key(opened.upgrades)}` })
      }
    } else for (const u of pending) {
      mine.tables[`${u.from}>${u.to}`] = { pr: null, at: now }
      opts.notify({ kind: 'MODEL-GENERATION', text: `${u.from} ${u.to}` })
    }
    writeWatch(file, { ...state, repos: { ...state.repos, [repo]: mine } })
  }, { waitMs: 5_000, staleMs: 10 * 60_000 })
}
