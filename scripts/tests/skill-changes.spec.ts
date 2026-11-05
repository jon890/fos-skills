// 스킬 변경 이력 조각(scripts/skill_changes.ts)의 검사와 버전 상향을 임시 git 저장소로 본다.
// 명령으로 보는 사례는 bump-plugin-version.spec.ts, check-skill-docs.spec.ts 에 있다. 여기는 함수의 세부 판정이다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { git } from '../../modules/testkit/git.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { checkChangelog } from '../check-skill-docs.ts'
import { applyFragments, checkChanges, checkFragment, nextVersion, todaySeoul } from '../skill_changes.ts'
import { REPO_ROOT } from './boundary.ts'

const SKILL_MD = '---\nname: orch\nmetadata:\n  version: "5.15.0"\n---\n본문\n'
const CHANGELOG = '# CHANGELOG: orch\n\n## 5.15.0 (2026-11-01)\n\n- 앞 변경\n'
const BOARD_LOG = '# CHANGELOG: work-board\n\n소개 문단.\n\n## 1.4.2 (2026-11-01)\n\n- 앞 변경\n'

describe('checkFragment', () => {
  test('맞는 조각은 통과한다', () => {
    assert.deepEqual(checkFragment('fix-typo.patch.md', '- 문구를 고쳤다\n\n'), [])
    assert.deepEqual(checkFragment('add-queue.minor.md', '- 하나\n- 둘\n'), [])
  })

  for (const name of ['fix.md', 'fix.major.md', 'Fix.patch.md', 'fix_x.patch.md', '.patch.md']) {
    test(`틀린 이름 ${name}`, () => assert.ok(checkFragment(name, '- a\n').some((p) => p.includes('이름')), name))
  }

  test('목록이 아닌 줄, 빈 조각, 빈 항목, 개수, 길이, 호환성', () => {
    assert.ok(checkFragment('a.patch.md', '# 제목\n- a\n').some((p) => p.includes('항목(`- `)이 아닌')))
    assert.ok(checkFragment('a.patch.md', '\n').some((p) => p.includes('항목이 없다')))
    for (const text of ['- 정상\n- \n', '- 정상\n-   \n- 둘\n']) {
      assert.ok(checkFragment('a.patch.md', text).some((p) => p.includes('내용이 빈 항목')), JSON.stringify(text))
    }
    assert.ok(checkFragment('a.patch.md', Array.from({ length: 6 }, (_, n) => `- 항목 ${n}\n`).join('')).some((p) => p.includes('6개')))
    assert.ok(checkFragment('a.patch.md', `- ${'가'.repeat(161)}\n`).some((p) => p.includes('160자')))
    assert.deepEqual(checkFragment('a.patch.md', `- ${'가'.repeat(160)}\n`), [])
    assert.ok(checkFragment('a.minor.md', '- 호환성: 옵션을 지웠다\n').some((p) => p.includes('호환성')))
  })

  test('길이는 코드 포인트로 센다', () => {
    assert.deepEqual(checkFragment('a.patch.md', `- ${'😀'.repeat(160)}\n`), [])
  })

  test('저장소에 틀린 조각이 없다', () => assert.deepEqual(checkChanges(REPO_ROOT), []))

  test('nextVersion', () => {
    assert.equal(nextVersion('5.15.9', 'patch'), '5.15.10')
    assert.equal(nextVersion('5.15.9', 'minor'), '5.16.0')
  })

  test('todaySeoul 은 날짜다', () => assert.match(todaySeoul(), /^\d{4}-\d{2}-\d{2}$/))
})

let root = ''

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

function commit(subject: string): void {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', subject])
}

function apply() {
  return applyFragments(root, '2026-11-04')
}

