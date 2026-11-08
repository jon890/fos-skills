// 설정 파일 경로 결정, config-path 명령, 설치 캐시 배치, 미리보기의 경로 조회를 명령 경계에서 본다.
// HOME 과 CLAUDE_CONFIG_DIR 는 임시 폴더로 바꾼다. 실제 브라우저는 열지 않는다.
// 설치 캐시 배치는 드라이버 폴더를 임시 폴더의 plugins/cache/m/p/1.0.0/<자리> 로 복사해 그 사본의 진입을 부른다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Box, commandIn, DRIVER_DIR, tempDir, write, type EnvChange, type T } from './helpers.ts'

const PLACES = ['skills/browser/browser-driver', 'tools/browser-driver']

function copyDriver(dest: string): string {
  mkdirSync(join(dest, '..'), { recursive: true })
  cpSync(DRIVER_DIR, dest, { recursive: true, filter: (src) => !/\/(tests|__pycache__|node_modules)(\/|$)/.test(src.slice(DRIVER_DIR.length)) })
  return dest
}

class Layout {
  readonly box: Box
  readonly root: string
  readonly driver: string
  data: string
  readonly claude: string
  readonly legacy: string

  constructor(t: T, opts: { codex?: boolean; place?: string } = {}) {
    this.box = new Box(t)
    this.root = this.box.root
    this.driver = copyDriver(join(this.root, 'plugins/cache/m/p/1.0.0', opts.place ?? PLACES[0]))
    this.claude = join(this.root, 'claude-home')
    this.data = join(this.root, 'plugins/data/p-m')
    this.legacy = join(this.box.home, '.claude/browser.config.json')
    // 기본은 BROWSER_CONFIG 를 주지 않고 CLAUDE_CONFIG_DIR 만 임시 폴더로 둔다
    this.box.env.BROWSER_CONFIG = undefined
    this.box.env.CLAUDE_CONFIG_DIR = this.claude
    if (opts.codex) {
      write(join(this.root, 'config.toml'))
      this.data = join(this.claude, 'plugins/data/p-m')
    }
  }

  putData(): string {
    return write(join(this.data, 'browser.config.json'), '{}')
  }

  // 설치 캐시 사본(또는 command 로 준 진입)에 명령을 준다
  run(args: string[], extra: EnvChange = {}, command = commandIn(this.driver)) {
    return this.box.run(args, extra, { command })
  }

  configPath(extra: EnvChange = {}, command = commandIn(this.driver)): string {
    const done = this.run(['config-path'], extra, command)
    assert.equal(done.code, 0, done.stderr)
    return done.stdout.replace(/\n$/, '')
  }
}

