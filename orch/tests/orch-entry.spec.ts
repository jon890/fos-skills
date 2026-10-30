// bin/orch.ts 진입점이 설치 기록에서 번들을 골라 스크립트를 부르는지 본다. 임시 설정 폴더와 가짜 번들만 쓴다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// 번들 하나. hello 스크립트가 자기 이름과 받은 인자, 종료 코드 요청을 낸다
function bundle(name: string): string {
  const root = join(tmp, 'cache', name)
  mkdirSync(join(root, 'orch', 'scripts'), { recursive: true })
  writeFileSync(
    join(root, 'orch', 'scripts', 'hello.ts'),
    `console.log('${name}', process.argv.slice(2).join(' '))\nprocess.exitCode = Number(process.env.HELLO_EXIT ?? 0)\n`,
  )
  return root
}

function install(configDir: string, entries: Entry[]): void {
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  const data = { version: 2, plugins: { 'fos-skills@fos-skills': entries, 'other@x': [{ scope: 'user', installPath: '/no' }] } }
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify(data))
}

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...extra, HOME: join(tmp, 'nohome') }
  for (const key of ['CLAUDE_CONFIG_DIR', 'ORCH_SCRIPTS_DIR']) if (!(key in extra)) delete base[key]
  // 직접 실행할 때 shebang 의 env 가 이 테스트의 node 를 찾게 한다
  base.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
  return base
}

function orch(args: string[], extra: Record<string, string> = {}, entry = ENTRY): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], { env: env(extra), encoding: 'utf8' })
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

  test('orch/scripts 가 없는 installPath 는 건너뛴다', () => {
    const config = join(tmp, 'profile')
    install(config, [
      { scope: 'user', installPath: join(tmp, 'cache', 'deleted') },
      { scope: 'project', installPath: bundle('alive') },
    ])
    const r = orch(['hello'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'alive')
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

  test('진입점 파일만 복사해 둔 사본도 설치 기록을 따라간다', () => {
    const config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('installed') }])
    const vendored = join(tmp, 'repo', '.orch', 'bin', 'orch.ts')
    mkdirSync(dirname(vendored), { recursive: true })
    copyFileSync(ENTRY, vendored)
    const r = orch(['hello', 'from-copy'], { CLAUDE_CONFIG_DIR: config }, vendored)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'installed from-copy')
  })

  test('설치 기록도 이 진입점의 번들도 없으면 3 이다', () => {
    const vendored = join(tmp, 'alone', 'orch.ts')
    mkdirSync(dirname(vendored), { recursive: true })
    copyFileSync(ENTRY, vendored)
    const r = orch(['hello'], { CLAUDE_CONFIG_DIR: join(tmp, 'empty') }, vendored)
    assert.equal(r.code, 3)
    assert.match(r.stderr, /orch\/scripts 를 찾지 못했다/)
  })

  test('ORCH_SCRIPTS_DIR 가 설치 기록보다 앞선다', () => {
    const config = join(tmp, 'profile')
    install(config, [{ scope: 'user', installPath: bundle('installed') }])
    const checkout = bundle('checkout')
    const r = orch(['hello'], { CLAUDE_CONFIG_DIR: config, ORCH_SCRIPTS_DIR: join(checkout, 'orch', 'scripts') })
    assert.equal(r.stdout.trim(), 'checkout')
    assert.equal(orch(['hello'], { CLAUDE_CONFIG_DIR: config, ORCH_SCRIPTS_DIR: join(tmp, 'nope') }).code, 3)
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
    assert.equal(r.stdout.trim(), join(tmp, 'cache', 'b', 'orch', 'scripts', 'hello.ts'))
  })

  test('--path 는 스크립트 폴더를 낸다', () => {
    assert.equal(orch(['--path'], { CLAUDE_CONFIG_DIR: config }).stdout.trim(), join(tmp, 'cache', 'b', 'orch', 'scripts'))
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
    assert.match(r.stderr, /쓸 수 있는 이름: hello$/m)
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
    assert.match(help.stdout, /^사용법: orch\.ts NAME/)
  })

  test('모르는 옵션과 --path 의 이름 둘은 2 다', () => {
    assert.equal(orch(['--nope'], { CLAUDE_CONFIG_DIR: config }).code, 2)
    assert.equal(orch(['--path', 'a', 'b'], { CLAUDE_CONFIG_DIR: config }).code, 2)
  })
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
    assert.equal(resolved(a).stdout.trim(), '/u/a/orch/bin/orch.ts')
    assert.equal(resolved(b).stdout.trim(), '/u/b/orch/bin/orch.ts')
  })

  test('풀린 경로의 진입점이 설치본의 스크립트를 부른다', () => {
    const config = join(tmp, 'profile')
    const root = bundle('real')
    mkdirSync(join(root, 'orch', 'bin'), { recursive: true })
    copyFileSync(ENTRY, join(root, 'orch', 'bin', 'orch.ts'))
    install(config, [{ scope: 'user', installPath: root }])
    const entry = resolved(config).stdout.trim()
    assert.equal(orch(['hello', 'via-snippet'], { CLAUDE_CONFIG_DIR: config }, entry).stdout.trim(), 'real via-snippet')
  })
})
