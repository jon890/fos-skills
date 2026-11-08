// help, doctor, driver, install 의 출력을 명령 경계에서 본다. 실제 브라우저는 열지 않는다.
// 설치된 백엔드는 PATH 의 가짜 실행 파일로 만들고, 사용자 홈은 임시 폴더다.
// 긴 출력은 fixtures/admin.json 에 옛 구현이 낸 글자를 적어 두고 같은지 본다(임시 경로는 <ROOT0> 로 가린다).

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Box, DRIVER_DIR, golden, mask, write, type EnvChange, type FakeRule, type T } from './helpers.ts'

function setup(t: T, installed: Record<string, FakeRule[]> = {}, env: EnvChange = {}) {
  const box = new Box(t)
  for (const [name, rules] of Object.entries(installed)) box.fake(name, rules)
  Object.assign(box.env, env)
  return box
}

const run = (box: Box, args: string[], extra: EnvChange = {}) => {
  const done = box.run(args, extra)
  return { ...done, stdout: mask(done.stdout, box.root), stderr: mask(done.stderr, box.root) }
}

describe('help', () => {
  const backends: [string, Record<string, FakeRule[]>, EnvChange][] = [
    ['help-none', {}, {}],
    ['help-ego', { 'ego-browser': [] }, {}],
    ['help-orca', { orca: [] }, {}],
    ['help-cmux', { cmux: [] }, { BROWSER_DRIVER: 'cmux' }],
    ['help-agent-browser', { 'agent-browser': [] }, { BROWSER_DRIVER: 'agent-browser' }],
    ['help-unknown', { orca: [] }, { BROWSER_DRIVER: 'nope' }],
  ]
  for (const [key, installed, env] of backends) {
    test(`${key} 출력이 같다`, (t) => {
      const box = setup(t, installed, env)
      const done = run(box, ['help'])
      assert.equal(done.code, 0)
      assert.equal(done.stderr, '')
      golden('admin.json', key, done.stdout)
    })
  }

  test('설정 파일이 깨졌어도 도움말은 나온다', (t) => {
    const box = setup(t)
    box.setConfig('{"driver"')
    const done = run(box, ['help'])
    assert.equal(done.code, 0)
    golden('admin.json', 'help-none', done.stdout)
  })

  test('인자 없이 부르면 같은 도움말을 내고 2 로 끝난다', (t) => {
    const box = setup(t, { orca: [] })
    const done = run(box, [])
    assert.equal(done.code, 2)
    golden('admin.json', 'help-orca', done.stdout)
  })
})

describe('doctor', () => {
  const cases: [string, Record<string, FakeRule[]>, EnvChange, unknown, number][] = [
    ['doctor-none', {}, {}, undefined, 2],
    ['doctor-ego-orca', { 'ego-browser': [], orca: [] }, {}, undefined, 0],
    ['doctor-orca', { orca: [] }, {}, undefined, 0],
    ['doctor-cmux-denied', { cmux: [{ stderr: 'Access denied\nsecond line\n', code: 1 }] }, {}, undefined, 0],
    ['doctor-cmux-silent', { cmux: [{ code: 1 }] }, {}, undefined, 0],
    ['doctor-cmux-ok', { cmux: [{ stdout: 'pong\n' }] }, {}, undefined, 0],
    ['doctor-agent-browser', { 'agent-browser': [] }, {}, undefined, 0],
    ['doctor-agent-browser-cdp', { 'agent-browser': [] }, {}, { cdpPort: 9222 }, 0],
    ['doctor-pinned', { 'ego-browser': [], orca: [], cmux: [], 'agent-browser': [] }, { BROWSER_DRIVER: 'cmux' }, undefined, 0],
    ['doctor-bogus', { orca: [] }, { BROWSER_DRIVER: 'bogus' }, undefined, 0],
    ['doctor-ego-profile', { 'ego-browser': [] }, { BROWSER_EGO_PROFILE: 'Profile 2' }, undefined, 0],
    ['doctor-ego-purpose', { 'ego-browser': [] }, { BROWSER_EGO_PURPOSE: 'work' }, { egoProfiles: { work: 'Profile 3' } }, 0],
    ['doctor-ego-default-profile', { 'ego-browser': [] }, {}, { egoProfiles: { default: 'Profile 9' } }, 0],
    ['doctor-ego-space', { 'ego-browser': [] }, { BROWSER_EGO_SPACE: ' 월 작업 ' }, undefined, 0],
    ['doctor-ego-bad-purpose', { 'ego-browser': [] }, { BROWSER_EGO_PURPOSE: 'x' }, { egoProfiles: { a: 'A' } }, 0],
    ['doctor-config-driver', { 'ego-browser': [], orca: [] }, {}, { driver: 'orca' }, 0],
  ]
  for (const [key, installed, env, config, code] of cases) {
    test(`${key} 출력이 같다`, (t) => {
      const box = setup(t, installed, env)
      if (config !== undefined) box.setConfig(config)
      const done = run(box, ['doctor'])
      assert.equal(done.code, code, done.stderr)
      assert.equal(done.stderr, '')
      golden('admin.json', key, done.stdout)
    })
  }

  test('설정 파일이 있으면 (없음) 표시가 빠진다', (t) => {
    const box = setup(t, { orca: [] })
    box.setConfig({})
    const out = run(box, ['doctor']).stdout
    assert.ok(out.includes('설정 파일: <ROOT0>/browser.config.json\n'))
    assert.ok(!out.includes('(없음, 자동 감지로 돈다)'))
  })

  test('못 쓰는 명령을 백엔드마다 나열한다', (t) => {
    const box = setup(t, { 'ego-browser': [], orca: [], cmux: [], 'agent-browser': [] })
    const out = run(box, ['doctor']).stdout
    assert.ok(out.includes('      못 쓰는 명령: console, errors, jsfile, worktree\n'))
    assert.ok(out.includes('      못 쓰는 명령: click, drag, hover, jsfile, pages, reset, spaces\n'))
    assert.ok(out.includes('      못 쓰는 명령: click, drag, hover, jsfile, pages, reset, spaces, worktree\n'))
  })
})