describe('설치 캐시의 설정 경로', () => {
  for (const place of PLACES) {
    test(`${place} 배치에서 데이터 폴더의 설정을 쓴다`, (t) => {
      const lay = new Layout(t, { place })
      const expected = lay.putData()
      assert.equal(lay.configPath(), expected)
    })
  }

  test('데이터 폴더에 설정이 없으면 옛 위치다', (t) => {
    const lay = new Layout(t)
    assert.equal(lay.configPath(), lay.legacy)
  })

  test('BROWSER_CONFIG 가 데이터 폴더보다 앞선다', (t) => {
    const lay = new Layout(t)
    lay.putData()
    assert.equal(lay.configPath({ BROWSER_CONFIG: '/x/y.json' }), '/x/y.json')
  })

  test('설치 캐시 밖의 복사본은 캐시 판정을 받지 않는다', (t) => {
    const lay = new Layout(t)
    lay.putData()
    const outside = copyDriver(join(lay.root, 'checkout/tools/browser-driver'))
    // 캐시 밖이라 Claude 설정 폴더의 plugins/data/*/ 후보를 찾는데 이 사례는 데이터 폴더가 설정 폴더 밖에 있다
    assert.equal(lay.configPath({}, commandIn(outside)), lay.legacy)
  })

  test('캐시 배치가 아닌 이름 조합은 캐시로 보지 않는다', (t) => {
    const lay = new Layout(t)
    lay.putData()
    for (const dir of ['plugins/cache/m/p/1.0.0/skills/browser/other', 'plugins/cache/m/p/skills/browser/browser-driver', 'plugins/cache/m/p/1.0.0/x/skills/browser/browser-driver/..', 'cache/m/p/1.0.0/tools/browser-driver', 'plugins/cache/m/1.0.0/tools/browser-driver']) {
      const copy = copyDriver(join(lay.root, 'alt', dir.replace(/\/\.\.$/, '')))
      assert.equal(lay.configPath({}, commandIn(copy)), lay.legacy, dir)
    }
  })

  test('심볼릭 링크로 불려도 실체 경로로 판정한다', (t) => {
    const lay = new Layout(t)
    const expected = lay.putData()
    const link = join(lay.root, 'link')
    symlinkSync(lay.driver, link)
    assert.equal(lay.configPath({}, commandIn(link)), expected)
  })

  test('데이터 폴더를 만들지 않는다', (t) => {
    const lay = new Layout(t)
    lay.configPath()
    assert.ok(!existsSync(lay.data))
  })

  test('다른 플러그인의 설정을 고르지 않는다', (t) => {
    const lay = new Layout(t)
    write(join(lay.claude, 'plugins/data/other-m/browser.config.json'), '{}')
    // 캐시 안이면 후보 목록을 보지 않는다
    assert.equal(lay.configPath(), lay.legacy)
  })
})

