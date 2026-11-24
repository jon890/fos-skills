// 업무 알림함 명령. /board 훅과 대화가 같은 명령으로 알림을 받고, 맥락을 읽고, 답한다.
// 설계는 docs/features/work-inbox/spec.md, 파일 형식은 skills/inbox/references/config.md 가 소유한다.
//
// 사용:
//   inbox.ts board --repo <주 checkout> [--json]   보드에 보일 항목. 주기가 지난 출처 받기를 따로 띄우고 지금 캐시를 낸다
//   inbox.ts fetch [--force]                        받기만 한다. --force 는 주기를 무시한다
//   inbox.ts list [--repo <경로>]                   항목을 사람이 읽는 줄로 낸다. --repo 가 없으면 넘긴 것 말고 모두
//   inbox.ts context <id>                           본문과 앞 대화를 JSON 으로 낸다. 작성자는 이름으로 푼다
//   inbox.ts reply <id> --body-file <파일> [--yes]  받는 사람 멘션과 signature 를 붙여 등록한다. --yes 가 없으면 합성한 본문만 낸다
//   inbox.ts dismiss <id> [--undo]                  넘긴 것으로 적는다. 모든 저장소의 보드에서 사라진다
// 종료 코드: 0 성공, 1 거절·실패(이유는 stderr), 2 사용법 오류, 3 확인 필요(reply 에 --yes 없음)
// 설정 파일이 없으면 board --json 은 {"enabled": false} 를 내고 0, 다른 명령은 1 이다(R6).
// 명령 실행은 import.meta.main 안에만 둔다. 테스트는 main 에 가짜 adapter 와 Runner 를 넣는다.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { orchDir } from '../../orch/scripts/lib/paths.ts'
import { OwnerLockBusy } from '../../orch/scripts/lib/owner-lock.ts'
import { ADAPTERS } from './adapters/index.ts'
import { taskCursorTime } from './adapters/dooray.ts'
import type { Adapter, AdapterConfig, AdapterFactory, FetchResult, InboxItem, Runner } from './lib/model.ts'
import { type CacheFile, type Config, DEFAULT_INTERVAL_MINUTES, readConfig, type SourceState, Store } from './lib/store.ts'
import { boardView, isOff, type RepoFilter, visibleItems } from './lib/view.ts'

// 받기 한 번에 「답함」 을 확인하는 새 항목 수. 항목마다 두레이 호출이 하나씩 든다
export const MAX_ANSWER_CHECKS = 15
// 옛 필터 파일(한 major 동안 함께 읽는다). 새 자리는 CONFIG_FILE 의 inbox 절이다
export const FILTER_FILE = join('config', 'notification.json')
export const CONFIG_FILE = 'config.json'
// 두레이 명령 하나를 기다리는 한도. 넘으면 그 호출만 실패로 친다
const COMMAND_TIMEOUT_MS = 60000

const USAGE = '사용법: inbox.ts {board,fetch,list,context,reply,dismiss} [id] [--repo R] [--json] [--force] [--body-file F] [--yes] [--undo]'

export type Deps = {
  run: Runner
  now: () => Date
  adapters: Readonly<Record<string, AdapterFactory>>
  out: (text: string) => void
  err: (text: string) => void
  tmpDir: string
  // 받기를 따로 띄운다. board 는 보드 훅의 시간 제한 안에 끝나야 해서 받기를 기다리지 않는다.
  // 없으면 board 가 그 자리에서 받는다(테스트)
  startFetch?: (key: string, scheduledAt: string) => void
}

class Refused extends Error {}

