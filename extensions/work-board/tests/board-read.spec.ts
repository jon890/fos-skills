import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { GET_FIELDS } from '../../../modules/work-board/item.ts'
import { item, run, tempBoard, write } from './board-run.ts'

test('set 은 우선순위를 숫자로 저장하고 잘못된 값을 거절한다', (t) => {
  const board = tempBoard()
  t.after(board.cleanup)
  write(board.file, { id: 'a', title: '기존 항목', status: 'wait', stepAt: '2026-11-27T09:00:00+09:00' })
  const cmd = (...args: string[]) => run(board.file, args)
  const set = (priority: string) => cmd('set', 'a', '--priority', priority)
  assert.equal(set('2').code, 0)
  assert.deepEqual(item(board.file, 'a'), {
    id: 'a', title: '기존 항목', status: 'wait', stepAt: '2026-11-27T09:00:00+09:00', priority: 2,
  })
  assert.match(cmd('list').stdout, /우선순위 2/)
  assert.equal(JSON.parse(cmd('view', 'a').stdout).priority, 2)
  assert.equal(JSON.parse(cmd('get', 'a', 'priority').stdout).value, '2')
  const before = readFileSync(board.file, 'utf8')
  for (const value of ['', '0', '-1', '2.1', '1e2', '0x10', ' 2', 'text', '9007199254740992']) {
    const refused = set(value)
    assert.equal(refused.code, 1, refused.stderr)
    assert.match(refused.stderr, /--priority.*정수/)
    assert.equal(readFileSync(board.file, 'utf8'), before)
  }
  assert.equal(cmd('list', '--priority', '1').code, 2)
  assert.equal(set('none').code, 0)
  assert.ok(!('priority' in item(board.file, 'a')))
  assert.doesNotMatch(cmd('list').stdout, /우선순위/)
})

test('옛 goal 은 doing 으로 읽되 조회는 파일을 보존하고 새 goal 쓰기는 거절한다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'old', status: 'goal', title: '기존 항목', details: ['1. 구현'], progress: '0/1' }, { id: 'bare', status: 'goal', title: '목표만' })
    const before = readFileSync(t.file, 'utf8')
    for (const command of ['view', 'item']) {
      const result = run(t.file, [command, 'old'])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).status, 'doing')
    }
    assert.equal(JSON.parse(run(t.file, ['get', 'old', 'status']).stdout).value, 'doing')
    assert.equal(JSON.parse(run(t.file, ['items', 'doing']).stdout)[0].id, 'old')
    assert.match(run(t.file, ['list']).stdout, /doing/)
    const bare = JSON.parse(run(t.file, ['item', 'bare']).stdout)
    assert.equal(bare.status, 'doing')
    assert.equal(readFileSync(t.file, 'utf8'), before)
    for (const args of [['set', 'old', 'goal'], ['set', 'new', 'goal'], ['items', 'goal']]) {
      const result = run(t.file, args)
      assert.equal(result.code, 1, result.stderr)
      assert.match(result.stderr, /decide\|doing\|wait\|done/)
      assert.equal(readFileSync(t.file, 'utf8'), before)
    }
    assert.equal(run(t.file, ['set', 'old', '--title', '수정한 제목']).code, 0)
    const saved = JSON.parse(readFileSync(t.file, 'utf8')).items.find((row: { id: string }) => row.id === 'old')
    assert.equal(saved.status, 'doing')
    assert.equal(saved.progress, '0/1')
    assert.deepEqual(saved.details, [{ text: '1. 구현', done: false }])
    // 진행률도 단계도 없던 옛 항목은 다른 doing 항목처럼 진행률을 함께 줘야 고칠 수 있다
    const refused = run(t.file, ['set', 'bare', '--title', '이름 수정'])
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /진행률이 필요하다/)
    assert.equal(run(t.file, ['set', 'bare', '--title', '이름 수정', '--progress', '0/1']).code, 0)
    assert.equal(JSON.parse(readFileSync(t.file, 'utf8')).items.find((row: { id: string }) => row.id === 'bare').title, '이름 수정')
  } finally { t.cleanup() }
})

test('get, item, items 는 잠금 없이 저장된 값과 단계 값을 읽는다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'doing', pr: 555, details: ['✓ 1. 구현', '2. [ask] 머지 (#70 merge)'] }, { id: 'b', status: 'done', title: '' }, { id: 99, status: 'done' })
    writeFileSync(`${t.file}.lock`, 'other')
    const before = readFileSync(t.file, 'utf8')
    for (const field of ['status', 'title', 'owner', 'pr', 'merged-pr', 'branch', 'worktree', 'task', 'stages', 'progress', 'step']) assert.ok(GET_FIELDS.includes(field as typeof GET_FIELDS[number]))
    const get = (id: string, field: string, ...rest: string[]) => run(t.file, ['get', id, field, ...rest])
    assert.equal(JSON.parse(get('a', 'pr').stdout).value, '555')
    assert.equal(JSON.parse(get('a', 'title').stdout).value, 'a')
    assert.equal(JSON.parse(get('a', 'progress').stdout).value, '1/2')
    assert.deepEqual(JSON.parse(get('a', 'step', '2').stdout), { id: 'a', field: 'step', number: 2, value: '2. [ask] 머지 (#70 merge)' })
    assert.equal(get('b', 'title').code, 4); assert.equal(JSON.parse(get('b', 'title').stdout).value, null)
    const view = JSON.parse(run(t.file, ['view', 'a']).stdout), item = JSON.parse(run(t.file, ['item', 'a']).stdout)
    assert.deepEqual(item.lines, view.lines); assert.equal(item.pr, 555); assert.ok(!('rev' in item)); assert.ok(!('title' in item))
    assert.deepEqual(JSON.parse(run(t.file, ['items', 'done']).stdout).map((row: { id: unknown }) => row.id), ['b', 99])
    for (const args of [['items', ''], ['items', 'doing,'], ['item', '99'], ['get', 'missing', 'pr']]) assert.equal(run(t.file, args).code, 1)
    for (const args of [['get', 'a'], ['get', 'a', 'foo'], ['get', 'a', 'step'], ['get', 'a', 'pr', '1'], ['item', 'a', 'b']]) assert.equal(run(t.file, args).code, 2)
    assert.equal(readFileSync(t.file, 'utf8'), before)
  } finally { t.cleanup() }
})