describe('임시 저장소의 조각', () => {
  beforeEach(() => {
    root = tempDir('skill-changes-')
    git(root, ['init', '-q', '-b', 'main'])
    write('skills/orch/SKILL.md', SKILL_MD)
    write('skills/orch/CHANGELOG.md', CHANGELOG)
    write('skills/plan/SKILL.md', SKILL_MD.replace('orch', 'plan').replace('5.15.0', '2.0.0'))
    write('skills/plan/CHANGELOG.md', CHANGELOG.replace('orch', 'plan').replace('5.15.0', '2.0.0'))
    write('extensions/work-board/CHANGELOG.md', BOARD_LOG)
    commit('init')
  })

  test('틀린 조각마다 경로와 이유를 낸다', () => {
    write('skills/orch/changes/fix.md', '- a\n')
    write('skills/plan/changes/x.minor.md', '문단\n')
    write('extensions/work-board/changes/y.patch.md', '- 호환성: 지웠다\n')
    const problems = checkChanges(root)
    assert.equal(problems.length, 3, problems.join('\n'))
    assert.ok(problems.some((p) => p.startsWith('extensions/work-board/changes/y.patch.md: ')))
    assert.ok(problems.some((p) => p.startsWith('skills/orch/changes/fix.md: 이름')))
    assert.equal(problems.filter((p) => p.startsWith('skills/plan/changes/x.minor.md: ')).length, 1)
  })

  test('changes 아래 폴더는 파일이 아니라고 낸다', () => {
    mkdirSync(join(root, 'skills/orch/changes/sub'), { recursive: true })
    assert.deepEqual(checkChanges(root), ['skills/orch/changes/sub: 파일이 아니다'])
  })

  test('두 브랜치가 조각을 더해도 충돌 없이 머지된다', () => {
    for (const branch of ['a', 'b']) {
      git(root, ['checkout', '-q', '-b', branch, 'main'])
      write(`skills/orch/changes/${branch}-work.minor.md`, `- ${branch} 변경\n`)
      commit(`feat: ${branch}`)
    }
    git(root, ['checkout', '-q', 'main'])
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge a', 'a'])
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge b', 'b'])
    assert.deepEqual(readdirSync(join(root, 'skills/orch/changes')).sort(), ['a-work.minor.md', 'b-work.minor.md'])
  })

  test('minor 조각은 버전을 올리고 절을 쓰고 조각 폴더를 지운다', () => {
    write('skills/orch/changes/add-queue.minor.md', '- 큐를 더했다\n- 설정을 더했다\n')
    commit('feat(orch): 큐')
    assert.deepEqual(apply(), { applied: [['orch', '5.16.0']], warnings: [] })
    assert.equal(read('skills/orch/SKILL.md'), SKILL_MD.replace('5.15.0', '5.16.0'))
    assert.equal(read('skills/orch/CHANGELOG.md'), '# CHANGELOG: orch\n\n## 5.16.0 (2026-11-04)\n\n- 큐를 더했다\n- 설정을 더했다\n\n## 5.15.0 (2026-11-01)\n\n- 앞 변경\n')
    assert.ok(!existsSync(join(root, 'skills/orch/changes')))
  })

  test('patch 조각은 patch 를 올린다', () => {
    write('skills/orch/changes/fix-typo.patch.md', '- 문구를 고쳤다\n')
    commit('fix')
    assert.deepEqual(apply().applied, [['orch', '5.15.1']])
  })

  test('조각은 이름순이 아니라 머지 순서로 적용한다', () => {
    write('skills/orch/changes/zzz-first.minor.md', '- 먼저\n')
    commit('first')
    write('skills/orch/changes/aaa-second.patch.md', '- 나중\n')
    commit('second')
    assert.deepEqual(apply().applied, [['orch', '5.16.0'], ['orch', '5.16.1']])
    assert.ok(read('skills/orch/CHANGELOG.md').includes('## 5.16.1 (2026-11-04)\n\n- 나중\n\n## 5.16.0 (2026-11-04)\n\n- 먼저\n\n## 5.15.0'))
  })

  test('단위마다 따로 올린다', () => {
    write('skills/orch/changes/a.minor.md', '- orch\n')
    write('skills/plan/changes/b.patch.md', '- plan\n')
    write('extensions/work-board/changes/c.minor.md', '- board\n')
    commit('many')
    assert.deepEqual(apply().applied, [['orch', '5.16.0'], ['plan', '2.0.1'], ['work-board', '1.5.0']])
  })

  test('SKILL.md 가 없는 확장은 CHANGELOG 만 바꾼다', () => {
    write('extensions/work-board/changes/c.minor.md', '- board\n')
    commit('board')
    apply()
    assert.ok(read('extensions/work-board/CHANGELOG.md').includes('소개 문단.\n\n## 1.5.0 (2026-11-04)\n\n- board\n\n## 1.4.2'))
    assert.ok(!existsSync(join(root, 'extensions/work-board/SKILL.md')))
  })

  test('틀린 조각은 경고하고 남긴다', () => {
    write('skills/orch/changes/bad.minor.md', '# 제목\n')
    write('skills/plan/changes/ok.minor.md', '- 정상\n')
    commit('mixed')
    const { applied, warnings } = apply()
    assert.deepEqual(applied, [['plan', '2.1.0']])
    assert.deepEqual(warnings, ['skills/orch/changes/bad.minor.md: 목록 항목(`- `)이 아닌 줄이 있다. 건너뛴다'])
    assert.ok(existsSync(join(root, 'skills/orch/changes/bad.minor.md')))
    assert.equal(read('skills/orch/SKILL.md'), SKILL_MD)
  })

  test('끝이 빈 항목인 조각은 건너뛰고 결과 CHANGELOG 는 형식 검사를 통과한다', () => {
    write('skills/orch/changes/empty.patch.md', '- valid change\n- \n')
    write('skills/plan/changes/ok.patch.md', '- 정상\n')
    commit('blank bullet')
    const { applied, warnings } = apply()
    assert.deepEqual(applied, [['plan', '2.0.1']])
    assert.equal(warnings.length, 1)
    assert.equal(read('skills/orch/CHANGELOG.md'), CHANGELOG)
    assert.deepEqual(checkChangelog('plan', read('skills/plan/CHANGELOG.md'), '2.0.1'), [])
  })

  test('조각이 없으면 아무것도 바꾸지 않고 두 번 불러도 같다', () => {
    assert.deepEqual(apply(), { applied: [], warnings: [] })
    write('skills/orch/changes/a.minor.md', '- 하나\n')
    commit('a')
    apply()
    const after = read('skills/orch/CHANGELOG.md')
    assert.deepEqual(apply(), { applied: [], warnings: [] })
    assert.equal(read('skills/orch/CHANGELOG.md'), after)
  })

  test('첫 버전 절을 읽지 못하는 단위는 건너뛴다', () => {
    write('skills/orch/CHANGELOG.md', '# CHANGELOG: orch\n')
    write('skills/orch/changes/a.minor.md', '- 하나\n')
    commit('broken')
    assert.deepEqual(apply(), { applied: [], warnings: ['skills/orch/CHANGELOG.md: 첫 버전 절을 읽을 수 없어 조각을 건너뛴다'] })
  })

  test('SKILL.md 에 version 줄이 없으면 단위를 건너뛰고 조각을 남긴다', () => {
    write('skills/orch/SKILL.md', '---\nname: orch\n---\n')
    write('skills/orch/changes/a.minor.md', '- 하나\n')
    commit('no version line')
    assert.deepEqual(apply(), { applied: [], warnings: ['skills/orch/SKILL.md: metadata.version 줄을 찾지 못해 조각을 건너뛴다'] })
    assert.ok(existsSync(join(root, 'skills/orch/changes/a.minor.md')))
    assert.equal(read('skills/orch/CHANGELOG.md'), CHANGELOG)
  })

  test('머지 커밋은 이름이 반대로 정렬돼도 main 의 순서를 따른다', () => {
    git(root, ['checkout', '-q', '-b', 'first', 'main'])
    write('skills/orch/changes/zzz.minor.md', '- 먼저 머지\n')
    commit('feat: first')
    git(root, ['checkout', '-q', '-b', 'second', 'main'])
    write('skills/orch/changes/aaa.patch.md', '- 나중 머지\n')
    commit('feat: second')
    git(root, ['checkout', '-q', 'main'])
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge first', 'first'])
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge second', 'second'])
    assert.deepEqual(apply().applied, [['orch', '5.16.0'], ['orch', '5.16.1']])
  })

  test('squash 머지도 main 의 순서를 따른다', () => {
    for (const [branch, name] of [['first', 'zzz.minor.md'], ['second', 'aaa.patch.md']]) {
      git(root, ['checkout', '-q', '-b', branch, 'main'])
      write(`skills/orch/changes/${name}`, `- ${branch}\n`)
      commit(`feat: ${branch}`)
      git(root, ['checkout', '-q', 'main'])
      git(root, ['merge', '-q', '--squash', branch])
      commit(`${branch} (#1)`)
    }
    assert.deepEqual(apply().applied, [['orch', '5.16.0'], ['orch', '5.16.1']])
  })

  test('폴더를 옮긴 조각은 순서를 모르니 이름순이다', () => {
    write('skills/orch/changes/zzz.minor.md', '- 먼저\n')
    commit('first')
    write('skills/orch/changes/aaa.patch.md', '- 나중\n')
    commit('second')
    git(root, ['mv', 'skills/orch', 'skills/orch2'])
    commit('move')
    assert.deepEqual(apply().applied, [['orch2', '5.15.1'], ['orch2', '5.16.0']])
  })

  test('다시 쓴 슬러그는 마지막으로 더한 자리를 쓴다', () => {
    write('skills/orch/changes/fix-docs.patch.md', '- 옛 조각\n')
    commit('old fix-docs')
    git(root, ['rm', '-q', 'skills/orch/changes/fix-docs.patch.md'])
    commit('bot: processed')
    write('skills/orch/changes/zzz.minor.md', '- 먼저 머지\n')
    commit('zzz')
    write('skills/orch/changes/fix-docs.patch.md', '- 다시 쓴 조각\n')
    commit('fix-docs again')
    assert.deepEqual(apply().applied, [['orch', '5.16.0'], ['orch', '5.16.1']])
    assert.ok(read('skills/orch/CHANGELOG.md').includes('## 5.16.1 (2026-11-04)\n\n- 다시 쓴 조각'))
  })

  test('직접 올린 버전 위에 조각을 올린다', () => {
    write('skills/orch/CHANGELOG.md', '# CHANGELOG: orch\n\n## 5.16.0 (2026-11-02)\n\n- 직접 올림\n\n## 5.15.0 (2026-11-01)\n\n- 앞 변경\n')
    write('skills/orch/SKILL.md', SKILL_MD.replace('5.15.0', '5.16.0'))
    write('skills/orch/changes/a.minor.md', '- 조각\n')
    commit('mix across PRs')
    assert.deepEqual(apply().applied, [['orch', '5.17.0']])
  })

  test('version 줄 뒤 빈 줄은 옛 정규식처럼 마지막 줄바꿈 앞까지 먹는다(Python 3.12 실측)', () => {
    write('skills/orch/SKILL.md', '---\nmetadata:\n  version: "5.15.0"\n\n\nname: orch\n---\n')
    write('skills/orch/changes/a.patch.md', '- 하나\n')
    commit('blank lines')
    apply()
    assert.equal(read('skills/orch/SKILL.md'), '---\nmetadata:\n  version: "5.15.1"\nname: orch\n---\n')
  })
})
