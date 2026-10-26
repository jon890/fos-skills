// reserve-migration.ts 를 임시 git 저장소와 bare origin, 가짜 gh 로 본다. GitHub 에는 닿지 않는다.
// 저장소의 main 에는 db/api/V2__a.sql 이 있고 설정의 migrations.dirs 는 {"api": "db/api"} 다.
// 가짜 gh 는 열린 PR 조회(number,headRefName,baseRefName,files)에 open 행을, 브랜치의 PR 조회(--head <브랜치>)에 heads 의 답을 낸다.
// 그 밖의 gh 호출은 빈 목록이다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/reserve-migration.ts', import.meta.url))
const OPEN_ARGS = ['pr', 'list', 'number,headRefName,baseRefName,files']
const OLD = '2020-01-01T00:00:00Z'
const LATER = '2099-01-01T00:00:00Z'

type Json = Record<string, unknown>
type Result = { status: number | null; stdout: string; stderr: string }

let tmp: string
let repo: string
let env: NodeJS.ProcessEnv
let gh: FakeBin

function git(args: string[], cwd = repo): void {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function stateFile(name: string): string {
  return join(repo, '.orch', 'state', name)
}

function reservations(): Json[] {
  return (JSON.parse(readFileSync(stateFile('migration-reservations.json'), 'utf8')) as { reservations: Json[] }).reservations
}

function seed(list: Json[]): void {
  write(stateFile('migration-reservations.json'), JSON.stringify({ reservations: list }))
}

function entry(branch: string, label: string, at: string): Json {
  return { module: 'api', version: [Number(label.slice(1))], label, branch, name: 'old', path: `db/api/${label}__old.sql`, at }
}

function openPr(number: number, branch: string, ...paths: string[]): Json {
  return { number, headRefName: branch, baseRefName: 'main', files: paths.map((path) => ({ path, changeType: 'ADDED' })) }
}

// open 은 열린 PR 조회의 답, heads 는 브랜치마다 --head 조회의 규칙(stdout 이나 code)이다
function github(opts: { open?: Json[]; openRule?: FakeRule; heads?: Record<string, FakeRule> } = {}): void {
  gh.setRules([
    { stdout: `${JSON.stringify(opts.open ?? [])}\n`, ...opts.openRule, args: OPEN_ARGS },
    ...Object.entries(opts.heads ?? {}).map(([branch, rule]) => ({ ...rule, args: ['pr', 'list', '--head', branch] })),
    { stdout: '[]\n' },
  ])
}

function prs(...rows: Json[]): FakeRule {
  return { stdout: `${JSON.stringify(rows)}\n` }
}

function reserve(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], {
    env: { ...env, ...opts.env },
    cwd: opts.cwd ?? tmp,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: done.status, stdout: done.stdout, stderr: done.stderr }
}

