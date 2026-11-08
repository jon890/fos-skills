// content-preview 의 show-preview 명령 경계 테스트. 드라이버를 고르는 순서, 탭을 다시 쓰는 흐름, 워크트리 대조,
// 설정 파일의 previewDriver, 기본 브라우저로 내려가는 단계를 가짜 드라이버·osascript·open·uname 으로 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다. 실제 브라우저와 드라이버에는 닿지 않는다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { copyScripts, linkFake, linkTools, lines, realPython, run, tempDir, write } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const command = (scripts: string) => [process.execPath, join(scripts, 'show-preview.ts')]
// ──

type T = { after(fn: () => void): void }

// 서브명령별 셸 조각. 없는 서브명령은 종료 코드 1 이다
type Handlers = Partial<Record<'url' | 'worktree' | 'nav' | 'open' | 'close' | 'config-path', string>>

function setup(t: T, opts: { git?: boolean } = {}) {
  const root = tempDir('show-preview-', t)
  const scripts = copyScripts(root)
  const log = join(root, 'calls.log')
  const osaIn = join(root, 'osascript.in')
  const home = join(root, 'home')
  mkdirSync(home)
  const work = join(root, 'work')
  mkdirSync(work)
  const wantDir = join(root, 'worktree')
  mkdirSync(wantDir)
  const html = write(join(work, 'p.html'), '<p>x</p>')
  const shim = join(root, 'shim')
  for (const name of ['uname', 'open', 'xdg-open', 'osascript'] as const) linkFake(join(shim, name), name)
  const python = realPython()
  if (python) symlinkSync(python, join(shim, 'python3'))
  if (opts.git) run(['git', 'init', '-q', wantDir])
  const env = { ...process.env, HOME: home, PATH: `${shim}:${process.env.PATH}`, ORCA_WORKTREE: `path:${wantDir}`, FAKE_LOG: log, FAKE_OSA_IN: osaIn } as NodeJS.ProcessEnv
  for (const name of ['BROWSER_CONFIG', 'PREVIEW_BROWSER_DRIVER', 'BROWSER_DRIVER_PATH', 'BROWSER_DRIVER', 'FAKE_UNAME', 'OPEN_RC', 'XDG_RC', 'CHROME', 'EDGE', 'BRAVE', 'SAFARI']) delete env[name]
  // 가짜 드라이버를 path 에 놓고 서브명령별 응답(셸 조각)을 환경 변수로 정한다
  const driverEnv: NodeJS.ProcessEnv = {}
  const driver = (path: string, handlers: Handlers) => {
    for (const [name, body] of Object.entries(handlers)) driverEnv[`FAKE_${name.toUpperCase().replace('-', '_')}`] = body
    return linkFake(path, 'driver')
  }
  const exec = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = work) => run([...command(scripts), ...args], { cwd, env: { ...env, ...driverEnv, ...extra, PWD: cwd } })
  return { root, scripts, log, osaIn, home, work, wantDir, html, shim, env, driver, exec, tabid: `${html}.tabid`, url: `file://${html}` }
}

// 링크를 실행 권한 없는 파일로 바꾼다. chmod 는 링크가 가리키는 공용 가짜 파일을 바꾸므로 쓰지 않는다
function disable(path: string): void {
  rmSync(path)
  write(path, '#!/bin/sh\nexit 0\n', 0o644)
}

// 드라이버가 정상일 때의 기본 응답. 열면 page id P1, worktree 는 사용자가 보는 곳이다
const OK = (want: string): Handlers => ({ url: 'exit 0', worktree: `echo ${want}; exit 0`, nav: 'exit 0', open: 'echo P1; exit 0', close: 'exit 0' })

describe('show-preview 인자', () => {
  test('경로가 없으면 1', (t) => {
    const s = setup(t)
    const done = s.exec([])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('미리보기 HTML 경로가 필요하다'))
  })

  test('파일이 없으면 2', (t) => {
    const s = setup(t)
    const done = s.exec(['nope.html'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '파일이 없다: nope.html\n')
    assert.deepEqual(lines(s.log), [])
  })
})

