// 스킬 README·CHANGELOG·변경 이력 조각 형식 검사기(scripts/check-skill-docs)의 명령 경계 테스트.
// 명령은 자기 위치의 상위 폴더를 저장소로 쓰므로 임시 root 에 복사해 부르고 stdout 바이트와 종료 코드를 본다.

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { copyFromRepo, REPO_ROOT } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', 'scripts/check-skill-docs.py']
const FILES = ['scripts/check-skill-docs.py', 'scripts/skill_changes.py', 'scripts/skill_paths.py']
// ──

const README = (name: string) =>
  `# ${name}\n\n반복하던 수고를 덜어 준다.\n\n## 이럴 때 쓴다\n\n- 상황\n\n## 사용 예시\n\n\`\`\`text\n## 코드 블록 안의 제목은 절이 아니다\n\`\`\`\n\n## 받는 것\n\n- 결과\n\n## 함께 쓰는 스킬\n\n- 다른 스킬\n`
const CHANGELOG = (name: string) =>
  `# CHANGELOG: ${name}\n\n## 2.1.0 (2026-10-25)\n\n- 새 명령을 더했다\n- 호환성: 옛 옵션을 지웠다\n\n## 2.0.0 (2026-10-20)\n\n- 단계를 줄였다\n\n## 1.x\n\n- 처음 만들고 다듬었다\n`
const SKILL_MD = '---\nname: x\nmetadata:\n  version: "2.1.0"\n---\n'

function write(root: string, path: string, text: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

// skills/ 아래 demo 와 옛 배치(저장소 루트)의 legacy, 두 스킬을 둔다
function fixture(t: { after(fn: () => void): void }): string {
  const root = tempDir('skill-docs-', t)
  copyFromRepo(root, FILES)
  for (const [dir, name] of [
    ['skills/demo', 'demo'],
    ['legacy', 'legacy'],
  ]) {
    write(root, `${dir}/SKILL.md`, SKILL_MD)
    write(root, `${dir}/README.md`, README(name))
    write(root, `${dir}/CHANGELOG.md`, CHANGELOG(name))
  }
  return root
}

function check(root: string, args: string[] = []) {
  return runCommand([...COMMAND, ...args], { cwd: root })
}

describe('check-skill-docs 명령', () => {
  test('이 저장소의 스킬과 조각은 형식을 지킨다', () => {
    const done = runCommand(COMMAND, { cwd: REPO_ROOT })
    assert.equal(done.stdout, '')
    assert.equal(done.code, 0, done.stderr)
  })

  test('형식을 지키면 출력 없이 0 이다', (t) => {
    const done = check(fixture(t))
    assert.equal(done.stdout, '')
    assert.equal(done.code, 0, done.stderr)
  })

  test('위반은 스킬 이름과 파일, 조각은 저장소 상대 경로로 한 줄씩 내고 1 이다', (t) => {
    const root = fixture(t)
    write(root, 'skills/demo/README.md', README('demo').replace('## 사용 예시', '## 예시') + '\n## 구성\n')
    write(root, 'legacy/CHANGELOG.md', CHANGELOG('legacy').replace('## 1.x', '## 1.3.0 (2026-10-01)').replace('- 단계를 줄였다', '단계를 줄였다.\n- ' + '가'.repeat(161)))
    write(root, 'legacy/SKILL.md', SKILL_MD.replace('2.1.0', '2.2.0'))
    write(root, 'skills/demo/changes/bad.md', '# 제목\n')
    const done = check(root)
    assert.equal(done.code, 1, done.stderr)
    assert.equal(
      done.stdout,
      [
        'demo/README.md: `## 구성` 절을 두지 않는다. 파일 구성은 SKILL.md 와 docstring 이 소유한다',
        'demo/README.md: 빠진 절: `## 사용 예시`',
        'legacy/CHANGELOG.md: 첫 절의 버전이 SKILL.md 의 2.2.0 과 다르다',
        'legacy/CHANGELOG.md: `## 2.0.0 (2026-10-20)`: 목록 항목이 아닌 줄이 있다',
        `legacy/CHANGELOG.md: \`## 2.0.0 (2026-10-20)\`: 160자를 넘는 항목이 있다: - ${'가'.repeat(38)}…`,
        'legacy/CHANGELOG.md: `## 1.3.0 (2026-10-01)`: 이전 major 는 `## 1.x` 한 절로 줄인다',
        'skills/demo/changes/bad.md: 이름이 `<슬러그>.patch.md` 나 `<슬러그>.minor.md` 꼴이 아니다(슬러그는 영문 소문자, 숫자, 하이픈)',
        'skills/demo/changes/bad.md: 목록 항목(`- `)이 아닌 줄이 있다',
        '',
      ].join('\n'),
    )
  })

  test('스킬 이름을 주면 그 스킬과 그 스킬의 조각만 본다', (t) => {
    const root = fixture(t)
    write(root, 'skills/demo/changes/bad.md', '- 하나\n')
    write(root, 'legacy/README.md', README('other'))
    const legacy = check(root, ['legacy'])
    assert.equal(legacy.code, 1)
    assert.equal(legacy.stdout, 'legacy/README.md: 첫 줄이 `# legacy` 이 아니다\n')
    const demo = check(root, ['demo'])
    assert.equal(demo.code, 1)
    assert.equal(demo.stdout, 'skills/demo/changes/bad.md: 이름이 `<슬러그>.patch.md` 나 `<슬러그>.minor.md` 꼴이 아니다(슬러그는 영문 소문자, 숫자, 하이픈)\n')
  })

  test('스킬 폴더 밖 단위(extensions)의 조각도 인자 없이 본다', (t) => {
    const root = fixture(t)
    write(root, 'extensions/board/CHANGELOG.md', '# CHANGELOG: board\n\n## 1.0.0 (2026-11-01)\n\n- 처음\n')
    write(root, 'extensions/board/changes/x.minor.md', '- 호환성: 지웠다\n')
    const done = check(root)
    assert.equal(done.code, 1)
    assert.equal(done.stdout, 'extensions/board/changes/x.minor.md: `호환성:` 항목은 조각으로 받지 않는다. major 는 PR 이 버전과 CHANGELOG 를 직접 올린다\n')
  })

  test('README 가 없거나 없는 스킬 이름이면 1 이다', (t) => {
    const root = fixture(t)
    assert.equal(check(root, ['missing']).code, 1)
    rmSync(join(root, 'skills/demo/README.md'))
    assert.equal(check(root).code, 1)
  })
})