describe('캐시 밖의 설정 경로', () => {
  function checkout(t: T) {
    const lay = new Layout(t)
    const put = (plugin = 'p-m', data: unknown = {}) => write(join(lay.claude, 'plugins/data', plugin, 'browser.config.json'), JSON.stringify(data))
    // 이 저장소의 드라이버 폴더 자체를 부른다
    const run = (args: string[], extra: EnvChange = {}) => lay.box.run(args, extra)
    return { lay, put, run }
  }

  test('후보가 하나면 옛 위치가 있어도 그것을 쓰고 옛 위치는 건드리지 않는다', (t) => {
    const { lay, put, run } = checkout(t)
    const expected = put()
    write(lay.legacy, '{"legacy": true}')
    const done = run(['config-path'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, `${expected}\n`, ''])
    assert.equal(readFileSync(lay.legacy, 'utf8'), '{"legacy": true}')
  })

  test('후보가 여럿이면 정렬한 목록을 경고하고 옛 위치를 쓴다', (t) => {
    const { lay, put, run } = checkout(t)
    const second = put('z-m')
    const first = put('a-m')
    const done = run(['config-path'])
    assert.deepEqual([done.code, done.stdout], [0, `${lay.legacy}\n`])
    assert.equal(
      done.stderr,
      `경고: 설치 캐시 밖에서 플러그인 데이터 설정 후보가 여러 개여서 옛 위치 사용: ${lay.legacy}\n후보 목록:\n  ${first}\n  ${second}\n쓸 파일을 BROWSER_CONFIG 로 지정한다.\n`,
    )
    assert.ok(!existsSync(lay.legacy))
  })

  test('경고는 config-path 가 아닌 명령에서도 나온다', (t) => {
    const { put, run } = checkout(t)
    put('z-m')
    put('a-m')
    const done = run(['help'])
    assert.equal(done.code, 0)
    assert.ok(done.stderr.startsWith('경고: '))
  })

  test('후보가 없으면 옛 위치를 쓰고 폴더를 만들지 않는다', (t) => {
    const { lay, run } = checkout(t)
    const done = run(['config-path'])
    assert.deepEqual([done.stdout, done.stderr], [`${lay.legacy}\n`, ''])
    assert.ok(!existsSync(join(lay.box.home, '.claude')))
    assert.ok(!existsSync(lay.claude))
  })

  test('옛 위치가 링크여도 그대로 둔다', (t) => {
    const { lay, put, run } = checkout(t)
    const cfg = put()
    mkdirSync(join(lay.box.home, '.claude'), { recursive: true })
    symlinkSync(cfg, lay.legacy)
    assert.equal(run(['config-path']).stdout, `${cfg}\n`)
    assert.ok(lstatSync(lay.legacy).isSymbolicLink())
  })

  test('BROWSER_CONFIG 는 없는 파일이고 후보가 애매해도 앞선다', (t) => {
    const { lay, put, run } = checkout(t)
    put('a-m')
    put('z-m')
    const chosen = join(lay.root, 'chosen.json')
    const done = run(['config-path'], { BROWSER_CONFIG: chosen })
    assert.deepEqual([done.stdout, done.stderr], [`${chosen}\n`, ''])
  })

  test('CLAUDE_CONFIG_DIR 가 없거나 비면 홈의 .claude 를 본다', (t) => {
    const { lay, run } = checkout(t)
    const cfg = write(join(lay.box.home, '.claude/plugins/data/p-m/browser.config.json'), '{}')
    for (const value of [undefined, '']) assert.equal(run(['config-path'], { CLAUDE_CONFIG_DIR: value }).stdout, `${cfg}\n`, JSON.stringify(value))
  })

  test('CLAUDE_CONFIG_DIR 의 ~ 와 상대 경로를 푼다', (t) => {
    const { lay, run } = checkout(t)
    const tilde = write(join(lay.box.home, 'c/plugins/data/p-m/browser.config.json'), '{}')
    assert.equal(run(['config-path'], { CLAUDE_CONFIG_DIR: '~/c' }).stdout, `${tilde}\n`)
    const rel = write(join(lay.root, 'cwd/rel/dir/plugins/data/p-m/browser.config.json'), '{}')
    const done = lay.box.run(['config-path'], { CLAUDE_CONFIG_DIR: 'rel/dir' }, { cwd: join(lay.root, 'cwd') })
    assert.equal(done.stdout, `${rel}\n`)
  })

  test('browser.config.json 이라는 이름의 폴더는 후보가 아니다', (t) => {
    const { lay, put, run } = checkout(t)
    const expected = put()
    mkdirSync(join(lay.claude, 'plugins/data/q-m/browser.config.json'), { recursive: true })
    assert.equal(run(['config-path']).stdout, `${expected}\n`)
  })

  test('doctor 는 고른 경로와 근거를 설명한다', (t) => {
    const { lay, put, run } = checkout(t)
    const expected = put()
    lay.box.systemPath = false
    const done = run(['doctor'], { BROWSER_DRIVER: 'ego', PATH: '' })
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes(`설정 파일: ${expected}\n`))
    assert.ok(done.stdout.includes('설정 판정: 설치 캐시 밖에서 플러그인 데이터 설정 후보가 하나\n'))
  })

  test('doctor 는 애매한 후보와 옛 위치로의 되돌림을 설명한다', (t) => {
    const { lay, put, run } = checkout(t)
    put('a-m')
    put('z-m')
    const done = run(['doctor'], { BROWSER_DRIVER: 'ego' })
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes(`설정 파일: ${lay.legacy}  (없음, 자동 감지로 돈다)\n`))
    assert.ok(done.stdout.includes('설정 판정: 설치 캐시 밖에서 플러그인 데이터 설정 후보가 여러 개여서 옛 위치 사용\n'))
  })
})

