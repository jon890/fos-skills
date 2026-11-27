// 루프의 보드 동기화가 worker_done 에서 끝낸 단계 번호와 PR 없는 일인지를 모으는지 본다(loop/steps/board.ts 의 workerSteps).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { workerSteps } from '../scripts/loop/steps/board.ts'
import { recordHistory } from '../scripts/lib/launch-history.ts'

test('worker_done 의 steps= 와 PR 없는 지시서를 dispatch 별로 모은다', (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'loop-worker-steps-')))
  const saved = process.env.ORCH_DIR
  process.env.ORCH_DIR = join(repo, '.orch')
  mkdirSync(join(repo, '.orch'), { recursive: true })
  t.after(() => {
    if (saved === undefined) delete process.env.ORCH_DIR; else process.env.ORCH_DIR = saved
    rmSync(repo, { recursive: true, force: true })
  })
  const noPr = join(repo, 'no-pr.md')
  const withPr = join(repo, 'with-pr.md')
  writeFileSync(noPr, '# 조사\n허락: 커밋·PR 없음\n## 할 일\n1. 조사한다\n')
  writeFileSync(withPr, '# 구현\n허락: push 와 PR 생성\n## 할 일\n1. 구현한다\n2. **문서**를 고친다\n')
  recordHistory(repo, { at: '2026-01-01', dispatch: 'a', worktree: join(repo, 'a'), spec: noPr } as never)
  recordHistory(repo, { at: '2026-01-01', dispatch: 'b', worktree: join(repo, 'b'), spec: withPr } as never)
  recordHistory(repo, { at: '2026-01-01', dispatch: 'c', worktree: join(repo, 'c'), spec: join(repo, 'gone.md') } as never)
  const done = (dispatch: string, body = '') => ({ type: 'worker_done', body, payload: { dispatchId: dispatch, outcome: 'succeeded' } })
  assert.deepEqual(workerSteps(repo, [done('a'), done('b', '끝냈다. steps=1,2'), done('b2'), done('c')]), {
    a: { steps: null, noPr: true },
    b: { steps: [1, 2], noPr: false, texts: ['구현한다', '문서를 고친다'] },
  })
})
