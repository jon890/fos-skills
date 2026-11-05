// 플러그인 루트의 실행기(bin/orch)와 install-cli 를 본다. 임시 설정 폴더와 가짜 번들만 쓴다.
// 번들 고르기는 lib/install-record.ts 와 같은 사례 표(fixtures/install-records.json)로 대조한다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CASES, layout } from './fixtures/install-records.ts'

const LAUNCHER = fileURLToPath(new URL('../../../bin/orch', import.meta.url))
const INSTALL = fileURLToPath(new URL('../scripts/doctor/install-cli.ts', import.meta.url))
const SHIM = fileURLToPath(new URL('../scripts/ts_shim.py', import.meta.url))

type Result = { code: number | null; stdout: string; stderr: string }
let tmp: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-launcher-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...extra, HOME: extra.HOME ?? join(tmp, 'nohome') }
  for (const key of ['CLAUDE_CONFIG_DIR', 'ORCH_SCRIPTS_DIR', 'ORCH_ENTRY_HOP']) if (!(key in extra)) delete base[key]
  return base
}

function launch(launcher: string, args: string[], extra: Record<string, string>): Result {
  const done = spawnSync(process.execPath, [launcher, ...args], { env: env(extra), encoding: 'utf8', cwd: tmp })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

// 가짜 진입점: 자기 번들 이름과 받은 인자, HELLO_EXIT 의 종료 코드를 낸다. lib/commands.ts 가 있어야 새 진입점으로 본다
function entry(bundle: string, name: string, body?: string): void {
  mkdirSync(join(bundle, 'skills', 'orch', 'bin'), { recursive: true })
  mkdirSync(join(bundle, 'skills', 'orch', 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(bundle, 'skills', 'orch', 'scripts', 'lib', 'commands.ts'), '')
  writeFileSync(
    join(bundle, 'skills', 'orch', 'bin', 'orch.ts'),
    body ?? `console.log(${JSON.stringify(name)}, process.argv.slice(2).join(' '))\nprocess.exitCode = Number(process.env.HELLO_EXIT ?? 0)\n`,
  )
}

function installRecord(config: string, entries: { scope: string; installPath: string }[]): void {
  mkdirSync(join(config, 'plugins'), { recursive: true })
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'fos-skills@fos-skills': entries } }))
}

describe('번들 고르기 사례 표', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { config, path } = layout(tmp, c)
      for (const name of c.bundles) entry(path(name), name)
      // own 번들의 플러그인 루트에 실행기를 둔다
      const own = join(path('own'), 'bin', 'orch')
      mkdirSync(dirname(own), { recursive: true })
      copyFileSync(LAUNCHER, own)
      const r = launch(own, ['x'], { CLAUDE_CONFIG_DIR: config })
      if ('error' in c.expect) {
        assert.equal(r.code, 3, r.stdout)
        assert.match(r.stderr, /claude plugin (update|install) fos-skills@fos-skills/)
      } else {
        assert.equal(r.code, 0, r.stderr)
        assert.equal(r.stdout.trim(), `${c.expect.bundle} x`)
      }
    })
  }
})

describe('넘기기', () => {
  test('user 범위 번들의 진입점에 인자와 종료 코드를 그대로 잇는다. 공백 있는 설정 폴더도 된다', () => {
    const config = join(tmp, 'profile with space', 'home')
    const bundle = join(tmp, 'cache', 'b')
    entry(bundle, 'b')
    installRecord(config, [{ scope: 'user', installPath: bundle }])
    const r = launch(LAUNCHER, ['loop', 'status', '--x'], { CLAUDE_CONFIG_DIR: config, HELLO_EXIT: '7' })
    assert.equal(r.code, 7)
    assert.equal(r.stdout.trim(), 'b loop status --x')
  })

  test('이 기능 이전 번들(명령 표 없음)이면 넘기지 않고 3 이다', () => {
    const config = join(tmp, 'profile')
    const bundle = join(tmp, 'cache', 'before')
    mkdirSync(join(bundle, 'skills', 'orch', 'scripts'), { recursive: true })
    installRecord(config, [{ scope: 'user', installPath: bundle }])
    const r = launch(LAUNCHER, ['loop', 'status'], { CLAUDE_CONFIG_DIR: config })
    assert.equal(r.code, 3)
    assert.match(r.stderr, /새 진입점이 없다.*claude plugin update/)
  })

  test('ORCH_SCRIPTS_DIR 이 있으면 그 체크아웃의 진입점에 넘긴다', () => {
    const checkout = join(tmp, 'checkout')
    entry(checkout, 'checkout')
    const r = launch(LAUNCHER, ['x'], { CLAUDE_CONFIG_DIR: join(tmp, 'none'), ORCH_SCRIPTS_DIR: join(checkout, 'skills', 'orch', 'scripts') })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'checkout x')
  })

  test('~/.local/bin 사본도 설치 기록을 따라가고, 기록이 없으면 설치를 안내한다', () => {
    const home = join(tmp, 'home')
    const copy = join(home, '.local', 'bin', 'orch')
    mkdirSync(dirname(copy), { recursive: true })
    copyFileSync(LAUNCHER, copy)
    const none = launch(copy, ['x'], { HOME: home })
    assert.equal(none.code, 3)
    assert.match(none.stderr, /claude plugin install fos-skills@fos-skills/)
    const bundle = join(tmp, 'cache', 'installed')
    entry(bundle, 'installed')
    installRecord(join(home, '.claude'), [{ scope: 'user', installPath: bundle }])
    const r = launch(copy, ['x'], { HOME: home })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'installed x')
  })

  test('받은 SIGTERM 을 자식에게 전하고 143 으로 끝난다', async () => {
    const config = join(tmp, 'profile')
    const bundle = join(tmp, 'cache', 's')
    entry(bundle, 's', "console.log('ready')\nsetInterval(() => {}, 1000)\n")
    installRecord(config, [{ scope: 'user', installPath: bundle }])
    const child = spawn(process.execPath, [LAUNCHER], { env: env({ CLAUDE_CONFIG_DIR: config }) })
    let out = ''
    await new Promise<void>((done) => child.stdout.on('data', (d) => {
      out += String(d)
      if (out.includes('ready')) done()
    }))
    child.kill('SIGTERM')
    assert.equal(await new Promise<number | null>((done) => child.on('close', (c) => done(c))), 143)
  })
})

