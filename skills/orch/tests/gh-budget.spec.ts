import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { budgetGh, pollSeconds, readTtl } from '../scripts/lib/gh-budget.ts'
import { run } from '../scripts/lib/proc.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

import { createHash } from 'node:crypto'

test('판정 조회는 낡은 캐시와 TTL 재설정이 있어도 매번 실행하고 표시 캐시는 유지한다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-decisions-'))
  const saved = { ORCH_DIR: process.env.ORCH_DIR, ORCH_GH_CACHE: process.env.ORCH_GH_CACHE, ORCH_GH_CACHE_TTL_SECONDS: process.env.ORCH_GH_CACHE_TTL_SECONDS }
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.ORCH_DIR = join(repo, '.orch')
  process.env.ORCH_GH_CACHE = '1'
  process.env.ORCH_GH_CACHE_TTL_SECONDS = '3600'
  const cache = join(repo, '.orch/state/gh/cache')
  mkdirSync(cache, { recursive: true })
  const queries = [
    ...['statusCheckRollup', 'headRefOid', 'mergeable', 'mergeStateStatus', 'isDraft', 'state', 'files'].map((field) => ['pr', 'view', '7', '--json', field]),
    ['pr', 'list', '--json', 'number,headRefOid,statusCheckRollup'], ['pr', 'checks', '7'],
    ['api', 'graphql', '-f', 'query=query { repository { pullRequest { reviewThreads { nodes { isResolved } } } } }'],
    ['api', 'repos/o/r/compare/main...abc'], ['api', 'repos/o/r/rules/branches/main'],
  ]
  const display = ['pr', 'list', '--json', 'number,title']
  let shown = 0
  const show = () => budgetGh(display, repo, 'same', () => ({ code: 0, stdout: String(++shown), stderr: '', timedOut: false }))
  assert.equal(show().stdout, '1')
  for (const args of queries) {
    const key = createHash('sha256').update(JSON.stringify(['same', args])).digest('hex')
    writeFileSync(join(cache, `${key}.json`), JSON.stringify({ expires: Date.now() + 3600_000, generation: '', result: { code: 0, stdout: 'stale', stderr: '', timedOut: false } }))
    let calls = 0
    const read = () => budgetGh(args, repo, 'same', () => ({ code: 0, stdout: String(++calls), stderr: '', timedOut: false }), { passthrough: true })
    assert.equal(read().stdout, '1', args.join(' '))
    assert.equal(read().stdout, '2', args.join(' '))
  }
  assert.equal(show().stdout, '1', '읽기 판정은 표시 캐시를 무효화하지 않는다')
})

test('같은 한 시간 조건에서 HEAD 키를 둔 pending 과 completed 스냅샷의 호출 수를 센다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-decision-hour-'))
  const saved = { ORCH_DIR: process.env.ORCH_DIR, ORCH_GH_CACHE: process.env.ORCH_GH_CACHE }
  const originalNow = Date.now
  t.after(() => {
    Date.now = originalNow
    rmSync(repo, { recursive: true, force: true })
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.ORCH_DIR = join(repo, '.orch')
  process.env.ORCH_GH_CACHE = '1'
  let now = originalNow()
  Date.now = () => now
  const counts: number[] = []
  for (const mode of ['disabled', 'pending', 'completed']) {
    process.env.ORCH_GH_CACHE = mode === 'disabled' ? '0' : '1'
    let calls = 0
    const args = ['pr', 'view', '7', '--json', 'statusCheckRollup,headRefOid']
    const options = { cacheKey: `checks:7:head:${mode}`, ttlSeconds: () => mode === 'completed' ? 300 : 60 }
    const execute = () => ({ code: 0, stdout: String(++calls), stderr: '', timedOut: false })
    for (let seconds = 0; seconds < 3600; seconds += 30) {
      now += 30_000
      for (let worker = 0; worker < 2; worker++) {
        budgetGh(args, repo, 'same', execute, options)
      }
    }
    counts.push(calls)
    if (mode === 'completed') {
      // 멈춤/머지 직전 검증 한 번, 캐시를 건너뛰는 mergeable 과 스레드 조회 각각 한 번.
      budgetGh(args, repo, 'same', execute, { ...options, refresh: true })
      budgetGh(['pr', 'view', '7', '--json', 'mergeable'], repo, 'same', execute, { passthrough: true })
      budgetGh(['api', 'graphql', '-f', 'query=query { reviewThreads { nodes { isResolved } } }'], repo, 'same', execute, { passthrough: true })
      counts.push(calls)
    }
  }
  assert.deepEqual(counts, [240, 60, 12, 15])
})