describe('Codex 설치본', () => {
  test('config.toml 파일이 있으면 데이터 폴더는 Claude 설정 폴더 아래다', (t) => {
    const lay = new Layout(t, { codex: true })
    const expected = lay.putData()
    assert.equal(lay.configPath(), expected)
    assert.ok(expected.startsWith(lay.claude))
  })

  test('데이터 파일이 없으면 옛 위치다', (t) => {
    const lay = new Layout(t, { codex: true })
    assert.equal(lay.configPath(), lay.legacy)
  })

  test('config.toml 이 폴더이면 Claude Code 설치본이다', (t) => {
    const lay = new Layout(t, { codex: true })
    rmSync(join(lay.root, 'config.toml'))
    mkdirSync(join(lay.root, 'config.toml'))
    const expected = write(join(lay.root, 'plugins/data/p-m/browser.config.json'), '{}')
    assert.equal(lay.configPath(), expected)
  })

  test('CLAUDE_CONFIG_DIR 가 비면 홈의 .claude 를 쓴다', (t) => {
    const lay = new Layout(t, { codex: true })
    const expected = write(join(lay.box.home, '.claude/plugins/data/p-m/browser.config.json'), '{}')
    for (const value of ['', undefined]) assert.equal(lay.configPath({ CLAUDE_CONFIG_DIR: value }), expected, JSON.stringify(value))
  })

  test('상대 경로인 CLAUDE_CONFIG_DIR 는 절대 경로가 된다', (t) => {
    const lay = new Layout(t, { codex: true })
    const cwd = join(lay.root, 'cwd')
    mkdirSync(cwd)
    const expected = write(join(cwd, 'rel/dir/plugins/data/p-m/browser.config.json'), '{}')
    const done = lay.box.run(['config-path'], { CLAUDE_CONFIG_DIR: 'rel/dir' }, { command: commandIn(lay.driver), cwd })
    assert.equal(done.stdout, `${expected}\n`)
  })

  test('폴더를 만들지 않는다', (t) => {
    const lay = new Layout(t, { codex: true })
    lay.configPath()
    assert.ok(!existsSync(lay.claude))
  })
})

describe('config-path 명령', () => {
  test('한 줄을 내고 파일이 없어도 0 으로 끝난다', (t) => {
    const box = new Box(t)
    box.env.BROWSER_CONFIG = undefined
    const done = box.run(['config-path'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, `${join(box.home, '.claude/browser.config.json')}\n`, ''])
  })

  test('BROWSER_CONFIG 의 값은 공백이 있어도 그대로 낸다', (t) => {
    const box = new Box(t)
    const done = box.run(['config-path'], { BROWSER_CONFIG: '/tmp/with space/x.json' })
    assert.equal(done.stdout, '/tmp/with space/x.json\n')
  })

  test('BROWSER_CONFIG 가 비면 없는 것으로 본다', (t) => {
    const box = new Box(t)
    box.env.BROWSER_CONFIG = undefined
    assert.equal(box.run(['config-path'], { BROWSER_CONFIG: '' }).stdout, `${join(box.home, '.claude/browser.config.json')}\n`)
  })

  test('help 가 명령을 나열한다', (t) => {
    assert.ok(new Box(t).run(['help']).stdout.includes('config-path'))
  })
})

