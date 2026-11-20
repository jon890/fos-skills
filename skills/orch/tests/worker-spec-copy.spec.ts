import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { copyWorkerSpec } from '../scripts/lib/worker-spec-copy.ts'
import { coordinatorCommandWarning } from '../scripts/lib/spec.ts'

test('지시서와 공통 지시서, 명시한 커밋 전 파일을 워크트리 안에서 읽는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-spec-copy-'))
  try {
    const specs = join(root, '.orch', 'specs')
    const worktree = join(root, 'worktrees', 'task')
    mkdirSync(specs, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const common = join(specs, 'spec-common.md')
    const draft = join(specs, 'draft.md')
    const spec = join(specs, 'spec-task.md')
    writeFileSync(common, '공통 규칙')
    writeFileSync(draft, '아직 커밋하지 않은 입력')
    writeFileSync(spec, `공통 지시서: ${common}\n입력: ${draft}\n`)
    const copied = copyWorkerSpec(spec, root, worktree)
    const body = readFileSync(copied, 'utf8')
    assert.ok(copied.startsWith(join(worktree, '.orch', 'worker-specs')))
    assert.equal(readFileSync(join(dirname(copied), 'spec-common.md'), 'utf8'), '공통 규칙')
    assert.doesNotMatch(body, /\.orch\/specs\//)
    assert.match(body, /공통 지시서:/)
    for (const file of body.matchAll(/\/[^\s]+\.md/g)) assert.ok(existsSync(file[0]))
    assert.equal(copyWorkerSpec(spec, root, worktree), copied)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('직접 실행처럼 읽히는 허락 줄만 경고한다', () => {
  assert.deepEqual(coordinatorCommandWarning('허락: ssh 서버 조회를 허락했다.'), { no: 1, command: 'ssh' })
  assert.deepEqual(coordinatorCommandWarning('허락: git rm 대량 삭제를 허락했다.'), { no: 1, command: '대량 삭제' })
  assert.equal(coordinatorCommandWarning('허락: ssh 명령은 ask 로 코디네이터에게 보낸다.'), null)
  assert.equal(coordinatorCommandWarning('허락: ssh 는 실행하지 않는다.'), null)
})