describe('실행기 파일', () => {
  test('표지 주석이 둘째 줄에 있고 실행 비트가 있다', () => {
    const lines = readFileSync(LAUNCHER, 'utf8').split('\n')
    assert.equal(lines[0], '#!/usr/bin/env node')
    assert.equal(lines[1], '// fos-skills orch launcher')
    assert.ok(statSync(LAUNCHER).mode & 0o111, '실행 권한이 없다')
  })

  test('최소 Node 버전이 ts_shim.py 의 MIN_NODE 와 같다', () => {
    const launcher = /const MIN_NODE = \[(\d+), (\d+)\]/.exec(readFileSync(LAUNCHER, 'utf8'))
    const shim = /^MIN_NODE = \((\d+), (\d+)\)$/m.exec(readFileSync(SHIM, 'utf8'))
    assert.ok(launcher && shim)
    assert.deepEqual(launcher.slice(1), shim.slice(1))
  })
})

describe('install-cli', () => {
  function install(target: string): Result {
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', INSTALL, '--target', target], { env: env({}), encoding: 'utf8' })
    return { code: done.status, stdout: done.stdout, stderr: done.stderr }
  }

  test('새로 깔고, 같으면 그대로 두고, 표지 있는 옛 사본은 갱신한다', () => {
    const target = join(tmp, 'bin', 'orch')
    const first = install(target)
    assert.equal(first.code, 0, first.stderr)
    assert.equal(first.stdout.trim(), `CLI-INSTALLED ${target}`)
    assert.equal(statSync(target).mode & 0o777, 0o755)
    assert.equal(readFileSync(target, 'utf8'), readFileSync(LAUNCHER, 'utf8'))
    assert.equal(install(target).stdout.trim(), `CLI-CURRENT ${target}`)
    writeFileSync(target, '#!/usr/bin/env node\n// fos-skills orch launcher\n// old\n')
    assert.equal(install(target).stdout.trim(), `CLI-UPDATED ${target}`)
    assert.equal(readFileSync(target, 'utf8'), readFileSync(LAUNCHER, 'utf8'))
  })

  test('심볼릭 링크는 표지가 있어도 따라가 덮지 않고 CLI-CONFLICT 와 1 이다', () => {
    const real = join(tmp, 'other-checkout', 'bin', 'orch')
    mkdirSync(dirname(real), { recursive: true })
    writeFileSync(real, '#!/usr/bin/env node\n// fos-skills orch launcher\n// other\n')
    const target = join(tmp, 'bin', 'orch')
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(real, target)
    const r = install(target)
    assert.equal(r.code, 1)
    assert.equal(r.stdout.trim(), `CLI-CONFLICT ${target}`)
    assert.equal(readFileSync(real, 'utf8'), '#!/usr/bin/env node\n// fos-skills orch launcher\n// other\n')
  })

  test('대상이 없는 링크도 따라가 쓰지 않는다', () => {
    const target = join(tmp, 'bin', 'orch')
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(join(tmp, 'nowhere', 'orch'), target)
    const r = install(target)
    assert.equal(r.code, 1)
    assert.equal(r.stdout.trim(), `CLI-CONFLICT ${target}`)
    assert.equal(existsSync(join(tmp, 'nowhere', 'orch')), false)
  })

  test('표지 없는 다른 orch 는 덮지 않고 CLI-CONFLICT 와 1 이다', () => {
    const target = join(tmp, 'bin', 'orch')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '#!/bin/sh\necho other\n')
    const r = install(target)
    assert.equal(r.code, 1)
    assert.equal(r.stdout.trim(), `CLI-CONFLICT ${target}`)
    assert.equal(readFileSync(target, 'utf8'), '#!/bin/sh\necho other\n')
  })
})
