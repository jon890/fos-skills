// 두레이 adapter 를 가짜 Runner 로 돌려 본다. 응답은 두레이 공식 문서의 streams 예시와 dooray CLI 0.29.1 의 JSON 필드를 본떴다.
// 실제 두레이에는 닿지 않는다.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { createDooray, excerptOf, LOG_COUNT, MAX_CHANNELS, MAX_THREAD_FAILURES, MAX_THREADS, messageText, MORE_LOG_COUNT, mentions, plainText, TASK_FEED_SINCE, THREAD_SCAN_COUNT } from '../scripts/adapters/dooray.ts'
import type { Adapter, Cache, RunResult } from '../scripts/lib/model.ts'

const ME = '4567890123456789012'
const ORG = '5678901234567890123'
const KIM = '1111'
const LEE = '2222'
const link = (id: string, name: string) => `[@${name}](dooray://${ORG}/members/${id} "member")`
const SINCE = '2026-10-26T06:00:00.000Z'

const STREAM = [
  { type: 'event', event: { read: false, id: 'c1', type: 'comment', postId: 'p81', createdAt: '2026-11-02T14:00:00+09:00',
    creator: { type: 'member', member: { organizationMemberId: KIM, name: '김철수' } },
    body: { mimeType: 'text/x-markdown', content: `${link(ME, '김병태')} 운영 계정도 같은 권한이 필요한지 확인 부탁드려요` } } },
  // 멘션 없는 댓글은 받지 않는다
  { type: 'event', event: { id: 'c2', type: 'comment', postId: 'p81', creator: { member: { organizationMemberId: LEE, name: '이영희' } },
    body: { content: '확인했습니다' } } },
  // 내가 나를 멘션한 댓글은 받지 않는다
  { type: 'event', event: { id: 'c3', type: 'comment', postId: 'p81', creator: { member: { organizationMemberId: ME, name: '김병태' } },
    body: { content: link(ME, '김병태') } } },
  { type: 'post', post: { id: 'p342', projectId: 'proj-home', subject: '배포 일정 조율', createdAt: '2026-11-02T10:00:00+09:00',
    users: { from: { member: { organizationMemberId: LEE, name: '이영희' } }, to: [{ member: { organizationMemberId: ME, name: '김병태' } }], cc: [] },
    body: { content: '이번 주 배포 일정' } } },
  { type: 'post', post: { id: 'p77', createdAt: '2026-11-01T10:00:00+09:00',
    users: { from: { member: { organizationMemberId: KIM } }, to: [], cc: [{ member: { organizationMemberId: ME } }] }, body: { content: '참조' } } },
  // 기간 밖에 만든 업무가 고쳐져 피드에 다시 오면 받지 않는다
  { type: 'post', post: { id: 'p1', createdAt: '2026-10-01T10:00:00+09:00',
    users: { from: { member: { organizationMemberId: KIM } }, to: [{ member: { organizationMemberId: ME } }] } } },
  { type: 'mail', mail: { id: 'mail1' } },
]

const POSTS: Record<string, unknown> = {
  p81: { id: 'p81', taskNumber: '어드민개발/81', subject: '어드민 권한 정리', project: { id: 'proj-admin', code: '어드민개발' }, body: { content: '권한 정리 본문' } },
  p342: { id: 'p342', taskNumber: 'EXAMPLE-PROJECT/342', subject: '배포 일정 조율', project: { id: 'proj-home', code: 'EXAMPLE-PROJECT' } },
  p77: { id: 'p77', taskNumber: '어드민개발/77', subject: '로그 보존 기간', project: { id: 'proj-admin', code: '어드민개발' } },
}

const CHANNELS = [
  { id: 'ch-dev', title: '예시 개발방', type: 'private', updatedAt: '2026-11-02T14:30:00+09:00' },
  { id: 'ch-bot', title: '배포 알림', type: 'bot', updatedAt: '2026-11-02T14:31:00+09:00' },
  { id: 'ch-me', title: '', type: 'me', updatedAt: '2026-11-02T14:32:00+09:00' },
  { id: 'ch-dm', title: '', type: 'direct', updatedAt: '2026-11-02T14:20:00+09:00' },
]

const DEV_LOGS = [
    { id: 'l2', sender: { type: 'member', member: { organizationMemberId: ME } }, sentAt: '2026-11-02T14:25:00+09:00', text: '네 볼게요' },
    { id: 'l1', sender: { type: 'member', member: { organizationMemberId: LEE } }, sentAt: '2026-11-02T14:10:00+09:00', text: `${link(ME, '김병태')} 리뷰 부탁해요` },
]

const LOGS: Record<string, unknown[]> = {
  'ch-dev': DEV_LOGS,
  'ch-dm': [
    // 일부 메시지는 text 가 {"type":0,"text":"…"} JSON 문자열로 온다
    { id: 'l9', sender: { type: 'member', member: { organizationMemberId: KIM } }, sentAt: '2026-11-02T14:00:00+09:00',
      text: JSON.stringify({ type: 0, text: `${link(ME, '김병태')} 잠깐 통화 가능?` }) },
  ],
}

class MemoryCache implements Cache {
  values = new Map<string, unknown>()
  read<T>(name: string, fallback: T): T {
    return (this.values.has(name) ? structuredClone(this.values.get(name)) : fallback) as T
  }
  write(name: string, value: unknown): void {
    this.values.set(name, structuredClone(value))
  }
}

