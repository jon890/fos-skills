// plan_number 의 명령 경계 테스트. 접두사, tasks 경로, 지운 계획서, PR 브랜치 이름을 실제 git 저장소와 가짜 gh 로 센다.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, git, PLAN_NUMBER, run, tempDir, write } from './helpers.ts'

type Case = ReturnType<typeof setup>

function setup() {
  const root = tempDir('plan-number-')
  const bin = join(root, 'bin')
  const heads = join(root, 'heads')
  mkdirSync(bin)
  writeFileSync(heads, '')
  // 실제 gh 를 부르지 않게 PATH 앞에 가짜 gh 를 둔다. heads 파일이 PR 의 head 브랜치 목록이다. 파일이 없으면 gh 가 실패한다
  const fakeGh = `#!${process.execPath}\nconst fs = require('node:fs')\nif (!fs.existsSync(${JSON.stringify(heads)})) process.exit(1)\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(heads)}, 'utf8'))\n`
  write(join(bin, 'gh'), fakeGh, 0o755)
  const env = baseEnv({ PATH: `${bin}:${process.env.PATH}` })
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  git(root, 'init', '--quiet', '--bare', '-b', 'main', remote)
  git(root, 'clone', '--quiet', remote, repo)
  git(repo, 'checkout', '--quiet', '-b', 'main')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 't')
  const c = {
    root, bin, heads, repo, env,
    commit(rel: string, message: string) {
      write(join(repo, rel), '{}')
      git(repo, 'add', '-A')
      git(repo, 'commit', '--quiet', '-m', message)
    },
    remove(rel: string, message: string) {
      git(repo, 'rm', '-r', '--quiet', rel)
      git(repo, 'commit', '--quiet', '-m', message)
    },
    script(...args: string[]) {
      git(repo, 'push', '--quiet', '-u', 'origin', 'HEAD')
      const r = run(PLAN_NUMBER, { cwd: repo, env, args })
      return { code: r.code, out: r.stdout, stderr: r.stderr }
    },
  }
  c.commit('README.md', 'init')
  return c
}

const last = (out: string) => out.trimEnd().split('\n').at(-1)

test('기본 호출은 트리의 번호를 센다', () => {
  const c = setup()
  c.commit('tasks/plan1-a/index.json', 'plan1')
  c.commit('tasks/plan2-b/index.json', 'plan2')
  const { code, out } = c.script()
  assert.equal(code, 0, out)
  assert.equal(last(out), '다음 번호: 3')
})

test('첫 위치 인자로 준 tasks 경로도 받는다', () => {
  const c = setup()
  c.commit('work/plan4-a/index.json', 'plan4')
  const { code, out } = c.script('work')
  assert.deepEqual([code, last(out)], [0, '다음 번호: 5'])
})

test('지운 계획서도 git 이력에서 센다', () => {
  const c = setup()
  c.commit('tasks/plan1-a/index.json', 'plan1')
  c.commit('tasks/plan2-b/index.json', 'plan2')
  c.remove('tasks/plan2-b', 'plan2 삭제')
  const { out } = c.script()
  assert.equal(last(out), '다음 번호: 3', out)
  assert.ok(out.includes('plan2'))
  assert.ok(out.includes('git 이력에만 있다'))
})

test('계획서를 모두 지워도 번호는 이어진다', () => {
  const c = setup()
  c.commit('tasks/plan7-a/index.json', 'plan7')
  c.remove('tasks', '모두 삭제')
  const { out } = c.script()
  assert.ok(!out.includes('쓰인 번호가 없다'))
  assert.equal(last(out), '다음 번호: 8')
})

test('접두사는 자기 번호열만 센다', () => {
  const c = setup()
  c.commit('tasks/fe-plan026-a/index.json', 'fe')
  c.commit('tasks/be-plan040-b/index.json', 'be')
  c.commit('tasks/plan090-c/index.json', 'legacy')
  const { out } = c.script('--prefix', 'fe-')
  assert.equal(last(out), '다음 번호: 27', out)
  assert.ok(!out.includes('be-plan'))
})

test('접두사를 주지 않으면 접두사 있는 계획은 세지 않는다', () => {
  const c = setup()
  c.commit('tasks/fe-plan050-a/index.json', 'fe')
  c.commit('tasks/plan3-c/index.json', 'legacy')
  assert.equal(last(c.script().out), '다음 번호: 4')
})

test('앞의 0 은 10진수로 센다', () => {
  const c = setup()
  c.commit('tasks/plan010-a/index.json', 'plan010')
  assert.equal(last(c.script().out), '다음 번호: 11')
})