describe('show-preview 드라이버 선택', () => {
  function drivers(t: T) {
    const s = setup(t)
    const handlers = OK(s.wantDir)
    const env = s.driver(join(s.root, 'by-env'), handlers)
    const bundled = s.driver(join(s.root, 'tools', 'browser-driver', 'browser_driver.ts'), handlers)
    const personal = s.driver(join(s.home, '.claude', 'scripts', 'browser-driver'), handlers)
    return { s, env, bundled, personal }
  }
  const first = (s: { log: string }) => lines(s.log)[0]?.split(' ')[0]

  test('BROWSER_DRIVER_PATH, 함께 받은 것, 개인 링크 순이다', (t) => {
    const { s, env, bundled } = drivers(t)
    assert.equal(s.exec(['p.html'], { BROWSER_DRIVER_PATH: env }).code, 0)
    assert.equal(first(s), 'by-env')
    rmSync(s.log)
    assert.equal(s.exec(['p.html']).code, 0)
    assert.equal(first(s), 'browser_driver.ts')
    rmSync(s.log)
    rmSync(bundled)
    assert.equal(s.exec(['p.html']).code, 0)
    assert.equal(first(s), 'browser-driver')
  })

  test('실행 권한이 없는 후보는 건너뛴다', (t) => {
    const { s, env, bundled } = drivers(t)
    disable(env)
    disable(bundled)
    assert.equal(s.exec(['p.html'], { BROWSER_DRIVER_PATH: env }).code, 0)
    assert.equal(first(s), 'browser-driver')
  })

  test('후보가 없으면 드라이버를 거치지 않고 기본 브라우저로 간다', (t) => {
    const s = setup(t)
    const done = s.exec(['p.html'])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n`)
    assert.equal(done.stderr, '')
    assert.deepEqual(lines(s.log).map((line) => line.split(' ')[0]), ['uname', 'osascript', 'osascript', 'osascript', 'osascript', 'open'])
  })

  test('스킬이 놓인 위치에서 위로 올라가며 tools/browser-driver 를 찾는다', (t) => {
    // 팀 사본의 배치(<루트>/plugins/<플러그인>/skills/content-preview/scripts)에서도 다섯 단계 안에 닿는다
    const s = setup(t)
    const deep = join(s.root, 'a', 'b', 'skills', 'content-preview', 'scripts')
    mkdirSync(join(s.root, 'a', 'b', 'skills', 'content-preview'), { recursive: true })
    run(['cp', '-R', s.scripts, deep])
    s.driver(join(s.root, 'a', 'tools', 'browser-driver', 'browser_driver.ts'), OK(s.wantDir))
    const done = run([...command(deep), 'p.html'], { cwd: s.work, env: { ...s.env, PWD: s.work } })
    assert.equal(done.code, 0)
    assert.equal(lines(s.log)[0].split(' ')[0], 'browser_driver.ts')
  })
})

describe('show-preview 드라이버로 띄우기', () => {
  function withDriver(t: T, handlers: (want: string) => Handlers = OK) {
    const s = setup(t)
    const driver = s.driver(join(s.root, 'drv'), handlers(s.wantDir))
    // 없는 설정 파일을 가리켜 드라이버에게 config-path 를 묻는 호출이 섞이지 않게 한다
    const exec = (extra: NodeJS.ProcessEnv = {}, args = ['p.html'], cwd = s.work) => s.exec(args, { BROWSER_DRIVER_PATH: driver, BROWSER_CONFIG: join(s.root, 'none.json'), ...extra }, cwd)
    return { s, driver, exec, calls: () => lines(s.log).map((line) => line.replace(/ BD=.*$/, '')) }
  }

  test('새로 열고 page id 를 파일에 남긴다', (t) => {
    const { s, exec, calls } = withDriver(t)
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n탭 위치: ${s.wantDir}\n`)
    assert.equal(done.stderr, '')
    assert.equal(readFileSync(s.tabid, 'utf8'), 'P1\n')
    assert.deepEqual(calls(), [`drv open ${s.url}`, 'drv worktree P1', 'drv worktree P1'])
  })

  test('상대 경로와 하위 폴더 경로를 절대 경로로 바꿔 쓴다', (t) => {
    const { s, exec, calls } = withDriver(t)
    mkdirSync(join(s.work, 'sub'))
    write(join(s.work, 'sub', 'q.html'), 'x')
    const done = exec({}, ['sub/q.html'])
    assert.equal(done.stdout, `새로 열었다: ${join(s.work, 'sub', 'q.html')}\n탭 위치: ${s.wantDir}\n`)
    assert.equal(calls()[0], `drv open file://${join(s.work, 'sub', 'q.html')}`)
    assert.ok(existsSync(join(s.work, 'sub', 'q.html.tabid')))
  })

  test('살아 있는 탭은 이동시켜 갱신하고 새 탭을 열지 않는다', (t) => {
    const { s, exec, calls } = withDriver(t)
    write(s.tabid, 'P7\n')
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '갱신: 기존 탭 (P7)\n')
    assert.deepEqual(calls(), ['drv url P7', 'drv worktree P7', 'drv worktree P7', `drv nav P7 ${s.url}`])
  })

  test('탭이 닫혔으면 새로 연다', (t) => {
    const { s, exec, calls } = withDriver(t, (want) => ({ ...OK(want), url: 'exit 1' }))
    write(s.tabid, 'P7\n')
    const done = exec()
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n탭 위치: ${s.wantDir}\n`)
    assert.equal(readFileSync(s.tabid, 'utf8'), 'P1\n')
    assert.deepEqual(calls().map((c) => c.split(' ')[1]), ['url', 'open', 'worktree', 'worktree'])
  })

  test('탭 id 파일이 비어 있으면 새로 연다', (t) => {
    const { s, exec, calls } = withDriver(t)
    write(s.tabid, '\n')
    assert.equal(exec().code, 0)
    assert.equal(calls()[0].split(' ')[1], 'open')
  })

  test('다른 워크트리의 탭이면 알리고 새로 연다', (t) => {
    const { s, exec, calls } = withDriver(t, (want) => ({ ...OK(want), worktree: `case "$2" in P7) echo /elsewhere;; *) echo ${want};; esac; exit 0`, open: 'echo P8; exit 0' }))
    write(s.tabid, 'P7\n')
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n탭 위치: ${s.wantDir}\n`)
    assert.equal(done.stderr, '기존 탭이 다른 워크트리에 있다: /elsewhere. 새로 연다.\n')
    assert.equal(readFileSync(s.tabid, 'utf8'), 'P8\n')
    assert.deepEqual(calls().map((c) => c.split(' ').slice(0, 2).join(' ')), ['drv url', 'drv worktree', 'drv worktree', 'drv open', 'drv worktree', 'drv worktree'])
  })

  test('갱신에 실패하면 알리고 새로 연다', (t) => {
    const { s, exec } = withDriver(t, (want) => ({ ...OK(want), nav: 'exit 1' }))
    write(s.tabid, 'P7\n')
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stderr, '기존 탭을 찾았으나 갱신하지 못했다. 새로 연다.\n')
    assert.equal(readFileSync(s.tabid, 'utf8'), 'P1\n')
  })

  test('백엔드가 worktree 를 모르면 알리고 탭은 그대로 쓴다', (t) => {
    const { s, exec } = withDriver(t, (want) => ({ ...OK(want), worktree: 'exit 1' }))
    const opened = exec()
    assert.equal(opened.code, 0)
    assert.equal(opened.stdout, `새로 열었다: ${s.html}\n`)
    assert.equal(
      opened.stderr,
      '이 백엔드는 worktree 를 다루지 않아 탭 위치를 대조하지 못한다.\n사람이 볼 화면이면 설정 파일의 previewDriver 나 PREVIEW_BROWSER_DRIVER 로 정한다.\n',
    )
    const updated = exec()
    assert.equal(updated.stdout, '갱신: 기존 탭 (P1)\n')
    assert.equal(updated.stderr, '이 백엔드는 worktree 를 다루지 않아 탭 위치를 대조하지 못한다.\n')
  })

  test('새로 연 탭이 사용자가 보는 워크트리가 아니면 닫고 기본 브라우저로 간다', (t) => {
    const { s, exec, calls } = withDriver(t, (want) => ({ ...OK(want), worktree: 'echo /elsewhere; exit 0' }))
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n탭 위치: /elsewhere\n새로 열었다: ${s.html}\n`)
    assert.equal(
      done.stderr,
      `이 탭은 사용자가 보는 워크트리(${s.wantDir})가 아니다. 기본 브라우저로 다시 띄운다.\nbrowser-driver(자동 감지) 로 열지 못했다. 기본 브라우저로 내려간다.\n`,
    )
    assert.equal(existsSync(s.tabid), false)
    assert.ok(calls().includes('drv close P1'))
    assert.equal(calls().at(-1), `open ${s.html}`)
  })

  test('드라이버가 열지 못하면 알리고 기본 브라우저로 간다', (t) => {
    const { s, exec } = withDriver(t, () => ({}))
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n`)
    assert.equal(done.stderr, 'browser-driver(자동 감지) 로 열지 못했다. 기본 브라우저로 내려간다.\n')
    assert.equal(existsSync(s.tabid), false)
  })

  test('open 이 빈 page id 를 내면 열지 못한 것이다', (t) => {
    const { s, exec } = withDriver(t, (want) => ({ ...OK(want), open: 'exit 0' }))
    const done = exec()
    assert.equal(done.stderr, 'browser-driver(자동 감지) 로 열지 못했다. 기본 브라우저로 내려간다.\n')
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n`)
  })

  test('탭 id 를 남기지 못해도 탭은 열린 것이다', (t) => {
    const { s, exec } = withDriver(t)
    mkdirSync(s.tabid)
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n탭 위치: ${s.wantDir}\n`)
    assert.ok(done.stderr.endsWith(`탭 id 를 남기지 못했다. 다음 실행은 새 탭을 연다: ${s.tabid}\n`))
  })

  test('ORCA_WORKTREE 가 없으면 현재 저장소 루트가 기준이다', (t) => {
    const s = setup(t, { git: true })
    const driver = s.driver(join(s.root, 'drv'), OK(s.wantDir))
    const env = { BROWSER_DRIVER_PATH: driver, BROWSER_CONFIG: join(s.root, 'none.json'), ORCA_WORKTREE: '' }
    const inside = s.exec([s.html], env, s.wantDir)
    assert.equal(inside.stdout, `새로 열었다: ${s.html}\n탭 위치: ${s.wantDir}\n`)
    assert.equal(inside.stderr, '')
    rmSync(s.tabid)
    const outside = s.exec([s.html], env, s.work)
    assert.equal(outside.stderr.startsWith(`이 탭은 사용자가 보는 워크트리(${s.work})가 아니다.`), true)
  })

  test('ORCA_WORKTREE 의 path: 접두는 뗀다', (t) => {
    const { s, exec } = withDriver(t)
    const plain = exec({ ORCA_WORKTREE: s.wantDir })
    assert.equal(plain.stdout, `새로 열었다: ${s.html}\n탭 위치: ${s.wantDir}\n`)
    assert.equal(plain.stderr, '')
  })
})

