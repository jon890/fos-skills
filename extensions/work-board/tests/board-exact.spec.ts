import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { linesRev } from '../bin/board.ts'
import { item, run, tempBoard, write } from './board-run.ts'

test('엄격 set 은 없는 항목을 만들지 않고 기존 진행률 검사를 지킨다', () => {
  const t = tempBoard()
  try {
    assert.equal(run(t.file, ['set', 'nope', 'doing', '--exact']).code, 1); assert.ok(!existsSync(t.file))
    write(t.file, { id: 'a', status: 'goal' })
    const normal = run(t.file, ['set', 'a', 'doing']), exact = run(t.file, ['set', 'a', 'doing', '--exact'])
    assert.equal(normal.code, 1); assert.equal(exact.code, 1); assert.equal(exact.stderr, normal.stderr)
    const result = run(t.file, ['set', 'a', 'wait', '--exact'])
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { id: 'a', status: 'wait', was: 'goal', progress: null, rev: linesRev(undefined), lines: [] })
    assert.equal(result.stdout.trim().split('\n').length, 1)
    assert.equal(run(t.file, ['set', 'nope', 'wait']).stdout, ''); assert.ok(item(t.file, 'nope'))
  } finally { t.cleanup() }
})
test('엄격 step 은 없는 번호와 중복 번호를 거절하며 되돌림과 decide 전환을 지킨다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'decide', details: ['1. 구현', '2. 리뷰', '3. 머지', '9.머지'] })
    const before = readFileSync(t.file, 'utf8'), missing = run(t.file, ['step', 'a', '9', '--exact'])
    assert.equal(missing.code, 1); assert.match(missing.stderr, /9 번 단계가 없다. 있는 번호: 1 2 3/); assert.equal(readFileSync(t.file, 'utf8'), before)
    let result = run(t.file, ['step', 'a', '2', '--exact']); assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).number, 2); assert.equal(JSON.parse(result.stdout).lines[1].done, true)
    result = run(t.file, ['step', 'a', '2', '--undo', '--exact']); assert.equal(JSON.parse(result.stdout).lines[1].done, false)
    assert.equal(JSON.parse(result.stdout).status, 'decide')
    write(t.file, { id: 'a', details: ['2. 리뷰', '2. 둘째'] })
    const duplicate = readFileSync(t.file, 'utf8')
    assert.equal(run(t.file, ['step', 'a', '2', '--exact']).code, 1); assert.equal(readFileSync(t.file, 'utf8'), duplicate)
    assert.equal(run(t.file, ['step', 'a', '2']).code, 0)
    write(t.file, { id: 'a', status: 'decide', details: ['1. 결정'] })
    result = run(t.file, ['step', 'a', '1', '--exact'])
    assert.equal(JSON.parse(result.stdout).status, 'done'); assert.equal(JSON.parse(result.stdout).was, 'decide')
    result = run(t.file, ['step', 'a', '1', '--undo', '--exact']); assert.equal(JSON.parse(result.stdout).status, 'done')
  } finally { t.cleanup() }
})
test('view 는 읽기만 하고 세는 쪽의 번호, 진행률과 지문을 낸다', () => {
  const t = tempBoard()
  try {
    const row = { id: 'a', status: 'doing', details: ['✓ 1. 구현', '2. 리뷰', '3. 머지', '참고', '  '], next: ['4. 다른 쪽'] }
    write(t.file, row); writeFileSync(`${t.file}.lock`, 'other')
    const before = readFileSync(t.file, 'utf8'), result = run(t.file, ['view', 'a'])
    assert.equal(result.code, 0); const view = JSON.parse(result.stdout)
    assert.deepEqual(view.progress, [1, 3]); assert.deepEqual(view.lines.map((line: { number: number | null }) => line.number), [1, 2, 3, null, null])
    assert.equal(view.lines[4].in, 'next'); assert.equal(view.rev, linesRev(row)); assert.equal(readFileSync(t.file, 'utf8'), before)
    assert.equal(run(t.file, ['view', 'nope']).code, 1)
    for (const [extra, progress] of [[{ progress: '7/10' }, [7, 10]], [{}, null], [{ next: ['1. 다음'] }, [0, 1]]] as const) {
      write(t.file, { id: 'a', ...extra })
      const got = JSON.parse(run(t.file, ['view', 'a']).stdout)
      assert.deepEqual(got.progress, progress)
      if ('next' in extra) { assert.equal(got.lines[0].in, 'next'); assert.equal(got.lines[0].number, 1) }
    }
    assert.equal(linesRev({ details: ['✓ 1. 구현'] }), linesRev({ details: [{ text: '1. 구현', done: true }] }))
    assert.notEqual(linesRev({ details: ['1. 구현'] }), linesRev({ details: ['✓ 1. 구현'] }))
    assert.notEqual(linesRev({ details: ['1. 구현'] }), linesRev({ details: ['1. 고침'] }))
  } finally { t.cleanup() }
})
test('읽은 뒤 바뀐 글이나 끝냄 값을 통째 저장으로 덮지 않는다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', details: ['1. 구현', '2. 리뷰'] })
    const rev = JSON.parse(run(t.file, ['view', 'a']).stdout).rev
    const args = ['set', 'a', '--detail', '1. 구현', '--detail', '2. 리뷰', '--if-rev', rev]
    assert.equal(run(t.file, args).code, 0)
    assert.equal(run(t.file, ['detail-edit', 'a', '1', '1. 바꾼 글']).code, 0)
    const changed = readFileSync(t.file, 'utf8'), refused = run(t.file, args)
    assert.equal(refused.code, 1); assert.match(refused.stderr, /줄이 바뀌어/); assert.equal(readFileSync(t.file, 'utf8'), changed)
    const current = JSON.parse(run(t.file, ['view', 'a']).stdout).rev
    assert.equal(run(t.file, [...args.slice(0, -1), current]).code, 0)
    assert.equal(run(t.file, ['step', 'a', '1']).code, 0)
    const marked = readFileSync(t.file, 'utf8')
    assert.equal(run(t.file, args).code, 1); assert.equal(readFileSync(t.file, 'utf8'), marked)
    assert.equal(run(t.file, ['set', 'nope', 'wait', '--if-rev', rev]).code, 1); assert.equal(item(t.file, 'nope'), undefined)
  } finally { t.cleanup() }
})
test('새 옵션의 조합 오류와 기존 줄임 옵션을 구분한다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', details: ['1. 구현'] }); const before = readFileSync(t.file, 'utf8')
    for (const args of [['mark', 'a', '1', '--exact'], ['step', 'a', '1', '--if-rev', 'x']]) {
      const result = run(t.file, args); assert.equal(result.code, 2); assert.match(result.stderr, /^사용법: board.ts/)
      assert.equal(readFileSync(t.file, 'utf8'), before)
    }
    assert.equal(run(t.file, ['set', 'a', 'wait', '--s', 'pr=1,merge=2', '--o', 'me']).code, 0)
    assert.equal(item(t.file, 'a').stages, 'pr=1,merge=2'); assert.equal(item(t.file, 'a').owner, 'me')
  } finally { t.cleanup() }
})