let calls: string[][]
let failing: Set<string>
let comments: unknown[]
let stream: unknown[]
let streamFor: ((args: string[]) => RunResult) | null
let sent: { argv: string[]; body: string }[]
let dir: string
let channelList: unknown[]

function ok(value: unknown): RunResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: '' }
}

function runner(argv: string[]): RunResult {
  calls.push(argv)
  const key = argv.slice(2, 4).join(' ')
  const writeKey = argv.slice(1, 3).join(' ')
  if (failing.has(key) || failing.has(argv.slice(2).join(' ')) || (argv[1] !== '--json' && failing.has(writeKey))) return { code: 1, stdout: '', stderr: `${key} 실패 (429)` }
  if (argv[1] === '--version') return { code: 0, stdout: '0.36.0\n', stderr: '' }
  if (argv[1] === 'messenger' && argv[2] === 'react') {
    sent.push({ argv, body: '' })
    return { code: 0, stdout: '', stderr: '' }
  }
  if (argv[1] !== '--json') {
    const file = argv[argv.indexOf('--body-file') + 1]
    sent.push({ argv, body: readFileSync(file, 'utf8') })
    return { code: 0, stdout: '', stderr: '' }
  }
  const args = argv.slice(2)
  if (key === 'member get') {
    if (args[2] === 'me') return ok({ id: ME, name: '김병태', defaultOrganization: { id: ORG } })
    const names: Record<string, string> = { [KIM]: '김철수', [LEE]: '이영희' }
    return names[args[2]] ? ok({ id: args[2], name: names[args[2]] }) : { code: 1, stdout: '', stderr: '멤버 없음' }
  }
  if (key === 'stream list') return streamFor ? streamFor(args) : ok(stream)
  if (key === 'post get') return ok(POSTS[args[3]])
  if (key === 'post comment') return ok(comments)
  if (key === 'messenger channels') return ok(channelList)
  if (key === 'messenger logs') return ok((LOGS[args[2]] ?? []).slice(0, Number(args[4]) || undefined))
  return { code: 1, stdout: '', stderr: `모르는 명령 ${argv.join(' ')}` }
}