describe('show-preview 백엔드 설정', () => {
  // 드라이버는 config-path 만 답하고 나머지는 실패한다. 호출마다 BROWSER_DRIVER 값이 로그에 남는다
  function configured(t: T, answer: string | null) {
    const s = setup(t)
    const reply = answer === null ? 'exit 2' : `echo "${answer}"; exit 0`
    const driver = s.driver(join(s.root, 'drv'), { 'config-path': reply })
    const config = (name: string, text: string) => write(join(s.root, name), text)
    const exec = (extra: NodeJS.ProcessEnv = {}) => s.exec(['p.html'], { BROWSER_DRIVER_PATH: driver, ...extra })
    const calls = () => lines(s.log).filter((line) => line.startsWith('drv '))
    return { s, config, exec, calls }
  }

  test('드라이버에게 설정 파일 경로를 묻고 previewDriver 를 이후 호출의 BROWSER_DRIVER 로 준다', (t) => {
    const probe = setup(t)
    const { s, config, exec, calls } = configured(t, join(probe.root, 'from-driver.json'))
    write(join(probe.root, 'from-driver.json'), JSON.stringify({ previewDriver: 'orca' }))
    void config
    const done = exec()
    assert.equal(done.code, 0)
    assert.equal(done.stderr, 'browser-driver(orca) 로 열지 못했다. 기본 브라우저로 내려간다.\n')
    assert.deepEqual(calls(), ['drv config-path BD=', `drv open ${s.url} BD=orca`])
  })

  test('PREVIEW_BROWSER_DRIVER 가 설정 파일보다 먼저이고 경로를 묻지도 않는다', (t) => {
    const { s, calls, exec } = configured(t, '/nowhere')
    const done = exec({ PREVIEW_BROWSER_DRIVER: 'ego' })
    assert.equal(done.stderr, 'browser-driver(ego) 로 열지 못했다. 기본 브라우저로 내려간다.\n')
    assert.deepEqual(calls(), [`drv open ${s.url} BD=ego`])
  })

  test('BROWSER_CONFIG 가 있으면 경로를 묻지 않고 그 파일을 읽는다', (t) => {
    const { s, config, calls, exec } = configured(t, '/nowhere')
    const file = config('mine.json', '{"previewDriver": "cmux"}')
    exec({ BROWSER_CONFIG: file })
    assert.deepEqual(calls(), [`drv open ${s.url} BD=cmux`])
  })

  test('경로를 모르는 드라이버면 개인 설정 파일로 내려간다', (t) => {
    const { s, calls, exec } = configured(t, null)
    write(join(s.home, '.claude', 'browser.config.json'), '{"previewDriver": "agent_browser"}')
    exec()
    assert.deepEqual(calls(), ['drv config-path BD=', `drv open ${s.url} BD=agent_browser`])
  })

  test('경로가 여러 줄이면 무시하고 개인 설정 파일로 내려간다', (t) => {
    const { s, calls, exec } = configured(t, 'a\nb')
    write(join(s.home, '.claude', 'browser.config.json'), '{"previewDriver": "orca"}')
    exec()
    assert.deepEqual(calls(), ['drv config-path BD=', `drv open ${s.url} BD=orca`])
  })

  for (const [name, text] of [['설정 파일이 없다', null], ['JSON 이 깨졌다', '{oops'], ['previewDriver 가 빈 값이다', '{"previewDriver": ""}'], ['previewDriver 가 없다', '{}'], ['JSON 이 객체가 아니다', '["orca"]']] as const) {
    test(`${name} 이면 값을 주지 않는다`, (t) => {
      const { s, config, calls, exec } = configured(t, null)
      if (text !== null) write(join(s.home, '.claude', 'browser.config.json'), text)
      void config
      const done = exec()
      assert.equal(done.stderr, 'browser-driver(자동 감지) 로 열지 못했다. 기본 브라우저로 내려간다.\n')
      assert.deepEqual(calls(), ['drv config-path BD=', `drv open ${s.url} BD=`])
    })
  }

  test('정해진 값이 없으면 셸의 BROWSER_DRIVER 를 그대로 물려준다', (t) => {
    const { s, calls, exec } = configured(t, null)
    exec({ BROWSER_DRIVER: 'zzz' })
    assert.deepEqual(calls(), ['drv config-path BD=zzz', `drv open ${s.url} BD=zzz`])
  })
})

