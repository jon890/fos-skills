// inbox.ts 를 가짜 adapter 와 임시 폴더로 돌려 본다. 두레이에는 닿지 않는다.
// 설정과 상태 폴더는 INBOX_CONFIG, INBOX_STATE_DIR 로 테스트마다 새로 만든다.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { ADAPTERS } from '../scripts/adapters/index.ts'
import { type Deps, main } from '../scripts/inbox.ts'
import type { Adapter, AdapterFactory, FetchRequest, FetchResult, InboxItem, RunResult } from '../scripts/lib/model.ts'
import { DEFAULT_SIGNATURE, Store } from '../scripts/lib/store.ts'

const NOW = new Date('2026-11-02T06:00:00.000Z')

function item(id: string, scope: string[], at = '2026-11-02T05:00:00.000Z', extra: Partial<InboxItem> = {}): InboxItem {
  return {
    id: `fake:task:${id}`, adapter: 'fake', source: 'task', kind: 'mention', title: `업무 ${id}`, url: '',
    scope, from: { id: 'u1', name: '김철수' }, at, excerpt: '확인 부탁드려요', target: { kind: 'task', postId: id }, state: 'new', ...extra,
  }
}

type FakeState = {
  items: InboxItem[]
  errors: Record<string, string>
  answered: Set<string>
  fetches: (FetchRequest & { source: string })[]
  replies: { id: string; text: string }[]
  failReply?: boolean
  duringFetch?: (source: string) => void
  people: Record<string, string>
}

function fakeFactory(state: FakeState): AdapterFactory {
  return () => {
    const adapter: Adapter = {
      name: 'fake',
      sources: ['task', 'messenger'],
      fetch(request, source = 'task'): FetchResult {
        state.fetches.push({ ...request, source })
        state.duringFetch?.(source)
        const error = state.errors[source]
        return {
          items: state.items.filter((row) => row.source === source).map((row) => ({ ...row })),
          errors: error ? { [source]: error } : {},
          cursors: error ? {} : { [source]: now.toISOString() },
        }
      },
      context(row) {
        const ids = ['u1', 'u2']
        const names = adapter.resolvePeople(ids)
        return {
          item: row, body: '본문',
          previous: ids.map((id) => ({ from: { id, name: names.get(id) ?? '' }, at: row.at, text: '앞 댓글' })),
          unresolved: ids.filter((id) => !names.has(id)),
        }
      },
      resolvePeople(ids) {
        return new Map(ids.filter((id) => state.people[id]).map((id) => [id, state.people[id]]))
      },
      answered(row) {
        return state.answered.has(row.id)
      },
      compose(row, body, signature) {
        return `@${row.from.name} ${body.trim()}${signature ? `\n\n${signature}` : ''}`
      },
      reply(row, text) {
        if (state.failReply) throw new Error('등록 실패 (500)')
        state.replies.push({ id: row.id, text })
        return 'https://example.test/task'
      },
    }
    return adapter
  }
}

let dir: string
let state: FakeState
let now: Date
let out: string
let err: string
let extra: Partial<Deps>

function deps(): Deps {
  return {
    run: () => { throw new Error('가짜 adapter 는 명령을 부르지 않는다') },
    now: () => now,
    adapters: { fake: fakeFactory(state) },
    out: (text) => { out += text },
    err: (text) => { err += text },
    tmpDir: dir,
    ...extra,
  }
}

function call(...argv: string[]): number {
  out = ''
  err = ''
  return main(argv, deps())
}

function writeConfig(value: Record<string, unknown>): void {
  writeFileSync(process.env.INBOX_CONFIG as string, JSON.stringify({ adapters: [{ type: 'fake' }], ...value }))
}

// 필터 파일을 가진 저장소 폴더. git 밖이라 orch 폴더는 <폴더>/.orch 다
function repo(name: string, filter: Record<string, unknown> | null): string {
  const root = join(dir, name)
  mkdirSync(join(root, '.orch', 'config'), { recursive: true })
  if (filter) writeFileSync(join(root, '.orch', 'config.json'), JSON.stringify({ inbox: filter }))
  return root
}