function adapter(config: Record<string, unknown> = {}): Adapter {
  return createDooray({ type: 'dooray', webUrl: 'https://example.dooray.com/', ...config },
    { run: runner, cache: new MemoryCache(), now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
}

beforeEach(() => {
  calls = []
  failing = new Set()
  comments = []
  stream = STREAM
  streamFor = null
  sent = []
  channelList = CHANNELS
  dir = mkdtempSync(join(tmpdir(), 'dooray-spec-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('본문 읽기', () => {
  test('링크 표기를 읽을 글로 바꾸고 멘션을 판정한다', () => {
    assert.equal(plainText(`${link(ME, '김병태')} 확인 &#91;MOD&#93;`), '@김병태 확인 [MOD]')
    assert.equal(mentions(link(ME, '김병태'), ME), true)
    assert.equal(mentions(link(`${ME}9`, '다른 사람'), ME), false)
    assert.equal([...excerptOf('가'.repeat(100))].length, 81)
    assert.equal(messageText('{"type":0,"text":"안녕"}'), '안녕')
    assert.equal(messageText('{보통 글}'), '{보통 글}')
    assert.equal(messageText('{"type":1}'), '{"type":1}')
    assert.equal(messageText(undefined), '')
  })
})

describe('받기', () => {
  test('업무 댓글 멘션, 담당, 참조를 공통 모델로 바꾼다 (R1, R2)', () => {
    const result = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} })
    assert.deepEqual(result.errors, {})
    const byId = Object.fromEntries(result.items.map((row) => [row.id, row]))
    assert.deepEqual(Object.keys(byId).sort(), ['dooray:task:comment:c1', 'dooray:task:post:p342', 'dooray:task:post:p77'])
    const mention = byId['dooray:task:comment:c1']
    assert.equal(mention.kind, 'mention')
    assert.equal(mention.title, '어드민개발/81 어드민 권한 정리')
    assert.equal(mention.url, 'https://example.dooray.com/project/tasks/p81')
    assert.deepEqual(mention.scope, ['proj-admin', '어드민개발'])
    assert.deepEqual(mention.from, { id: KIM, name: '김철수' })
    assert.equal(mention.at, '2026-11-02T05:00:00.000Z')
    assert.equal(mention.excerpt, '@김병태 운영 계정도 같은 권한이 필요한지 확인 부탁드려요')
    assert.deepEqual(mention.target, { kind: 'task', postId: 'p81', commentId: 'c1' })
    assert.equal(byId['dooray:task:post:p342'].kind, 'assigned')
    assert.equal(byId['dooray:task:post:p77'].kind, 'cc')
    assert.deepEqual(calls.find((argv) => argv[2] === 'stream'), ['dooray', '--json', 'stream', 'list', '--since', TASK_FEED_SINCE, '--all'])
    // 지난 커서가 있으면 피드 원본의 첫 페이지부터 읽는다
    calls = []
    adapter({ messenger: false }).fetch({ since: SINCE, cursors: { task: '2026-11-02T05:55:00.000Z' } })
    assert.deepEqual(calls.find((argv) => argv[2] === 'stream')?.slice(4), ['--size', '200'])
    // 업무 정보는 업무마다 한 번만 읽는다
    assert.equal(calls.filter((argv) => argv[2] === 'post' && argv[3] === 'get' && argv[5] === 'p81').length, 1)
  })

  test('메신저는 봇 방과 나와의 대화를 건너뛰고 바뀐 방의 멘션만 받는다 (D1, D14)', () => {
    const result = adapter().fetch({ since: SINCE, cursors: { messenger: '2026-11-02T05:00:00.000Z' } })
    const messenger = result.items.filter((row) => row.source === 'messenger')
    assert.deepEqual(messenger.map((row) => row.id).sort(), ['dooray:messenger:ch-dev:l1', 'dooray:messenger:ch-dm:l9'])
    const dev = messenger.find((row) => row.id.endsWith('l1'))
    assert.deepEqual(dev?.scope, ['ch-dev', '예시 개발방'])
    assert.deepEqual(dev?.from, { id: LEE, name: '이영희' })
    assert.equal(messenger.find((row) => row.id.endsWith('l9'))?.title, '김철수 대화')
    assert.equal(messenger.find((row) => row.id.endsWith('l9'))?.excerpt, '@김병태 잠깐 통화 가능?')
    assert.deepEqual(calls.find((argv) => argv[3] === 'channels'), ['dooray', '--json', 'messenger', 'channels', '--since', '2026-11-02T05:00:00.000Z'])
    // 바뀐 방은 오래된 순으로 읽는다
    const logCalls = calls.filter((argv) => argv[3] === 'logs').map((argv) => argv[4])
    assert.deepEqual(logCalls, ['ch-dm', 'ch-dev'])
    // 남은 방이 없으면 커서는 이번 받기 시각이다
    assert.equal(result.cursors.messenger, '2026-11-02T06:00:00.000Z')
  })

  test(`메신저는 한 번에 ${MAX_CHANNELS}개 방까지만 읽고, 남은 방은 cursor 로 다음 받기에 넘긴다`, () => {
    const many = Array.from({ length: MAX_CHANNELS + 5 }, (_, i) => ({ id: `c${i}`, title: `방${i}`, type: 'private',
      updatedAt: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 60000).toISOString() }))
    CHANNELS.push(...many)
    try {
      const result = adapter().fetch({ since: SINCE, cursors: {} })
      const read = calls.filter((argv) => argv[3] === 'logs').map((argv) => argv[4])
      assert.equal(read.length, MAX_CHANNELS)
      assert.deepEqual(read.slice(0, 2), ['c0', 'c1'])
      assert.equal(result.cursors.messenger, many[MAX_CHANNELS - 1].updatedAt)
    } finally {
      CHANNELS.splice(4)
    }
  })

  test(`바뀐 방은 logs ${THREAD_SCAN_COUNT}개를 한 번에 읽고, 스레드 logs ${LOG_COUNT}개가 모두 지난 받기 뒤의 것이면 ${MORE_LOG_COUNT}개로 다시 읽는다`, () => {
    const busy = Array.from({ length: LOG_COUNT }, (_, i) => ({ id: `b${i}`, sender: { member: { organizationMemberId: LEE } },
      sentAt: new Date(Date.parse('2026-11-02T05:30:00Z') + i * 1000).toISOString(), text: '잡담' }))
    LOGS['ch-dev'] = [...DEV_LOGS, { id: 'p-busy', sender: { member: { organizationMemberId: KIM } }, sentAt: '2026-11-02T13:00:00+09:00', text: '스레드',
      thread: { channelId: 'th-busy', totalCount: LOG_COUNT, lastUpdatedAt: Date.parse('2026-11-02T05:50:00Z') } }]
    LOGS['th-busy'] = busy
    try {
      adapter().fetch({ since: SINCE, cursors: { messenger: '2026-11-02T05:00:00.000Z' } })
      const counts = (id: string) => calls.filter((argv) => argv[3] === 'logs' && argv[4] === id).map((argv) => argv[6])
      assert.deepEqual(counts('ch-dev'), [String(THREAD_SCAN_COUNT)])
      assert.deepEqual(counts('th-busy'), [String(LOG_COUNT), String(MORE_LOG_COUNT)])
    } finally {
      LOGS['ch-dev'] = DEV_LOGS
      delete LOGS['th-busy']
    }
  })

  test('메신저가 실패해도 업무 항목은 낸다 (R7)', () => {
    failing.add('messenger channels')
    const result = adapter().fetch({ since: SINCE, cursors: {} })
    assert.match(result.errors.messenger, /429/)
    assert.equal(result.errors.task, undefined)
    assert.equal(result.items.filter((row) => row.source === 'task').length, 3)
  })

  test('대화방 하나의 logs 가 실패하면 그 방만 빼고 오류를 남긴다', () => {
    failing.add(`messenger logs ch-dev -n ${THREAD_SCAN_COUNT}`)
    const result = adapter().fetch({ since: SINCE, cursors: {} })
    assert.match(result.errors.messenger, /대화방 1개 읽기 실패: 예시 개발방/)
    assert.deepEqual(result.items.filter((row) => row.source === 'messenger').map((row) => row.id), ['dooray:messenger:ch-dm:l9'])
  })

  test('업무 피드가 실패하면 task 오류를 남긴다 (R7)', () => {
    failing.add('stream list')
    const result = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} })
    assert.match(result.errors.task, /stream list.*429/)
    assert.equal(result.items.length, 0)
  })
})

