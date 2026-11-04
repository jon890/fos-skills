// bin/orch.ts 진입점이 설치 기록에서 번들을 골라 스크립트를 부르는지 본다. 임시 설정 폴더와 가짜 번들만 쓴다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))
const OWN_SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))

type Result = { code: number | null; stdout: string; stderr: string }
type Entry = { scope: string; installPath: string }

let tmp: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-entry-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// 번들 하나. 이 체크아웃의 진입점과 lib 사본을 넣어, 다른 번들에서 넘겨받은 진입점이 돌게 한다(lib: false 면 이 기능 이전 번들이다).
// hello 스크립트가 자기 이름과 받은 인자, 종료 코드 요청을 낸다. wait-important 와 orch-loop 는 새 꼴의 대상이 되는 같은 꼴의 가짜다.
// sleeper 는 ready 를 내고 신호를 기다린다
function bundle(name: string, opts: { base?: string; lib?: boolean } = {}): string {
  const root = join(opts.base ?? join(tmp, 'cache'), name)
  const scripts = join(root, 'skills', 'orch', 'scripts')
  mkdirSync(scripts, { recursive: true })
  const echo = `console.log('${name}', process.argv.slice(2).join(' '), 'hop=' + (process.env.ORCH_ENTRY_HOP ?? ''))\nprocess.exitCode = Number(process.env.HELLO_EXIT ?? 0)\n`
  writeFileSync(join(scripts, 'hello.ts'), `console.log('${name}', process.argv.slice(2).join(' '))\nprocess.exitCode = Number(process.env.HELLO_EXIT ?? 0)\n`)
  for (const fake of ['wait-important.ts', 'orch-loop.ts']) writeFileSync(join(scripts, fake), echo)
  writeFileSync(join(scripts, 'sleeper.ts'), "console.log('ready')\nsetInterval(() => {}, 1000)\n")
  if (opts.lib !== false) {
    mkdirSync(join(root, 'skills', 'orch', 'bin'), { recursive: true })
    copyFileSync(ENTRY, join(root, 'skills', 'orch', 'bin', 'orch.ts'))
    cpSync(join(OWN_SCRIPTS, 'lib'), join(scripts, 'lib'), { recursive: true })
    // lib 가 가져오는 work-board 모듈(lib/paths.ts 의 board.ts 같은 것)
    for (const dir of ['bin', 'hooks']) cpSync(join(OWN_SCRIPTS, '..', '..', '..', 'extensions', 'work-board', dir), join(root, 'extensions', 'work-board', dir), { recursive: true })
  }
  return root
}

function install(configDir: string, entries: Entry[]): void {
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  const data = { version: 2, plugins: { 'fos-skills@fos-skills': entries, 'other@x': [{ scope: 'user', installPath: '/no' }] } }
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify(data))
}

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  // 새 꼴의 문맥 채우기가 진짜 orca 의 run-current 를 읽지 않게 없는 실행 파일을 준다
  const base: NodeJS.ProcessEnv = { ...process.env, ORCA: join(tmp, 'no-orca'), ...extra, HOME: join(tmp, 'nohome') }
  for (const key of ['CLAUDE_CONFIG_DIR', 'ORCH_SCRIPTS_DIR', 'ORCH_CONTEXT', 'ORCH_ENTRY_HOP']) if (!(key in extra)) delete base[key]
  // 직접 실행할 때 shebang 의 env 가 이 테스트의 node 를 찾게 한다
  base.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
  return base
}

// 작업 폴더는 git 저장소 밖(임시 폴더)이다. 새 꼴이 이 체크아웃을 문맥 저장소로 읽지 않게 한다
function orch(args: string[], extra: Record<string, string> = {}, entry = ENTRY, cwd = tmp): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], { env: env(extra), encoding: 'utf8', cwd })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

