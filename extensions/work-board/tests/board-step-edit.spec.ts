import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseEventTag } from '../hooks/event-tags.js'
import { item, run, tempBoard, write } from './board-run.ts'

test('단계 글만 바꾸며 끝냄 값을 유지하고 앞 표시만 명시적으로 반영한다', () => {
  const t = tempBoard()
  try {
    for (const done of [false, true]) {
      write(t.file, { id: 'a', status: 'decide', details: [{ text: '9. 머지', done }, { text: '참고', done: false }] })
      const result = run(t.file, ['step-edit', 'a', '9', '9. 머지 확인'])
      assert.equal(result.code, 0); const view = JSON.parse(result.stdout)
      assert.equal(view.number, 9); assert.equal(view.lines[0].done, done); assert.equal(view.lines[1].text, '참고')
      assert.equal(view.status, 'decide')
    }
    write(t.file, { id: 'a', status: 'decide', next: ['9. 머지'] })
    const result = run(t.file, ['step-edit', 'a', '9', '✓ 9. 머지'])
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).status, 'decide')
    assert.deepEqual(item(t.file, 'a').next, [{ text: '9. 머지', done: true }])
  } finally { t.cleanup() }
})
test('단계 글의 다른 번호, 중복 번호, 꼬리표 삭제는 바이트를 보존하며 거절한다', () => {
  const t = tempBoard()
  try {
    for (const [details, args, message] of [
      [['9. 머지'], ['step-edit', 'a', '9', '10. 머지'], '9 번으로'],
      [['9. 머지'], ['step-edit', 'a', '9', '9.머지'], '9 번으로'],
      [['9. 머지'], ['step-edit', 'a', '8', '8. 머지'], '있는 번호: 9'],
      [['9. 머지', '9. 둘째'], ['step-edit', 'a', '9', '9. 머지'], '둘 이상'],
      [['9. 머지 (#1455 merge)'], ['step-edit', 'a', '9', '9. 머지 확인'], '꼬리표'],
      [['2. [merge] 머지'], ['step-edit', 'a', '2', '2. 머지'], '꼬리표'],
    ] as [string[], string[], string][]) {
      write(t.file, { id: 'a', details }); const before = readFileSync(t.file, 'utf8')
      const result = run(t.file, args); assert.equal(result.code, 1); assert.ok(result.stderr.includes(message), result.stderr)
      assert.equal(readFileSync(t.file, 'utf8'), before)
    }
    write(t.file, { id: 'a', details: ['2. [merge] 머지'] })
    assert.equal(run(t.file, ['step-edit', 'a', '2', '2. [merge] develop 머지']).code, 0)
    write(t.file, { id: 'a', details: ['9. 머지 (#1455 merge)'] })
    assert.equal(run(t.file, ['step-edit', 'a', '9', '9. 머지 확인 (#1456 merge)']).code, 0)
    const result = run(t.file, ['step-edit', 'a', '9', '9. 확인 (#1 pr)', '--event', '1456 deploy'])
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).lines[0].text, '9. 확인 (#1456 deploy)')
  } finally { t.cleanup() }
})
test('단계를 세는 쪽에 새 번호를 붙이고 끝나지 않은 줄을 더한다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', details: Array.from({ length: 9 }, (_, i) => `${i + 1}. 단계`) })
    let result = run(t.file, ['step-add', 'a', '리뷰 반영'])
    assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout).number, 10)
    assert.deepEqual((item(t.file, 'a').details as unknown[]).at(-1), { text: '10. 리뷰 반영', done: false })
    const before = readFileSync(t.file, 'utf8')
    assert.equal(run(t.file, ['step-add', 'a', '9. 중복']).code, 1); assert.equal(readFileSync(t.file, 'utf8'), before)
    result = run(t.file, ['step-add', 'a', '12. 건너뛴 번호']); assert.equal(JSON.parse(result.stdout).number, 12)
    for (const [extra, key, number] of [[{ next: ['4. 다음'], details: ['참고'] }, 'next', 5], [{ details: ['참고'] }, 'details', 1], [{}, 'details', 1]] as const) {
      write(t.file, { id: 'a', ...extra }); result = run(t.file, ['step-add', 'a', '✓ 정리'])
      assert.equal(result.code, 0); assert.deepEqual((item(t.file, 'a')[key] as unknown[]).at(-1), { text: `${number}. 정리`, done: false })
    }
    write(t.file, { id: 'a', status: 'done' }); const closed = readFileSync(t.file, 'utf8')
    assert.equal(run(t.file, ['step-add', 'a', '글']).code, 1); assert.equal(readFileSync(t.file, 'utf8'), closed)
  } finally { t.cleanup() }
})
test('사건 꼬리표, stages 와 progress 알림과 저장 형식을 확인한다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', details: ['1. PR', '2. 머지', '3. 확인'], stages: 'pr=1,merge=2' })
    for (const pr of ['1455', '#1455']) {
      const result = run(t.file, ['step-add', 'a', '확인', '--event', `${pr} merge`])
      assert.equal(result.code, 0); assert.match(result.stderr, /stages/)
      const line = JSON.parse(result.stdout).lines.at(-1)
      assert.deepEqual(parseEventTag(line.text), { pr: '1455', event: 'merge' })
    }
    let result = run(t.file, ['step-edit', 'a', '3', '3. 확인 (#1455 merge)'])
    assert.equal(result.code, 0); assert.match(result.stderr, /stages/)
    for (const event of ['1455 build', 'abc merge', '1455', '0 merge', '01455 merge']) {
      const before = readFileSync(t.file, 'utf8'); result = run(t.file, ['step-add', 'a', '글', '--event', event])
      assert.equal(result.code, 1); assert.equal(readFileSync(t.file, 'utf8'), before)
    }
    write(t.file, { id: 'a', progress: '2/5' }); result = run(t.file, ['step-add', 'a', '글'])
    assert.equal(result.code, 0); assert.match(result.stderr, /progress 값을 지우면 단계 수로 센다/)
    assert.doesNotMatch(result.stderr, /set a --progress auto/)
    const text = readFileSync(t.file, 'utf8'); assert.equal(text, JSON.stringify(JSON.parse(text), null, 1))
    for (const args of [['set', 'a', 'wait', '--event', '1 merge'], ['step-add', 'a', '글', '--exact'], ['step-edit', 'a', '1', '1. 글', '--if-rev', 'x']]) {
      const before = readFileSync(t.file, 'utf8'); result = run(t.file, args)
      assert.equal(result.code, 2); assert.match(result.stderr, /^사용법: board.ts/); assert.equal(readFileSync(t.file, 'utf8'), before)
    }
    assert.equal(run(t.file, ['step-add', 'missing', '글']).code, 1)
  } finally { t.cleanup() }
})