// 스레드 답글 실측 꼴(dooray-cli 0.36.0): 부모 메시지의 thread 칸에 스레드 대화방 id, 답글 수, 마지막 답글 시각(epoch ms)이 있다.
// 스레드는 channels 목록에 나오지 않는다. id, 이름, 메시지는 가짜 값이다
const THREAD_FROM = '2026-11-02T05:00:00.000Z'
function parentLog(id: string, threadId: string, lastUpdatedAt: string) {
  return { id, sender: { type: 'member', member: { organizationMemberId: KIM } }, sentAt: '2026-11-02T13:00:00+09:00', text: '배포 순서 정리했어요',
    thread: { channelId: threadId, totalCount: 4, lastUpdatedAt: Date.parse(lastUpdatedAt) } }
}
const THREAD_LOGS = [
  { id: 't4', sender: { type: 'member', member: { organizationMemberId: LEE } }, sentAt: '2026-11-02T14:40:00+09:00', text: `${link(ME, '김병태')} 이 순서로 괜찮을까요?` },
  { id: 't3', sender: { type: 'member', member: { organizationMemberId: KIM } }, sentAt: '2026-11-02T14:35:00+09:00', text: '좋아요' },
  { id: 't2', sender: { type: 'member', member: { organizationMemberId: KIM } }, sentAt: '2026-11-02T14:30:00+09:00', text: JSON.stringify({ type: 0, text: `${link(ME, '김병태')} 확인 부탁해요` }) },
  { id: 't1', sender: { type: 'member', member: { organizationMemberId: LEE } }, sentAt: '2026-11-02T14:20:00+09:00', text: '저는 봤어요' },
]

