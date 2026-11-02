// 업무 알림함 명령. /board 훅과 대화가 같은 명령으로 알림을 받고, 맥락을 읽고, 답한다.
// 설계는 docs/features/work-inbox/spec.md, 파일 형식은 inbox/references/config.md 가 소유한다.
//
// 사용:
//   inbox.ts board --repo <주 checkout> [--json]   보드에 보일 항목. 캐시가 intervalMinutes 보다 오래됐으면 먼저 받는다
//   inbox.ts fetch [--force]                        받기만 한다. --force 는 주기를 무시한다
//   inbox.ts list [--repo <경로>]                   항목을 사람이 읽는 줄로 낸다. --repo 가 없으면 넘긴 것 말고 모두
//   inbox.ts context <id>                           본문과 앞 대화를 JSON 으로 낸다. 작성자는 이름으로 푼다
//   inbox.ts reply <id> --body-file <파일> [--yes]  받는 사람 멘션과 signature 를 붙여 등록한다. --yes 가 없으면 합성한 본문만 낸다
//   inbox.ts dismiss <id> [--undo]                  넘긴 것으로 적는다. 모든 저장소의 보드에서 사라진다
// 종료 코드: 0 성공, 1 거절·실패(이유는 stderr), 2 사용법 오류, 3 확인 필요(reply 에 --yes 없음)
// 설정 파일이 없으면 board --json 은 {"enabled": false} 를 내고 0, 다른 명령은 1 이다(R6).
// 명령 실행은 import.meta.main 안에만 둔다. 테스트는 main 에 가짜 adapter 와 Runner 를 넣는다.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { orchDir } from '../../orch/scripts/lib/paths.ts'
import { ADAPTERS } from './adapters/index.ts'
import type { Adapter, AdapterFactory, InboxItem, Runner } from './lib/model.ts'
import { type CacheFile, type Config, readConfig, Store } from './lib/store.ts'
import { boardView, type RepoFilter, visibleItems } from './lib/view.ts'

// 받기 한 번에 「답함」 을 확인하는 새 항목 수. 항목마다 두레이 호출이 하나씩 든다
export const MAX_ANSWER_CHECKS = 15
export const FILTER_FILE = join('config', 'notification.json')

const USAGE = '사용법: inbox.ts {board,fetch,list,context,reply,dismiss} [id] [--repo R] [--json] [--force] [--body-file F] [--yes] [--undo]'

export type Deps = {
  run: Runner
  now: () => Date
  adapters: Readonly<Record<string, AdapterFactory>>
  out: (text: string) => void
  err: (text: string) => void
  tmpDir: string
}

class Refused extends Error {}