test('캐시 분류는 읽기만 허용하고 환경 변수로 TTL 과 끄기를 바꾼다', () => {
  process.env.ORCH_GH_CACHE = '1'
  delete process.env.ORCH_GH_CACHE_TTL_SECONDS
  for (const args of [['pr', 'view', '7'], ['run', 'list'], ['api', 'repos/o/r'], ['api', 'graphql', '-f', 'query=query { viewer { login } }']]) assert.equal(readTtl(args), 60)
  assert.equal(readTtl(['api', 'repos/o/r/rules/branches/main']), 300)
  assert.equal(readTtl(['repo', 'view', '--json', 'url']), 300)
  for (const args of [['pr', 'merge', '7'], ['pr', 'create'], ['pr', 'comment', '7'], ['api', '-X', 'PUT', 'repos/o/r/pulls/7/update-branch'], ['api', '-XPOST', 'repos/o/r'], ['api', 'repos/o/r', '-Fa=b'], ['api', 'repos/o/r', '-f', 'a=b'], ['api', 'graphql', '--input=body.json', '-f', 'query={viewer{login}}'], ['api', 'graphql', '-f', 'query=mutation { x }'], ['api', 'graphql', '-F', 'query=@file'], ['pr', 'checks', '--watch']]) assert.equal(readTtl(args), 0)
  process.env.ORCH_GH_CACHE_TTL_SECONDS = '120'
  assert.equal(readTtl(['pr', 'view', '7']), 120)
  assert.equal(readTtl(['pr', 'merge', '7']), 0)
  process.env.ORCH_GH_CACHE = '0'
  assert.equal(readTtl(['pr', 'view', '7']), 0)
  delete process.env.ORCH_GH_CACHE_TTL_SECONDS
})

test('적중, 만료, 쓰기 뒤 무효화, 실패 재시도와 일별 기록', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-budget-'))
  t.after(() => { rmSync(repo, { recursive: true, force: true }); delete process.env.ORCH_DIR; process.env.ORCH_GH_CACHE = '0' })
  process.env.ORCH_DIR = join(repo, '.orch')
  process.env.ORCH_GH_CACHE = '1'
  let calls = 0
  const execute = () => ({ code: 0, stdout: String(++calls), stderr: '', timedOut: false })
  const read = () => budgetGh(['pr', 'view', '7'], repo, 'same', execute)
  assert.equal(read().stdout, '1')
  assert.equal(read().stdout, '1')
  const cacheDir = join(repo, '.orch/state/gh/cache')
  const file = join(cacheDir, readdirSync(cacheDir)[0])
  const entry = JSON.parse(readFileSync(file, 'utf8'))
  entry.expires = Date.now() - 1
  writeFileSync(file, JSON.stringify(entry))
  assert.equal(read().stdout, '2')
  budgetGh(['pr', 'merge', '7'], repo, 'same', execute)
  assert.equal(read().stdout, '4')
  const failed = () => ({ ...execute(), code: 1 })
  budgetGh(['run', 'list'], repo, 'same', failed)
  budgetGh(['run', 'list'], repo, 'same', failed)
  assert.equal(calls, 6)
  const logDir = join(repo, '.orch/state/gh/logs')
  const names = readdirSync(logDir)
  assert.match(names[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/)
  const rows = readFileSync(join(logDir, names[0]), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 7)
  assert.equal(rows.filter((row) => row.cacheHit).length, 1)
  for (const row of rows) {
    assert.ok(Number.isFinite(Date.parse(row.time)))
    assert.ok(row.durationMs >= 0)
    assert.equal(typeof row.command, 'string')
    assert.equal(Object.hasOwn(row, 'args'), false)
  }
})

