// 승인 대기 창의 순수 함수를 본다. 그리기와 누르기는 approvals-pane.test.ts 가 본다.
//
// 실행: node --test extensions/work-board/tests/approvals-pane.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalArgv, approvalControls, approvalKey, approvalWait, armedState, parseApprovals, pressToast, statusLine } from '../hooks/register.js'

const entry = (over: Record<string, unknown> = {}) => ({ id: 'post-1', version: 3, kind: 'post', title: '제목', state: 'open', terminal: 'term_c', ...over })

test('parseApprovals: 열린 대기만 버전 순으로 낸다', () => {
  const source = JSON.stringify({ seq: 9, entries: [
    entry({ id: 'b', version: 7 }), entry({ id: 'a', version: 2 }), entry({ id: 'c', version: 5, state: 'approved' }),
    entry({ id: 'd', version: 6, state: 'used' }), { id: 'broken' },
  ] })
  assert.deepEqual(parseApprovals(source).open?.map(e => e.id), ['a', 'b'])
})

test('parseApprovals: 빈 글은 대기 없음이고 깨진 글과 틀린 꼴은 error 다', () => {
  assert.deepEqual(parseApprovals(''), { open: [] })
  assert.deepEqual(parseApprovals('  \n'), { open: [] })
  assert.ok('error' in parseApprovals('{깨짐'))
  assert.deepEqual(parseApprovals('{"seq":1}'), { error: '승인 파일 꼴이 틀려요' })
})

test('approvalWait: 59분, 61분, 25시간은 노랑, 2일', () => {
  const at = Date.parse('2026-11-10T12:00:00+09:00')
  const ago = (minutes: number) => new Date(at - minutes * 60000).toISOString()
  assert.deepEqual(approvalWait(ago(59), at), { text: '59분', old: false })
  assert.deepEqual(approvalWait(ago(61), at), { text: '1시간', old: false })
  assert.deepEqual(approvalWait(ago(24 * 60), at), { text: '1일', old: false })
  assert.deepEqual(approvalWait(ago(25 * 60), at), { text: '1일', old: true })
  assert.deepEqual(approvalWait(ago(48 * 60 + 5), at), { text: '2일', old: true })
  assert.deepEqual(approvalWait(undefined, at), { text: '0분', old: false })
})

test('approvalKey 는 id 와 버전과 동작을 함께 쓴다', () => {
  assert.equal(approvalKey(entry(), 'approve'), 'approval:post-1:3:approve')
  assert.notEqual(approvalKey(entry({ version: 4 }), 'approve'), approvalKey(entry(), 'approve'))
})

test('approvalControls: worker 가 아닌 창만 press, worker 이거나 모르면 guide, 읽는 중이면 checking, command 는 올린 터미널만 fill', () => {
  assert.equal(approvalControls(entry(), { known: true, terminal: 'term_x', worker: false }), 'press')
  assert.equal(approvalControls(entry(), { known: true, terminal: 'term_x', worker: true }), 'guide')
  assert.equal(approvalControls(entry(), { known: true, terminal: 'term_x', worker: null }), 'guide')
  assert.equal(approvalControls(entry(), { known: false, terminal: null, worker: null }), 'checking')
  assert.equal(approvalControls(entry({ kind: 'real' }), { known: true, terminal: null, worker: false }), 'press')
  const command = entry({ kind: 'command', terminal: 'term_c' })
  assert.equal(approvalControls(command, { known: true, terminal: 'term_c', worker: false }), 'fill')
  assert.equal(approvalControls(command, { known: true, terminal: 'term_c', worker: true }), 'guide')
  assert.equal(approvalControls(command, { known: true, terminal: 'term_c', worker: null }), 'guide')
  assert.equal(approvalControls(command, { known: true, terminal: 'term_other', worker: false }), 'text')
  assert.equal(approvalControls(command, { known: true, terminal: null, worker: false }), 'text')
  assert.equal(approvalControls(command, { known: false, terminal: null, worker: null }), 'checking')
})

test('approvalArgv: 인자 순서와 - 로 시작하는 글', () => {
  const root = '/plugin'
  assert.deepEqual(approvalArgv(root, '/repo', entry(), 'approve', '', 'person'), [
    'node', '--disable-warning=ExperimentalWarning', '/plugin/extensions/work-board/bin/approvals.ts',
    'press', 'post-1', '3', 'approve', '--origin', 'person', '--repo', '/repo',
  ])
  const argv = approvalArgv(root, '/repo', entry(), 'revise', '-제목을 짧게', undefined)
  assert.deepEqual(argv.slice(-2), ['/repo', '--note=-제목을 짧게'])
  assert.equal(argv[argv.indexOf('--origin') + 1], 'none')
})

test('armedState: 처음 누른 키를 10초 안에 다시 눌러야 armed 다', () => {
  const armed = { key: 'k', until: 10_000 }
  assert.equal(armedState(armed, 'k', 9_999), 'armed')
  assert.equal(armedState(armed, 'k', 10_000), 'idle')
  assert.equal(armedState(armed, 'other', 5_000), 'idle')
  assert.equal(armedState(null, 'k', 0), 'idle')
})

test('pressToast: 예전 화면의 버튼은 스펙 문구로, 나머지는 이유 그대로 보인다', () => {
  assert.equal(pressToast('내용이 바뀌었어요'), '내용이 바뀌었어요. 새 미리보기를 확인하세요')
  assert.equal(pressToast('코디네이터가 거뒀어요'), '코디네이터가 거뒀어요')
})

test('statusLine: 「승인 n」 은 알림 다음 결정 필요 앞에 붙고 0 이거나 인자가 없으면 없다', () => {
  const live = { questions: 2, workers: [], prs: null, errors: {} }
  const inbox = { enabled: true, items: [{ state: 'new' }], fetchedAt: '2026-11-10T00:00:00Z' }
  const line = statusLine([], live, inbox, null, 3)
  assert.ok(line.indexOf('알림 1') < line.indexOf('승인 3') && line.indexOf('승인 3') < line.indexOf('결정 필요 2'), line)
  assert.ok(!statusLine([], live, inbox, null, 0).includes('승인'))
  assert.equal(statusLine([], live, inbox), statusLine([], live, inbox, null, 0))
})