export const defaultRunner: Runner = (argv) => {
  const done = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
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

export function filterPath(repo: string): string {
  return join(orchDir(repo), FILTER_FILE)
}

function readFilter(repo: string): RepoFilter | null {
  const path = filterPath(repo)
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} 는 adapter 이름을 키로 둔 객체여야 한다`)
  return value as RepoFilter
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

// 캐시가 오래됐으면 받아서 합친다. 다른 세션이 받고 있으면 지금 캐시를 그대로 쓴다
export function sync(session: Session, setupErrors: Record<string, string>, force: boolean): CacheFile {
  const { config, store, deps } = session
  const cache = store.cache()
  const now = deps.now()
  const stale = force || !cache.fetchedAt || now.getTime() - Date.parse(cache.fetchedAt) >= config.intervalMinutes * 60 * 1000
  if (!stale || !store.lock(now.getTime())) return cache
  try {
    const since = new Date(now.getTime() - config.days * 24 * 60 * 60 * 1000).toISOString()
    const lastOk = store.read<Record<string, string>>('last-ok', {})
    const byId = new Map(cache.items.map((item) => [item.id, item]))
    const errors: Record<string, string> = { ...setupErrors }
    for (const adapter of session.adapters.values()) {
      const result = adapter.fetch({ since, lastFetchedAt: lastOk[adapter.name] ?? null })
      for (const [source, message] of Object.entries(result.errors)) errors[`${adapter.name}:${source}`] = message
      if (Object.keys(result.errors).length === 0) lastOk[adapter.name] = now.toISOString()
      for (const item of result.items) {
        const known = byId.get(item.id)
        // 받은 값으로 갱신하되 답함 표시는 남긴다
        byId.set(item.id, known ? { ...item, state: known.state, at: known.at } : item)
      }
    }
    const items = [...byId.values()].filter((item) => !(Date.parse(item.at) < Date.parse(since)))
    const dismissed = store.dismissed()
    const pending = items
      .filter((item) => item.state === 'new' && !dismissed.has(item.id))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_ANSWER_CHECKS)
    for (const item of pending) {
      const adapter = session.adapters.get(item.adapter)
      try {
        if (adapter?.answered(item)) item.state = 'answered'
      } catch {
        // 확인하지 못한 항목은 새 항목으로 둔다. 다음 받기에서 다시 본다
      }
    }
    const next: CacheFile = { fetchedAt: now.toISOString(), items, errors }
    store.write('cache', next)
    store.write('last-ok', lastOk)
    return next
  } finally {
    store.unlock()
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

type Parsed = { cmd: string; id?: string; repo?: string; json: boolean; force: boolean; bodyFile?: string; yes: boolean; undo: boolean }

function parse(argv: string[]): Parsed | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help'
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
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
  return {
    cmd, id, repo: values.repo, json: values.json ?? false, force: values.force ?? false,
    bodyFile: values['body-file'], yes: values.yes ?? false, undo: values.undo ?? false,
  }
}

function boardCommand(a: Parsed, session: Session, setupErrors: Record<string, string>): void {
  const { config, store, deps } = session
  const errors: Record<string, string> = {}
  let cache: CacheFile
  try {
    cache = sync(session, setupErrors, false)
  } catch (error) {
    cache = store.cache()
    errors.inbox = (error as Error).message
  }
  const repo = a.repo as string
  let filter: RepoFilter | null = null
  try {
    filter = readFilter(repo)
  } catch (error) {
    errors.filter = (error as Error).message
  }
  let repos = store.repos()
  if (filter && !repos.some((known) => samePath(known, repo))) {
    repos = [...repos, repo]
    store.write('repos', repos)
  }
  const knownFilters: RepoFilter[] = []
  for (const known of repos) {
    if (samePath(known, repo)) continue
    try {
      const other = readFilter(known)
      if (other) knownFilters.push(other)
    } catch {
      // 다른 저장소의 필터가 깨졌으면 그 저장소는 미분류 판정에서 뺀다
    }
  }
  if (filter) knownFilters.push(filter)
  const isDefault = config.defaultBoard ? samePath(config.defaultBoard, repo) : null
  const view = boardView({ items: cache.items, dismissed: store.dismissed(), now: deps.now(), days: config.days, filter, knownFilters, isDefault })
  const result = {
    enabled: true,
    fetchedAt: cache.fetchedAt,
    errors: { ...cache.errors, ...errors },
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
    throw new Refused('알림함 설정이 없다. inbox/references/config.md 대로 ~/.config/fos-skills/inbox.json 을 만든다')
  }
  const { session, errors: setupErrors } = openSession(config, deps)
  const { store } = session
  switch (a.cmd) {
    case 'board':
      boardCommand(a, session, setupErrors)
      return 0
    case 'fetch': {
      const cache = sync(session, setupErrors, a.force)
      deps.out(`받은 시각 ${cache.fetchedAt ?? '-'}, 항목 ${cache.items.length}\n`)
      for (const [source, message] of Object.entries(cache.errors)) deps.out(`! ${source}: ${message}\n`)
      return 0
    }
    case 'list': {
      const cache = store.cache()
      const items = visibleItems(cache.items, store.dismissed(), session.deps.now(), config.days)
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
      const cache = store.cache()
      for (const row of cache.items) if (row.id === item.id) row.state = 'answered'
      store.write('cache', cache)
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

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    run: defaultRunner,
    now: () => new Date(),
    adapters: ADAPTERS,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    tmpDir: tmpdir(),
  })
}

