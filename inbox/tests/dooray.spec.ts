// 두레이 adapter 를 가짜 Runner 로 돌려 본다. 응답은 두레이 공식 문서의 streams 예시와 dooray CLI 0.29.1 의 JSON 필드를 본떴다.
// 실제 두레이에는 닿지 않는다.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { createDooray, excerptOf, MAX_CHANNELS, mentions, plainText } from '../scripts/adapters/dooray.ts'
import type { Adapter, Cache, RunResult } from '../scripts/lib/model.ts'

const ME = '3421415092208840539'
const ORG = '1387695619080878080'
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
  p342: { id: 'p342', taskNumber: 'AI-스마트홈-AI/342', subject: '배포 일정 조율', project: { id: 'proj-home', code: 'AI-스마트홈-AI' } },
  p77: { id: 'p77', taskNumber: '어드민개발/77', subject: '로그 보존 기간', project: { id: 'proj-admin', code: '어드민개발' } },
}

const CHANNELS = [
  { id: 'ch-dev', title: '스마트홈 개발', type: 'private', updatedAt: '2026-11-02T14:30:00+09:00' },
  { id: 'ch-bot', title: '배포 알림', type: 'bot', updatedAt: '2026-11-02T14:31:00+09:00' },
  { id: 'ch-me', title: '', type: 'me', updatedAt: '2026-11-02T14:32:00+09:00' },
  { id: 'ch-dm', title: '', type: 'direct', updatedAt: '2026-11-02T14:20:00+09:00' },
]

const LOGS: Record<string, unknown[]> = {
  'ch-dev': [
    { id: 'l2', sender: { type: 'member', member: { organizationMemberId: ME } }, sentAt: '2026-11-02T14:25:00+09:00', text: '네 볼게요' },
    { id: 'l1', sender: { type: 'member', member: { organizationMemberId: LEE } }, sentAt: '2026-11-02T14:10:00+09:00', text: `${link(ME, '김병태')} 리뷰 부탁해요` },
  ],
  'ch-dm': [
    { id: 'l9', sender: { type: 'member', member: { organizationMemberId: KIM } }, sentAt: '2026-11-02T14:00:00+09:00', text: `${link(ME, '김병태')} 잠깐 통화 가능?` },
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
let sent: { argv: string[]; body: string }[]
let dir: string

function ok(value: unknown): RunResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: '' }
}

function runner(argv: string[]): RunResult {
  calls.push(argv)
  const key = argv.slice(2, 4).join(' ')
  if (failing.has(key) || failing.has(argv.slice(2).join(' '))) return { code: 1, stdout: '', stderr: `${key} 실패 (429)` }
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
  if (key === 'stream list') return ok(STREAM)
  if (key === 'post get') return ok(POSTS[args[3]])
  if (key === 'post comment') return ok(comments)
  if (key === 'messenger channels') return ok(CHANNELS)
  if (key === 'messenger logs') return ok(LOGS[args[2]] ?? [])
  return { code: 1, stdout: '', stderr: `모르는 명령 ${argv.join(' ')}` }
}

function adapter(config: Record<string, unknown> = {}): Adapter {
  return createDooray({ type: 'dooray', webUrl: 'https://nhnent.dooray.com/', ...config },
    { run: runner, cache: new MemoryCache(), now: () => new Date('2026-11-02T06:00:00.000Z'), tmpDir: dir })
}

beforeEach(() => {
  calls = []
  failing = new Set()
  comments = []
  sent = []
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
  })
})