describe('번들 고르기', () => {
  test('같은 진입점이 CLAUDE_CONFIG_DIR 마다 그 프로필의 설치본 스크립트를 부른다', () => {
    const a = join(tmp, 'profile-a')
    const b = join(tmp, 'profile with space', 'home')
    install(a, [{ scope: 'user', installPath: bundle('bundle-a') }])
    install(b, [{ scope: 'user', installPath: bundle('bundle-b') }])
    const first = orch(['hello', 'x', '--y'], { CLAUDE_CONFIG_DIR: a })
    const second = orch(['hello', 'x', '--y'], { CLAUDE_CONFIG_DIR: b })
    assert.equal(first.code, 0, first.stderr)
    assert.equal(first.stdout.trim(), 'bundle-a x --y')
    assert.equal(second.code, 0, second.stderr)
    assert.equal(second.stdout.trim(), 'bundle-b x --y')
  })

  test('설치 기록이 바뀌면 같은 진입점이 새 번들을 부른다', () => {
    const config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('v1') }])
    assert.equal(orch(['hello'], { CLAUDE_CONFIG_DIR: config }).stdout.trim(), 'v1')
    install(config, [{ scope: 'user', installPath: bundle('v2') }])
    assert.equal(orch(['hello'], { CLAUDE_CONFIG_DIR: config }).stdout.trim(), 'v2')
  })

  test('user scope 를 먼저 쓰고 같은 scope 안에서는 기록 순서를 지킨다', () => {
    const config = join(tmp, 'profile')
    install(config, [
      { scope: 'project', installPath: bundle('project') },
      { scope: 'user', installPath: bundle('user-1') },
      { scope: 'user', installPath: bundle('user-2') },
    ])
    assert.equal(orch(['hello'], { CLAUDE_CONFIG_DIR: config }).stdout.trim(), 'user-1')
  })

  test('user 범위 설치본에 skills/orch/scripts 가 없으면 project 범위로 넘어가지 않고 3 이다', () => {
    const config = join(tmp, 'profile')
    install(config, [
      { scope: 'user', installPath: join(tmp, 'cache', 'deleted') },
      { scope: 'project', installPath: bundle('alive') },
    ])
    const r = orch(['hello'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 3)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /user 범위 설치본 .*deleted 에 skills\/orch\/scripts 가 없다/)
    assert.match(r.stderr, /deleted\/skills\/orch\/bin\/orch\.ts/)
  })

  test('project 범위만 있으면 기록 순서로 스크립트가 있는 항목을 쓴다', () => {
    const config = join(tmp, 'profile')
    install(config, [
      { scope: 'project', installPath: join(tmp, 'cache', 'deleted') },
      { scope: 'project', installPath: bundle('alive') },
    ])
    const r = orch(['hello'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'alive')
  })

  test('옛 번들의 진입점으로 불러도 현재 설치본의 진입점이 돌고 STALE-BUNDLE 이 없다', () => {
    const config = join(tmp, 'profile')
    const cacheDir = join(tmp, 'plugins', 'cache', 'fos-skills', 'fos-skills')
    install(config, [{ scope: 'user', installPath: bundle('current', { base: cacheDir }) }])
    const old = bundle('old', { base: cacheDir })
    const r = orch(['hello', 'x'], { CLAUDE_CONFIG_DIR: config }, join(old, 'skills', 'orch', 'bin', 'orch.ts'))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'current x')
    assert.doesNotMatch(r.stderr, /STALE-BUNDLE/)
  })

  test('설치본이 이 기능 이전 번들이면 넘기지 않고 갱신을 안내하며 3 이다', () => {
    const config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('before', { lib: false }) }])
    const r = orch(['hello'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 3)
    assert.match(r.stderr, /새 진입점이 없다.*claude plugin update fos-skills@fos-skills/)
  })

  test('CLAUDE_CONFIG_DIR 가 없으면 ~/.claude 를 쓴다', () => {
    const home = join(tmp, 'h')
    install(join(home, '.claude'), [{ scope: 'user', installPath: bundle('home-bundle') }])
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'hello'], { env: { ...env({}), HOME: home }, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.equal(done.stdout.trim(), 'home-bundle')
  })

  test('설치 기록에 쓸 항목이 없으면 이 진입점이 든 번들을 쓰고 알린다', () => {
    const r = orch(['--path'], { CLAUDE_CONFIG_DIR: join(tmp, 'empty') })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), OWN_SCRIPTS)
    assert.match(r.stderr, /설치본을 찾지 못해 이 진입점이 든 번들을 쓴다/)
  })

  test('진입점 파일만 복사한 사본은 실행기 복사를 안내하고 3 이다', () => {
    const config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('installed') }])
    const vendored = join(tmp, 'repo', '.orch', 'bin', 'orch.ts')
    mkdirSync(dirname(vendored), { recursive: true })
    copyFileSync(ENTRY, vendored)
    const r = orch(['hello', 'from-copy'], { CLAUDE_CONFIG_DIR: config }, vendored)
    assert.equal(r.code, 3)
    assert.match(r.stderr, /진입점만 복사해 쓰지 않는다.*bin\/orch/)
  })

  test('ORCH_SCRIPTS_DIR 가 설치 기록보다 앞선다', () => {
    const config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('installed') }])
    const checkout = bundle('checkout')
    const r = orch(['hello'], { CLAUDE_CONFIG_DIR: config, ORCH_SCRIPTS_DIR: join(checkout, 'skills', 'orch', 'scripts') })
    assert.equal(r.stdout.trim(), 'checkout')
    assert.equal(orch(['hello'], { CLAUDE_CONFIG_DIR: config, ORCH_SCRIPTS_DIR: join(tmp, 'nope') }).code, 3)
  })

  test('ORCH_SCRIPTS_DIR 의 체크아웃 진입점이 그 체크아웃의 명령 표로 푼다', () => {
    const config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('installed') }])
    const checkout = bundle('checkout')
    const r = orch(['loop', 'start', '--x'], { CLAUDE_CONFIG_DIR: config, ORCH_SCRIPTS_DIR: join(checkout, 'skills', 'orch', 'scripts') })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'checkout --start --x hop=')
  })
})