test('동시에 시작한 두 프로세스가 같은 조회를 한 번만 실행한다', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-concurrent-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const fake = fakeBin(repo, 'gh', [{ stdout: '{"number":7}' }])
  const module = fileURLToPath(new URL('../scripts/lib/gh.ts', import.meta.url))
  const code = `import { gh } from ${JSON.stringify(module)}; process.stdout.write(gh(['pr', 'view', '7'], {cwd: ${JSON.stringify(repo)}}).stdout)`
  const env = { ...process.env, GH: fake.path, ORCH_GH_CACHE: '1', ORCH_DIR: join(repo, '.orch') }
  function child(): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { env })
      let out = ''; let err = ''
      proc.stdout.on('data', (data) => { out += data })
      proc.stderr.on('data', (data) => { err += data })
      proc.on('error', reject)
      proc.on('close', (status) => status === 0 ? resolve(out) : reject(new Error(err)))
    })
  }
  assert.deepEqual(await Promise.all([child(), child()]), ['{"number":7}', '{"number":7}'])
  assert.equal(fake.calls().length, 1)
})

test('대기 간격이 60, 120, 240, 300초로 늘고 상한에 머문다', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 1000].map((n) => pollSeconds(n)), [60, 120, 240, 300, 300, 300])
  assert.equal(pollSeconds(0, 600), 300)
})

test('캐시를 끈 읽기는 다른 프로세스의 캐시를 지우지 않는다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-disabled-'))
  t.after(() => { rmSync(repo, { recursive: true, force: true }); delete process.env.ORCH_DIR; process.env.ORCH_GH_CACHE = '0' })
  process.env.ORCH_DIR = join(repo, '.orch')
  let calls = 0
  const read = () => budgetGh(['pr', 'view', '7'], repo, 'same', () => ({ code: 0, stdout: String(++calls), stderr: '', timedOut: false }))
  process.env.ORCH_GH_CACHE = '1'
  assert.equal(read().stdout, '1')
  process.env.ORCH_GH_CACHE = '0'
  assert.equal(read().stdout, '2')
  process.env.ORCH_GH_CACHE = '1'
  assert.equal(read().stdout, '1')
  budgetGh(['pr', 'checks', '--watch'], repo, 'same', () => ({ code: 0, stdout: '', stderr: '', timedOut: false }))
  assert.equal(read().stdout, '1')
  budgetGh(['repo', 'view', '--json', 'url'], repo, 'same', () => ({ code: 0, stdout: '{}', stderr: '', timedOut: false }))
  assert.equal(read().stdout, '1')
})

test('잠금을 우회한 쓰기 뒤에는 뒤늦게 저장된 옛 응답도 쓰지 않는다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-generation-'))
  t.after(() => { rmSync(repo, { recursive: true, force: true }); delete process.env.ORCH_DIR; process.env.ORCH_GH_CACHE = '0' })
  const root = join(repo, '.orch/state/gh')
  process.env.ORCH_DIR = join(repo, '.orch')
  process.env.ORCH_GH_CACHE = '1'
  let calls = 0
  const execute = () => ({ code: 0, stdout: String(++calls), stderr: '', timedOut: false })
  const read = () => budgetGh(['pr', 'view', '7'], repo, 'same', execute)
  read()
  const file = join(root, 'cache', readdirSync(join(root, 'cache'))[0])
  const stale = readFileSync(file, 'utf8')
  mkdirSync(join(root, 'lock'))
  writeFileSync(join(root, 'lock/pid'), String(process.pid))
  budgetGh(['pr', 'comment', '7'], repo, 'same', execute, { lockWaitMs: 0 })
  rmSync(join(root, 'lock'), { recursive: true })
  writeFileSync(file, stale)
  assert.equal(read().stdout, '3')
})