function reserveAsync(args: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], { env, cwd: tmp })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function ok(done: Result): string {
  assert.equal(done.status, 0, `종료 코드 ${done.status}\n${done.stdout}${done.stderr}`)
  return done.stdout
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'reserve-migration-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  gh = fakeBin(tmp, 'gh', [])
  env = {
    ...process.env,
    GH: gh.path,
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: tmp,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  delete env.ORCH_DIR
  delete env.RESERVE_LOCK_WAIT_MS
  delete env.NODE_OPTIONS
  git(['init', '-q', '-b', 'main'])
  write(join(repo, 'db', 'api', 'V2__a.sql'), 'select 1;\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  git(['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')], tmp)
  git(['remote', 'add', 'origin', join(tmp, 'origin.git')])
  git(['push', '-q', 'origin', 'main'])
  // 예약한 브랜치가 로컬에 있어야 다음 호출의 정리가 그 예약을 남긴다
  git(['branch', 'feat-a'])
  git(['branch', 'feat-c'])
  write(join(repo, '.orch', 'config.json'), JSON.stringify({ migrations: { dirs: { api: 'db/api' } } }))
  github({ open: [openPr(7, 'feat-b', 'db/api/V3__b.sql')] })
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('예약', () => {
  test('base 최고와 다른 브랜치의 열린 PR 을 넘는 번호를 작업 디렉터리의 브랜치로 예약한다', () => {
    git(['checkout', '-q', 'feat-a'])
    const out = ok(reserve(['--module', 'api', '--name', 'Add index'], { cwd: repo }))
    assert.equal(out, 'RESERVED api V4 db/api/V4__add_index.sql\n')
    const [saved, ...rest] = reservations()
    assert.deepEqual(rest, [])
    assert.deepEqual({ ...saved, at: typeof saved.at }, {
      module: 'api',
      version: [4],
      label: 'V4',
      branch: 'feat-a',
      name: 'add_index',
      path: 'db/api/V4__add_index.sql',
      at: 'string',
    })
    assert.ok(!Number.isNaN(Date.parse(saved.at as string)), `at 이 시각이 아니다: ${saved.at}`)
    assert.equal(existsSync(stateFile('migration-reservations.lock')), false, '잠금이 남았다')
  })

  test('같은 인자로 다시 부르면 같은 예약을 reused 로 준다. --again 이면 새 번호다', () => {
    const args = ['--module', 'api', '--name', 'add index', '--branch', 'feat-a']
    assert.equal(ok(reserve(args)), 'RESERVED api V4 db/api/V4__add_index.sql\n')
    const first = reservations()
    assert.equal(ok(reserve(args)), 'RESERVED api V4 db/api/V4__add_index.sql reused\n')
    assert.deepEqual(reservations(), first)
    // 다른 브랜치가 V5 를 예약한 뒤 --again 이면 자기 V4 를 버리고 V6 을 받는다
    assert.equal(ok(reserve(['--module', 'api', '--name', 'other', '--branch', 'feat-c'])), 'RESERVED api V5 db/api/V5__other.sql\n')
    assert.equal(ok(reserve([...args, '--again'])), 'RESERVED api V6 db/api/V6__add_index.sql\n')
    assert.deepEqual(
      reservations().map((r) => [r.branch, r.label]),
      [
        ['feat-c', 'V5'],
        ['feat-a', 'V6'],
      ],
    )
  })

  test('두 프로세스가 동시에 다른 브랜치로 예약하면 서로 다른 번호를 받는다', async () => {
    git(['branch', 'feat-x'])
    git(['branch', 'feat-y'])
    const done = await Promise.all([
      reserveAsync(['--module', 'api', '--name', 'add index', '--branch', 'feat-x']),
      reserveAsync(['--module', 'api', '--name', 'add index', '--branch', 'feat-y']),
    ])
    const labels = done.map((d) => ok(d).trim().split(' ')[2]).sort()
    assert.deepEqual(labels, ['V4', 'V5'])
    assert.deepEqual(reservations().map((r) => r.label).sort(), ['V4', 'V5'])
  })

  test('살아 있는 다른 pid 가 잠금을 쥐고 있으면 기다린 뒤 LOCK-TIMEOUT 과 4 다', () => {
    const lock = stateFile('migration-reservations.lock')
    write(lock, String(process.pid))
    const done = reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a'], { env: { RESERVE_LOCK_WAIT_MS: '300' } })
    assert.equal(done.status, 4, done.stdout + done.stderr)
    assert.equal(done.stdout, `LOCK-TIMEOUT ${lock}\n`)
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid), '남의 잠금을 지웠다')
    assert.equal(existsSync(stateFile('migration-reservations.json')), false)
  })

  test('다시 줄 예약의 번호가 base 최고 이하가 되면 새 번호와 renewed 다', () => {
    const args = ['--module', 'api', '--name', 'add index', '--branch', 'feat-a']
    assert.equal(ok(reserve(args)), 'RESERVED api V4 db/api/V4__add_index.sql\n')
    // 다른 PC 에서 같은 번호가 머지됐다
    write(join(repo, 'db', 'api', 'V4__elsewhere.sql'), 'select 4;\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'V4'])
    git(['push', '-q', 'origin', 'main'])
    assert.equal(ok(reserve(args)), 'RESERVED api V5 db/api/V5__add_index.sql renewed\n')
    assert.deepEqual(
      reservations().map((r) => [r.branch, r.label]),
      [['feat-a', 'V5']],
    )
  })
})

describe('정리', () => {
  test('예약 뒤에 머지된 PR 이 있으면 다음 호출이 PRUNED 로 지우고 그 번호를 다시 쓴다', () => {
    git(['branch', 'feat-old'])
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z')])
    github({ open: [openPr(7, 'feat-b', 'db/api/V3__b.sql')], heads: { 'feat-old': prs({ state: 'MERGED', mergedAt: LATER, closedAt: LATER }) } })
    const out = ok(reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a']))
    assert.equal(out, 'PRUNED api V4 feat-old\nRESERVED api V4 db/api/V4__add_index.sql\n')
    assert.deepEqual(
      reservations().map((r) => r.branch),
      ['feat-a'],
    )
  })

  test('예약 전에 머지된 옛 PR 만 있고 로컬 브랜치가 있으면 남긴다', () => {
    git(['branch', 'feat-old'])
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z')])
    github({ open: [openPr(7, 'feat-b', 'db/api/V3__b.sql')], heads: { 'feat-old': prs({ state: 'MERGED', mergedAt: OLD, closedAt: OLD }) } })
    assert.equal(ok(reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a'])), 'RESERVED api V5 db/api/V5__add_index.sql\n')
    assert.deepEqual(
      reservations().map((r) => [r.branch, r.label]),
      [
        ['feat-old', 'V4'],
        ['feat-a', 'V5'],
      ],
    )
  })

  test('그 브랜치의 PR 조회가 실패하면 브랜치가 없어도 남긴다', () => {
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z')])
    github({ open: [openPr(7, 'feat-b', 'db/api/V3__b.sql')], heads: { 'feat-old': { code: 1, stderr: 'HTTP 502\n' } } })
    assert.equal(ok(reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a'])), 'RESERVED api V5 db/api/V5__add_index.sql\n')
    assert.deepEqual(
      reservations().map((r) => r.branch),
      ['feat-old', 'feat-a'],
    )
  })

  test('PR 이 없고 로컬 브랜치만 있으면 남긴다', () => {
    git(['branch', 'feat-old'])
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z')])
    assert.equal(ok(reserve(['--prune'])), 'PRUNE-DONE 0\n')
    assert.deepEqual(
      reservations().map((r) => r.branch),
      ['feat-old'],
    )
  })

  test('PR 이 없고 원격과 로컬에 모두 없으면 PRUNED 다', () => {
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z')])
    const out = ok(reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a']))
    assert.equal(out, 'PRUNED api V4 feat-old\nRESERVED api V4 db/api/V4__add_index.sql\n')
  })

  test('원격에만 브랜치가 있으면 남긴다', () => {
    git(['push', '-q', 'origin', 'main:refs/heads/feat-old'])
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z')])
    assert.equal(ok(reserve(['--prune'])), 'PRUNE-DONE 0\n')
    assert.deepEqual(
      reservations().map((r) => r.branch),
      ['feat-old'],
    )
  })

  test('PR 이 없고 ls-remote 가 실패하면 남긴다', () => {
    git(['remote', 'set-url', 'origin', join(tmp, 'missing.git')])
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z')])
    assert.equal(ok(reserve(['--prune'])), 'PRUNE-DONE 0\n')
    assert.deepEqual(
      reservations().map((r) => r.branch),
      ['feat-old'],
    )
  })

  test('--prune 은 지운 것을 파일에 쓰고 PRUNE-DONE 1 과 0 이다', () => {
    seed([entry('feat-old', 'V4', '2026-10-27T00:00:00Z'), entry('feat-a', 'V5', '2026-10-27T00:00:00Z')])
    assert.equal(ok(reserve(['--prune'])), 'PRUNED api V4 feat-old\nPRUNE-DONE 1\n')
    assert.deepEqual(
      reservations().map((r) => r.branch),
      ['feat-a'],
    )
  })

  test('형식이 틀린 예약은 stderr 로 알리고 다음 쓰기에서 뺀다', () => {
    seed([entry('feat-a', 'V5', '2026-10-27T00:00:00Z'), { module: 'api' }])
    const done = reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-c'])
    assert.equal(ok(done), 'RESERVED api V6 db/api/V6__add_index.sql\n')
    assert.match(done.stderr, /경고: 형식이 틀린 예약 1 개를 건너뛴다/)
    assert.deepEqual(
      reservations().map((r) => r.label),
      ['V5', 'V6'],
    )
  })
})

describe('실패', () => {
  test('--name 이 한글뿐이면 사용법 오류 2 다', () => {
    const done = reserve(['--module', 'api', '--name', '인덱스 추가', '--branch', 'feat-a'])
    assert.equal(done.status, 2, done.stdout + done.stderr)
    assert.equal(done.stdout, '')
  })

  test('설정에 없는 모듈은 사용법 오류 2 다', () => {
    const done = reserve(['--module', 'web', '--name', 'add index', '--branch', 'feat-a'])
    assert.equal(done.status, 2, done.stdout + done.stderr)
    assert.match(done.stderr, /모듈 web 이 없다/)
  })

  test('설정 파일이 틀리면 2 다', () => {
    write(join(repo, '.orch', 'config.json'), JSON.stringify({ migrations: { dirs: { api: '' } } }))
    const done = reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a'])
    assert.equal(done.status, 2, done.stdout + done.stderr)
  })

  test('열린 PR 조회가 실패하면 LOOKUP-FAIL 과 1 이고 예약 파일이 바뀌지 않는다', () => {
    ok(reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a']))
    const before = readFileSync(stateFile('migration-reservations.json'), 'utf8')
    github({ openRule: { code: 1, stderr: 'HTTP 502\n' } })
    const done = reserve(['--module', 'api', '--name', 'other', '--branch', 'feat-c'])
    assert.equal(done.status, 1, done.stdout + done.stderr)
    assert.match(done.stdout, /^LOOKUP-FAIL /)
    assert.equal(readFileSync(stateFile('migration-reservations.json'), 'utf8'), before)
  })

  test('예약 파일이 JSON 이 아니면 LOOKUP-FAIL 과 1 이다', () => {
    write(stateFile('migration-reservations.json'), '{')
    const done = reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a'])
    assert.equal(done.status, 1, done.stdout + done.stderr)
    assert.match(done.stdout, /^LOOKUP-FAIL 예약 파일을 읽지 못했다/)
    assert.equal(readFileSync(stateFile('migration-reservations.json'), 'utf8'), '{')
  })

  test('base 를 받지 못하면 LOOKUP-FAIL 과 1 이다', () => {
    const done = reserve(['--module', 'api', '--name', 'add index', '--branch', 'feat-a', '--base', 'nope'])
    assert.equal(done.status, 1, done.stdout + done.stderr)
    assert.match(done.stdout, /^LOOKUP-FAIL origin nope 를 받지 못했다/)
    assert.equal(existsSync(stateFile('migration-reservations.json')), false)
  })
})
