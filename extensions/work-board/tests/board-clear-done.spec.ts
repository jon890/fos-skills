import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { item, run, tempBoard, write } from './board-run.ts'

const json = (stdout: string) => JSON.parse(stdout)

test('끝난 단계를 지우고 남은 단계를 1번부터 다시 매기며 stages 와 worker 줄 stages 를 새 번호로 바꾼다', () => {
  const t = tempBoard()
  try {
    write(t.file, {
      id: 'a', status: 'doing', stages: 'pr=1,merge=2,deploy=3',
      details: [
        { text: '1. [pr] PR', done: true }, { text: '2. [merge] 머지', done: true }, { text: '참고', done: true },
        { text: '3. [deploy] 배포', done: false }, { text: '4) [auto] 확인 (#12 merge)', done: false }, { text: '5. 후속 PR', done: true },
        { text: '6. 후속 머지', done: false },
      ],
      workers: [{ role: 'impl', worktree: 'wa' }, { role: 'follow', worktree: 'wb', stages: 'pr=5,merge=6' }],
    })
    const before = readFileSync(t.file, 'utf8')
    const result = run(t.file, ['clear-done', 'a'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(json(result.stdout), {
      cleared: [{ id: 'a', removed: 3, progress: [0, 3], renumbered: [
        { from: 3, to: 1, was: '3. [deploy] 배포', now: '1. [deploy] 배포' },
        { from: 4, to: 2, was: '4) [auto] 확인 (#12 merge)', now: '2) [auto] 확인 (#12 merge)' },
        { from: 6, to: 3, was: '6. 후속 머지', now: '3. 후속 머지' },
      ] }],
      skipped: [],
    })
    const after = item(t.file, 'a')
    assert.deepEqual(after.details, [
      { text: '참고', done: true }, { text: '1. [deploy] 배포', done: false }, { text: '2) [auto] 확인 (#12 merge)', done: false }, { text: '3. 후속 머지', done: false },
    ])
    assert.equal(after.stages, 'deploy=1')
    assert.deepEqual(after.workers, [{ role: 'impl', worktree: 'wa' }, { role: 'follow', worktree: 'wb', stages: 'merge=3' }])
    assert.equal(readFileSync(`${t.file}.bak`, 'utf8'), before)
  } finally { t.cleanup() }
})

test('사건 단계가 모두 끝나 지워지면 stages 칸을 지우고, merge 단계를 잃은 worker 줄은 stages 를 지운다', () => {
  const t = tempBoard()
  try {
    write(t.file, {
      id: 'a', status: 'doing', stages: 'pr=1,merge=2',
      next: [{ text: '1. [pr] PR', done: true }, { text: '2. [merge] 머지', done: true }, { text: '3. 사용자 확인', done: false }],
      workers: [{ role: 'follow', worktree: 'wb', stages: 'pr=3,merge=2' }],
    })
    assert.equal(run(t.file, ['clear-done', 'a']).code, 0)
    const after = item(t.file, 'a')
    assert.deepEqual(after.next, [{ text: '1. 사용자 확인', done: false }])
    assert.equal('stages' in after, false)
    assert.deepEqual(after.workers, [{ role: 'follow', worktree: 'wb' }])
  } finally { t.cleanup() }
})

test('명시 진행률은 끝낸 수를 지워 0/<남은 수> 가 된다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'p', status: 'doing', progress: '17/18' })
    assert.deepEqual(json(run(t.file, ['clear-done', 'p']).stdout).cleared, [{ id: 'p', removed: 17, progress: [0, 1], renumbered: [] }])
    assert.equal(item(t.file, 'p').progress, '0/1')
  } finally { t.cleanup() }
})

test('끝난 단계가 없는 항목, 모두 끝난 항목, done 항목은 건너뛰고 보드를 쓰지 않는다', () => {
  const t = tempBoard()
  try {
    write(t.file,
      { id: 'none', status: 'doing', details: [{ text: '1. [merge] 머지 (#3 merge)', done: false }] },
      { id: 'all', status: 'doing', details: [{ text: '1. a', done: true }, { text: '2. b', done: true }] },
      { id: 'closed', status: 'done', details: [{ text: '1. a', done: true }, { text: '2. b', done: false }] },
      { id: 'twice', status: 'doing', details: [{ text: '1. a', done: true }, { text: '2. b', done: false }, { text: '2. c', done: false }] },
    )
    const before = readFileSync(t.file, 'utf8')
    for (const [id, reason] of [['none', /끝난 단계가 없다/], ['all', /모든 단계가 끝난 항목/], ['closed', /done 항목/], ['twice', /같은 번호/]] as const) {
      const result = run(t.file, ['clear-done', id])
      assert.equal(result.code, 0, result.stderr)
      const body = json(result.stdout)
      assert.deepEqual(body.cleared, [])
      assert.match(body.skipped[0].reason, reason)
    }
    // 묶음은 지울 것이 없는 항목과 done 항목을 알리지 않는다
    assert.deepEqual(json(run(t.file, ['clear-done', '--all']).stdout).skipped.map((row: { id: string }) => row.id), ['all', 'twice'])
    assert.equal(readFileSync(t.file, 'utf8'), before)
    assert.equal(existsSync(`${t.file}.bak`), false)
    assert.equal(run(t.file, ['clear-done', 'missing']).code, 1)
  } finally { t.cleanup() }
})

test('묶음은 done 이 아닌 모든 항목에 한 번에 적용하고 --except 항목은 건너뛴다', () => {
  const t = tempBoard()
  try {
    const steps = () => [{ text: '1. a', done: true }, { text: '2. b', done: false }]
    write(t.file, { id: 'a', status: 'doing', details: steps() }, { id: 'b', status: 'wait', next: steps() }, { id: 'c', status: 'doing', details: steps() })
    const body = json(run(t.file, ['clear-done', '--all', '--except', 'c']).stdout)
    assert.deepEqual(body.cleared.map((row: { id: string }) => row.id), ['a', 'b'])
    assert.deepEqual(body.skipped, [{ id: 'c', reason: '열린 단계 승인이 있다' }])
    assert.deepEqual(item(t.file, 'b').next, [{ text: '1. b', done: false }])
    assert.deepEqual(item(t.file, 'c').details, steps())
  } finally { t.cleanup() }
})

test('사용법이 틀리면 2 다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'doing' })
    for (const args of [['clear-done'], ['clear-done', 'a', '--all'], ['clear-done', 'a', '--except', 'b'], ['clear-done', 'a', 'b'], ['del-done', '--all', '--except', 'a']]) assert.equal(run(t.file, args).code, 2, args.join(' '))
  } finally { t.cleanup() }
})
