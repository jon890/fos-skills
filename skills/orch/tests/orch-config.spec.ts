// 실제 진입점과 임시 설정 파일로 공개 명령 계약과 동시 쓰기를 확인한다.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const entry = join(root, 'skills/orch/bin/orch.ts')
let dir: string, repo: string, file: string, env: NodeJS.ProcessEnv
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-config-')))
  repo = join(dir, 'repo'); mkdirSync(repo)
  file = join(repo, '.orch/config.json')
  env = { ...process.env, ORCH_SCRIPTS_DIR: join(root, 'skills/orch/scripts'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), ORCA: join(dir, 'no-orca'), GIT_CEILING_DIRECTORIES: dir }
  for (const key of ['ORCH_DIR', 'ORCH_CONTEXT', 'ORCH_ENTRY_HOP', 'ORCH_OUTPUT', 'GH_HOST']) delete env[key]
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
function run(args: string[], extra: NodeJS.ProcessEnv = {}, cwd = repo) {
  return spawnSync(process.execPath, [entry, 'config', ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 })
}
function put(value: unknown) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)) }
function get() { return JSON.parse(readFileSync(file, 'utf8')) }
function ok(args: string[], extra: NodeJS.ProcessEnv = {}, cwd = repo) {
  const result = run(args, extra, cwd)
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
  return result
}
function refused(args: string[], reason: RegExp, status = 1) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  const result = run(args)
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`)
  assert.match(result.stderr, reason)
  assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : undefined, before)
  return result
}
function child(args: string[]) {
  const proc = spawn(process.execPath, [entry, 'config', ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  proc.stdout.on('data', data => { out += data }); proc.stderr.on('data', data => { err += data })
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    proc.on('error', reject); proc.on('close', code => resolve({ code, out, err }))
  })
}

test('도움말과 사용법 오류, 옵션과 겹치는 경로', () => {
  assert.match(ok(['--help']).stdout, /show.*\n.*get.*\n.*set.*\n.*unset/s)
  for (const args of [['get'], ['set', 'pipeline.tick_sec'], ['unset'], ['show', 'queue', 'finish'], ['get', 'queue'], ['set', 'queue', '{}'], ['set', 'queue.required', '[]', '--typo'], ['get', 'queue.required', '--json'], ['get', '.queue.required'], ['unset', 'queue', 'queue.method'], ['set', 'queue.method', 'merge', 'queue.method', 'squash']]) refused(args, /사용법/, 2)
  const literal = refused(['set', 'routing.review_author', '--literal'], /사용법/, 2)
  assert.match(literal.stderr, /-- 로 시작하는 값은 -- 뒤에 둔다/)
  assert.match(literal.stderr, /--json 은 -- 앞에 둔다/)
})

test('show 는 읽기만 하고 잘못된 파일도 문제와 함께 보여 준다', () => {
  assert.equal(ok(['show']).stdout, '{}\n'); assert.equal(existsSync(file), false)
  assert.equal(ok(['show', 'pipeline']).stdout, '{}\n')
  refused(['show', 'queu'], /모르는 절.*finish.*queue/)
  put({ queue: { method: 'squash', typo: 1, before: 'echo old' }, pipeline: { tick_sec: -1 }, queu: {} })
  const text = readFileSync(file, 'utf8')
  const show = ok(['show', 'queue'])
  assert.deepEqual(JSON.parse(show.stdout), get().queue)
  for (const key of ['queue.typo', 'queue.before', 'pipeline.tick_sec', 'queu']) assert.ok(show.stderr.includes(key))
  assert.equal(readFileSync(file, 'utf8'), text)
  writeFileSync(file, '{'); refused(['show'], /읽지 못했다/)
  put(null); assert.equal(ok(['show']).stdout, 'null\n')
  put({ pipeline: null }); assert.equal(ok(['show', 'pipeline']).stdout, 'null\n')
})

test('get 은 있는 값만 JSON 한 줄로 내고 모르는 이름과 부재를 구분한다', () => {
  refused(['get', 'pipeline.tick_sec'], /설정 파일에 없다/)
  refused(['get', 'pipeline.tick_secs'], /모르는 키/)
  refused(['get', 'queue.auto_review.prass'], /모르는 키/)
  ok(['set', 'routing.review_author', 'bot'])
  assert.equal(ok(['get', 'routing.review_author']).stdout, '"bot"\n')
  put({ routing: { review_author: 'bot' }, queu: {} })
  assert.match(ok(['get', 'routing.review_author']).stderr, /queu/)
})

test('set 은 문자와 JSON 을 구분하고 배치 변경과 이전 값을 낸다', () => {
  assert.match(ok(['set', 'routing.review_author', 'bot']).stdout, /CONFIG-SET routing.review_author "bot" \(이전: 없음\)/)
  assert.match(ok(['set', 'routing.review_author', '-bot']).stdout, /이전: "bot"/)
  refused(['set', 'pipeline.tick_sec', '60'], /--json/)
  refused(['set', 'pipeline.tick_sec', '-1', '--json'], /pipeline.tick_sec/)
  refused(['set', 'queue.required', '[broken', '--json'], /JSON/)
  ok(['set', 'pipeline.tick_sec', '60', 'queue.required', '["Tests"]', '--json'])
  assert.deepEqual(get().queue.required, ['Tests']); assert.equal(get().pipeline.tick_sec, 60)
  ok(['set', 'hooks.timeouts.after-queue', '30', '--json'])
  assert.equal(get().hooks.timeouts['after-queue'], 30)
  ok(['set', 'finish.deploy_workflow', 'deploy.yml', 'finish.deploy_branch', 'main'])
  assert.equal(get().finish.deploy_branch, 'main')
  assert.equal(ok(['set', 'routing.review_author', '--', '--literal']).status, 0)
  assert.equal(get().routing.review_author, '--literal')
  ok(['set', '--json', 'routing.review_author', '--', '"--json-literal"'])
  assert.equal(get().routing.review_author, '--json-literal')
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
  assert.deepEqual(Object.keys(get()), ['routing', 'pipeline', 'queue', 'hooks', 'finish'])
})

test('새 오류와 같은 문구의 오류는 거절하고 기존의 다른 오류는 경고한다', () => {
  put({ pipeline: { tick_sec: -1, digest_sec: -1 }, queue: { typo: 1 }, queu: {} })
  refused(['set', 'pipeline.tick_sec', '-2', '--json'], /pipeline.tick_sec/)
  const result = ok(['set', 'pipeline.tick_sec', '60', '--json'])
  for (const text of ['pipeline.digest_sec', 'queue.typo', 'queu']) assert.ok(result.stderr.includes(text))
  refused(['set', 'hooks.timeouts.foo', '30', '--json'], /모르는 키/)
  refused(['set', 'pipeline.tick_sec', '90', 'pipeline.digest_sec', '-3', '--json'], /digest_sec/)
  assert.equal(get().pipeline.tick_sec, 60)
  put({ contracts: { merge_command: 'merge', paths: ['docs/**'] } })
  refused(['unset', 'contracts.paths'], /둘 다/)
  ok(['unset', 'contracts.merge_command', 'contracts.paths']); assert.deepEqual(get(), {})
  put({ queue: { typo: 1 }, finish: { deploy_workflow: 'one' } })
  refused(['set', 'finish.deploy_workflow', 'two'], /둘 다/)
  ok(['set', 'pipeline.tick_sec', '60', '--json'])
  put({ queue: { typo: 1 } })
  refused(['set', 'queue.up_to_date_when', 'overlap'], /require_up_to_date/)
  ok(['unset', 'queue.typo']); assert.deepEqual(get(), {})
})

test('unset 은 모르는 키도 지우고 빈 객체 정리와 없는 경로 반복을 지원한다', () => {
  put({ hooks: { timeouts: { 'after-queue': 30 } }, queu: { typo: 1 } })
  ok(['unset', 'hooks.timeouts.after-queue']); assert.deepEqual(get(), { queu: { typo: 1 } })
  assert.match(ok(['unset', 'queu']).stdout, /CONFIG-UNSET queu \(이전: \{"typo":1\}\)/)
  const before = statSync(file).mtimeMs
  assert.match(ok(['unset', 'queu']).stdout, /이전: 없음/)
  assert.equal(statSync(file).mtimeMs, before)
  rmSync(file)
  ok(['unset', 'queu']); assert.equal(existsSync(file), false)
})

test('옛 칸을 포함한 삭제와 변경은 막고 조회는 허용한다', () => {
  put({ queue: { before: 'echo old' } })
  for (const args of [['unset', 'queue'], ['unset', 'queue.before'], ['set', 'queue.before', 'echo new']]) refused(args, /doctor migrate-hooks/)
  assert.equal(ok(['get', 'queue.before']).stdout, '"echo old"\n')
  ok(['set', 'routing.review_author', 'bot'])
  assert.equal(get().queue.before, 'echo old')
  mkdirSync(join(repo, '.claude'), { recursive: true }); writeFileSync(join(repo, '.claude/orch-finish.json'), '{}')
  for (const args of [['show'], ['get', 'queue.before'], ['set', 'routing.review_author', 'bot'], ['unset', 'queue']]) refused(args, /옛|migrate/, 2)
})

test('자유 이름의 객체를 편집해도 프로토타입을 읽거나 바꾸지 않는다', () => {
  ok(['set', 'migrations.dirs.__proto__', 'migrations'])
  assert.deepEqual(Object.keys(get().migrations.dirs), ['__proto__'])
  assert.equal(ok(['get', 'migrations.dirs.__proto__']).stdout, '"migrations"\n')
  ok(['unset', 'migrations.dirs.__proto__']); assert.deepEqual(get(), {})
  refused(['set', 'queue.__proto__', '{}', '--json'], /모르는 키/)
  put({ queue: { required: ['Tests'] } })
  refused(['set', 'queue.required.0', 'Other'], /객체|모르는 키/)
})

test('worktree 와 --repo 는 주 checkout 을 쓰고 ORCH_DIR 도 따른다', () => {
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git(['init', '-q']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial'])
  const worktree = join(dir, 'worktree'); git(['worktree', 'add', '-qb', 'test', worktree])
  ok(['set', 'routing.review_author', 'bot'], {}, worktree)
  assert.equal(get().routing.review_author, 'bot'); assert.equal(existsSync(join(worktree, '.orch/config.json')), false)
  const elsewhere = join(dir, 'elsewhere'); mkdirSync(elsewhere)
  ok(['set', 'routing.review_author', 'other', '--repo', worktree], {}, elsewhere)
  assert.equal(get().routing.review_author, 'other')
  const orchDir = join(dir, 'custom')
  ok(['set', 'routing.review_author', 'custom'], { ORCH_DIR: orchDir })
  assert.equal(JSON.parse(readFileSync(join(orchDir, 'config.json'), 'utf8')).routing.review_author, 'custom')
})

test('동시 set 은 두 값을 모두 남긴다', async () => {
  const results = await Promise.all([child(['set', 'routing.review_author', 'bot']), child(['set', 'pipeline.tick_sec', '60', '--json'])])
  for (const result of results) assert.equal(result.code, 0, result.err)
  assert.deepEqual(get(), { ...get(), routing: { review_author: 'bot' }, pipeline: { tick_sec: 60 } })
})

test('잠금 실패와 깨진 JSON 의 set/unset 은 파일 바이트를 보존한다', () => {
  put({ routing: { review_author: 'bot' } })
  writeFileSync(`${file}.lock`, 'other')
  refused(['set', 'routing.review_author', 'new'], /잠금/)
  rmSync(`${file}.lock`)
  writeFileSync(file, '{ broken')
  refused(['set', 'routing.review_author', 'new'], /읽지 못했다/)
  refused(['unset', 'routing'], /읽지 못했다/)
})

test('살아 있는 루프와 오래된 생존 기록에서만 재시작을 알린다', () => {
  mkdirSync(join(repo, '.orch/state'), { recursive: true })
  const loop = join(repo, '.orch/state/loop.json')
  const state = { pid: process.pid, alive_at: new Date().toISOString(), tick_sec: 30, started_at: new Date().toISOString(), run: 'run_test' }
  writeFileSync(loop, JSON.stringify(state))
  assert.match(ok(['set', 'pipeline.tick_sec', '60', '--json']).stderr, /루프를 다시 띄워야/)
  assert.doesNotMatch(ok(['set', 'pipeline.tick_sec', '60', '--json']).stderr, /루프를 다시/)
  assert.match(ok(['set', 'finish.run', 'run_test']).stderr, /--run 없이/)
  assert.match(ok(['set', 'finish.specs_dir', 'specs']).stderr, /--run 없이/)
  assert.doesNotMatch(ok(['set', 'pipeline.digest_sec', '60', '--json']).stderr, /다시 띄워야/)
  writeFileSync(loop, JSON.stringify({ ...state, alive_at: '2000-01-01T00:00:00Z' }))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'ps'), `#!${process.execPath}\nconsole.log('node orch-loop.ts')\n`, { mode: 0o755 })
  assert.match(ok(['set', 'pipeline.tick_sec', '70', '--json'], { PATH: `${bin}:${process.env.PATH ?? ''}` }).stderr, /루프를 다시 띄워야/)
  rmSync(loop)
  assert.doesNotMatch(ok(['set', 'pipeline.tick_sec', '90', '--json']).stderr, /다시 띄워야/)
})

test('검사표 의존 누락은 설치 안내로 거절한다', () => {
  const isolated = join(dir, 'bundle')
  cpSync(join(root, 'skills/orch'), join(isolated, 'skills/orch'), { recursive: true, filter: source => !source.includes('/tests') })
  cpSync(join(root, 'extensions/work-board'), join(isolated, 'extensions/work-board'), { recursive: true, filter: source => !source.includes('/tests') })
  const result = run(['show'], { ORCH_SCRIPTS_DIR: join(isolated, 'skills/orch/scripts') })
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /의존을 읽지 못했다.*npm ci/)
  const loop = spawnSync(process.execPath, [join(isolated, 'skills/orch/bin/orch.ts'), 'loop', 'status'], { cwd: repo, env: { ...env, ORCH_SCRIPTS_DIR: join(isolated, 'skills/orch/scripts') }, encoding: 'utf8', timeout: 15000 })
  assert.doesNotMatch(loop.stderr, /ERR_MODULE_NOT_FOUND|zod/)
  assert.notEqual(loop.status, null)
})