describe('프로필 설정 안내', () => {
  function profileBox(t: T) {
    const lay = new Layout(t)
    lay.box.env.BROWSER_DRIVER = 'ego'
    lay.box.env.BROWSER_EGO_PURPOSE = 'personal'
    lay.box.fake('ego-browser')
    return lay
  }
  const put = (lay: Layout, plugin: string, data: unknown = {}) => write(join(lay.claude, 'plugins/data', plugin, 'browser.config.json'), JSON.stringify(data))

  // 이 저장소 드라이버를 캐시 밖에서 부르는 사례다
  function open(lay: Layout, extra: EnvChange = {}) {
    return lay.box.run(['open', 'about:blank'], extra)
  }

  function guidance(lay: Layout, selected: string, reason: string, searched: string[]): string {
    return (
      `\n설정 파일: ${selected}\n설정 판정: ${reason}\n찾아본 경로:\n${searched.map((p) => `  ${p}`).join('\n')}` +
      '\negoProfiles 가 있는 설정 파일을 BROWSER_CONFIG 로 지정한다.\n  export BROWSER_CONFIG="/실제/설정/browser.config.json"' +
      `\n옛 위치가 없으면 지정한 파일에 링크를 건다:\n  ln -s "$BROWSER_CONFIG" ${lay.legacy}`
    )
  }

  const head = 'BROWSER_EGO_PURPOSE=personal 에 해당하는 프로필이 설정에 없다. 쓸 수 있는 용도: '

  test('설정이 없으면 찾아본 경로와 복구 명령을 안내한다', (t) => {
    const lay = profileBox(t)
    const done = open(lay)
    assert.equal(done.code, 2)
    const searched = [join(lay.claude, 'plugins/data/*/browser.config.json'), lay.legacy]
    assert.equal(done.stderr, `${head}(설정에 egoProfiles 가 없다)${guidance(lay, lay.legacy, '설치 캐시 밖에서 플러그인 데이터 설정 후보가 없어 옛 위치 사용', searched)}\n`)
  })

  test('고른 설정에 egoProfiles 가 없거나 비어 있어도 안내한다', (t) => {
    for (const data of [{}, { egoProfiles: {} }, { egoProfiles: [] }, { egoProfiles: null }]) {
      const lay = profileBox(t)
      const cfg = put(lay, 'p-m', data)
      const done = open(lay)
      assert.equal(done.code, 2, JSON.stringify(data))
      const searched = [join(lay.claude, 'plugins/data/*/browser.config.json'), cfg]
      assert.equal(done.stderr, `${head}(설정에 egoProfiles 가 없다)${guidance(lay, cfg, '설치 캐시 밖에서 플러그인 데이터 설정 후보가 하나', searched)}\n`, JSON.stringify(data))
    }
  })

  test('후보가 여럿이면 모두 나열하고 옛 위치를 보인다', (t) => {
    const lay = profileBox(t)
    const first = put(lay, 'a-m')
    const second = put(lay, 'z-m')
    const done = open(lay)
    assert.equal(done.code, 2)
    const searched = [join(lay.claude, 'plugins/data/*/browser.config.json'), first, second, lay.legacy]
    assert.ok(done.stderr.includes(guidance(lay, lay.legacy, '설치 캐시 밖에서 플러그인 데이터 설정 후보가 여러 개여서 옛 위치 사용', searched)))
    assert.ok(done.stderr.startsWith('경고: '))
  })

  test('BROWSER_CONFIG 로 고른 없는 파일이면 그 경로만 찾아본다', (t) => {
    const lay = profileBox(t)
    const selected = join(lay.root, 'missing.json')
    const done = open(lay, { BROWSER_CONFIG: selected })
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `${head}(설정에 egoProfiles 가 없다)${guidance(lay, selected, '환경변수 BROWSER_CONFIG', [selected])}\n`)
    assert.ok(!done.stderr.includes('plugins/data/*'))
  })

  test('용도 목록이 있으면 정렬해 보이고 안내는 붙이지 않는다', (t) => {
    const lay = profileBox(t)
    put(lay, 'p-m', { egoProfiles: { work: 'Profile 2', default: 'Default', alpha: 'A' } })
    const done = open(lay)
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `${head}alpha, default, work\n`)
  })

  test('고른 후보의 용도 프로필을 쓴다', (t) => {
    const lay = profileBox(t)
    put(lay, 'p-m', { egoProfiles: { personal: 'Default' } })
    const done = lay.box.run(['doctor'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('프로필 해석: Default (BROWSER_EGO_PURPOSE=personal → egoProfiles.personal)'))
  })

  test('egoProfiles 가 객체가 아니면 2 로 끝난다', (t) => {
    for (const value of [[1], 'x', 5, true]) {
      const lay = profileBox(t)
      put(lay, 'p-m', { egoProfiles: value })
      const done = open(lay, { BROWSER_EGO_PURPOSE: undefined })
      assert.equal(done.code, 2, JSON.stringify(value))
      assert.equal(done.stderr, '설정의 egoProfiles 는 용도와 프로필을 잇는 객체여야 한다\n')
    }
  })

  test('프로필을 직접 주면 설정을 읽지 않는다', (t) => {
    const lay = profileBox(t)
    const done = open(lay, { BROWSER_EGO_PROFILE: 'Direct' })
    assert.ok(!done.stderr.includes('쓸 수 있는 용도'))
  })
})