// 옛 자리(config/notification.json)에 필터를 둔 저장소 폴더
function legacyRepo(name: string, filter: Record<string, unknown>): string {
  const root = repo(name, null)
  writeFileSync(join(root, '.orch', 'config', 'notification.json'), JSON.stringify(filter))
  return root
}

function board(root: string) {
  assert.equal(call('board', '--repo', root, '--json'), 0, err)
  return JSON.parse(out)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inbox-spec-'))
  process.env.INBOX_CONFIG = join(dir, 'inbox.json')
  process.env.INBOX_STATE_DIR = join(dir, 'state')
  delete process.env.ORCH_DIR
  now = NOW
  extra = {}
  state = { items: [], errors: {}, answered: new Set(), fetches: [], replies: [], people: { u1: '김철수', u2: '이영희' } }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('설정과 받기', () => {
  test('설정이 없으면 board 는 enabled false 이고 adapter 를 부르지 않는다 (R6)', () => {
    assert.equal(call('board', '--repo', repo('a', null), '--json'), 0)
    assert.deepEqual(JSON.parse(out), { enabled: false })
    assert.equal(state.fetches.length, 0)
    assert.equal(call('list'), 1)
    assert.match(err, /설정이 없다/)
  })

  test('가짜 adapter 의 항목을 코드 변경 없이 보인다 (R2)', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const view = board(repo('a', null))
    assert.equal(view.enabled, true)
    assert.equal(view.newCount, 1)
    assert.equal(view.items[0].id, 'fake:task:1')
    assert.equal(view.items[0].from.name, '김철수')
  })

  test('기존 업무 주기는 유지하고 메신저는 1분마다 받는다 (REQ3)', () => {
    writeConfig({ intervalMinutes: 5 })
    const root = repo('a', null)
    board(root)
    board(root)
    assert.deepEqual(state.fetches.map(({ source }) => source), ['task', 'messenger'])
    assert.equal(state.fetches[0].since, '2026-10-26T06:00:00.000Z')
    assert.deepEqual(state.fetches[0].cursors, {})
    now = new Date(NOW.getTime() + 60_000)
    board(root)
    assert.deepEqual(state.fetches[2].cursors, { messenger: NOW.toISOString() })
    now = new Date(NOW.getTime() + 5 * 60_000)
    board(root)
    assert.deepEqual(state.fetches[3].cursors, { task: NOW.toISOString() })
  })

  test('출처별 설정 주기를 쓰고 새 업무 설정이 기존 값에 우선한다 (REQ5)', () => {
    writeConfig({ intervalMinutes: 5, taskIntervalMinutes: 2, messengerIntervalMinutes: 3 })
    const root = repo('a', null)
    board(root)
    now = new Date(NOW.getTime() + 60_000)
    board(root)
    assert.equal(state.fetches.length, 2)
    now = new Date(NOW.getTime() + 2 * 60_000)
    board(root)
    assert.deepEqual(state.fetches.slice(2).map(({ source }) => source), ['task'])
    now = new Date(NOW.getTime() + 3 * 60_000)
    board(root)
    assert.deepEqual(state.fetches.slice(2).map(({ source }) => source), ['task', 'messenger'])
  })

  test('board 는 출처별 받기를 따로 띄우고 지금 캐시를 바로 낸다 (REQ4)', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const started: [string, string][] = []
    extra = { startFetch: (key, at) => { started.push([key, at]) } }
    const root = repo('a', null)
    assert.equal(board(root).items.length, 0)
    assert.deepEqual(started, [['fake:task', NOW.toISOString()], ['fake:messenger', NOW.toISOString()]])
    assert.equal(state.fetches.length, 0)
    now = new Date(NOW.getTime() + 500)
    for (const [key, at] of started) assert.equal(call('fetch', '--source', key, '--scheduled-at', at), 0, err)
    assert.equal(board(root).items.length, 1)
    now = new Date(NOW.getTime() + 60_000)
    board(root)
    assert.deepEqual(started.slice(2), [['fake:messenger', now.toISOString()]])
  })

  test('업무 받기가 잠겨 있어도 메신저만 받는다 (REQ3)', () => {
    writeConfig({})
    const store = new Store()
    const root = repo('a', null)
    store.withFetchLock('fake:task', () => {
      board(root)
      assert.deepEqual(state.fetches.map(({ source }) => source), ['messenger'])
      assert.equal(call('fetch', '--force', '--source', 'fake:task'), 0, err)
      assert.equal(state.fetches.length, 1)
    })
    board(root)
    assert.deepEqual(state.fetches.map(({ source }) => source), ['messenger', 'task'])
  })

  test('업무 받는 동안 메신저가 쓴 캐시와 업무의 답함 표시를 함께 보존한다', () => {
    writeConfig({})
    const task = item('1', ['p1'])
    state.items = [task]
    assert.equal(call('fetch'), 0, err)
    const message = item('m', ['c1'], undefined, { id: 'fake:messenger:m', source: 'messenger' })
    state.items = [task, message]
    const body = join(dir, 'body.md')
    writeFileSync(body, '확인했습니다')
    state.duringFetch = (source) => {
      if (source !== 'task') return
      assert.equal(call('fetch', '--force', '--source', 'fake:messenger'), 0, err)
      assert.equal(call('reply', task.id, '--body-file', body, '--yes'), 0, err)
    }
    now = new Date(NOW.getTime() + 60_000)
    assert.equal(call('fetch', '--force', '--source', 'fake:task'), 0, err)
    const cache = new Store().cache()
    assert.deepEqual(cache.items.map((row) => [row.id, row.state]).sort(), [[message.id, 'new'], [task.id, 'answered']])
    assert.equal(cache.sources['fake:messenger'].cursor, now.toISOString())
  })

  test('기존 캐시와 업무 커서를 이어받고 커서가 있는 업무는 1분부터 받는다 (REQ2, REQ3)', () => {
    writeConfig({ adapters: [{ type: 'dooray', messenger: false }] })
    const store = new Store()
    const root = repo('a', null)
    const legacy = item('1', ['p1'], undefined, { adapter: 'dooray', id: 'dooray:task:1' })
    store.write('cache', { fetchedAt: NOW.toISOString(), items: [legacy], errors: {} })
    const calls: string[][] = []
    extra = {
      adapters: ADAPTERS,
      run: (argv) => {
        calls.push(argv.slice(2))
        return argv[2] === 'member'
          ? { code: 0, stdout: '{"id":"me","defaultOrganization":{"id":"org"}}', stderr: '' }
          : { code: 0, stdout: '[]', stderr: '' }
      },
    }
    now = new Date(NOW.getTime() + 60_000)
    assert.deepEqual(board(root).items.map((row) => row.id), [legacy.id])
    assert.equal(calls.length, 0)
    store.write('last-ok', { 'dooray:task': '잘못된 커서' })
    board(root)
    assert.equal(calls.length, 0)
    store.write('last-ok', { 'dooray:task': NOW.toISOString() })
    board(root)
    assert.deepEqual(calls.find(([command]) => command === 'stream'), ['stream', 'list', '--size', '200'])
    assert.ok(calls.every(([command]) => command !== 'messenger'))
    assert.equal(store.cache().sources['dooray:task'].cursor, now.toISOString())
  })

  test('출처 하나가 실패하면 오류를 남기고 직전 항목을 그대로 보인다 (R7)', () => {
    writeConfig({})
    const root = repo('a', null)
    state.items = [item('1', ['p1']), item('m', ['c1'], undefined, { id: 'fake:messenger:m', source: 'messenger' })]
    board(root)
    state.items = [item('1', ['p1'])]
    state.errors = { messenger: '대화방 1개 읽기 실패' }
    now = new Date(NOW.getTime() + 6 * 60 * 1000)
    const view = board(root)
    assert.deepEqual(view.errors, { 'fake:messenger': '대화방 1개 읽기 실패' })
    assert.deepEqual(view.items.map((row) => row.id).sort(), ['fake:messenger:m', 'fake:task:1'])
    // 실패가 있었으니 다음 받기는 지난 성공 시각부터 다시 읽는다
    now = new Date(NOW.getTime() + 12 * 60 * 1000)
    board(root)
    // 실패한 출처만 지난 커서에서 다시 읽고, 성공한 출처는 앞으로 간다
    assert.deepEqual(state.fetches[4].cursors, { task: new Date(NOW.getTime() + 6 * 60_000).toISOString() })
    assert.deepEqual(state.fetches[5].cursors, { messenger: NOW.toISOString() })
  })

  test('days 보다 오래된 항목은 보이지 않는다', () => {
    writeConfig({ days: 7 })
    state.items = [item('old', ['p1'], '2026-10-20T00:00:00.000Z'), item('new', ['p1'])]
    assert.deepEqual(board(repo('a', null)).items.map((row) => row.id), ['fake:task:new'])
  })
})

