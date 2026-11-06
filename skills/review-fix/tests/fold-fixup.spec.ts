// review-fix 의 fold_fixup 명령 경계 테스트. git 상태를 바꾸는 명령이라 임시 저장소에서만 돈다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { git, gitEnv, run, tempDir } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['bash', join(import.meta.dirname, '..', 'scripts', 'fold_fixup.sh')]
// ──

function repo(t: Parameters<typeof tempDir>[1]) {
  const dir = tempDir('fold-fixup-', t)
  const g = (...args: string[]) => git(dir, args)
  g('init', '-q', '-b', 'main')
  const commit = (name: string) => {
    writeFileSync(join(dir, `${name}.txt`), name)
    g('add', '.')
    g('commit', '-q', '-m', `add ${name}`)
  }
  for (const name of ['a', 'b', 'c']) commit(name)
  const fold = (...args: string[]) => run([...COMMAND, ...args], { cwd: dir, env: gitEnv() })
  const subjects = () => g('log', '--format=%s').split('\n')
  const stage = (name: string, text: string) => {
    writeFileSync(join(dir, `${name}.txt`), text)
    g('add', `${name}.txt`)
  }
  return { dir, g, commit, fold, subjects, stage }
}

describe('fold_fixup', () => {
  test('앞 커밋에 접고 이력은 선형으로 남는다', (t) => {
    const r = repo(t)
    r.stage('b', 'fixed')
    const done = r.fold(r.g('rev-parse', 'HEAD~1'))
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(r.subjects(), ['add c', 'add b', 'add a'])
    assert.equal(r.g('show', 'HEAD~1:b.txt'), 'fixed')
    assert.equal(r.g('show', 'HEAD:c.txt'), 'c')
  })

  test('성공하면 받은 인자 그대로 한 줄을 낸다', (t) => {
    const r = repo(t)
    r.stage('b', 'fixed')
    const done = r.fold('HEAD~1')
    assert.deepEqual([done.code, done.stdout], [0, '접었다: HEAD~1 의 새 해시는 git log 로 다시 읽는다\n'])
  })

  test('HEAD 가 원인이면 amend 와 같다', (t) => {
    const r = repo(t)
    r.stage('c', 'fixed')
    const done = r.fold(r.g('rev-parse', 'HEAD'))
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(r.subjects(), ['add c', 'add b', 'add a'])
    assert.equal(r.g('show', 'HEAD:c.txt'), 'fixed')
    assert.match(done.stdout, /^\[main [0-9a-f]+\] add c/)
  })

  test('루트 커밋도 원인이 될 수 있다', (t) => {
    const r = repo(t)
    r.stage('a', 'fixed')
    const done = r.fold(r.g('rev-list', '--max-parents=0', 'HEAD'))
    assert.equal(done.code, 0, done.stderr)
    assert.equal(r.g('show', 'HEAD~2:a.txt'), 'fixed')
    assert.deepEqual(r.subjects(), ['add c', 'add b', 'add a'])
  })

  test('스테이징하지 않은 변경은 건드리지 않고 되살린다', (t) => {
    const r = repo(t)
    r.stage('b', 'fixed')
    writeFileSync(join(r.dir, 'c.txt'), 'dirty')
    const done = r.fold(r.g('rev-parse', 'HEAD~1'))
    assert.equal(done.code, 0, done.stderr)
    assert.equal(readFileSync(join(r.dir, 'c.txt'), 'utf8'), 'dirty')
    assert.equal(r.g('status', '--porcelain'), 'M c.txt')
  })

  test('스테이징한 변경이 없으면 2', (t) => {
    const r = repo(t)
    const done = r.fold(r.g('rev-parse', 'HEAD~1'))
    assert.deepEqual([done.code, done.stdout], [2, ''])
    assert.match(done.stderr, /스테이징된 변경이 없다/)
    assert.equal(r.subjects().length, 3)
  })

  test('모르는 커밋이면 2', (t) => {
    const r = repo(t)
    r.stage('b', 'fixed')
    const done = r.fold('nope')
    assert.equal(done.code, 2)
    assert.match(done.stderr, /커밋을 찾을 수 없다: nope/)
  })

  test('원인이 HEAD 의 조상이 아니면 2', (t) => {
    const r = repo(t)
    r.g('checkout', '-q', '-b', 'side')
    r.commit('s')
    const side = r.g('rev-parse', 'HEAD')
    r.g('checkout', '-q', 'main')
    r.stage('a', 'fixed')
    const done = r.fold(side)
    assert.equal(done.code, 2)
    assert.match(done.stderr, /원인 커밋이 HEAD 의 조상이 아니다/)
  })

  test('범위에 머지 커밋이 있으면 2 로 거부하고 이력을 건드리지 않는다', (t) => {
    const r = repo(t)
    const base = r.g('rev-parse', 'HEAD')
    r.g('checkout', '-q', '-b', 'side')
    r.commit('s')
    r.g('checkout', '-q', 'main')
    r.g('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const before = r.g('rev-parse', 'HEAD')
    r.stage('a', 'fixed')
    const done = r.fold(base)
    assert.equal(done.code, 2, done.stderr)
    assert.match(done.stderr, /머지 커밋이 있어 접을 수 없다/)
    assert.equal(r.g('rev-parse', 'HEAD'), before)
  })

  test('충돌하면 rebase 를 중단하고 fixup 커밋을 HEAD 에 남긴 채 1', (t) => {
    const r = repo(t)
    writeFileSync(join(r.dir, 'b.txt'), 'c-edit')
    r.g('add', 'b.txt')
    r.g('commit', '-q', '-m', 'edit b again')
    r.stage('b', 'conflicting')
    const done = r.fold(r.g('rev-parse', 'HEAD~3'))
    assert.equal(done.code, 1, done.stderr)
    assert.match(done.stderr, /rebase 가 충돌해 중단했다/)
    assert.ok(!r.g('status', '--short', '--branch').toLowerCase().includes('rebase'))
    assert.ok(r.subjects()[0].startsWith('fixup!'))
  })

  test('인자 수가 틀리면 2 와 사용법', (t) => {
    const r = repo(t)
    for (const args of [[], ['a', 'b']]) {
      const done = r.fold(...args)
      assert.deepEqual([done.code, done.stdout], [2, ''])
      assert.match(done.stderr, /fold_fixup\.sh <원인커밋>/)
    }
  })
})