describe('스레드 답글 멘션', () => {
  let saved: unknown[]
  beforeEach(() => {
    saved = LOGS['ch-dev']
    LOGS['ch-dev'] = [...DEV_LOGS, parentLog('p-new', 'th-new', '2026-11-02T14:40:00+09:00'), parentLog('p-old', 'th-old', '2026-11-01T10:00:00+09:00')]
    LOGS['th-new'] = THREAD_LOGS
    LOGS['th-old'] = THREAD_LOGS
  })
  afterEach(() => {
    LOGS['ch-dev'] = saved
    delete LOGS['th-new']
    delete LOGS['th-old']
    for (let i = 0; i < MAX_THREADS + 3; i++) delete LOGS[`th${i}`]
    for (let i = 0; i < MAX_THREADS; i++) delete LOGS[`thf${i}`]
  })

  test('부모 메시지에 멘션이 없어도 지난 받기 뒤에 달린 스레드 답글의 멘션을 모은다', () => {
    const result = adapter().fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } })
    assert.deepEqual(result.errors, {})
    const thread = result.items.filter((row) => row.target.kind === 'messenger' && row.target.channelId === 'th-new')
    assert.deepEqual(thread.map((row) => row.id).sort(), ['dooray:messenger:th-new:t2', 'dooray:messenger:th-new:t4'])
    // 보드 제목과 숨김 기준은 부모 방이다
    for (const row of thread) {
      assert.equal(row.title, '예시 개발방')
      assert.deepEqual(row.scope, ['ch-dev', '예시 개발방'])
    }
    assert.equal(thread.find((row) => row.id.endsWith('t2'))?.excerpt, '@김병태 확인 부탁해요')
    // 지난 받기 전에 끝난 스레드는 다시 읽지 않는다
    const read = calls.filter((argv) => argv[3] === 'logs').map((argv) => argv[4])
    assert.ok(read.includes('th-new'))
    assert.ok(!read.includes('th-old'))
  })

  test('스레드 멘션의 답장과 리액션은 스레드로 간다', () => {
    const target = adapter()
    const row = target.fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } }).items.find((item) => item.id === 'dooray:messenger:th-new:t4')!
    target.reply(row, '네 괜찮아요')
    assert.deepEqual(sent[0].argv.slice(0, 5), ['dooray', 'messenger', 'channel-send', '--channel', 'th-new'])
    target.react(row, 'thumbsup', { confirmed: true })
    assert.deepEqual(sent[1].argv, ['dooray', 'messenger', 'react', 'th-new', 't4', '--emoji=thumbsup'])
    // 맥락과 답함도 스레드 logs 로 본다
    assert.equal(target.context(row).body, `${link(ME, '김병태')} 이 순서로 괜찮을까요?`)
    assert.equal(target.answered(row), false)
  })

  test(`스레드는 한 번에 ${MAX_THREADS}개까지만 읽고 남은 스레드는 다음 받기에 읽는다`, () => {
    const cache = new MemoryCache()
    const make = () => createDooray({ type: 'dooray' }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
    const count = MAX_THREADS + 3
    LOGS['ch-dev'] = Array.from({ length: count }, (_, i) => parentLog(`p${i}`, `th${i}`, '2026-11-02T14:40:00+09:00'))
    for (let i = 0; i < count; i++) LOGS[`th${i}`] = THREAD_LOGS
    const threadReads = () => calls.filter((argv) => argv[3] === 'logs' && argv[4].startsWith('th')).map((argv) => argv[4])
    const first = make().fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } })
    assert.equal(threadReads().length, MAX_THREADS)
    assert.equal(first.items.filter((row) => row.id.startsWith('dooray:messenger:th')).length, MAX_THREADS * 2)
    calls = []
    channelList = []
    const second = make().fetch({ since: SINCE, cursors: first.cursors })
    assert.deepEqual(threadReads(), Array.from({ length: 3 }, (_, i) => `th${MAX_THREADS + i}`))
    assert.equal(second.items.length, 3 * 2 + 3)
    assert.deepEqual(cache.read('dooray-pending-threads', ['?']), [])
  })

  test(`부모 메시지가 최근 ${LOG_COUNT}개 밖에 있어도 스레드를 찾는다`, () => {
    const chatter = Array.from({ length: LOG_COUNT + 10 }, (_, i) => ({ id: `n${i}`, sender: { member: { organizationMemberId: LEE } },
      sentAt: new Date(Date.parse('2026-11-02T05:59:00Z') - i * 120_000).toISOString(), text: '잡담' }))
    // 부모 메시지는 지난 받기 전에 올라왔고, 그 뒤로 잡담이 지난 받기 앞뒤에 걸쳐 쌓였다
    LOGS['ch-dev'] = [...chatter, { ...parentLog('p-deep', 'th-new', '2026-11-02T14:40:00+09:00'), sentAt: '2026-11-02T10:00:00+09:00' }]
    const result = adapter().fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } })
    assert.ok(result.items.some((row) => row.id === 'dooray:messenger:th-new:t4'))
  })

  test('부모 방 읽기가 실패하면 다음 받기는 실패한 받기의 기준 시각으로 스레드를 고른다', () => {
    const cache = new MemoryCache()
    const make = () => createDooray({ type: 'dooray' }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
    failing.add(`messenger logs ch-dev -n ${THREAD_SCAN_COUNT}`)
    const first = make().fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } })
    // 커서는 앞으로 가서, 스레드의 마지막 답글(05:40Z)이 새 커서(06:00Z)보다 앞이 된다
    assert.equal(first.cursors.messenger, '2026-11-02T06:00:00.000Z')
    failing.clear()
    calls = []
    channelList = []
    const second = make().fetch({ since: SINCE, cursors: first.cursors })
    assert.ok(second.items.some((row) => row.id === 'dooray:messenger:th-new:t4'))
    assert.deepEqual(cache.read('dooray-pending-channels', { '?': '' }), {})
  })

  test(`바뀐 방이 ${MAX_CHANNELS}개를 넘어 미룬 방은 다음 받기에도 미룰 때의 기준 시각으로 스레드를 고른다`, () => {
    const cache = new MemoryCache()
    const make = () => createDooray({ type: 'dooray' }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
    // 앞 묶음의 방들이 스레드의 마지막 답글(05:40Z) 뒤에 바뀌어, 다음 커서가 그 답글보다 뒤가 된다
    const filler = Array.from({ length: MAX_CHANNELS }, (_, i) => ({ id: `cf${i}`, title: `방${i}`, type: 'private',
      updatedAt: new Date(Date.parse('2026-11-02T05:41:00Z') + i * 1000).toISOString() }))
    const dev = { id: 'ch-dev', title: '예시 개발방', type: 'private', updatedAt: '2026-11-02T05:50:00.000Z' }
    channelList = [...filler, dev]
    const first = make().fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } })
    assert.ok(!calls.some((argv) => argv[3] === 'logs' && argv[4] === 'ch-dev'))
    assert.ok(first.cursors.messenger > '2026-11-02T05:40:00.000Z')
    calls = []
    channelList = [dev]
    const second = make().fetch({ since: SINCE, cursors: first.cursors })
    assert.ok(second.items.some((row) => row.id === 'dooray:messenger:th-new:t4'))
    assert.deepEqual(cache.read('dooray-pending-channels', { '?': '' }), {})
  })

  test(`읽지 못하는 스레드는 시도하지 않은 스레드 뒤로 가고, ${MAX_THREAD_FAILURES}번 실패하면 대기열에서 빠진다`, () => {
    const cache = new MemoryCache()
    const make = () => createDooray({ type: 'dooray' }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
    const broken = Array.from({ length: MAX_THREADS }, (_, i) => `thf${i}`)
    LOGS['ch-dev'] = [...broken.map((id, i) => parentLog(`pf${i}`, id, '2026-11-02T14:40:00+09:00')), parentLog('p-new', 'th-new', '2026-11-02T14:40:00+09:00')]
    for (const id of broken) failing.add(`messenger logs ${id} -n ${LOG_COUNT}`)
    let cursors: Record<string, string> = { messenger: THREAD_FROM }
    const errors: string[] = []
    const found: string[] = []
    for (let round = 0; round < MAX_THREAD_FAILURES + 2; round++) {
      const result = make().fetch({ since: SINCE, cursors })
      cursors = result.cursors
      channelList = []
      if (result.errors.messenger) errors.push(result.errors.messenger)
      found.push(...result.items.filter((row) => row.id === 'dooray:messenger:th-new:t4').map(() => String(round)))
    }
    // 첫 받기는 읽지 못하는 스레드로 차고, 둘째 받기에서 아직 시도하지 않은 스레드를 먼저 읽는다
    assert.deepEqual(found, ['1'])
    assert.ok(errors.some((line) => line.includes(`${MAX_THREAD_FAILURES}번 읽지 못해 더 읽지 않는다`)))
    assert.deepEqual(cache.read('dooray-pending-threads', ['?']), [])
  })

  test('예전 재시도 캐시의 방은 대기 방으로 옮겨 다시 읽는다', () => {
    const cache = new MemoryCache()
    cache.write('dooray-retry-channels', ['ch-dev'])
    cache.write('dooray-channel-titles', { 'ch-dev': '예시 개발방' })
    channelList = []
    const result = createDooray({ type: 'dooray' }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
      .fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } })
    assert.ok(result.items.some((row) => row.id === 'dooray:messenger:th-new:t4'))
    assert.deepEqual(cache.read('dooray-retry-channels', ['?']), [])
  })

  test('스레드 logs 가 실패하면 오류를 남기고 다음 받기에 다시 읽는다', () => {
    const cache = new MemoryCache()
    const make = () => createDooray({ type: 'dooray' }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
    failing.add('messenger logs th-new -n 50')
    const first = make().fetch({ since: SINCE, cursors: { messenger: THREAD_FROM } })
    assert.match(first.errors.messenger, /예시 개발방 스레드/)
    failing.clear()
    calls = []
    channelList = []
    const second = make().fetch({ since: SINCE, cursors: first.cursors })
    assert.ok(second.items.some((row) => row.id === 'dooray:messenger:th-new:t4'))
  })
})

