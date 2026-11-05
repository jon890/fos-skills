import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { fakeBin } from '../../../skills/orch/tests/fixtures/fake-bin.ts'

const bridge = fileURLToPath(new URL('../bin/github.ts', import.meta.url))
const ghModule = resolve(dirname(bridge), '../../../skills/orch/scripts/lib/gh.ts')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-gh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => {
    const done = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    assert.equal(done.status, 0, done.stderr)
  }
  git('init', '--initial-branch=main')
  git('remote', 'add', 'origin', 'https://example.invalid/o/r.git')
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-m', 'test')
  const fake = fakeBin(dir, 'fake-gh', [
    { args: ['pr', 'list'], stdout: '[{"number":7,"title":"same"}]' },
    { args: ['repo', 'view'], stdout: 'https://example.invalid/o/r\n' },
  ])
  const env = { ...process.env, GH: fake.path, ORCH_DIR: join(dir, '.orch'), ORCH_GH_CACHE: '1', ORCH_GH_CACHE_TTL_SECONDS: undefined }
  const run = (query: string, extra: object = {}, cwd = dir) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, query], { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (s) => { stdout += s })
    child.stderr.on('data', (s) => { stderr += s })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { dir, fake, env, run, git }
}

test('같은 저장소의 동시 세션과 워크트리가 orch 캐시를 나누고, 일반 orch 조회도 같은 결과를 읽는다', async (t) => {
  const f = fixture(t)
  const wt = join(f.dir, 'worktree')
  f.git('worktree', 'add', '-b', 'test-branch', wt)
  const [one, two, three] = await Promise.all([f.run('prs'), f.run('prs'), f.run('prs', {}, wt)])
  assert.equal(one.code, 0, one.stderr)
  assert.deepEqual(one, two)
  assert.deepEqual(two, three)
  assert.equal(f.fake.calls().length, 1)
  const ordinary = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { gh } from ${JSON.stringify(ghModule)}; const r = gh(['pr','list','--state','open','--limit','30','--json','number,title,isDraft,mergeStateStatus,headRefName,statusCheckRollup,author']); process.stdout.write(r.stdout); process.exitCode=r.code`],
  { cwd: f.dir, encoding: 'utf8', env: f.env })
  assert.equal(ordinary.status, 0, ordinary.stderr)
  assert.equal(ordinary.stdout, one.stdout)
  assert.equal(f.fake.calls().length, 1)
  const cache = join(f.dir, '.orch/state/gh/cache')
  const entry = JSON.parse(readFileSync(join(cache, readdirSync(cache)[0]), 'utf8'))
  assert.ok(entry.expires - Date.now() > 290_000, '5분 응답을 공유한다')
})

test('TTL 만료, 다른 호스트와 인증 설정은 캐시 적중으로 잘못 가리지 않는다', async (t) => {
  const f = fixture(t)
  await f.run('prs')
  await f.run('prs', { GH_HOST: 'other.invalid' })
  await f.run('prs', { GH_CONFIG_DIR: join(f.dir, 'other-config') })
  assert.equal(f.fake.calls().length, 3)
  const cache = join(f.dir, '.orch/state/gh/cache')
  for (const file of readdirSync(cache)) {
    const target = join(cache, file)
    const entry = JSON.parse(readFileSync(target, 'utf8'))
    writeFileSync(target, JSON.stringify({ ...entry, expires: 0 }))
  }
  await f.run('prs')
  assert.equal(f.fake.calls().length, 4)
})

test('실패 응답과 명시적으로 끈 캐시는 매번 실행하고, URL 은 같은 캐시로 공유한다', async (t) => {
  const f = fixture(t)
  const [a, b] = await Promise.all([f.run('url'), f.run('url')])
  assert.equal(a.code, 0)
  assert.equal(a.stdout, b.stdout)
  assert.equal(f.fake.calls().length, 1)
  f.fake.setRules([{ code: 1, stderr: 'offline\n' }])
  assert.equal((await f.run('prs')).code, 1)
  assert.equal((await f.run('prs')).code, 1)
  assert.equal(f.fake.calls().length, 3)
  f.fake.setRules([{ stdout: '[]' }])
  await f.run('prs', { ORCH_GH_CACHE: '0' })
  await f.run('prs', { ORCH_GH_CACHE: '0' })
  assert.equal(f.fake.calls().length, 5)
})

test('쓰기 명령과 잘못된 인자를 받으면 gh 를 실행하지 않는다', async (t) => {
  const f = fixture(t)
  for (const query of ['merge', 'constructor', 'toString', '']) assert.equal((await f.run(query)).code, 2)
  assert.equal(f.fake.calls().length, 0)
})

test('orch 없는 저장소는 외부 사용자 캐시를 세션·워크트리가 공유하고 .orch 를 만들지 않는다', async (t) => {
  const f = fixture(t)
  const cache = mkdtempSync(join(tmpdir(), 'board-user-cache-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  const wt = join(f.dir, 'worktree')
  f.git('worktree', 'add', '-b', 'outside-cache', wt)
  const env = { ORCH_DIR: undefined, XDG_CACHE_HOME: cache }
  const [one, two, three] = await Promise.all([f.run('prs', env), f.run('prs', env), f.run('prs', env, wt)])
  assert.equal(one.code, 0, one.stderr)
  assert.deepEqual(one, two)
  assert.deepEqual(two, three)
  assert.equal(f.fake.calls().length, 1)
  assert.equal(existsSync(join(f.dir, '.orch')), false)
  assert.equal(existsSync(join(wt, '.orch')), false)
  const folders = readdirSync(join(cache, 'fos-skills', 'work-board'))
  assert.equal(folders.length, 1)
  assert.match(folders[0], /^[a-f0-9]{64}$/)
  assert.ok(existsSync(join(cache, 'fos-skills', 'work-board', folders[0], 'state', 'gh', 'cache')))
})

test('기존 .orch 가 있으면 ORCH_DIR 없이도 기존 orch 캐시 경로를 쓴다', async (t) => {
  const f = fixture(t)
  mkdirSync(join(f.dir, '.orch'))
  const first = await f.run('prs', { ORCH_DIR: undefined })
  const second = await f.run('prs', { ORCH_DIR: undefined })
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(first, second)
  assert.equal(f.fake.calls().length, 1)
  assert.ok(existsSync(join(f.dir, '.orch', 'state', 'gh', 'cache')))
})