export const defaultRunner: Runner = (argv) => {
  const done = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS })
  if (done.error) return { code: 127, stdout: '', stderr: done.error.message }
  return { code: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

function samePath(a: string, b: string): boolean {
  const norm = (path: string) => {
    const trimmed = path.replace(/\/+$/, '')
    try {
      return realpathSync(trimmed)
    } catch {
      return trimmed
    }
  }
  return norm(a) === norm(b)
}

// 옛 자리. 다음 major 에 읽기를 지운다
export function legacyFilterPath(repo: string): string {
  return join(orchDir(repo), FILTER_FILE)
}

// 새 자리: <orch 폴더>/config.json 의 inbox 절
export function filterPath(repo: string): string {
  return join(orchDir(repo), CONFIG_FILE)
}

// 저장해 둔 경로가 옛 파일이면 같은 orch 폴더의 config.json 으로 바꾼다. 같은 저장소를 한 번만 세려는 것이다
function configPathOf(path: string): string {
  return basename(path) === 'notification.json' && basename(dirname(path)) === 'config' ? join(dirname(dirname(path)), CONFIG_FILE) : path
}

function legacyPathOf(path: string): string {
  return join(dirname(path), FILTER_FILE)
}

function asFilter(value: unknown, path: string): RepoFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} 는 adapter 이름을 키로 둔 객체여야 한다`)
  return value as RepoFilter
}

// config.json 의 inbox 절이 있으면 그것, 없으면 옛 파일. source 는 어디서 읽었는지, notes 는 사용자에게 알릴 줄이다
function readFilterFile(configPath: string): { filter: RepoFilter | null; source: 'config' | 'legacy' | 'none'; notes: string[] } {
  const notes: string[] = []
  let section: unknown
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) section = (parsed as Record<string, unknown>).inbox
  }
  const legacy = legacyPathOf(configPath)
  const hasLegacy = existsSync(legacy)
  if (section !== undefined) {
    if (hasLegacy) notes.push(`옛 자리 ${legacy} 는 ${configPath} 의 inbox 절이 있어 무시한다. 지워도 된다`)
    return { filter: asFilter(section, `${configPath} 의 inbox 절`), source: 'config', notes }
  }
  if (!hasLegacy) return { filter: null, source: 'none', notes }
  notes.push(`옛 자리 ${legacy} 를 읽었다. 이 내용을 ${configPath} 의 "inbox" 절로 옮긴다(다음 major 에 옛 파일 읽기를 지운다)`)
  return { filter: asFilter(JSON.parse(readFileSync(legacy, 'utf8')), legacy), source: 'legacy', notes }
}

// 이 저장소의 필터와, 보드가 연 모든 저장소의 필터. 다른 저장소의 필터는 그 저장소가 적어 둔 파일 경로로 읽는다.
// 저장소 경로로 다시 풀면 이 프로세스의 ORCH_DIR 이 다른 저장소에도 적용돼 틀린 파일을 읽는다
function repoFilters(store: Store, repo: string): { filter: RepoFilter | null; knownFilters: RepoFilter[]; error: string; notes: string[] } {
  const path = filterPath(repo)
  let filter: RepoFilter | null = null
  let error = ''
  let notes: string[] = []
  try {
    const read = readFilterFile(path)
    filter = read.filter
    notes = read.notes
  } catch (failure) {
    error = (failure as Error).message
  }
  let paths = store.repos().map(configPathOf)
  if (filter && !isOff(filter) && !paths.some((known) => samePath(known, path))) {
    paths = [...paths, path]
    store.write('repos', paths)
  }
  const knownFilters: RepoFilter[] = []
  for (const known of paths) {
    if (samePath(known, path)) continue
    try {
      const other = readFilterFile(known).filter
      if (other && !isOff(other)) knownFilters.push(other)
    } catch {
      // 다른 저장소의 필터가 깨졌으면 그 저장소는 미분류 판정에서 뺀다
    }
  }
  if (filter && !isOff(filter)) knownFilters.push(filter)
  return { filter, knownFilters, error, notes }
}

type Session = { config: Config; store: Store; deps: Deps; adapters: Map<string, Adapter> }

function adapterOf(session: Session, name: string): Adapter {
  const adapter = session.adapters.get(name)
  if (!adapter) throw new Refused(`설정에 없는 adapter 다: ${name}`)
  return adapter
}

function openSession(config: Config, deps: Deps): { session: Session; errors: Record<string, string> } {
  const store = new Store()
  const adapters = new Map<string, Adapter>()
  const errors: Record<string, string> = {}
  for (const entry of config.adapters) {
    const factory = deps.adapters[entry.type]
    if (!factory) {
      errors[entry.type] = `모르는 adapter 다: ${entry.type}. ${Object.keys(deps.adapters).join(', ')} 중 하나다`
      continue
    }
    adapters.set(entry.type, factory(entry, { run: deps.run, cache: store, now: deps.now, tmpDir: deps.tmpDir }))
  }
  return { session: { config, store, deps, adapters }, errors }
}

type Source = { adapter: Adapter; entry: AdapterConfig; source: string; key: string }

function sources(session: Session): Source[] {
  return [...session.adapters.values()].flatMap((adapter) => {
    const entry = session.config.adapters.find((row) => row.type === adapter.name)
    return adapter.sources.map((source) => ({ adapter, entry: entry ?? { type: adapter.name }, source, key: `${adapter.name}:${source}` }))
  })
}

function fetchErrors(session: Session, cache: CacheFile, setupErrors: Record<string, string>): Record<string, string> {
  const reported = { ...setupErrors }
  for (const { adapter, key } of sources(session)) {
    for (const name of [key, `${adapter.name}:auth`]) {
      if (cache.errors[name]) reported[name] = cache.errors[name]
    }
  }
  return reported
}

function isDue(session: Session, source: Source, state: SourceState, now: number): boolean {
  const { config } = session
  const canResumeTask = source.adapter.name === 'dooray' && !state.fullScan && taskCursorTime(state.cursor, now) !== null
  const interval = source.source === 'messenger'
    ? config.messengerIntervalMinutes
    : config.taskIntervalMinutes ?? (canResumeTask ? 1 : DEFAULT_INTERVAL_MINUTES)
  return !(now - Date.parse(state.attemptedAt ?? '') < interval * 60 * 1000)
}

function sourceItems(items: InboxItem[], source: Source): InboxItem[] {
  return items.filter((item) => item.adapter === source.adapter.name && item.source === source.source)
}

function syncSource(session: Session, source: Source, now: Date, force: boolean): void {
  const { config, store } = session
  const { adapter, entry, source: name, key } = source
  let entered = false
  try {
    store.withFetchLock(key, () => {
      entered = true
      const cache = store.cache()
      const state = store.sourceState(key, cache)
      if (!force && !isDue(session, source, state, now.getTime())) return
      const since = new Date(now.getTime() - config.days * 24 * 60 * 60 * 1000).toISOString()
      let result: FetchResult
      try {
        result = adapter.fetch({ since, cursors: state.cursor ? { [name]: state.cursor } : {} }, name)
      } catch (error) {
        result = { items: [], errors: { [name]: (error as Error).message }, cursors: {} }
      }

      const byId = new Map(sourceItems(cache.items, source).map((item) => [item.id, item]))
      for (const item of sourceItems(result.items, source)) {
        const known = byId.get(item.id)
        byId.set(item.id, known ? { ...item, state: known.state, at: known.at } : item)
      }
      const exclusions = entry[name === 'messenger' ? 'excludeChannels' : 'excludeProjects']
      const items = [...byId.values()].filter((item) =>
        !(Date.parse(item.at) < Date.parse(since)) &&
        (!Array.isArray(exclusions) || !item.scope.some((scope) => exclusions.includes(scope))))
      const dismissed = store.dismissed()
      const pending = items
        .filter((item) => item.state === 'new' && !dismissed.has(item.id))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, MAX_ANSWER_CHECKS)
      for (const item of pending) {
        try {
          if (adapter.answered(item)) item.state = 'answered'
        } catch {
          // 확인하지 못한 항목은 다음 받기에서 다시 본다
        }
      }

      const attemptedAt = now.toISOString()
      store.updateCache((latest) => {
        const answered = new Set(sourceItems(latest.items, source).filter((item) => item.state === 'answered').map((item) => item.id))
        for (const item of items) if (answered.has(item.id)) item.state = 'answered'
        latest.items = latest.items.filter((item) => item.adapter !== adapter.name || item.source !== name).concat(items)
        if (!latest.fetchedAt || attemptedAt > latest.fetchedAt) latest.fetchedAt = attemptedAt
        latest.sources[key] = {
          attemptedAt,
          cursor: result.cursors[name] ?? state.cursor,
          authError: result.errors.auth,
          fullScan: result.cursors[name] ? result.fullScanSources?.includes(name) : state.fullScan,
        }
        if (result.errors[name]) latest.errors[key] = result.errors[name]
        else delete latest.errors[key]
        const auth = adapter.sources.map((s) => latest.sources[`${adapter.name}:${s}`]?.authError).find(Boolean)
        if (auth) latest.errors[`${adapter.name}:auth`] = auth
        else delete latest.errors[`${adapter.name}:auth`]
      })
    })
  } catch (error) {
    if (entered || !(error instanceof OwnerLockBusy)) throw error
  }
}

function findItem(store: Store, id: string): InboxItem {
  const item = store.cache().items.find((row) => row.id === id)
  if (!item) throw new Refused(`항목이 없다: ${id}. inbox.ts list 로 id 를 본다`)
  return item
}

function line(item: InboxItem): string {
  const mark = item.state === 'answered' ? '✓' : '●'
  return `${mark} ${item.id}  ${item.title}  ${item.from.name || item.from.id} · ${item.kind} · ${item.at}${item.excerpt ? `\n    ${item.excerpt}` : ''}`
}

type Parsed = { cmd: string; id?: string; repo?: string; json: boolean; force: boolean; source?: string; scheduledAt?: string; bodyFile?: string; yes: boolean; undo: boolean }

function parse(argv: string[]): Parsed | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help'
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      source: { type: 'string' },
      'scheduled-at': { type: 'string' },
      'body-file': { type: 'string' },
      yes: { type: 'boolean' },
      undo: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const [cmd, id, ...rest] = positionals
  if (!cmd || !['board', 'fetch', 'list', 'context', 'reply', 'dismiss'].includes(cmd)) throw new Error(`명령이 필요하다: ${cmd ?? ''}`)
  if (rest.length > 0) throw new Error(`모르는 인자: ${rest.join(' ')}`)
  if (['context', 'reply', 'dismiss'].includes(cmd) && !id) throw new Error(`${cmd} 에는 항목 id 가 필요하다`)
  if (cmd === 'board' && !values.repo) throw new Error('board 에는 --repo 가 필요하다')
  if (cmd === 'reply' && !values['body-file']) throw new Error('reply 에는 --body-file 이 필요하다')
  if (values.source !== undefined && cmd !== 'fetch') throw new Error('--source 는 fetch 에서만 쓴다')
  if (values['scheduled-at'] !== undefined && (!values.source || !Number.isFinite(Date.parse(values['scheduled-at'])))) {
    throw new Error('--scheduled-at 에는 출처와 시각이 필요하다')
  }
  return {
    source: values.source, scheduledAt: values['scheduled-at'],
    cmd, id, repo: values.repo, json: values.json ?? false, force: values.force ?? false,
    bodyFile: values['body-file'], yes: values.yes ?? false, undo: values.undo ?? false,
  }
}

function boardCommand(a: Parsed, session: Session, setupErrors: Record<string, string>): void {
  const { config, store, deps } = session
  // 필터가 알림을 끈 저장소는 받기도 띄우지 않고 설정이 없을 때와 같은 응답을 낸다
  if (isOff(repoFilters(store, a.repo as string).filter)) {
    deps.out(a.json ? '{"enabled":false}\n' : '알림 꺼짐\n')
    return
  }
  const errors: Record<string, string> = {}
  let cache = store.cache()
  try {
    const now = deps.now()
    for (const source of sources(session)) {
      if (!isDue(session, source, store.sourceState(source.key, cache), now.getTime()) || store.fetchHeld(source.key)) continue
      if (deps.startFetch) deps.startFetch(source.key, now.toISOString())
      else {
        syncSource(session, source, now, false)
        cache = store.cache()
      }
    }
  } catch (error) {
    cache = store.cache()
    errors.inbox = (error as Error).message
  }
  const repo = a.repo as string
  const { filter, knownFilters, error, notes } = repoFilters(store, repo)
  if (error) errors.filter = error
  for (const note of notes) deps.err(`${note}\n`)
  const isDefault = config.defaultBoard ? samePath(config.defaultBoard, repo) : null
  const view = boardView({ items: cache.items, dismissed: store.dismissed(), now: deps.now(), days: config.days, filter, knownFilters, isDefault })
  const result = {
    enabled: true,
    fetchedAt: cache.fetchedAt,
    errors: { ...fetchErrors(session, cache, setupErrors), ...errors },
    filtered: filter !== null,
    isDefault: isDefault === true,
    newCount: view.newCount,
    unclassified: view.unclassified,
    items: view.items,
  }
  if (a.json) deps.out(`${JSON.stringify(result)}\n`)
  else {
    deps.out(`알림 ${result.newCount}${result.unclassified ? ` · 미분류 ${result.unclassified}` : ''}\n`)
    for (const [source, message] of Object.entries(result.errors)) deps.out(`! ${source}: ${message}\n`)
    for (const item of view.items) deps.out(`${line(item)}\n`)
  }
}

function run(a: Parsed, deps: Deps): number {
  const config = readConfig()
  if (!config) {
    if (a.cmd === 'board' && a.json) {
      deps.out('{"enabled":false}\n')
      return 0
    }
    throw new Refused('알림함 설정이 없다. skills/inbox/references/config.md 대로 ~/.config/fos-skills/inbox.json 을 만든다')
  }
  const { session, errors: setupErrors } = openSession(config, deps)
  const { store } = session
  switch (a.cmd) {
    case 'board':
      boardCommand(a, session, setupErrors)
      return 0
    case 'fetch': {
      const selected = sources(session).filter(({ key }) => a.source === undefined || a.source === key)
      if (a.source !== undefined && selected.length === 0) throw new Refused(`설정에 없는 출처다: ${a.source}`)
      const scheduled = a.scheduledAt ? new Date(a.scheduledAt) : deps.now()
      for (const source of selected) syncSource(session, source, scheduled, a.force)
      const cache = store.cache()
      deps.out(`받은 시각 ${cache.fetchedAt ?? '-'}, 항목 ${cache.items.length}\n`)
      for (const [source, message] of Object.entries(fetchErrors(session, cache, setupErrors))) deps.out(`! ${source}: ${message}\n`)
      return 0
    }
    case 'list': {
      const cache = store.cache()
      let items = visibleItems(cache.items, store.dismissed(), session.deps.now(), config.days)
      if (a.repo) {
        const { filter, knownFilters, notes } = repoFilters(store, a.repo)
        for (const note of notes) deps.err(`${note}\n`)
        const isDefault = config.defaultBoard ? samePath(config.defaultBoard, a.repo) : null
        items = boardView({ items: cache.items, dismissed: store.dismissed(), now: session.deps.now(), days: config.days, filter, knownFilters, isDefault }).items
      }
      for (const item of items) deps.out(`${line(item)}\n`)
      return 0
    }
    case 'context': {
      const item = findItem(store, a.id as string)
      const context = adapterOf(session, item.adapter).context(item)
      deps.out(`${JSON.stringify(context, null, 1)}\n`)
      if (context.unresolved.length > 0) {
        deps.err(`이름으로 풀지 못한 사람: ${context.unresolved.join(', ')}. 초안을 쓰기 전에 dooray member get 으로 확인한다\n`)
        return 1
      }
      return 0
    }
    case 'reply': {
      const item = findItem(store, a.id as string)
      const adapter = adapterOf(session, item.adapter)
      const body = readFileSync(a.bodyFile as string, 'utf8')
      if (!body.trim()) throw new Refused('본문이 비었다')
      const text = adapter.compose(item, body, config.signature)
      if (!a.yes) {
        deps.out(text.endsWith('\n') ? text : `${text}\n`)
        deps.err('등록하지 않았다. 사용자가 이 본문을 확인한 뒤 --yes 를 붙여 다시 부른다\n')
        return 3
      }
      const url = adapter.reply(item, text)
      store.updateCache((cache) => {
        for (const row of cache.items) if (row.id === item.id) row.state = 'answered'
      })
      deps.out(`등록했다${url ? `: ${url}` : ''}\n`)
      return 0
    }
    case 'dismiss': {
      const dismissed = store.dismissed()
      if (a.undo) dismissed.delete(a.id as string)
      else dismissed.add(a.id as string)
      store.write('dismissed', [...dismissed])
      deps.out(`${a.undo ? '되돌렸다' : '넘겼다'}: ${a.id}\n`)
      return 0
    }
  }
  return 2
}

export function main(argv: string[], deps: Deps): number {
  let parsed: Parsed | 'help'
  try {
    parsed = parse(argv)
  } catch (error) {
    deps.err(`${USAGE}\ninbox.ts: error: ${(error as Error).message}\n`)
    return 2
  }
  if (parsed === 'help') {
    deps.out(`${USAGE}\n`)
    return 0
  }
  try {
    return run(parsed, deps)
  } catch (error) {
    deps.err(`${(error as Error).message}\n`)
    return 1
  }
}

// 받기를 떼어 띄운다. 이 프로세스가 끝나도 받기는 이어지고, 잠금이 같은 시각의 중복 받기를 막는다
function startDetachedFetch(key: string, scheduledAt: string): void {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), 'fetch', '--source', key, '--scheduled-at', scheduledAt], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    startFetch: startDetachedFetch,
    run: defaultRunner,
    now: () => new Date(),
    adapters: ADAPTERS,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    tmpDir: tmpdir(),
  })
}