describe('부분 실패와 이름 (검토 반영)', () => {
  test('대화방 하나가 실패해도 메신저 커서는 앞으로 가고 그 방은 다음 받기에 다시 읽는다 (R7)', () => {
    const cache = new MemoryCache()
    const make = () => createDooray({ type: 'dooray' }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
    failing.add(`messenger logs ch-dev -n ${THREAD_SCAN_COUNT}`)
    const first = make().fetch({ since: SINCE, cursors: {} })
    assert.match(first.errors.messenger, /예시 개발방/)
    assert.equal(first.cursors.messenger, '2026-11-02T06:00:00.000Z')
    assert.equal(first.cursors.task, '2026-11-02T06:00:00.000Z')
    failing.clear()
    calls = []
    channelList = []
    const second = make().fetch({ since: SINCE, cursors: first.cursors })
    // 커서 뒤에 바뀐 방이 없어도 실패했던 방은 다시 읽는다
    assert.ok(calls.some((argv) => argv[3] === 'logs' && argv[4] === 'ch-dev'))
    assert.ok(second.items.some((row) => row.id === 'dooray:messenger:ch-dev:l1'))
    assert.deepEqual(second.items.find((row) => row.id === 'dooray:messenger:ch-dev:l1')?.scope, ['ch-dev', '예시 개발방'])
    assert.deepEqual(cache.read('dooray-pending-channels', { '?': '' }), {})
  })

  test('업무 하나의 조회가 실패하면 그 원소만 빼고 커서는 앞으로 간다', () => {
    failing.add('post get --id p342')
    const result = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} })
    assert.match(result.errors.task, /업무 1개 읽기 실패/)
    assert.equal(result.cursors.task, '2026-11-02T06:00:00.000Z')
    assert.deepEqual(result.items.map((row) => row.id).sort(), ['dooray:task:comment:c1', 'dooray:task:post:p77'])
  })

  test('나를 읽지 못하면 auth 오류 한 줄만 내고 커서를 옮기지 않는다 (R7)', () => {
    failing.add('member get me')
    const result = adapter().fetch({ since: SINCE, cursors: {} })
    assert.deepEqual(Object.keys(result.errors), ['auth'])
    assert.deepEqual(result.cursors, {})
  })

  test('피드에 이름이 없는 보낸 사람은 member get 으로 풀어 맥락과 답변에 쓴다 (R3, R10)', () => {
    const target = adapter({ messenger: false })
    const cc = target.fetch({ since: SINCE, cursors: {} }).items.find((row) => row.id === 'dooray:task:post:p77')!
    assert.deepEqual(cc.from, { id: KIM, name: '김철수' })
    const unnamed = { ...cc, from: { id: KIM, name: '' } }
    comments = []
    assert.deepEqual(target.context(unnamed).unresolved, [])
    assert.equal(target.context(unnamed).item.from.name, '김철수')
    assert.match(target.compose(unnamed, '네', ''), /^\[@김철수\]/)
  })

  test('보낸 사람 이름을 끝내 풀지 못하면 맥락은 unresolved, 답변 합성은 던진다 (R3)', () => {
    const target = adapter({ messenger: false })
    const ghost = { ...mentionOf(target), from: { id: '9999', name: '' } }
    comments = []
    assert.deepEqual(target.context(ghost).unresolved, ['9999'])
    assert.throws(() => target.compose(ghost, '네', ''), /9999/)
  })
})

function mentionOf(target: Adapter) {
  return target.fetch({ since: SINCE, cursors: {} }).items.find((row) => row.id === 'dooray:task:comment:c1')!
}

