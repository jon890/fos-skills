import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { item, run, tempBoard, write } from './board-run.ts'

test('번호 뒤 표시만 바꾸고 끝냄 상태와 다른 줄과 꼬리표를 그대로 둔다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'doing', details: [{ text: '1. 구현', done: true }, { text: '2. [auto] PR4 API (계획: x)', done: false }, { text: '참고: [auto] 글', done: false }] })
    let result = run(t.file, ['step-mark', 'a', '2', 'ask'])
    assert.equal(result.code, 0, result.stderr)
    const view = JSON.parse(result.stdout)
    assert.equal(view.number, 2); assert.equal(view.status, 'doing'); assert.equal(view.lines[1].text, '2. [ask] PR4 API (계획: x)')
    assert.deepEqual(item(t.file, 'a').details, [{ text: '1. 구현', done: true }, { text: '2. [ask] PR4 API (계획: x)', done: false }, { text: '참고: [auto] 글', done: false }])
    for (const [args, text] of [
      [['wait', '2026-11-10 19:00'], '2. [wait: 2026-11-10 19:00] PR4 API (계획: x)'],
      [['wait'], '2. [wait] PR4 API (계획: x)'],
      [['plain'], '2. PR4 API (계획: x)'],
      [['auto'], '2. [auto] PR4 API (계획: x)'],
      [['auto'], '2. [auto] PR4 API (계획: x)'],
    ] as [string[], string][]) {
      result = run(t.file, ['step-mark', 'a', '2', ...args]); assert.equal(result.code, 0, result.stderr)
      assert.equal((item(t.file, 'a').details as { text: string }[])[1].text, text)
    }
  } finally { t.cleanup() }
})

test('끝난 줄은 끝난 채 남고 줄 끝 꼬리표와 next 단계도 받는다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', details: [{ text: '5. [wait] 기획 답 (#665 merge)', done: true }] })
    assert.equal(run(t.file, ['step-mark', 'a', '5', 'ask']).code, 0)
    assert.deepEqual(item(t.file, 'a').details, [{ text: '5. [ask] 기획 답 (#665 merge)', done: true }])
    assert.equal(run(t.file, ['step-mark', 'a', '5', 'plain']).code, 0)
    assert.deepEqual(item(t.file, 'a').details, [{ text: '5. 기획 답 (#665 merge)', done: true }])
    write(t.file, { id: 'a', details: ['참고'], next: ['3. real 활성화'] })
    assert.equal(run(t.file, ['step-mark', 'a', '3', 'ask']).code, 0)
    assert.deepEqual(item(t.file, 'a').next, [{ text: '3. [ask] real 활성화', done: false }])
  } finally { t.cleanup() }
})

test('사건 단계와 없는 번호와 잘못된 조건은 보드 바이트를 그대로 두고 거절한다', () => {
  const t = tempBoard()
  try {
    for (const [extra, args, message] of [
      [{ details: ['2. [merge] 머지'] }, ['2', 'auto'], '사건 단계'],
      [{ details: ['1. 구현', '2. 머지'], stages: 'pr=1,merge=2' }, ['2', 'auto'], '사건 단계'],
      [{ details: ['1. 구현', '2. 머지'], stages: 'pr=1,merge=2' }, ['1', 'ask'], '사건 단계'],
      [{ details: ['1. 구현', '2. 머지'] }, ['9', 'auto'], '있는 번호: 1 2'],
      [{ details: ['9. 머지', '9. 둘째'] }, ['9', 'auto'], '둘 이상'],
      [{ details: ['3. 확인'] }, ['3', 'wait', ''], '조건'],
      [{ details: ['3. 확인'] }, ['3', 'wait', 'a]b'], '조건'],
      [{ details: ['3. 확인'] }, ['3', 'wait', 'a\nb'], '조건'],
    ] as [Record<string, unknown>, string[], string][]) {
      write(t.file, { id: 'a', ...extra }); const before = readFileSync(t.file, 'utf8')
      const result = run(t.file, ['step-mark', 'a', ...args])
      assert.equal(result.code, 1, result.stderr); assert.ok(result.stderr.includes(message), result.stderr)
      assert.equal(readFileSync(t.file, 'utf8'), before)
    }
    write(t.file, { id: 'a' }); const before = readFileSync(t.file, 'utf8')
    const result = run(t.file, ['step-mark', 'missing', '1', 'auto'])
    assert.equal(result.code, 1); assert.ok(result.stderr.includes('항목이 없다'))
    assert.equal(readFileSync(t.file, 'utf8'), before)
  } finally { t.cleanup() }
})

test('모르는 표시와 번호 형식과 조건 위치는 사용법 오류다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', details: ['3. 확인'] }); const before = readFileSync(t.file, 'utf8')
    for (const args of [['3', 'Auto'], ['3', 'maybe'], ['3'], ['x', 'auto'], ['3', 'auto', '조건'], ['3', 'ask', '조건'], ['3', 'plain', '조건'], ['3', 'wait', 'a', 'b'], ['3', 'auto', '--event', '1 merge'], ['3', 'auto', '--exact']]) {
      const result = run(t.file, ['step-mark', 'a', ...args])
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`)
      assert.equal(readFileSync(t.file, 'utf8'), before)
    }
  } finally { t.cleanup() }
})