test('같은 한 시간 조건에서 캐시를 끈 호출과 켠 호출 수를 비교한다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-hour-'))
  t.after(() => { rmSync(repo, { recursive: true, force: true }); delete process.env.ORCH_DIR; process.env.ORCH_GH_CACHE = '0' })
  process.env.ORCH_DIR = join(repo, '.orch')
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  const counts: number[] = []
  // PR 하나를 마무리 프로세스 둘이 30초마다 조회하는 동일 조건. 시간을 주입해 실제 한 시간을 기다리지 않는다.
  for (const enabled of ['0', '1']) {
    process.env.ORCH_GH_CACHE = enabled
    let calls = 0
    for (let seconds = 0; seconds < 3600; seconds += 30) {
      now += 30_000
      for (let worker = 0; worker < 2; worker++) budgetGh(['pr', 'view', '7'], repo, enabled, () => ({ code: 0, stdout: String(++calls), stderr: '', timedOut: false }))
    }
    counts.push(calls)
  }
  assert.deepEqual(counts, [240, 60])
})

test('워크트리끼리는 명시한 PR 캐시를 공유하고 인증값이 다르면 따로 읽는다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-worktrees-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  for (const args of [['init', '-q'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial', '--allow-empty'], ['worktree', 'add', '-q', '--detach', join(repo, 'other')]]) {
    const done = run(['git', '-C', repo, ...args])
    assert.equal(done.code, 0, done.stderr)
  }
  const fake = fakeBin(repo, 'gh', [{ stdout: '{"number":7}' }])
  const module = fileURLToPath(new URL('../scripts/lib/gh.ts', import.meta.url))
  const invoke = (cwd: string, token: string) => {
    const code = `import { gh } from ${JSON.stringify(module)}; process.stdout.write(gh(['pr','view','7'], {cwd:${JSON.stringify(cwd)}}).stdout)`
    const result = run([process.execPath, '--input-type=module', '-e', code], { env: { GH: fake.path, GH_TOKEN: token, ORCH_GH_CACHE: '1', ORCH_DIR: join(repo, '.orch') } })
    assert.equal(result.code, 0, result.stderr)
  }
  invoke(repo, 'test-token-a')
  invoke(join(repo, 'other'), 'test-token-a')
  assert.equal(fake.calls().length, 1)
  invoke(repo, 'test-token-b')
  assert.equal(fake.calls().length, 2)
})

test('호출 수 명령은 UTC 날짜 경계를 넘어 최근 한 시간만 센다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gh-usage-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const logs = join(repo, '.orch/state/gh/logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, '2026-01-01.jsonl'), [
    { time: '2026-01-01T23:45:00Z', cacheHit: false },
    { time: '2026-01-01T22:00:00Z', cacheHit: false },
  ].map((row) => JSON.stringify(row)).join('\n'))
  writeFileSync(join(logs, '2026-01-02.jsonl'), JSON.stringify({ time: '2026-01-02T00:15:00Z', cacheHit: true }) + '\n{partial')
  const module = fileURLToPath(new URL('../scripts/gh-usage.ts', import.meta.url))
  const code = `Date.now=()=>Date.parse('2026-01-02T00:30:00Z'); process.argv=['node','gh-usage','--repo',${JSON.stringify(repo)}]; await import(${JSON.stringify(module)})`
  const result = run([process.execPath, '--input-type=module', '-e', code], { env: { ORCH_DIR: join(repo, '.orch') } })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'GH-USAGE last-hour calls=1 cache-hits=1\n')
})