describe('맥락, 답함, 답변', () => {
  function mentionItem(target: Adapter) {
    return target.fetch({ since: SINCE, cursors: {} }).items.find((row) => row.id === 'dooray:task:comment:c1')!
  }

  test('context 는 앞 댓글의 작성자를 이름으로 푼다 (R3)', () => {
    const target = adapter({ messenger: false })
    comments = [
      { id: 'c1', creator: { member: { organizationMemberId: KIM } }, createdAt: '2026-11-02T14:00:00+09:00', body: { content: '두 번째' } },
      { id: 'c0', creator: { member: { organizationMemberId: LEE } }, createdAt: '2026-11-02T13:00:00+09:00', body: { content: '첫 번째' } },
    ]
    const context = target.context(mentionItem(target))
    assert.equal(context.body, '권한 정리 본문')
    assert.deepEqual(context.previous.map((row) => [row.from.name, row.text]), [['이영희', '첫 번째'], ['김철수', '두 번째']])
    assert.deepEqual(context.unresolved, [])
  })

  test('풀지 못한 작성자는 unresolved 에 남는다 (R3)', () => {
    const target = adapter({ messenger: false })
    comments = [{ id: 'c9', creator: { member: { organizationMemberId: '9999' } }, createdAt: '2026-11-02T14:00:00+09:00', body: { content: '?' } }]
    assert.deepEqual(target.context(mentionItem(target)).unresolved, ['9999'])
  })

  test('알림 뒤의 내 댓글이 있으면 답함이다 (R5)', () => {
    const row = mentionItem(adapter({ messenger: false }))
    comments = [{ creator: { member: { organizationMemberId: KIM } }, createdAt: '2026-11-02T14:30:00+09:00' }]
    assert.equal(adapter({ messenger: false }).answered(row), false)
    comments = [{ creator: { member: { organizationMemberId: ME } }, createdAt: '2026-11-02T14:30:00+09:00' }]
    assert.equal(adapter({ messenger: false }).answered(row), true)
  })

  test('피드에 시각이 없던 멘션은 댓글 목록의 그 댓글 시각을 기준으로 답함을 판정한다 (R5)', () => {
    // 처음 받은 시각(item.at)이 내 답보다 늦어도, 멘션 댓글 뒤에 내 답이 있으면 답함이다
    const row = { ...mentionItem(adapter({ messenger: false })), at: '2026-11-02T06:00:00.000Z' }
    comments = [
      { id: 'mine', creator: { member: { organizationMemberId: ME } }, createdAt: '2026-11-02T14:20:00+09:00' },
      { id: 'c1', creator: { member: { organizationMemberId: KIM } }, createdAt: '2026-11-02T14:00:00+09:00' },
    ]
    assert.equal(adapter({ messenger: false }).answered(row), true)
  })

  test('메신저 멘션 뒤에 내가 그 방에 쓰면 답함이다 (R5)', () => {
    const target = adapter()
    const row = target.fetch({ since: SINCE, cursors: {} }).items.find((item) => item.id === 'dooray:messenger:ch-dev:l1')!
    assert.equal(target.answered(row), true)
  })

  test('답변은 보낸 사람을 id 로 멘션하고 signature 를 붙여 업무 댓글로 등록한다 (R10)', () => {
    const target = adapter({ messenger: false })
    const row = mentionItem(target)
    const text = target.compose(row, '운영 계정은 필요 없습니다.\n', '🤖 서명')
    assert.equal(text, `[@김철수](dooray://${ORG}/members/${KIM} "member") 운영 계정은 필요 없습니다.\n\n🤖 서명`)
    assert.equal(target.compose(row, '네', ''), `[@김철수](dooray://${ORG}/members/${KIM} "member") 네`)
    assert.equal(target.reply(row, text), 'https://example.dooray.com/project/tasks/p81')
    assert.deepEqual(sent[0].argv.slice(0, 6), ['dooray', 'post', 'comment', 'add', '--id', 'p81'])
    assert.equal(sent[0].body, text)
  })

  test('등록 명령이 실패하면 던진다', () => {
    const target = adapter({ messenger: false })
    const row = mentionItem(target)
    failing.add('post comment')
    assert.throws(() => target.reply(row, '네'), /실패/)
    assert.equal(sent.length, 0)
  })

  test('메신저 답변은 그 대화방으로 보낸다', () => {
    const target = adapter()
    const row = target.fetch({ since: SINCE, cursors: {} }).items.find((item) => item.id === 'dooray:messenger:ch-dm:l9')!
    target.reply(row, '가능해요')
    assert.deepEqual(sent[0].argv.slice(0, 5), ['dooray', 'messenger', 'channel-send', '--channel', 'ch-dm'])
  })
})