describe('미리보기의 설정 경로 조회', () => {
  const CANDIDATES = [
    join(DRIVER_DIR, '..', '..', '..', 'export-only-skills', 'content-preview', 'scripts', 'show-preview.ts'),
    join(DRIVER_DIR, '..', '..', 'skills', 'content-preview', 'scripts', 'show-preview.ts'),
  ]
  const SHOW_PREVIEW = CANDIDATES.find((p) => existsSync(p))

  function setup(t: T) {
    const base = tempDir(t)
    const html = write(join(base, 'p.html'), '<p>x</p>')
    const log = join(base, 'driver.log')
    const shim = join(base, 'shim')
    for (const name of ['open', 'osascript', 'xdg-open']) write(join(shim, name), '#!/bin/sh\nexit 0\n', 0o755)
    // answer 가 null 이면 config-path 를 모르는 드라이버처럼 2 로 끝난다
    const driver = (answer: string | null) => {
      const path = join(base, 'fake-driver')
      const reply = answer === null ? 'exit 2' : `echo ${answer}; exit 0`
      write(path, `#!/bin/sh\necho "BD=$BROWSER_DRIVER" >> ${log}\n[ "$1" = config-path ] && { ${reply}; }\nexit 1\n`, 0o755)
      return path
    }
    const config = (name: string, previewDriver: string) => write(join(base, name), JSON.stringify({ previewDriver }))
    const run = (driverPath: string, extra: EnvChange = {}) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${shim}:/usr/bin:/bin`, HOME: join(base, 'home'), BROWSER_DRIVER_PATH: driverPath }
      for (const key of ['BROWSER_CONFIG', 'PREVIEW_BROWSER_DRIVER']) delete env[key]
      for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value
      const done = spawnSync(process.execPath, [SHOW_PREVIEW!, html], { env, encoding: 'utf8', timeout: 60_000 })
      return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
    }
    return { base, log, driver, config, run }
  }

  test('드라이버에게 설정 경로를 묻는다', (t) => {
    if (!SHOW_PREVIEW) return t.skip('show-preview.ts 를 두 배치 어디에서도 찾지 못했다')
    const s = setup(t)
    const done = s.run(s.driver(s.config('from-driver.json', 'orca')))
    assert.equal(done.code, 0, done.stderr)
    assert.ok(readFileSync(s.log, 'utf8').includes('BD=orca'))
  })

  test('BROWSER_CONFIG 가 드라이버의 답보다 앞선다', (t) => {
    if (!SHOW_PREVIEW) return t.skip('show-preview.ts 를 두 배치 어디에서도 찾지 못했다')
    const s = setup(t)
    const fromDriver = s.config('from-driver.json', 'orca')
    const fromEnv = s.config('from-env.json', 'cmux')
    const done = s.run(s.driver(fromDriver), { BROWSER_CONFIG: fromEnv })
    assert.equal(done.code, 0, done.stderr)
    assert.ok(readFileSync(s.log, 'utf8').includes('BD=cmux'))
  })

  test('config-path 를 모르는 옛 드라이버와도 돈다', (t) => {
    if (!SHOW_PREVIEW) return t.skip('show-preview.ts 를 두 배치 어디에서도 찾지 못했다')
    const s = setup(t)
    const done = s.run(s.driver(null))
    assert.equal(done.code, 0, done.stderr)
    assert.ok(!done.stderr.includes('config-path'))
  })
})