describe('실행', () => {
  let config: string
  beforeEach(() => {
    config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('b') }])
  })

  test('NAME 과 NAME.ts 둘 다 받는다', () => {
    assert.equal(orch(['hello.ts', 'z'], { CLAUDE_CONFIG_DIR: config }).stdout.trim(), 'b z')
  })

  test('스크립트의 종료 코드를 그대로 낸다', () => {
    assert.equal(orch(['hello'], { CLAUDE_CONFIG_DIR: config, HELLO_EXIT: '7' }).code, 7)
  })

  test('shebang 으로 직접 실행된다', () => {
    assert.ok(statSync(ENTRY).mode & 0o111, '실행 권한이 없다')
    const done = spawnSync(ENTRY, ['hello', 'direct'], { env: env({ CLAUDE_CONFIG_DIR: config }), encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.equal(done.stdout.trim(), 'b direct')
  })

  test('지워진 작업 폴더에서 시작해도 스크립트가 끝까지 돈다', () => {
    const gone = join(tmp, 'gone')
    const done = spawnSync('sh', ['-c', 'mkdir "$GONE" && cd "$GONE" && rmdir "$GONE" && PWD="$GONE" exec "$@"', 'sh', process.execPath, '--disable-warning=ExperimentalWarning', ENTRY, 'hello', 'alive'], {
      env: { ...env({ CLAUDE_CONFIG_DIR: config }), GONE: gone },
      cwd: tmp,
      encoding: 'utf8',
    })
    assert.equal(done.status, 0, done.stderr)
    assert.equal(done.stdout.trim(), 'b alive')
  })

  test('--path NAME 은 스크립트 파일 경로를 내고 실행하지 않는다', () => {
    const r = orch(['--path', 'hello'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), join(tmp, 'cache', 'b', 'skills', 'orch', 'scripts', 'hello.ts'))
  })

  test('--path 는 스크립트 폴더를 낸다', () => {
    assert.equal(orch(['--path'], { CLAUDE_CONFIG_DIR: config }).stdout.trim(), join(tmp, 'cache', 'b', 'skills', 'orch', 'scripts'))
  })
})