describe('시각 없는 댓글 event (웹 방식 stream)', () => {
  const noTime = (id: string, postId: string) => ({ type: 'event', event: { id, type: 'comment', postId, read: false,
    creator: { type: 'member', member: { organizationMemberId: KIM, name: '김철수' } },
    body: { content: `${link(ME, '김병태')} 확인 부탁드려요` } } })
  const commentListCalls = () => calls.filter((argv) => argv[2] === 'post' && argv[3] === 'comment' && argv[4] === 'list')

  test('댓글 목록에서 같은 id 댓글의 createdAt 을 항목 시각으로 쓴다', () => {
    stream = [noTime('c1', 'p81')]
    comments = [{ id: 'c1', createdAt: '2026-11-02T14:00:00+09:00' }]
    const item = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} }).items[0]
    assert.equal(item.at, '2026-11-02T05:00:00.000Z')
  })

  test('댓글을 못 찾으면 받은 시각을 쓴다', () => {
    stream = [noTime('c1', 'p81')]
    comments = [{ id: 'other', createdAt: '2026-11-02T14:00:00+09:00' }]
    const item = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} }).items[0]
    assert.equal(item.at, '2026-11-02T06:00:00.000Z')
  })

  test('댓글 목록을 읽지 못해도 항목은 받은 시각으로 낸다', () => {
    stream = [noTime('c1', 'p81')]
    failing.add('post comment')
    const result = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} })
    assert.equal(result.items[0].at, '2026-11-02T06:00:00.000Z')
  })

  test('같은 업무의 두 event 는 댓글 목록을 한 번만 읽는다', () => {
    stream = [noTime('c1', 'p81'), noTime('c4', 'p81')]
    comments = [{ id: 'c1', createdAt: '2026-11-02T14:00:00+09:00' }, { id: 'c4', createdAt: '2026-11-02T15:00:00+09:00' }]
    const items = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} }).items
    assert.deepEqual(items.map((row) => row.at).sort(), ['2026-11-02T05:00:00.000Z', '2026-11-02T06:00:00.000Z'])
    assert.equal(commentListCalls().length, 1)
  })

  test('댓글 목록 읽기가 실패하면 같은 업무는 그 받기 안에서 다시 부르지 않는다', () => {
    stream = [noTime('c1', 'p81'), noTime('c4', 'p81')]
    failing.add('post comment')
    const items = adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} }).items
    assert.deepEqual(items.map((row) => row.at), ['2026-11-02T06:00:00.000Z', '2026-11-02T06:00:00.000Z'])
    assert.equal(commentListCalls().length, 1)
  })

  test('업무 커서를 읽을 수 없으면 15일 전부터 받는다 (REQ2)', () => {
    const result = adapter().fetch({ since: SINCE, cursors: { task: '잘못된 커서' } }, 'task')
    assert.equal(result.items.length, 3)
    assert.deepEqual(calls.find((argv) => argv[2] === 'stream')?.slice(4), ['--since', TASK_FEED_SINCE, '--all'])
    assert.ok(calls.every((argv) => argv[2] !== 'messenger'))
  })

  test('업무 커서까지 원본을 받아 경계 페이지의 시각 없는 댓글을 남긴다 (REQ2)', () => {
    const first = String(Date.parse('2026-11-02T05:55:01.000Z')) + '000000'
    const boundary = String(Date.parse('2026-10-31T06:00:00.000Z')) + '000000'
    streamFor = (args) => {
      const cursor = args[args.indexOf('--before') + 1]
      if (cursor === first) return { ...ok([noTime('c1', 'p81')]), stderr: `ℹ  다음 페이지: --before ${boundary}\n` }
      return { ...ok([{ type: 'mail' }]), stderr: `ℹ  다음 페이지: --before ${first}\n` }
    }
    comments = [{ id: 'c1', createdAt: '2026-11-02T14:58:00+09:00' }]
    const result = adapter({ messenger: false }).fetch({ since: SINCE, cursors: { task: '2026-11-02T05:55:00.000Z' } }, 'task')
    assert.deepEqual(calls.filter((argv) => argv[2] === 'stream').map((argv) => argv.slice(4)), [
      ['--size', '200'],
      ['--size', '200', '--before', first],
    ])
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].at, '2026-11-02T05:58:00.000Z')
  })

  test('메신저만 요청하면 업무를 부르지 않는다 (REQ3)', () => {
    const result = adapter().fetch({ since: SINCE, cursors: {} }, 'messenger')
    assert.ok(result.items.length > 0)
    assert.ok(result.items.every((item) => item.source === 'messenger'))
    assert.ok(calls.every((argv) => argv[2] !== 'stream'))
  })

  test('가득 찬 페이지에 다음 커서가 없으면 피드 전체를 다시 받고 느린 받기로 알린다', () => {
    streamFor = (args) => args.includes('--size') ? ok(Array.from({ length: 200 }, () => ({}))) : ok(STREAM)
    const result = adapter().fetch({ since: SINCE, cursors: { task: '2026-11-02T05:55:00.000Z' } }, 'task')
    assert.equal(result.items.length, 3)
    assert.deepEqual(result.fullScanSources, ['task'])
    assert.deepEqual(calls.filter((argv) => argv[2] === 'stream').map((argv) => argv.slice(4)), [
      ['--size', '200'],
      ['--since', TASK_FEED_SINCE, '--all'],
    ])
  })

  test('찾은 댓글 시각은 캐시해 다음 받기에서 댓글 목록을 다시 읽지 않는다', () => {
    stream = [noTime('c1', 'p81')]
    comments = [{ id: 'c1', createdAt: '2026-11-02T14:58:00+09:00' }]
    const cache = new MemoryCache()
    const make = () => createDooray({ type: 'dooray', messenger: false }, { run: runner, cache, now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
    make().fetch({ since: SINCE, cursors: {} })
    const before = commentListCalls().length
    const again = make().fetch({ since: SINCE, cursors: {} })
    assert.equal(commentListCalls().length, before)
    assert.equal(again.items[0].at, '2026-11-02T05:58:00.000Z')
  })

  test('시각이 있는 event 는 댓글 목록을 읽지 않는다', () => {
    adapter({ messenger: false }).fetch({ since: SINCE, cursors: {} })
    assert.equal(commentListCalls().length, 0)
  })
})
