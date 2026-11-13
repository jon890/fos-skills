import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempBoard, run, write, item } from './board-run.ts'
test('업무 칸 쓰기와 빈 칸 채우기는 잠금 안에서 현재 번호를 지킨다', () => {
  const b = tempBoard()
  try {
    write(b.file, { id: 'a', status: 'wait' }, { id: 'url', status: 'wait', task: 'https://x/old' })
    const ok = (args: string[]) => { const r = run(b.file, args); assert.equal(r.code, 0, r.stderr); return r }
    ok(['set', 'a', '--task-ref', 'X/1'])
    assert.equal(JSON.parse(ok(['get', 'a', 'task-ref']).stdout).value, 'X/1')
    assert.equal(item(b.file, 'a').status, 'wait')
    ok(['set', 'a', '--fill', '--task-ref', 'Y/2', '--worktree', 'other'])
    assert.equal(item(b.file, 'a')['task-ref'], 'X/1'); assert.equal(item(b.file, 'a').worktree, 'other')
    ok(['set', 'url', '--fill', '--task-ref', 'Y/2']); assert.equal(item(b.file, 'url')['task-ref'], undefined)
    assert.equal(run(b.file, ['set', 'a', '--task-ref', 'X 1']).code, 1)
    assert.equal(run(b.file, ['set', 'a', '--fill', '--task', '']).code, 2)
    assert.equal(run(b.file, ['get', 'a', 'task', '--fill']).code, 2)
    assert.equal(run(b.file, ['set', 'a', '--if-task-ref', 'Z/9', '--task', 'https://x/9']).code, 1)
    ok(['set', 'a', '--fill', '--if-task-ref', 'X/1', '--task', 'https://x/1'])
    assert.equal(item(b.file, 'a').task, 'https://x/1')
    ok(['set', 'a', '--fill', '--if-task-ref', 'X/1', '--task', 'https://x/2']); assert.equal(item(b.file, 'a').task, 'https://x/1')
    assert.equal(JSON.parse(ok(['items']).stdout)[0]['task-ref'], 'X/1')
    ok(['set', 'a', '--task-ref', '']); assert.equal(item(b.file, 'a')['task-ref'], undefined); assert.equal(item(b.file, 'a').task, 'https://x/1')
    ok(['set', 'a', '--task', '']); ok(['set', 'a', '--fill', '--task-ref', 'Y/2']); assert.equal(item(b.file, 'a')['task-ref'], 'Y/2')
  } finally { b.cleanup() }
})