test('하위 디렉터리 tasks 경로와 접두사', () => {
  const c = setup()
  c.commit('backend/tasks/be-plan002-a/index.json', 'be')
  c.remove('backend/tasks/be-plan002-a', '삭제')
  c.commit('frontend/tasks/be-plan009-x/index.json', '다른 디렉터리')
  const { out } = c.script('--tasks-dir', 'backend/tasks/', '--prefix', 'be-')
  assert.equal(last(out), '다음 번호: 3', out)
})

test('머지하지 않은 원격 브랜치의 계획도 알린다', () => {
  const c = setup()
  c.commit('tasks/plan1-a/index.json', 'plan1')
  git(c.repo, 'push', '--quiet', '-u', 'origin', 'main')
  git(c.repo, 'checkout', '--quiet', '-b', 'plan2-b')
  c.commit('tasks/plan2-b/index.json', 'plan2')
  git(c.repo, 'push', '--quiet', '-u', 'origin', 'plan2-b')
  git(c.repo, 'checkout', '--quiet', 'main')
  git(c.repo, 'branch', '--quiet', '-D', 'plan2-b')
  const { out } = c.script()
  assert.ok(out.includes('밖에만 있다'), out)
  assert.equal(last(out), '다음 번호: 3')
})

test('squash 머지한 계획은 PR 브랜치 이름에서 센다', () => {
  const c = setup()
  c.commit('tasks/fe-plan020-a/index.json', 'fe')
  writeFileSync(c.heads, 'plan/fe-027-login\nfe-plan025-old\nfeature/fe-plan026-x\nplan/be-099-api\n')
  const { out } = c.script('--prefix', 'fe-')
  assert.equal(last(out), '다음 번호: 28', out)
  assert.ok(out.includes('PR 브랜치 이름에만 있다'))
  assert.ok(!out.includes('99'))
})

test('접두사 없는 PR 브랜치 형식', () => {
  const c = setup()
  writeFileSync(c.heads, 'plan/12-slug\nplan/fe-040-x\nfeat/unrelated\n')
  assert.equal(last(c.script().out), '다음 번호: 13')
})

test('gh 가 실패하면 번호 앞에 알린다', () => {
  const c = setup()
  rmSync(c.heads)
  c.commit('tasks/plan1-a/index.json', 'plan1')
  const { code, out } = c.script()
  const lines = out.trimEnd().split('\n')
  assert.deepEqual([code, lines.at(-1)], [0, '다음 번호: 2'])
  assert.ok(lines.at(-2)!.includes('PR 이력을 보지 못했다'))
})

test('잘못된 접두사는 2 로 거부한다', () => {
  const c = setup()
  assert.equal(c.script('--prefix', 'fe.*').code, 2)
})

test('--name-regex 는 area 번호 디렉터리를 센다', () => {
  const c = setup()
  c.commit('tasks/area-015-a/index.json', 'a')
  c.commit('tasks/area-017-b/phase-01.md', 'b')
  c.commit('tasks/other-040-c/index.json', 'other area')
  const { code, out } = c.script('--name-regex', 'area-(\\d{3})-')
  assert.deepEqual([code, last(out)], [0, '다음 번호: 18'], out)
  assert.ok(out.includes('area-017-b'))
  assert.ok(!out.includes('other'))
})

test('--name-regex 도 지운 계획서를 이력에서 센다', () => {
  const c = setup()
  c.commit('tasks/area-031-a/index.json', 'a')
  c.remove('tasks/area-031-a', '삭제')
  const { out } = c.script('--name-regex', 'area-(\\d{3})-')
  assert.equal(last(out), '다음 번호: 32', out)
  assert.ok(out.includes('git 이력에만 있다'))
})

test('--name-regex 는 PR 브랜치 이름도 읽는다', () => {
  const c = setup()
  c.commit('tasks/area-001-a/index.json', 'a')
  writeFileSync(c.heads, 'feat/area-020-x\nplan/area-021-y\nother-099-z\n')
  assert.equal(last(c.script('--name-regex', 'area-(\\d{3})-').out), '다음 번호: 22')
})

test('이력의 이름을 해석하지 못하면 1 을 내지 않고 실패한다', () => {
  const c = setup()
  c.commit('tasks/area-015-a/index.json', 'a')
  const { code, out } = c.script('--prefix', 'area-')
  assert.equal(code, 2)
  assert.ok(!out.includes('다음 번호'))
})

test('--name-regex 가 아무것도 맞추지 못하면 실패한다', () => {
  const c = setup()
  c.commit('tasks/area-015-a/index.json', 'a')
  assert.equal(c.script('--name-regex', 'other-(\\d{3})-').code, 2)
})

