// inbox.ts 를 가짜 adapter 와 임시 폴더로 돌려 본다. 두레이에는 닿지 않는다.
// 설정과 상태 폴더는 INBOX_CONFIG, INBOX_STATE_DIR 로 테스트마다 새로 만든다.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { type Deps, main } from '../scripts/inbox.ts'
import type { Adapter, AdapterFactory, FetchRequest, FetchResult, InboxItem } from '../scripts/lib/model.ts'
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
  fetches: FetchRequest[]
  replies: { id: string; text: string }[]
  failReply?: boolean
  people: Record<string, string>
}

function fakeFactory(state: FakeState): AdapterFactory {
  return () => {
    const adapter: Adapter = {
      name: 'fake',
      fetch(request): FetchResult {
        state.fetches.push(request)
        // 실패한 출처는 커서를 옮기지 않는다
        const cursors = Object.fromEntries(['task', 'messenger'].filter((source) => !state.errors[source]).map((source) => [source, now.toISOString()]))
        return { items: state.items.map((row) => ({ ...row })), errors: state.errors, cursors }
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
  if (filter) writeFileSync(join(root, '.orch', 'config', 'notification.json'), JSON.stringify(filter))
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

  test('주기 안에서는 다시 받지 않고, 주기가 지나면 받는다 (R1)', () => {
    writeConfig({ intervalMinutes: 5 })
    const root = repo('a', null)
    board(root)
    board(root)
    assert.equal(state.fetches.length, 1)
    now = new Date(NOW.getTime() + 5 * 60 * 1000)
    board(root)
    assert.equal(state.fetches.length, 2)
    assert.equal(state.fetches[0].since, '2026-10-26T06:00:00.000Z')
    assert.deepEqual(state.fetches[0].cursors, {})
    assert.deepEqual(state.fetches[1].cursors, { task: NOW.toISOString(), messenger: NOW.toISOString() })
  })

  test('board 는 받기를 따로 띄우고 지금 캐시를 바로 낸다 (D15)', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    let started = 0
    extra = { startFetch: () => { started++ } }
    const root = repo('a', null)
    assert.equal(board(root).items.length, 0)
    assert.equal(started, 1)
    assert.equal(state.fetches.length, 0)
    // 따로 띄운 받기가 끝나면 다음 board 는 받은 항목을 내고 다시 띄우지 않는다
    assert.equal(call('fetch'), 0)
    assert.equal(board(root).items.length, 1)
    assert.equal(started, 1)
  })

  test('다른 세션이 받는 중이면 받지 않고, 10분 넘은 잠금은 무시한다 (D2)', () => {
    writeConfig({})
    state.items = [item('1', ['p1'])]
    const lock = join(process.env.INBOX_STATE_DIR as string, 'fetch.lock')
    mkdirSync(lock, { recursive: true })
    const root = repo('a', null)
    assert.equal(board(root).items.length, 0)
    assert.equal(state.fetches.length, 0)
    const old = new Date(NOW.getTime() - 11 * 60 * 1000)
    utimesSync(lock, old, old)
    assert.equal(board(root).items.length, 1)
    assert.equal(state.fetches.length, 1)
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
    assert.deepEqual(state.fetches[2].cursors, { task: new Date(NOW.getTime() + 6 * 60 * 1000).toISOString(), messenger: NOW.toISOString() })
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
    writeFileSync(join(root, '.orch', 'config', 'notification.json'), '{')
    const view = board(root)
    assert.ok(view.errors.filter)
    assert.equal(view.items.length, 1)
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

describe('잠금 (검토 반영)', () => {
  test('자기가 잡은 잠금만 풀고, 빼앗긴 잠금은 남긴다', () => {
    const first = new Store(join(dir, 'lock-state'))
    const second = new Store(join(dir, 'lock-state'))
    const t0 = Date.now()
    assert.equal(first.lock(t0), true)
    assert.equal(second.lock(t0), false)
    // 오래된 잠금을 다른 세션이 다시 잡으면, 먼저 잡았던 쪽의 unlock 은 그 잠금을 지우지 않는다
    assert.equal(second.lock(t0 + 11 * 60 * 1000), true)
    first.unlock()
    assert.equal(second.lockHeld(Date.now()), true)
    second.unlock()
    assert.equal(second.lockHeld(Date.now()), false)
  })
})