describe('답함과 넘김 (R5)', () => {
  test('알림 뒤에 답이 있으면 답함으로 뒤에 두고 새 수에서 뺀다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'], '2026-11-02T05:30:00.000Z'), item('2', ['p1'], '2026-11-02T05:00:00.000Z')]
    state.answered = new Set(['fake:task:1'])
    const view = board(repo('a', null))
    assert.equal(view.newCount, 1)
    assert.deepEqual(view.items.map((row) => [row.id, row.state]), [['fake:task:2', 'new'], ['fake:task:1', 'answered']])
  })

  test('넘긴 항목은 다른 저장소의 보드에서도 사라지고 되돌릴 수 있다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const a = repo('a', null)
    const b = repo('b', null)
    board(a)
    assert.equal(call('dismiss', 'fake:task:1'), 0)
    assert.equal(board(a).items.length, 0)
    assert.equal(board(b).items.length, 0)
    assert.equal(call('dismiss', 'fake:task:1', '--undo'), 0)
    assert.equal(board(b).items.length, 1)
  })
})

describe('저장소 필터 (R8, R9)', () => {
  test('사람 단위 제외 목록은 저장된 항목까지 다음 받기에서 없앤다', () => {
    const main = repo('main', null)
    state.items = [item('excluded', ['proj-id', 'PROJECT']), item('keep', ['other']), item('channel', ['room-id', '개발방'], undefined, { source: 'messenger' })]
    writeConfig({})
    assert.equal(call('fetch', '--force'), 0)
    assert.equal(board(main).items.length, 3)
    writeConfig({ adapters: [{ type: 'fake', excludeProjects: ['PROJECT'], excludeChannels: ['개발방'] }] })
    state.items = []
    assert.equal(call('fetch', '--force'), 0)
    assert.deepEqual(board(main).items.map((row) => row.id), ['fake:task:keep'])
    assert.deepEqual(new Store().cache().items.map((row) => row.id), ['fake:task:keep'])
  })

  test('필터가 있는 저장소는 자기 항목만, 없는 저장소는 모두 보인다', () => {
    writeConfig({})
    state.items = [item('home', ['smarthome']), item('fos', ['fos-assistant']), item('loose', ['etc'])]
    const home = repo('home', { fake: { projects: ['smarthome'] } })
    const fos = repo('fos', { fake: { projects: ['fos-assistant'] } })
    const plain = repo('plain', null)
    board(fos)
    // 기본 보드를 정하지 않았으면 미분류도 목록으로 보인다
    assert.deepEqual(board(home).items.map((row) => row.id).sort(), ['fake:task:home', 'fake:task:loose'])
    assert.equal(board(plain).items.length, 3)
  })

  test('기본 보드에는 미분류 목록, 다른 필터 보드에는 미분류 수만 보인다', () => {
    const home = repo('home', { fake: { projects: ['smarthome'] } })
    const main = repo('main', { fake: { channels: ['개인'] } })
    writeConfig({ defaultBoard: main })
    state.items = [item('home', ['smarthome']), item('loose', ['etc']), item('done', ['etc'], undefined, {})]
    state.answered = new Set(['fake:task:done'])
    board(main)
    const homeView = board(home)
    assert.deepEqual(homeView.items.map((row) => row.id), ['fake:task:home'])
    assert.equal(homeView.unclassified, 1)
    assert.equal(homeView.isDefault, false)
    const mainView = board(main)
    assert.equal(mainView.isDefault, true)
    assert.equal(mainView.unclassified, 0)
    assert.deepEqual(mainView.items.map((row) => row.id), ['fake:task:loose', 'fake:task:done'])
  })

  test('enabled false 인 저장소는 알림을 보지 않고 받기도 띄우지 않는다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const off = repo('off', { enabled: false, fake: { projects: ['p1'] } })
    assert.deepEqual(board(off), { enabled: false })
    assert.equal(state.fetches.length, 0)
    assert.equal(call('board', '--repo', off), 0)
    assert.match(out, /알림 꺼짐/)
    assert.equal(call('list', '--repo', off), 0)
    assert.equal(out.trim(), '')
  })

  test('끈 저장소의 필터는 다른 보드의 미분류 판정에 들지 않는다', () => {
    const home = repo('home', { fake: { projects: ['smarthome'] } })
    const off = repo('off', { enabled: false, fake: { projects: ['etc'] } })
    const main = repo('main', { fake: { channels: ['개인'] } })
    writeConfig({ defaultBoard: main })
    state.items = [item('home', ['smarthome']), item('loose', ['etc'])]
    board(off)
    board(main)
    // etc 는 끈 저장소 소유가 아니라 미분류다
    assert.equal(board(home).unclassified, 1)
    assert.deepEqual(board(main).items.map((row) => row.id), ['fake:task:loose'])
  })

  test('깨진 필터 파일은 오류로 알리고 필터 없이 보인다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const root = repo('a', null)
    writeFileSync(join(root, '.orch', 'config.json'), '{')
    const view = board(root)
    assert.ok(view.errors.filter)
    assert.equal(view.items.length, 1)
  })

  test('config.json 의 inbox 절이 없고 옛 파일만 있으면 옛 파일로 거르고 옛 자리 경고를 stderr 에 낸다', () => {
    writeConfig({ defaultBoard: join(dir, 'other') })
    state.items = [item('1', ['p1']), item('2', ['p2'])]
    const root = legacyRepo('old', { fake: { projects: ['p1'] } })
    // inbox 절 없는 config.json 이 있어도 옛 파일로 내려간다
    writeFileSync(join(root, '.orch', 'config.json'), JSON.stringify({ pipeline: {} }))
    const view = board(root)
    assert.equal(view.filtered, true)
    assert.deepEqual(view.items.map((row) => row.id), ['fake:task:1'])
    assert.match(err, /옛 자리 .*notification\.json.*"inbox" 절로 옮긴다/)
  })

  test('옛 파일만 있어도 enabled false 는 알림을 끈다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    assert.deepEqual(board(legacyRepo('old', { enabled: false })), { enabled: false })
  })

  test('둘 다 있으면 inbox 절을 쓰고 옛 파일은 무시한다고 알린다', () => {
    writeConfig({ defaultBoard: join(dir, 'other') })
    state.items = [item('1', ['p1']), item('2', ['p2'])]
    const root = legacyRepo('both', { fake: { projects: ['p2'] } })
    writeFileSync(join(root, '.orch', 'config.json'), JSON.stringify({ inbox: { fake: { projects: ['p1'] } } }))
    assert.deepEqual(board(root).items.map((row) => row.id), ['fake:task:1'])
    assert.match(err, /무시한다/)
  })

  test('inbox 절만 있으면 경고가 없다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    board(repo('new', { fake: { projects: ['p1'] } }))
    assert.equal(err, '')
  })

  test('inbox 절이 객체가 아니면 오류로 알리고 필터 없이 보인다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const root = repo('a', null)
    writeFileSync(join(root, '.orch', 'config.json'), JSON.stringify({ inbox: [] }))
    const view = board(root)
    assert.match(view.errors.filter, /inbox 절/)
    assert.equal(view.items.length, 1)
  })

  test('옛 파일 필터의 저장소도 다른 보드의 미분류 판정에 든다', () => {
    const home = legacyRepo('home', { fake: { projects: ['smarthome'] } })
    const main = repo('main', { fake: { channels: ['개인'] } })
    writeConfig({ defaultBoard: main })
    state.items = [item('home', ['smarthome']), item('loose', ['etc'])]
    board(home)
    assert.deepEqual(board(main).items.map((row) => row.id), ['fake:task:loose'])
  })
})

