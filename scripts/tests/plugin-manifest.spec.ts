// 내보내기 전용 원본을 제외한 스킬 디렉터리와 매니페스트를 대조하고 버전 자리를 본다.
// scripts/test-plugin-install.ts 가 설치 전에 이 파일 하나를 node --test 로 돌린다.

import assert from 'node:assert/strict'
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { tempDir } from '../../modules/testkit/temp.ts'
import { skillDirs } from '../skill_paths.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const PLUGIN = join(ROOT, '.claude-plugin/plugin.json')
const MARKETPLACE = join(ROOT, '.claude-plugin/marketplace.json')
const CODEX_PLUGIN = join(ROOT, '.codex-plugin/plugin.json')
const CHANGELOG = join(ROOT, '.claude-plugin/CHANGELOG.md')
const EXPORT_ONLY: string[] = JSON.parse(readFileSync(join(ROOT, 'scripts/export-only-skills.json'), 'utf8'))

function load(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// 내보내기 전용 원본을 제외하고 array 와 비교해 [빠진 것, 남는 것] 을 돌려준다
function skillDiff(array: string[], root: string): [string[], string[]] {
  const found = [...skillDirs(root, true).values()].map((path) => `./${relative(root, path).split('\\').join('/')}`)
  const exportNames = new Set(EXPORT_ONLY.map((path) => basename(path)))
  const expected = new Set(found.filter((path) => !EXPORT_ONLY.includes(path) && !exportNames.has(basename(path))))
  const declared = new Set(array)
  return [[...expected].filter((p) => !declared.has(p)).sort(), [...declared].filter((p) => !expected.has(p)).sort()]
}

function fakeRoot(t: { after(fn: () => void): void }, names: string[]): string {
  const root = tempDir('manifest-', t)
  for (const name of names) {
    mkdirSync(join(root, name))
    writeFileSync(join(root, name, 'SKILL.md'), '')
  }
  return root
}

describe('플러그인 매니페스트', () => {
  test('배열이 스킬 디렉터리와 같다', () => assert.deepEqual(skillDiff(load(PLUGIN).skills, ROOT), [[], []]))

  test('배열이 정렬돼 있다', () => {
    const skills: string[] = load(PLUGIN).skills
    assert.deepEqual([...skills].sort(), skills)
  })

  test('내보내기 전용 원본이 있고 등록되지 않았다', () => {
    const skills: string[] = load(PLUGIN).skills
    for (const skill of EXPORT_ONLY) {
      accessSync(join(ROOT, skill, 'SKILL.md'))
      assert.ok(!skills.includes(skill), skill)
    }
  })

  test('내보내기 전용 원본은 배열에서 빠질 수 있다', (t) => {
    const root = fakeRoot(t, ['a', 'content-preview', 'korean-check'])
    assert.deepEqual(skillDiff(['./a'], root), [[], []])
    assert.deepEqual(skillDiff([], root), [['./a'], []])
    assert.deepEqual(skillDiff(['./a', './content-preview'], root), [[], ['./content-preview']])
  })

  test('빠진 스킬과 없는 항목을 낸다', (t) => {
    const root = fakeRoot(t, ['a', 'b'])
    assert.deepEqual(skillDiff(['./a'], root), [['./b'], []])
    assert.deepEqual(skillDiff(['./a', './b', './c'], root), [[], ['./c']])
  })

  test('훅 파일이 있다', () => {
    const hooks: string[] = load(PLUGIN).hooks
    assert.ok(hooks.includes('./extensions/work-board/hooks/hooks.json'))
    for (const path of hooks) accessSync(join(ROOT, path))
  })

  test('보드가 플러그인 루트로 부르는 스크립트가 있다', () => {
    const source = readFileSync(join(ROOT, 'extensions/work-board/hooks/register.js'), 'utf8')
    const paths = [...source.matchAll(/\$\.plugin\.root \+ ['"](\/[^'"]+\.(?:ts|js))['"]/g)].map((m) => m[1])
    assert.ok(paths.length >= 5)
    for (const path of paths) accessSync(join(ROOT, path.slice(1)))
  })

  // Codex 는 .codex-plugin 이 있으면 .claude-plugin 을 읽지 않는다. hook 은 Claude 전용이라 싣지 않는다.
  // .claude-plugin 의 hook 을 Codex 가 읽으면 hook 이 바뀔 때마다 Codex worker 가 신뢰 확인 화면에서 멈춘다
  test('Codex 매니페스트는 같은 스킬을 hook 과 version 없이 싣는다', () => {
    const codex = load(CODEX_PLUGIN)
    assert.equal(codex.name, load(PLUGIN).name)
    assert.deepEqual(codex.skills, load(PLUGIN).skills)
    assert.ok(!('hooks' in codex))
    assert.ok(!('version' in codex))
  })

  test('Codex 가 기본으로 읽는 루트 hooks/hooks.json 이 없다', () => {
    assert.throws(() => accessSync(join(ROOT, 'hooks/hooks.json')))
  })

  // version 은 plugin.json 하나에 X.Y.Z 로 둔다. workflow 가 올리는 곳이 하나여야 한다(ADR-019)
  test('version 은 plugin.json 에만 있고 플러그인 CHANGELOG 의 첫 절과 같다', () => {
    const version = load(PLUGIN).version
    assert.match(version, /^\d+\.\d+\.\d+$/)
    const marketplace = load(MARKETPLACE)
    assert.ok(!('version' in marketplace))
    assert.ok(!('version' in marketplace.plugins[0]))
    const first = readFileSync(CHANGELOG, 'utf8').split('\n').find((line) => line.startsWith('## '))
    assert.ok(first?.startsWith(`## ${version} (`), first)
  })

  test('이름과 소스', () => {
    const marketplace = load(MARKETPLACE)
    assert.equal(marketplace.name, 'fos-skills')
    assert.equal(marketplace.plugins[0].name, 'fos-skills')
    assert.equal(load(PLUGIN).name, 'fos-skills')
    assert.equal(marketplace.plugins[0].source, './')
  })

  test('author 이름이 있다', () => assert.ok(load(PLUGIN).author.name))

  // 루트 bin/ 에는 orch 실행기 하나만 둔다. 공용 도구의 PATH 명령은 nhn-dev 가 소유한다. 근거는 docs/adr/004-no-plugin-bin.md
  test('루트 bin/ 에는 orch 실행기 하나만 있다', () => {
    assert.deepEqual(readdirSync(join(ROOT, 'bin')).sort(), ['orch'])
    accessSync(join(ROOT, 'bin/orch'), constants.X_OK)
  })
})
