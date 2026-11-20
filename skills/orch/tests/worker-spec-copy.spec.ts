import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { copyWorkerSpec, workerSpecLine } from '../scripts/lib/worker-spec-copy.ts'
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
  assert.deepEqual(coordinatorCommandWarning('허락: ssh 조회를 허락한다. 승인을 기다리지 않고 진행한다.'), { no: 1, command: 'ssh' })
})

test('복사에 실패하면 원본 지시 줄로 계속 띄우고 경고한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-spec-fallback-'))
  try {
    const spec = join(root, 'spec.md')
    const worktree = join(root, 'worktree')
    mkdirSync(worktree)
    writeFileSync(spec, '# 일')
    writeFileSync(join(worktree, '.orch'), '폴더를 만들 수 없음')
    const line = `지시서 ${spec} 를 끝까지 읽는다.`
    const warnings: string[] = []
    assert.equal(workerSpecLine(line, spec, root, worktree, message => warnings.push(message)), line)
    assert.match(warnings[0], /지시서 복사에 실패해 원본 경로로 띄운다/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('다른 내용의 추적 파일은 원본 내용을 복사하고 handoff 출력 경로는 유지한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-spec-paths-'))
  try {
    const worktree = join(root, 'worktree')
    const specs = join(root, '.orch', 'specs')
    const handoff = join(root, '.orch', 'handoff', 'result.md')
    const input = join(root, 'input.md')
    const longer = join(root, 'input.md-extra.md')
    const spec = join(specs, 'spec-task.md')
    mkdirSync(specs, { recursive: true })
    mkdirSync(dirname(handoff), { recursive: true })
    mkdirSync(worktree)
    writeFileSync(handoff, '결과를 쓸 곳')
    writeFileSync(input, '최신 입력')
    writeFileSync(longer, '다른 입력')
    writeFileSync(join(worktree, 'input.md'), '옛 입력')
    writeFileSync(spec, `입력: ${input}\n다른 입력: ${longer}\n출력: ${handoff}\n`)
    const body = readFileSync(copyWorkerSpec(spec, root, worktree), 'utf8')
    assert.ok(body.includes(`출력: ${handoff}`), body)
    assert.ok(!body.includes(`입력: ${join(worktree, 'input.md')}\n`), body)
    const copiedInput = /입력: (\S+\.md)\n/.exec(body)?.[1]
    assert.equal(readFileSync(copiedInput!, 'utf8'), '최신 입력')
    const copiedLonger = /다른 입력: (\S+\.md)\n/.exec(body)?.[1]
    assert.equal(readFileSync(copiedLonger!, 'utf8'), '다른 입력')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