describe('맥락과 답변', () => {
  test('context 는 작성자를 이름으로 풀고, 풀지 못하면 1 이다 (R3)', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    board(repo('a', null))
    assert.equal(call('context', 'fake:task:1'), 0, err)
    assert.deepEqual(JSON.parse(out).previous.map((row) => row.from.name), ['김철수', '이영희'])
    delete state.people.u2
    assert.equal(call('context', 'fake:task:1'), 1)
    assert.match(err, /u2/)
  })

  test('reply 는 --yes 없이 합성한 본문만 내고 3 이다 (R4, R10)', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    board(repo('a', null))
    const body = join(dir, 'body.md')
    writeFileSync(body, '확인했습니다.\n')
    assert.equal(call('reply', 'fake:task:1', '--body-file', body), 3)
    assert.equal(out, `@김철수 확인했습니다.\n\n${DEFAULT_SIGNATURE}\n`)
    assert.equal(state.replies.length, 0)
    assert.equal(call('reply', 'fake:task:1', '--body-file', body, '--yes'), 0)
    assert.equal(state.replies.length, 1)
    assert.match(out, /등록했다: https:\/\/example.test\/task/)
    // 등록한 항목은 다음 받기 전에도 답함이다
    assert.equal(board(repo('a', null)).newCount, 0)
  })

  test('등록이 실패하면 1 이고 답함으로 적지 않는다', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const root = repo('a', null)
    board(root)
    const body = join(dir, 'body.md')
    writeFileSync(body, '네')
    state.failReply = true
    assert.equal(call('reply', 'fake:task:1', '--body-file', body, '--yes'), 1)
    assert.match(err, /등록 실패/)
    assert.equal(board(root).newCount, 1)
  })

  test('signature 가 빈 문자열이면 붙이지 않는다 (R10)', () => {
    writeConfig({ signature: '' })
    state.items = [item('1', ['p1'])]
    board(repo('a', null))
    const body = join(dir, 'body.md')
    writeFileSync(body, '네')
    assert.equal(call('reply', 'fake:task:1', '--body-file', body), 3)
    assert.equal(out, '@김철수 네\n')
  })

  test('없는 id 와 모르는 adapter 는 거절한다', () => {
    writeConfig({ adapters: [{ type: 'fake' }, { type: 'slack' }] })
    state.items = [item('1', ['p1'])]
    const view = board(repo('a', null))
    assert.match(view.errors.slack, /모르는 adapter/)
    assert.equal(call('context', 'fake:task:없음'), 1)
    assert.match(err, /항목이 없다/)
  })

  test('사용법 오류는 2 다', () => {
    assert.equal(call('board'), 2)
    assert.equal(call('reply', 'x'), 2)
    assert.equal(call('nope'), 2)
  })
})