describe('사용법 오류', () => {
  let config: string
  beforeEach(() => {
    config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('b') }])
  })

  test('없는 이름은 쓸 수 있는 이름을 알리고 2 다', () => {
    const r = orch(['nope'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /쓸 수 있는 이름: hello orch-loop sleeper wait-important$/m)
  })

  test('경로 구분자나 .. 이 든 이름은 거부한다', () => {
    for (const name of ['../x', 'a/b', '..', '-x.ts', '']) {
      const r = orch([name], { CLAUDE_CONFIG_DIR: config })
      assert.equal(r.code, 2, `${name}: ${r.stderr}`)
    }
  })

  test('인자가 없으면 2, --help 는 0 이다', () => {
    assert.equal(orch([], { CLAUDE_CONFIG_DIR: config }).code, 2)
    const help = orch(['--help'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(help.code, 0)
    assert.match(help.stdout, /^사용법: orch <묶음> <동작>/)
    assert.match(help.stdout, /orch loop start/)
  })

  test('모르는 옵션과 --path 의 이름 둘은 2 다', () => {
    assert.equal(orch(['--nope'], { CLAUDE_CONFIG_DIR: config }).code, 2)
    assert.equal(orch(['--path', 'a', 'b'], { CLAUDE_CONFIG_DIR: config }).code, 2)
  })
})

describe('새 꼴과 옛 꼴', () => {
  let config: string
  beforeEach(() => {
    config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('b') }])
  })

  test('새 꼴이 명령 표의 스크립트를 앞 인자와 함께 부르고 스크립트 자식에 ORCH_ENTRY_HOP 을 넘기지 않는다', () => {
    const r = orch(['loop', 'status', '--repo', '/r'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'b --status --repo /r hop=')
    assert.doesNotMatch(r.stderr, /새 꼴/)
  })

  test('옛 꼴은 같은 stdout 과 종료 코드를 내고 stderr 에 새 꼴을 한 줄 안내한다', () => {
    const fresh = orch(['wait', '--ack', 'd1', '--run', 'R'], { CLAUDE_CONFIG_DIR: config, HELLO_EXIT: '5' })
    const old = orch(['wait-important', '--ack', 'd1', '--run', 'R'], { CLAUDE_CONFIG_DIR: config, HELLO_EXIT: '5' })
    assert.equal(fresh.code, 5)
    assert.equal(old.code, fresh.code)
    assert.equal(old.stdout, fresh.stdout)
    assert.equal(old.stderr.split('\n').filter((l) => l === 'orch: 새 꼴: orch wait').length, 1)
    const loop = orch(['orch-loop.ts', '--start'], { CLAUDE_CONFIG_DIR: config })
    assert.match(loop.stderr, /^orch: 새 꼴: orch loop start$/m)
  })

  test('새 꼴은 옛 모드 플래그를 사용법 오류로 거부한다', () => {
    const r = orch(['loop', '--start'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 2)
    assert.equal(r.stdout, '')
    assert.equal(orch(['wait', '--ack-l', 'd'], { CLAUDE_CONFIG_DIR: config }).code, 2)
  })

  test('묶음의 --help 는 동작 목록을 낸다', () => {
    const r = orch(['loop', '--help'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /orch loop start/)
    assert.match(r.stdout, /orch loop stalled/)
  })

  test('--path 는 옛 이름을 명령 표로 푼다', () => {
    const r = orch(['--path', 'wait-important'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), join(tmp, 'cache', 'b', 'skills', 'orch', 'scripts', 'wait-important.ts'))
  })

  test('새 꼴은 작업 폴더 저장소를 채워 넘기고 stderr 에 출처를 남기며, 옛 꼴은 채우지 않는다', () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo)
    spawnSync('git', ['init', '-q', repo])
    const fresh = orch(['loop', 'status'], { CLAUDE_CONFIG_DIR: config }, ENTRY, repo)
    assert.equal(fresh.code, 0, fresh.stderr)
    assert.equal(fresh.stdout.trim(), `b --status --repo ${realpathSync(repo)} hop=`)
    assert.match(fresh.stderr, /^orch: 문맥 repo=.*\(작업 폴더\)$/m)
    const old = orch(['orch-loop', '--status'], { CLAUDE_CONFIG_DIR: config }, ENTRY, repo)
    assert.equal(old.stdout.trim(), 'b --status hop=')
    assert.doesNotMatch(old.stderr, /문맥/)
  })

  test('줄여 쓴 문맥 인자는 사용법 오류다', () => {
    assert.equal(orch(['loop', 'start', '--re', 'x'], { CLAUDE_CONFIG_DIR: config }).code, 2)
  })

  test('받은 SIGTERM 을 자식에게 전하고 143 으로 끝난다', async () => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'sleeper'], { env: env({ CLAUDE_CONFIG_DIR: config }) })
    let out = ''
    await new Promise<void>((done) => child.stdout.on('data', (d) => {
      out += String(d)
      if (out.includes('ready')) done()
    }))
    child.kill('SIGTERM')
    const code = await new Promise<number | null>((done) => child.on('close', (c) => done(c)))
    assert.equal(code, 143)
  })
})