describe('받기', () => {
  test('업무 댓글 멘션, 담당, 참조를 공통 모델로 바꾼다 (R1, R2)', () => {
    const result = adapter({ messenger: false }).fetch({ since: SINCE, lastFetchedAt: null })
    assert.deepEqual(result.errors, {})
    const byId = Object.fromEntries(result.items.map((row) => [row.id, row]))
    assert.deepEqual(Object.keys(byId).sort(), ['dooray:task:comment:c1', 'dooray:task:post:p342', 'dooray:task:post:p77'])
    const mention = byId['dooray:task:comment:c1']
    assert.equal(mention.kind, 'mention')
    assert.equal(mention.title, '어드민개발/81 어드민 권한 정리')
    assert.equal(mention.url, 'https://nhnent.dooray.com/project/tasks/p81')
    assert.deepEqual(mention.scope, ['proj-admin', '어드민개발'])
    assert.deepEqual(mention.from, { id: KIM, name: '김철수' })
    assert.equal(mention.at, '2026-11-02T05:00:00.000Z')
    assert.equal(mention.excerpt, '@김병태 운영 계정도 같은 권한이 필요한지 확인 부탁드려요')
    assert.deepEqual(mention.target, { kind: 'task', postId: 'p81', commentId: 'c1' })
    assert.equal(byId['dooray:task:post:p342'].kind, 'assigned')
    assert.equal(byId['dooray:task:post:p77'].kind, 'cc')
    assert.deepEqual(calls.find((argv) => argv[2] === 'stream'), ['dooray', '--json', 'stream', 'list', '--since', SINCE, '--all'])
    // 업무 정보는 업무마다 한 번만 읽는다
    assert.equal(calls.filter((argv) => argv[2] === 'post' && argv[3] === 'get' && argv[5] === 'p81').length, 1)
  })

  test('메신저는 봇 방과 나와의 대화를 건너뛰고 바뀐 방의 멘션만 받는다 (D1, D14)', () => {
    const result = adapter().fetch({ since: SINCE, lastFetchedAt: '2026-11-02T05:00:00.000Z' })
    const messenger = result.items.filter((row) => row.source === 'messenger')
    assert.deepEqual(messenger.map((row) => row.id).sort(), ['dooray:messenger:ch-dev:l1', 'dooray:messenger:ch-dm:l9'])
    const dev = messenger.find((row) => row.id.endsWith('l1'))
    assert.deepEqual(dev?.scope, ['ch-dev', '스마트홈 개발'])
    assert.deepEqual(dev?.from, { id: LEE, name: '이영희' })
    assert.equal(messenger.find((row) => row.id.endsWith('l9'))?.title, '김철수 대화')
    assert.deepEqual(calls.find((argv) => argv[3] === 'channels'), ['dooray', '--json', 'messenger', 'channels', '--since', '2026-11-02T05:00:00.000Z'])
    const logCalls = calls.filter((argv) => argv[3] === 'logs').map((argv) => argv[4])
    assert.deepEqual(logCalls, ['ch-dev', 'ch-dm'])
  })

  test(`메신저는 한 번에 ${MAX_CHANNELS}개 방까지만 읽는다`, () => {
    const many = Array.from({ length: MAX_CHANNELS + 5 }, (_, i) => ({ id: `c${i}`, title: `방${i}`, type: 'private', updatedAt: `2026-11-02T0${i % 10}:00:00Z` }))
    CHANNELS.push(...many)
    try {
      adapter().fetch({ since: SINCE, lastFetchedAt: null })
      assert.equal(calls.filter((argv) => argv[3] === 'logs').length, MAX_CHANNELS)
    } finally {
      CHANNELS.splice(4)
    }
  })

  test('메신저가 실패해도 업무 항목은 낸다 (R7)', () => {
    failing.add('messenger channels')
    const result = adapter().fetch({ since: SINCE, lastFetchedAt: null })
    assert.match(result.errors.messenger, /429/)
    assert.equal(result.errors.task, undefined)
    assert.equal(result.items.filter((row) => row.source === 'task').length, 3)
  })

  test('대화방 하나의 logs 가 실패하면 그 방만 빼고 오류를 남긴다', () => {
    failing.add('messenger logs ch-dev -n 50')
    const result = adapter().fetch({ since: SINCE, lastFetchedAt: null })
    assert.match(result.errors.messenger, /대화방 1개 읽기 실패: 스마트홈 개발/)
    assert.deepEqual(result.items.filter((row) => row.source === 'messenger').map((row) => row.id), ['dooray:messenger:ch-dm:l9'])
  })

  test('업무 피드가 실패하면 task 오류를 남긴다 (R7)', () => {
    failing.add('stream list')
    const result = adapter({ messenger: false }).fetch({ since: SINCE, lastFetchedAt: null })
    assert.match(result.errors.task, /stream list.*429/)
    assert.equal(result.items.length, 0)
  })
})

describe('맥락, 답함, 답변', () => {
  function mentionItem(target: Adapter) {
    return target.fetch({ since: SINCE, lastFetchedAt: null }).items.find((row) => row.id === 'dooray:task:comment:c1')!
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
    const target = adapter({ messenger: false })
    const row = mentionItem(target)
    comments = [{ creator: { member: { organizationMemberId: KIM } }, createdAt: '2026-11-02T14:30:00+09:00' }]
    assert.equal(target.answered(row), false)
    comments = [{ creator: { member: { organizationMemberId: ME } }, createdAt: '2026-11-02T14:30:00+09:00' }]
    assert.equal(target.answered(row), true)
  })

  test('메신저 멘션 뒤에 내가 그 방에 쓰면 답함이다 (R5)', () => {
    const target = adapter()
    const row = target.fetch({ since: SINCE, lastFetchedAt: null }).items.find((item) => item.id === 'dooray:messenger:ch-dev:l1')!
    assert.equal(target.answered(row), true)
  })

  test('답변은 보낸 사람을 id 로 멘션하고 signature 를 붙여 업무 댓글로 등록한다 (R10)', () => {
    const target = adapter({ messenger: false })
    const row = mentionItem(target)
    const text = target.compose(row, '운영 계정은 필요 없습니다.\n', '🤖 서명')
    assert.equal(text, `[@김철수](dooray://${ORG}/members/${KIM} "member") 운영 계정은 필요 없습니다.\n\n🤖 서명`)
    assert.equal(target.compose(row, '네', ''), `[@김철수](dooray://${ORG}/members/${KIM} "member") 네`)
    assert.equal(target.reply(row, text), 'https://nhnent.dooray.com/project/tasks/p81')
    assert.deepEqual(sent[0].argv.slice(0, 6), ['dooray', 'post', 'comment', 'add', '--id', 'p81'])
    assert.equal(sent[0].body, text)
  })

  test('메신저 답변은 그 대화방으로 보낸다', () => {
    const target = adapter()
    const row = target.fetch({ since: SINCE, lastFetchedAt: null }).items.find((item) => item.id === 'dooray:messenger:ch-dm:l9')!
    target.reply(row, '가능해요')
    assert.deepEqual(sent[0].argv.slice(0, 5), ['dooray', 'messenger', 'channel-send', '--channel', 'ch-dm'])
  })
})