describe('업무 댓글 리액션', () => {
  const mention = item('1', ['example'], undefined, {
    id: 'dooray:task:comment:c1',
    adapter: 'dooray',
    target: { kind: 'task', postId: 'p1', commentId: 'c1' },
    excerpt: '반영 확인했습니다. 감사합니다',
  })
  let calls: string[][]
  let version: RunResult
  let reaction: RunResult

  beforeEach(() => {
    calls = []
    version = { code: 0, stdout: '0.35.0\n', stderr: '' }
    reaction = { code: 0, stdout: '', stderr: '' }
    writeConfig({ adapters: [{ type: 'dooray' }] })
    new Store().updateCache((cache) => { cache.items = [mention] })
    extra = {
      adapters: ADAPTERS,
      startFetch: () => {},
      run: (argv) => {
        calls.push(argv)
        if (argv[1] === '--version') return version
        assert.deepEqual(argv.slice(1, 4), ['post', 'comment', 'react'])
        return reaction
      },
    }
  })

  const expectedCalls = (emoji: string) => [
    ['dooray', '--version'],
    ['dooray', 'post', 'comment', 'react', '--id', 'p1', '--comment-id', 'c1', `--emoji=${emoji}`],
  ]

  test('미리보기에는 업무와 댓글, 기본 이모지가 보이고 두레이를 호출하지 않는다', () => {
    assert.equal(call('react', mention.id), 3)
    assert.match(out, /업무 1.*댓글.*작성자 김철수/)
    assert.match(out, /"\+1" 리액션/)
    assert.match(out, /반영 확인했습니다/)
    assert.match(err, /--yes/)
    assert.deepEqual(calls, [])
    assert.equal(new Store().cache().items[0].state, 'new')
  })

  test('확인한 기본 이모지를 달면 다음 받기 전에도 답함이고 새 알림 수에서 빠진다', () => {
    const root = repo('a', null)
    assert.equal(board(root).newCount, 1)
    assert.equal(call('react', mention.id, '--yes'), 0, err)
    assert.deepEqual(calls, expectedCalls('+1'))
    assert.match(out, /리액션을 달았다/)
    const view = board(root)
    assert.equal(view.newCount, 0)
    assert.equal(view.items[0].state, 'answered')
    assert.equal(call('react', mention.id, '--yes'), 1)
    assert.match(err, /이미 답한.*넘김/)
    assert.deepEqual(calls, expectedCalls('+1'))
  })

  test('옵션을 주면 사람 설정에 저장한 기본값보다 우선한다', () => {
    writeConfig({ adapters: [{ type: 'dooray' }], reactionEmoji: 'heart' })
    assert.equal(call('react', mention.id), 3)
    assert.match(out, /"heart"/)
    assert.equal(call('react', mention.id, '--emoji', 'clap'), 3)
    assert.match(out, /"clap"/)
    assert.deepEqual(calls, [])
    assert.equal(call('react', mention.id, '--emoji', 'clap', '--yes'), 0, err)
    assert.deepEqual(calls, expectedCalls('clap'))
  })

  test('옵션 없이 확인하면 사람 설정의 이모지 이름을 사용한다', () => {
    writeConfig({ adapters: [{ type: 'dooray' }], reactionEmoji: 'heart' })
    version.stdout = '0.36.0'
    assert.equal(call('react', mention.id, '--yes'), 0, err)
    assert.deepEqual(calls, expectedCalls('heart'))
  })

  for (const [label, patch, refusal] of [
    ['담당', { kind: 'assigned' }, /담당·참조.*답장이나 넘김/],
    ['참조', { kind: 'cc' }, /담당·참조.*답장이나 넘김/],
    ['댓글 ID 없음', { target: { kind: 'task', postId: 'p1' } }, /댓글을 찾을 수 없다.*답장이나 넘김/],
    ['메시지 ID 없는 메신저', { source: 'messenger', target: { kind: 'messenger', channelId: 'ch1' } }, /메신저 메시지를 찾을 수 없다.*넘김/],
    ['넘긴 상태', { state: 'dismissed' }, /이미 넘긴.*답장/],
  ] as const) {
    test(`${label} 항목은 확인했어도 거절한다`, () => {
      new Store().updateCache((cache) => { cache.items = [{ ...mention, ...patch }] })
      assert.equal(call('react', mention.id, '--yes'), 1)
      assert.match(err, refusal)
      assert.deepEqual(calls, [])
    })
  }

  test('넘김 기록에 있는 항목은 확인했어도 거절한다', () => {
    assert.equal(call('dismiss', mention.id), 0)
    assert.equal(call('react', mention.id, '--yes'), 1)
    assert.match(err, /이미 넘긴.*답장/)
    assert.deepEqual(calls, [])
  })

  test('세션 오류는 종료 코드 1 로 넘김과 갱신 방법을 알려 주고 상태를 유지한다', () => {
    reaction = { code: 3, stdout: '', stderr: '웹 세션 만료' }
    assert.equal(call('react', mention.id, '--yes'), 1)
    assert.match(err, /리액션을 달지 않았다.*넘김/)
    assert.match(err, /dooray config set session-cookie -/)
    assert.equal(new Store().cache().items[0].state, 'new')
  })

  test('이모지 이름 오류는 두레이 CLI 출력 전체를 전달하고 상태를 유지한다', () => {
    reaction = { code: 2, stdout: '', stderr: '이모지 문자는 받지 않습니다\n이름을 입력하세요\n' }
    assert.equal(call('react', mention.id, '--emoji', '👍', '--yes'), 1)
    assert.deepEqual(calls, expectedCalls('👍'))
    assert.equal(err, reaction.stderr)
    assert.equal(new Store().cache().items[0].state, 'new')
  })

  for (const value of ['0.9.0', '0.34.9', '0.35.0-rc.1', '알 수 없음']) {
    test(`버전이 ${value} 이면 리액션 요청 없이 CLI 갱신을 안내한다`, () => {
      version.stdout = value
      assert.equal(call('react', mention.id, '--yes'), 1)
      assert.match(err, /dooray-cli 를 0\.35\.0 이상으로 올린다/)
      assert.deepEqual(calls, [['dooray', '--version']])
      assert.equal(new Store().cache().items[0].state, 'new')
    })
  }

  test('이미 리액션 등록 중이면 같은 항목의 두 번째 호출을 거절한다', () => {
    new Store().withReactionLock(mention.id, () => {
      assert.equal(call('react', mention.id, '--yes'), 1)
      assert.match(err, /등록하는 중/)
    })
    assert.deepEqual(calls, [])
  })
})