test('--allow-empty 는 1 을 낸다', () => {
  const c = setup()
  c.commit('tasks/area-015-a/index.json', 'a')
  const { code, out } = c.script('--name-regex', 'other-(\\d{3})-', '--allow-empty')
  assert.deepEqual([code, last(out)], [0, '다음 번호: 1'])
})

test('다른 접두사의 계획만 있으면 오류가 아니다', () => {
  const c = setup()
  c.commit('tasks/be-plan040-b/index.json', 'be')
  const { code, out } = c.script('--prefix', 'fe-')
  assert.deepEqual([code, last(out)], [0, '다음 번호: 1'], out)
})

test('--name-regex 에는 번호를 잡는 캡처 그룹이 하나여야 한다', () => {
  const c = setup()
  c.commit('tasks/area-015-a/index.json', 'a')
  assert.equal(c.script('--name-regex', 'area-\\d{3}-').code, 2)
  assert.equal(c.script('--name-regex', '(a)(b)').code, 2)
})

test('--name-regex 와 --prefix 는 함께 쓰지 않는다', () => {
  const c = setup()
  assert.equal(c.script('--name-regex', 'a-(\\d+)-', '--prefix', 'a-').code, 2)
})

test('이력은 git log 한 번과 ls-tree 한 번으로 읽는다', () => {
  // 원격 ref 가 많아도 ref 마다 git 을 부르지 않는다. git 호출을 세는 래퍼를 PATH 앞에 둔다.
  const c = setup()
  const realGit = run(['which', 'git'], { env: baseEnv() }).stdout.trim()
  const count = join(c.root, 'git-calls')
  const wrapper =
    `#!${process.execPath}\nconst { spawnSync } = require('node:child_process')\nrequire('node:fs').appendFileSync(${JSON.stringify(count)}, process.argv.slice(2).join(' ') + '\\n')\n` +
    `process.exitCode = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1\n`
  write(join(c.bin, 'git'), wrapper, 0o755)
  chmodSync(join(c.bin, 'git'), 0o755)
  c.commit('tasks/plan1-a/index.json', 'plan1')
  for (let i = 0; i < 5; i++) {
    git(c.repo, 'branch', `b${i}`)
    git(c.repo, 'push', '--quiet', 'origin', `b${i}`)
  }
  c.script()
  assert.ok(existsSync(count))
  const calls = readFileSync(count, 'utf8').split('\n').filter(Boolean)
  assert.equal(calls.filter((call) => ` ${call} `.includes(' log ')).length, 1, calls.join('\n'))
  assert.equal(calls.filter((call) => call.includes('ls-tree')).length, 1, calls.join('\n'))
})

test('옵션 값이 없으면 종료 코드 1 로 끝난다(셸의 ${2:?} 동작)', () => {
  const c = setup()
  for (const option of ['--tasks-dir', '--prefix', '--name-regex']) {
    const r = c.script(option)
    assert.equal(r.code, 1, option)
    assert.equal(r.out, '', option)
  }
})

test('모르는 옵션은 2 로 거부하고 -h 는 사용법을 낸다', () => {
  const c = setup()
  const unknown = c.script('--nope')
  assert.equal(unknown.code, 2)
  assert.ok(unknown.stderr.includes('모르는 옵션: --nope'), unknown.stderr)
  const help = run(PLAN_NUMBER, { cwd: c.repo, env: c.env, args: ['--help'] })
  assert.equal(help.code, 0)
  assert.ok(help.stdout.includes('plan_number'), help.stdout)
  assert.equal(run(PLAN_NUMBER, { cwd: c.repo, env: c.env, args: ['-h'] }).code, 0)
})

test('tasks 경로의 문자를 제한한다', () => {
  const c = setup()
  for (const dir of ['a b', 'tasks;rm', '']) assert.equal(c.script('--tasks-dir', dir).code, dir === '' ? 1 : 2, JSON.stringify(dir))
})

test('git 저장소 밖에서는 2 로 끝난다', () => {
  const c = setup()
  const outside = tempDir('plan-number-outside-')
  const r = run(PLAN_NUMBER, { cwd: outside, env: c.env })
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('git 저장소가 아니다'), r.stderr)
})

test('fetch 가 실패하면 2 로 끝난다', () => {
  const c = setup()
  git(c.repo, 'remote', 'set-url', 'origin', join(c.root, 'missing.git'))
  const r = run(PLAN_NUMBER, { cwd: c.repo, env: c.env })
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('git fetch 가 실패했다'), r.stderr)
})