describe('show-preview 기본 브라우저', () => {
  const osascript = (s: { osaIn: string }) => (existsSync(s.osaIn) ? readFileSync(s.osaIn, 'utf8').split('=====\n').filter((x) => x.trim()) : [])

  test('Chrome 계열의 기존 탭을 찾으면 갱신한다', (t) => {
    const s = setup(t)
    const done = s.exec(['p.html'], { CHROME: 'reloaded' })
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '갱신: Google Chrome 의 기존 탭\n')
    const scripts = osascript(s)
    assert.equal(scripts.length, 1)
    assert.ok(scripts[0].includes('tell application "Google Chrome"'))
    assert.ok(scripts[0].includes(`if URL of t is equal to "${s.url}" then`))
    assert.ok(scripts[0].includes('tell t to reload'))
    assert.ok(!lines(s.log).some((line) => line.startsWith('open ')))
  })

  test('Edge 와 Brave 도 차례로 본다', (t) => {
    const s = setup(t)
    assert.equal(s.exec(['p.html'], { EDGE: 'reloaded' }).stdout, '갱신: Microsoft Edge 의 기존 탭\n')
    assert.equal(osascript(s).length, 2)
    const s2 = setup(t)
    assert.equal(s2.exec(['p.html'], { BRAVE: 'reloaded' }).stdout, '갱신: Brave Browser 의 기존 탭\n')
    assert.equal(osascript(s2).length, 3)
  })

  test('Safari 의 기존 탭을 찾으면 갱신한다', (t) => {
    const s = setup(t)
    const done = s.exec(['p.html'], { SAFARI: 'reloaded', CHROME: 'notfound' })
    assert.equal(done.stdout, '갱신: Safari 의 기존 탭\n')
    const scripts = osascript(s)
    assert.equal(scripts.length, 4)
    assert.ok(scripts[3].includes('tell application "Safari"'))
    assert.ok(scripts[3].includes(`if URL of t is equal to "${s.url}" then`))
  })

  test('기존 탭이 없으면 open 으로 새로 연다', (t) => {
    const s = setup(t)
    const done = s.exec(['p.html'], { CHROME: 'notfound' })
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n`)
    assert.ok(lines(s.log).includes(`open ${s.html} BD=`))
  })

  test('open 이 실패하면 2', (t) => {
    const s = setup(t)
    const done = s.exec(['p.html'], { OPEN_RC: '1' })
    assert.equal(done.code, 2)
    assert.equal(done.stdout, '')
    assert.equal(done.stderr, `기본 브라우저로 열지 못했다: ${s.html}\n`)
  })

  test('macOS 가 아니면 xdg-open 으로 새로 열고 탭 갱신은 안 된다고 알린다', (t) => {
    const s = setup(t)
    const done = s.exec(['p.html'], { FAKE_UNAME: 'Linux' })
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `새로 열었다: ${s.html}\n이 환경은 기존 탭 갱신을 지원하지 않는다. 재생성하면 탭이 하나 더 열린다.\n`)
    assert.deepEqual(osascript(s), [])
    assert.ok(lines(s.log).includes(`xdg-open ${s.html} BD=`))
  })

  test('xdg-open 이 실패하면 2', (t) => {
    const s = setup(t)
    const done = s.exec(['p.html'], { FAKE_UNAME: 'Linux', XDG_RC: '1' })
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `xdg-open 으로 열지 못했다: ${s.html}\n`)
  })

  test('열 방법이 없으면 2', (t) => {
    const s = setup(t)
    // xdg-open 이 없는 PATH. uname 가짜와 스크립트가 쓰는 도구만 둔다
    const bin = join(s.root, 'bin')
    mkdirSync(bin)
    linkTools(bin, ['bash', 'sh', 'dirname', 'basename', 'cat', 'git', 'rm', 'env', 'tr', 'printenv'])
    const only = join(s.root, 'only-uname')
    linkFake(join(only, 'uname'), 'uname')
    const done = s.exec(['p.html'], { FAKE_UNAME: 'Linux', PATH: `${only}:${bin}` })
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `브라우저를 열 방법을 찾지 못했다. 직접 열어야 한다: ${s.html}\n`)
  })
})