describe('메신저 멘션 리액션', () => {
  const mention = item('1', ['example'], undefined, {
    id: 'dooray:messenger:ch1:m1',
    adapter: 'dooray',
    source: 'messenger',
    title: '개발방',
    target: { kind: 'messenger', channelId: 'ch1', logId: 'm1' },
    excerpt: '배포 끝났습니다. 감사합니다',
  })
  let calls: string[][]
  let version: RunResult
  let reaction: RunResult

  beforeEach(() => {
    calls = []
    version = { code: 0, stdout: '0.36.0\n', stderr: '' }
    reaction = { code: 0, stdout: '', stderr: '' }
    writeConfig({ adapters: [{ type: 'dooray' }] })
    new Store().updateCache((cache) => { cache.items = [mention] })
    extra = {
      adapters: ADAPTERS,
      startFetch: () => {},
      run: (argv) => {
        calls.push(argv)
        if (argv[1] === '--version') return version
        assert.deepEqual(argv.slice(1, 3), ['messenger', 'react'])
        return reaction
      },
    }
  })

  const reactCall = (emoji: string) => ['dooray', 'messenger', 'react', 'ch1', 'm1', `--emoji=${emoji}`]

  test('미리보기에는 대화방과 메시지, 이모지가 보이고 리액션을 달지 않는다', () => {
    assert.equal(call('react', mention.id), 3)
    assert.match(out, /개발방.*메시지.*작성자 김철수/)
    assert.match(out, /"\+1" 리액션/)
    assert.match(err, /--yes/)
    assert.deepEqual(calls, [['dooray', '--version']])
    assert.equal(new Store().cache().items[0].state, 'new')
  })

  test('확인하면 그 메시지에 리액션을 달고 답함이 된다', () => {
    const root = repo('a', null)
    assert.equal(board(root).newCount, 1)
    assert.equal(call('react', mention.id, '--emoji', 'clap', '--yes'), 0, err)
    assert.deepEqual(calls, [['dooray', '--version'], reactCall('clap')])
    assert.match(out, /메시지에 "clap" 리액션을 달았다/)
    assert.equal(board(root).newCount, 0)
    assert.equal(new Store().cache().items[0].state, 'answered')
  })

  test('세션 오류는 종료 코드 1 로 넘김과 갱신 방법을 알려 주고 상태를 유지한다', () => {
    reaction = { code: 3, stdout: '', stderr: '웹 세션 만료' }
    assert.equal(call('react', mention.id, '--yes'), 1)
    assert.match(err, /리액션을 달지 않았다.*넘김/)
    assert.match(err, /dooray config set session-cookie -/)
    assert.deepEqual(calls, [['dooray', '--version'], reactCall('+1')])
    assert.equal(new Store().cache().items[0].state, 'new')
  })

  for (const value of ['0.35.0', '0.36.0-rc.1', '알 수 없음']) {
    test(`버전이 ${value} 이면 미리보기부터 거절하고 넘김을 권한다`, () => {
      version.stdout = value
      for (const args of [[], ['--yes']]) {
        calls = []
        assert.equal(call('react', mention.id, ...args), 1)
        assert.match(err, /dooray-cli 를 0\.36\.0 이상으로 올린다.*넘김/)
        assert.deepEqual(calls, [['dooray', '--version']])
      }
      assert.equal(new Store().cache().items[0].state, 'new')
    })
  }
})

test('받기 프로세스가 죽었으면 다음 받기가 잠금을 회수한다', () => {
  const store = new Store()
  const lock = join(store.dir, 'fetch-fake%3Atask.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner'), '99999999 dead')
  assert.equal(store.fetchHeld('fake:task'), false)
  store.withFetchLock('fake:task', () => assert.equal(store.fetchHeld('fake:task'), true))
  assert.equal(store.fetchHeld('fake:task'), false)
})