describe('driver 명령', () => {
  test('설치 여부와 상관없이 고른 이름을 낸다', (t) => {
    const box = setup(t, {}, { BROWSER_DRIVER: 'cmux' })
    assert.deepEqual([box.run(['driver']).code, box.run(['driver']).stdout], [0, 'cmux\n'])
  })

  test('백엔드가 없으면 2 로 끝난다', (t) => {
    const done = run(setup(t), ['driver'])
    assert.equal(done.code, 2)
    golden('admin.json', 'driver-none', done.stderr)
  })
})

describe('install', () => {
  const stripTarget = (text: string) => text.replace(/^(  ✓ .*\/browser-driver) → .*$/m, '$1 → <TARGET>').replace(/^(  cp ).*( '?<ROOT0>\/browser\.config\.json'?)$/m, '$1<EXAMPLE>$2')

  test('기본 위치에 링크를 걸고 안내를 낸다', (t) => {
    const box = setup(t, { orca: [] })
    const done = box.run(['install'])
    const scripts = join(box.home, '.claude/scripts')
    assert.equal(done.code, 0, done.stderr)
    assert.ok(lstatSync(join(scripts, 'browser-driver')).isSymbolicLink())
    const out = stripTarget(mask(done.stdout, box.root))
    assert.equal(
      out,
      '=== 브라우저 드라이버 설치 ===\n\n  ✓ <ROOT0>/home/.claude/scripts/browser-driver → <TARGET>\n\n백엔드 확인\n  ✓ orca (자동 감지)\n\n설정을 바꾸려면 예시를 복사해 고친다.\n' +
        "  mkdir -p <ROOT0>\n  cp <EXAMPLE> <ROOT0>/browser.config.json\n",
    )
    assert.equal(done.stderr, '')
  })

  // 옛 Python 구현은 링크를 driver/admin.py 로 걸고 예시 설정을 driver/ 아래에서 찾는 잘못이 있었다. README 의 「진입점을 연결한다」 와
  // 어긋난 버그라 새 구현은 문서대로 진입 파일과 폴더의 예시 설정을 가리킨다. 옛 구현에서 통과하지 않는 유일한 사례다.
  test('링크는 진입 파일을 가리키고 안내의 예시 설정은 드라이버 폴더에 있다', (t) => {
    const box = setup(t, { orca: [] })
    const done = box.run(['install'])
    const entry = realpathSync(join(DRIVER_DIR, 'browser_driver.ts'))
    const link = join(box.home, '.claude/scripts/browser-driver')
    assert.equal(readlinkSync(link), entry)
    assert.ok(done.stdout.includes(`  ✓ ${link} → ${entry}\n`))
    assert.ok(done.stdout.includes(`  cp ${join(DRIVER_DIR, 'browser.config.example.json')} ${box.config}\n`))
    // 링크로 부르면 실제로 돈다
    const run = box.run(['driver'], {}, { command: [process.execPath, link] })
    assert.deepEqual([run.code, run.stdout], [0, 'orca\n'])
  })

  test('백엔드가 없으면 안내를 내고 그래도 0 으로 끝난다', (t) => {
    const box = setup(t)
    const done = box.run(['install', '--dst', join(box.root, 'dst')])
    assert.equal(done.code, 0)
    const lines = done.stdout.split('\n')
    const at = lines.indexOf('백엔드 확인')
    assert.equal(lines[at + 1], '  ✗ 쓸 수 있는 백엔드가 없다')
    assert.ok(lines[at + 2].startsWith('    쓸 수 있는 브라우저 백엔드가 없다. ego lite(https://lite.ego.app/)를 먼저 설치한다.'))
  })

  test('--dst 폴더를 만들고 거기에 건다', (t) => {
    const box = setup(t, { orca: [] })
    const dst = join(box.root, 'a/b/c')
    const done = box.run(['install', '--dst', dst, '--ignored'])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(lstatSync(join(dst, 'browser-driver')).isSymbolicLink())
    assert.ok(!existsSync(join(box.home, '.claude/scripts')))
  })

  test('--dst 뒤에 값이 없으면 기본 위치를 쓴다', (t) => {
    const box = setup(t, { orca: [] })
    assert.equal(box.run(['install', '--dst']).code, 0)
    assert.ok(lstatSync(join(box.home, '.claude/scripts/browser-driver')).isSymbolicLink())
    const other = setup(t, { orca: [] })
    assert.equal(other.run(['install', 'x', '--dst', join(other.root, 'd')]).code, 0)
    assert.ok(lstatSync(join(other.home, '.claude/scripts/browser-driver')).isSymbolicLink())
  })

  test('--dst 의 ~ 는 홈으로 푼다', (t) => {
    const box = setup(t, { orca: [] })
    assert.equal(box.run(['install', '--dst', '~/mine']).code, 0)
    assert.ok(lstatSync(join(box.home, 'mine/browser-driver')).isSymbolicLink())
  })

  test('같은 이름의 실제 파일은 .bak.<pid> 로 옮긴 뒤 링크를 건다', (t) => {
    const box = setup(t, { orca: [] })
    const dst = join(box.root, 'dst')
    write(join(dst, 'browser-driver'), 'mine')
    const done = box.run(['install', '--dst', dst])
    const backups = readdirSync(dst).filter((name) => /^browser-driver\.bak\.\d+$/.test(name))
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(dst, backups[0]), 'utf8'), 'mine')
    assert.ok(done.stdout.includes(`  기존 파일을 ${join(dst, backups[0])} 로 백업\n`))
    assert.ok(lstatSync(join(dst, 'browser-driver')).isSymbolicLink())
  })

  test('폴더도 같은 방식으로 옮긴다', (t) => {
    const box = setup(t, { orca: [] })
    const dst = join(box.root, 'dst')
    mkdirSync(join(dst, 'browser-driver'), { recursive: true })
    assert.equal(box.run(['install', '--dst', dst]).code, 0)
    assert.ok(readdirSync(dst).some((name) => /^browser-driver\.bak\.\d+$/.test(name)))
  })

  test('기존 링크는 깨진 것도 조용히 바꾼다', (t) => {
    const box = setup(t, { orca: [] })
    const dst = join(box.root, 'dst')
    mkdirSync(dst, { recursive: true })
    symlinkSync('/no/such/target', join(dst, 'browser-driver'))
    const done = box.run(['install', '--dst', dst])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(!done.stdout.includes('백업'))
    assert.deepEqual(readdirSync(dst), ['browser-driver'])
    assert.notEqual(readlinkSync(join(dst, 'browser-driver')), '/no/such/target')
  })

  test('셸 시절의 낡은 링크는 지우고 실제 파일은 백업한다', (t) => {
    const box = setup(t, { orca: [] })
    const dst = join(box.root, 'dst')
    mkdirSync(dst, { recursive: true })
    symlinkSync('/somewhere', join(dst, 'orca-browser.sh'))
    write(join(dst, 'browser-driver.sh'), 'keep me')
    const done = box.run(['install', '--dst', dst])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes(`  ✓ 낡은 ${join(dst, 'orca-browser.sh')} 제거\n`))
    assert.ok(!existsSync(join(dst, 'orca-browser.sh')))
    const backup = readdirSync(dst).find((name) => /^browser-driver\.sh\.bak\.\d+$/.test(name))
    assert.ok(backup)
    assert.equal(readFileSync(join(dst, backup), 'utf8'), 'keep me')
    assert.ok(done.stdout.includes(`  기존 파일을 ${join(dst, backup)} 로 백업\n`))
    assert.ok(!done.stdout.includes('낡은 ' + join(dst, 'browser-driver.sh')))
  })

  test('설정 예시를 복사하라는 안내는 mkdir 이 cp 보다 앞이고 공백이 있는 경로를 따옴표로 감싼다', (t) => {
    const box = setup(t, { orca: [] })
    const config = join(box.root, "con fig", "it's.json")
    const done = box.run(['install', '--dst', join(box.root, 'd')], { BROWSER_CONFIG: config })
    const lines = done.stdout.split('\n')
    const mkdir = lines.findIndex((line) => line.startsWith('  mkdir -p '))
    const cp = lines.findIndex((line) => line.startsWith('  cp '))
    assert.ok(mkdir >= 0 && mkdir < cp)
    assert.equal(lines[mkdir], `  mkdir -p '${join(box.root, 'con fig')}'`)
    assert.ok(lines[cp].endsWith(` '${config.replaceAll("'", `'"'"'`)}'`))
    assert.ok(lines[cp].includes('browser.config.example.json'))
  })
})
