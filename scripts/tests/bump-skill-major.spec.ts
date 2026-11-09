// 스킬 major 올림 명령(scripts/bump-skill-major)의 테스트. 임시 폴더의 가짜 스킬로 접기 전후를 본다.
// 명령은 자기 위치의 상위 폴더를 저장소로 쓰므로 임시 root 에 복사해 부르고 stdout 과 종료 코드를 본다.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { checkChangelog } from '../check-skill-docs.ts'
import { planBump } from '../bump-skill-major.ts'
import { copyFromRepo } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', 'scripts/bump-skill-major.ts']
const FILES = [
  'scripts/bump-skill-major.ts',
  'scripts/check-skill-docs.ts',
  'scripts/is-main.ts',
  'scripts/skill_changes.ts',
  'scripts/skill_paths.ts',
  'modules/kit/args.ts',
  'modules/kit/py.ts',
]
// ──

const SKILL_MD = '---\nname: demo\nmetadata:\n  version: "2.1.0"\n---\n'
const CHANGELOG = '# CHANGELOG: demo\n\n## 2.1.0 (2026-10-25)\n\n- 새 명령을 더했다\n- 옵션을 더했다\n\n## 2.0.0 (2026-10-20)\n\n- 단계를 줄였다\n\n## 1.x\n\n- 처음 만들고 다듬었다\n'

function write(root: string, path: string, text: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function fixture(t: { after(fn: () => void): void }, changelog = CHANGELOG): string {
  const root = tempDir('bump-major-', t)
  copyFromRepo(root, FILES)
  write(root, 'skills/demo/SKILL.md', SKILL_MD)
  write(root, 'skills/demo/CHANGELOG.md', changelog)
  return root
}

function bump(root: string, args: string[]) {
  return runCommand([...COMMAND, 'demo', '--date', '2026-11-09', ...args], { cwd: root })
}

describe('bump-skill-major 명령', () => {
  test('기본은 미리보기라 파일을 바꾸지 않는다', (t) => {
    const root = fixture(t)
    const done = bump(root, ['--note', '옛 옵션을 지웠다'])
    assert.equal(done.code, 0, done.stderr)
    assert.match(done.stdout, /demo: 2\.1\.0 -> 3\.0\.0/)
    assert.match(done.stdout, /미리보기만 했다/)
    assert.equal(read(root, 'skills/demo/SKILL.md'), SKILL_MD)
    assert.equal(read(root, 'skills/demo/CHANGELOG.md'), CHANGELOG)
  })

  test('--apply 는 버전을 올리고 현재 major 절을 한 절로 접고 새 절 머리를 만든다', (t) => {
    const root = fixture(t)
    const done = bump(root, ['--note', '옛 옵션을 지웠다', '--apply'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(read(root, 'skills/demo/SKILL.md'), SKILL_MD.replace('2.1.0', '3.0.0'))
    const after = read(root, 'skills/demo/CHANGELOG.md')
    assert.equal(
      after,
      '# CHANGELOG: demo\n\n## 3.0.0 (2026-11-09)\n\n- 호환성: 옛 옵션을 지웠다\n\n## 2.x\n\n- 새 명령을 더했다\n- 옵션을 더했다\n- 단계를 줄였다\n\n## 1.x\n\n- 처음 만들고 다듬었다\n',
    )
    assert.deepEqual(checkChangelog('demo', after, '3.0.0'), [])
  })

  test('접을 항목이 한도를 넘으면 쓰지 않고 1 이며 --summary 로 요약하면 통과한다', (t) => {
    const many = Array.from({ length: 12 }, (_, i) => `## 2.${i}.0 (2026-10-${String(10 + i)})\n\n- 변경 ${i}\n`).reverse().join('\n')
    const root = fixture(t, `# CHANGELOG: demo\n\n${many}\n## 1.x\n\n- 처음\n`)
    write(root, 'skills/demo/SKILL.md', SKILL_MD.replace('2.1.0', '2.11.0'))
    const before = read(root, 'skills/demo/CHANGELOG.md')
    const refused = bump(root, ['--note', '지웠다', '--apply'])
    assert.equal(refused.code, 1, refused.stdout)
    assert.match(refused.stderr, /직접 요약해 --summary 로 준다/)
    assert.equal(read(root, 'skills/demo/CHANGELOG.md'), before)
    assert.equal(read(root, 'skills/demo/SKILL.md').includes('"2.11.0"'), true)

    const done = bump(root, ['--note', '지웠다', '--summary', '명령을 열두 번 고쳤다', '--apply'])
    assert.equal(done.code, 0, done.stderr)
    assert.match(read(root, 'skills/demo/CHANGELOG.md'), /## 2\.x\n\n- 명령을 열두 번 고쳤다\n\n## 1\.x/)
  })

  test('--note 가 없거나 스킬 이름이 없으면 막는다', (t) => {
    const root = fixture(t)
    const noNote = bump(root, ['--apply'])
    assert.equal(noNote.code, 1)
    assert.match(noNote.stderr, /--note 가 필요하다/)
    assert.equal(read(root, 'skills/demo/SKILL.md'), SKILL_MD)
    assert.equal(runCommand(COMMAND, { cwd: root }).code, 2)
    assert.equal(bump(root, ['--bogus']).code, 2)
    assert.equal(runCommand([...COMMAND, 'demo', '--date', '내일', '--note', 'x'], { cwd: root }).code, 2)
  })

  test('남은 changes 조각은 경고만 한다', (t) => {
    const root = fixture(t)
    write(root, 'skills/demo/changes/later.patch.md', '- 나중 변경\n')
    const done = bump(root, ['--note', '지웠다'])
    assert.equal(done.code, 0, done.stderr)
    assert.match(done.stdout, /경고: changes\/later\.patch\.md 조각이 남아 있다/)
  })

  test('planBump 는 이미 N.x 절이 있거나 접을 절이 없으면 던진다', (t) => {
    const root = fixture(t, '# CHANGELOG: demo\n\n## 2.1.0 (2026-10-25)\n\n- 가\n\n## 2.x\n\n- 나\n')
    assert.throws(() => planBump(root, 'demo', { notes: ['x'] }), /2\.x` 절이 이미 있다/)
    write(root, 'skills/demo/CHANGELOG.md', '# CHANGELOG: demo\n\n## 1.x\n\n- 가\n')
    assert.throws(() => planBump(root, 'demo', { notes: ['x'] }), /접을 2\.Y\.Z 절이 없다/)
  })
})
