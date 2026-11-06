// 스킬 README·CHANGELOG·변경 이력 조각 형식 검사기(scripts/check-skill-docs)의 명령 경계 테스트.
// 명령은 자기 위치의 상위 폴더를 저장소로 쓰므로 임시 root 에 복사해 부르고 stdout 바이트와 종료 코드를 본다.

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { checkChangelog, checkReadme, MAX_BULLET_CHARS, MAX_VERSION_BULLETS } from '../check-skill-docs.ts'
import { copyFromRepo, REPO_ROOT } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', 'scripts/check-skill-docs.ts']
const FILES = ['scripts/check-skill-docs.ts', 'scripts/is-main.ts', 'scripts/skill_changes.ts', 'scripts/skill_paths.ts', 'modules/kit/args.ts', 'modules/kit/py.ts']
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

// 아래는 함수의 세부 판정이다. 명령 경계 사례와 달리 구현 파일을 import 한다

describe('checkReadme', () => {
  const readme = README('demo')
  test('맞는 README 는 통과한다', () => assert.deepEqual(checkReadme('demo', readme), []))
  test('빠진 절', () => assert.ok(checkReadme('demo', readme.replace('## 사용 예시', '## 예시')).some((p) => p.includes('`## 사용 예시`'))))
  test('절 순서', () => {
    const swapped = readme.replace('## 이럴 때 쓴다', '## TMP').replace('## 받는 것', '## 이럴 때 쓴다').replace('## TMP', '## 받는 것')
    assert.ok(checkReadme('demo', swapped).some((p) => p.includes('순서')))
  })
  test('파일 구성 절', () => assert.ok(checkReadme('demo', readme + '\n## 구성\n\n- `SKILL.md`\n').some((p) => p.includes('`## 구성`'))))
  test('첫 문단 없음', () => assert.ok(checkReadme('demo', readme.replace('반복하던 수고를 덜어 준다.\n', '')).some((p) => p.includes('첫 문단'))))
  test('제목이 다름', () => assert.ok(checkReadme('other', readme).length > 0))
})

describe('checkChangelog', () => {
  const log = CHANGELOG('demo')
  test('맞는 CHANGELOG 는 통과한다', () => assert.deepEqual(checkChangelog('demo', log, '2.1.0'), []))
  test('SKILL.md 와 버전이 다름', () => assert.ok(checkChangelog('demo', log, '2.2.0').some((p) => p.includes('SKILL.md'))))
  test('날짜 없는 절', () => assert.ok(checkChangelog('demo', log.replace('2.0.0 (2026-10-20)', '2.0.0'), '2.1.0').some((p) => p.includes('`## 2.0.0`'))))
  test('이전 major 의 버전 절', () => assert.ok(checkChangelog('demo', log.replace('## 1.x', '## 1.3.0 (2026-10-01)'), '2.1.0').some((p) => p.includes('`## 1.x`'))))
  test('현재 major 의 요약 절', () => assert.ok(checkChangelog('demo', log.replace('## 1.x', '## 2.x'), '2.1.0').some((p) => p.includes('현재 major'))))
  test('항목 수 상한', () => {
    const bullets = Array.from({ length: MAX_VERSION_BULLETS + 1 }, (_, n) => `- 항목 ${n}\n`).join('')
    assert.ok(checkChangelog('demo', log.replace('- 단계를 줄였다\n', bullets), '2.1.0').some((p) => p.includes('상한')))
  })
  test('긴 항목', () => assert.ok(checkChangelog('demo', log.replace('- 단계를 줄였다', '- ' + '가'.repeat(MAX_BULLET_CHARS + 1)), '2.1.0').some((p) => p.includes('자를 넘는'))))
  test('목록이 아닌 줄', () => assert.ok(checkChangelog('demo', log.replace('- 단계를 줄였다', '단계를 줄였다.'), '2.1.0').some((p) => p.includes('목록 항목이 아닌'))))
  test('버전 절이 없음', () => assert.deepEqual(checkChangelog('demo', '# CHANGELOG: demo\n\n소개\n', '1.0.0'), ['버전 절이 없다']))
})
