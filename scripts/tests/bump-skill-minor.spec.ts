// 스킬 major 올림 명령(scripts/bump-skill-minor)의 테스트. 임시 폴더의 가짜 스킬로 변경 전후를 본다.
// 명령은 자기 위치의 상위 폴더를 저장소로 쓰므로 임시 root 에 복사해 부르고 stdout 과 종료 코드를 본다.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { checkChangelog } from '../check-skill-docs.ts'
import { planBump } from '../bump-skill-minor.ts'
import { copyFromRepo } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', 'scripts/bump-skill-minor.ts']
const FILES = [
  'scripts/bump-skill-minor.ts',
  'scripts/check-skill-docs.ts',
  'scripts/is-main.ts',
  'scripts/skill_changes.ts',
  'scripts/skill_paths.ts',
  'modules/kit/args.ts',
  'modules/kit/py.ts',
]
// ──

const SKILL_MD = '---\nname: demo\nmetadata:\n  version: "0.3.1"\n---\n'
const CHANGELOG = '# CHANGELOG: demo\n\n## 0.3.1 (2026-10-25)\n\n- 새 명령을 더했다\n- 옵션을 더했다\n\n## 2.0.0 (2026-10-20)\n\n- 단계를 줄였다\n\n## 1.x\n\n- 처음 만들고 다듬었다\n'

function write(root: string, path: string, text: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function fixture(t: { after(fn: () => void): void }, changelog = CHANGELOG): string {
  const root = tempDir('bump-minor-', t)
  copyFromRepo(root, FILES)
  write(root, 'skills/demo/SKILL.md', SKILL_MD)
  write(root, 'skills/demo/CHANGELOG.md', changelog)
  return root
}

function bump(root: string, args: string[]) {
  return runCommand([...COMMAND, 'demo', '--date', '2026-11-09', ...args], { cwd: root })
}

describe('bump-skill-minor 명령', () => {
  test('기본은 미리보기라 파일을 바꾸지 않는다', (t) => {
    const root = fixture(t)
    const done = bump(root, ['--note', '옛 옵션을 지웠다'])
    assert.equal(done.code, 0, done.stderr)
    assert.match(done.stdout, /demo: 0\.3\.1 -> 0\.4\.0/)
    assert.match(done.stdout, /미리보기만 했다/)
    assert.equal(read(root, 'skills/demo/SKILL.md'), SKILL_MD)
    assert.equal(read(root, 'skills/demo/CHANGELOG.md'), CHANGELOG)
  })

  test('--apply 는 버전을 올리고 기존 절을 보존하고 새 minor 절을 추가한다', (t) => {
    const root = fixture(t)
    const done = bump(root, ['--note', '옛 옵션을 지웠다', '--apply'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(read(root, 'skills/demo/SKILL.md'), SKILL_MD.replace('0.3.1', '0.4.0'))
    const after = read(root, 'skills/demo/CHANGELOG.md')
    assert.equal(after, CHANGELOG.replace('## 0.3.1', '## 0.4.0 (2026-11-09)\n\n- 호환성: 옛 옵션을 지웠다\n\n## 0.3.1'))
    assert.deepEqual(checkChangelog('demo', after, '0.4.0'), [])
  })


  test('--note 가 없거나 스킬 이름이 없으면 막는다', (t) => {
    const root = fixture(t)
    const noNote = bump(root, ['--apply'])
    assert.equal(noNote.code, 1)
    assert.match(noNote.stderr, /--note 에서/)
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

  test('planBump 는 현재 버전 절과 metadata.version 이 다르면 멈춘다', (t) => {
    const root = fixture(t, CHANGELOG.replace('0.3.1', '0.3.0'))
    assert.throws(() => planBump(root, 'demo', { notes: ['x'] }), /첫 버전이 metadata.version 과 다르다/)
  })
})