test('git 저장소 밖에서 부르면 진입점은 repo 를 채우지 않고 스크립트가 --repo 를 요구한다', () => {
  const r = orch(['loop', 'status'], { ORCH_SCRIPTS_DIR: OWN_SCRIPTS })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--repo/)
  assert.doesNotMatch(r.stderr, /문맥 repo=/)
})

describe('overlay.md 의 진입점 경로 한 줄', () => {
  const OVERLAY = fileURLToPath(new URL('../references/overlay.md', import.meta.url))

  // 저장소 스크립트가 붙여 쓰는 줄. `ORCH=$(...) && "$ORCH" <명령>` 꼴이라 앞의 대입만 떼어 쓴다
  function resolver(): string {
    const m = /ORCH=\$\((node -e '.*?')\) && "\$ORCH"/.exec(readFileSync(OVERLAY, 'utf8'))
    assert.ok(m, 'overlay.md 에서 진입점을 푸는 줄을 찾지 못했다')
    return m[1]
  }

  function resolved(config: string): Result {
    const done = spawnSync('sh', ['-c', resolver()], { env: env({ CLAUDE_CONFIG_DIR: config }), encoding: 'utf8' })
    return { code: done.status, stdout: done.stdout, stderr: done.stderr }
  }

  test('설정 폴더마다 그 설치본의 진입점 경로를 낸다', () => {
    const a = join(tmp, 'profile-a')
    const b = join(tmp, 'profile with space', 'home')
    install(a, [{ scope: 'project', installPath: '/p/old' }, { scope: 'user', installPath: '/u/a' }])
    install(b, [{ scope: 'user', installPath: '/u/b' }])
    assert.equal(resolved(a).stdout.trim(), '/u/a/skills/orch/bin/orch.ts')
    assert.equal(resolved(b).stdout.trim(), '/u/b/skills/orch/bin/orch.ts')
  })

  test('풀린 경로의 진입점이 설치본의 스크립트를 부른다', () => {
    const config = join(tmp, 'profile')
    const root = bundle('real')
    mkdirSync(join(root, 'skills', 'orch', 'bin'), { recursive: true })
    copyFileSync(ENTRY, join(root, 'skills', 'orch', 'bin', 'orch.ts'))
    install(config, [{ scope: 'user', installPath: root }])
    const entry = resolved(config).stdout.trim()
    assert.equal(orch(['hello', 'via-snippet'], { CLAUDE_CONFIG_DIR: config }, entry).stdout.trim(), 'real via-snippet')
  })
})
