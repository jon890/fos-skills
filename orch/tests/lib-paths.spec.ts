import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import {
  boardPath,
  ensure,
  FILES,
  legacyPaths,
  makeParent,
  NAMES,
  orchDir,
  pathOf,
  requireMigrated,
  warnLegacy,
} from '../scripts/lib/paths.ts'

// CI 에는 git 작성자 설정이 없어 커밋이 실패하고, 로컬의 전역 설정은 결과를 바꿀 수 있어 둘 다 고정한다.
// 라이브러리가 부르는 git 도 같은 값을 받도록 process.env 에 둔다. 테스트 파일마다 프로세스가 나뉘어 다른 파일에 새지 않는다.
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'orch-test',
  GIT_AUTHOR_EMAIL: 'orch-test@example.com',
  GIT_COMMITTER_NAME: 'orch-test',
  GIT_COMMITTER_EMAIL: 'orch-test@example.com',
}
const saved: Record<string, string | undefined> = {}
const MIGRATE = join(import.meta.dirname, '../scripts/migrate-orch-dir.py')

let tmp: string
let repo: string

function sh(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(done.status, 0, `git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

function exclude(): string[] {
  const file = join(repo, '.git/info/exclude')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
}

function write(rel: string, body: string) {
  const file = join(repo, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
}

// stderr 로 낸 것을 모은다. requireMigrated 와 warnLegacy 의 안내 줄을 본다.
function captureStderr<T>(fn: () => T): { value: T; text: string } {
  const original = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stderr.write
  try {
    return { value: fn(), text }
  } finally {
    process.stderr.write = original
  }
}

before(() => {
  for (const key of [...Object.keys(GIT_ENV), 'ORCH_DIR']) saved[key] = process.env[key]
  Object.assign(process.env, GIT_ENV)
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(() => {
  delete process.env.ORCH_DIR
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-paths-')))
  repo = join(tmp, 'repo')
  sh(tmp, 'init', '-q', '-b', 'main', repo)
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('orchDir 와 pathOf', () => {
  test('하위 폴더에서 불러도 주 checkout 의 .orch 다', () => {
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    assert.equal(orchDir(sub), join(repo, '.orch'))
    assert.equal(pathOf('specs', repo), join(repo, '.orch/specs'))
    assert.equal(pathOf('config', repo), join(repo, '.orch/config.json'))
    assert.equal(pathOf('heavy-slot', repo), join(repo, '.orch/state/heavy-slot'))
    assert.equal(pathOf('hooks', repo), join(repo, '.orch/hooks'))
    assert.equal(pathOf('hooks-state', repo), join(repo, '.orch/state/hooks'))
  })

  test('연결된 워크트리에서 불러도 주 checkout 의 .orch 다', () => {
    const wt = join(tmp, 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
    assert.equal(orchDir(wt), join(repo, '.orch'))
    assert.equal(pathOf('queue', wt), join(repo, '.orch/queue'))
  })

  test('ORCH_DIR 상대경로는 주 checkout 기준이고 절대경로는 그대로다', () => {
    const wt = join(tmp, 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat/y', wt)
    process.env.ORCH_DIR = 'work/orch'
    assert.equal(pathOf('queue', wt), join(repo, 'work/orch/queue'))
    process.env.ORCH_DIR = join(tmp, 'elsewhere')
    assert.equal(pathOf('queue', repo), join(tmp, 'elsewhere/queue'))
  })

  test('git 밖이면 받은 폴더가 기준이다', () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    assert.equal(orchDir(plain), join(plain, '.orch'))
  })

  test('모르는 이름은 Error 다', () => {
    assert.throws(() => pathOf('board', repo), /모르는 이름: board/)
  })

  test('FILES 의 이름은 모두 NAMES 에 있다', () => {
    for (const name of FILES) assert.ok(Object.hasOwn(NAMES, name), `${name} 이 NAMES 에 없다`)
  })
})

describe('ensure 와 makeParent', () => {
  test('ensure 가 폴더를 만들고 info/exclude 에 한 줄만 더한다', () => {
    const target = ensure('queue', repo)
    ensure('state', repo)
    assert.ok(statSync(target).isDirectory())
    assert.equal(exclude().filter((line) => line === '/.orch/').length, 1)
    assert.equal(sh(repo, 'status', '--porcelain'), '')
  })

  test('파일 이름이면 부모 폴더만 만든다', () => {
    const target = ensure('config', repo)
    assert.ok(statSync(join(target, '..')).isDirectory())
    assert.equal(existsSync(target), false)
  })

  test('이미 무시되는 루트에는 줄을 더하지 않는다', () => {
    writeFileSync(join(repo, '.gitignore'), '.orch/\n')
    ensure('queue', repo)
    assert.ok(!exclude().includes('/.orch/'))
  })

  test('저장소 밖 루트에는 줄을 더하지 않는다', () => {
    process.env.ORCH_DIR = join(tmp, 'elsewhere')
    ensure('queue', repo)
    assert.ok(statSync(join(tmp, 'elsewhere/queue')).isDirectory())
    assert.ok(!exclude().some((line) => line.includes('elsewhere') || line === '/.orch/'))
  })

  test('makeParent 는 루트 안의 경로에서만 무시 줄을 더한다', () => {
    makeParent(join(tmp, 'other/state.json'), repo)
    assert.ok(statSync(join(tmp, 'other')).isDirectory())
    assert.ok(!exclude().includes('/.orch/'))
    makeParent(join(repo, '.orch/state/x.json'), repo)
    assert.ok(statSync(join(repo, '.orch/state')).isDirectory())
    assert.ok(exclude().includes('/.orch/'))
  })
})

describe('boardPath', () => {
  test('주지 않으면 work-board 의 기본 위치이고, 주면 주 checkout 기준이다', () => {
    assert.equal(boardPath(repo), join(repo, '.omc/board.json'))
    assert.equal(boardPath(repo, 'b/board.json'), join(repo, 'b/board.json'))
    assert.equal(boardPath(repo, '/abs/board.json'), '/abs/board.json')
  })

  test('옛 보드 파일이 있으면 그것이다', () => {
    write('.omc/handoffs/board.json', '{}')
    assert.equal(boardPath(repo), join(repo, '.omc/handoffs/board.json'))
  })
})

describe('옛 구조', () => {
  test('옛 구조가 없으면 통과한다', () => {
    assert.deepEqual(legacyPaths(repo), [])
    const { value, text } = captureStderr(() => requireMigrated(repo, 'x'))
    assert.equal(value, true)
    assert.equal(text, '')
  })

  test('파일이 든 옛 위치를 모두 알린다', () => {
    write('.claude/orch-finish.json', '{}')
    write('.omc/orch/wait.json', '{}')
    assert.deepEqual(legacyPaths(repo), ['.claude/orch-finish.json', '.omc/orch'])
  })

  test('빈 옛 폴더는 옛 위치로 세지 않는다', () => {
    mkdirSync(join(repo, '.omc/orch/specs'), { recursive: true })
    assert.deepEqual(legacyPaths(repo), [])
  })

  test('옛 위치에 파일이 있으면 requireMigrated 가 옮기는 명령과 함께 false 다', () => {
    write('.omc/handoffs/specs/spec-a.md', 'x')
    const { value, text } = captureStderr(() => requireMigrated(repo, 'finish-pr'))
    assert.equal(value, false)
    assert.match(text, /^finish-pr: orch 작업 폴더를 옮기기 전이다\. 옛 위치가 남아 있다: \.omc\/handoffs\/specs$/m)
    assert.ok(text.includes(`python3 ${MIGRATE} --repo ${repo} --apply`), `옮기는 명령이 없다: ${text}`)
    assert.ok(text.includes('설정 파일을 --config 로 직접 준다'), `우회 방법 줄이 없다: ${text}`)
  })

  test('bypass 가 null 이면 우회 방법 줄을 쓰지 않는다', () => {
    write('.claude/orch-overlay.md', '# 오버레이\n')
    const { value, text } = captureStderr(() => requireMigrated(repo, 'orch_paths', null))
    assert.equal(value, false)
    assert.ok(!text.includes('옮기기 전에 꼭 돌려야 하면'), text)
  })

  test('warnLegacy 는 알리기만 한다', () => {
    write('.claude/orch-finish.json', '{}')
    const { text } = captureStderr(() => warnLegacy(repo, 'wait-important'))
    assert.ok(text.startsWith('wait-important: 옛 위치가 남아 있다(.claude/orch-finish.json)'), text)
    assert.ok(text.includes(`python3 ${MIGRATE} --repo ${repo} 로 옮긴다`), text)
  })
})
