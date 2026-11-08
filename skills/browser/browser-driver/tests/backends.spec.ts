// orca, cmux, agent-browser 백엔드가 외부 명령에 넘기는 인자와 돌려주는 출력을 가짜 실행 파일로 본다.
// ego 는 input-and-output, ego-space 에서 본다. 실제 브라우저는 열지 않는다.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Box, golden, type FakeRule, type T } from './helpers.ts'

const json = (value: unknown) => `${JSON.stringify(value)}\n`

function backend(t: T, name: string, rules: FakeRule[], config?: unknown) {
  const box = new Box(t)
  box.env.BROWSER_DRIVER = name
  const fake = box.fake(name, rules)
  if (config !== undefined) box.setConfig(config)
  return { box, fake, argvs: () => fake.calls().map((call) => call.argv) }
}

describe('orca', () => {
  const ok = (result: unknown) => json({ ok: true, result })

  test('open 은 탭을 만들고 준비를 기다린 뒤 위치를 stderr 로 알린다', (t) => {
    const { box, argvs } = backend(t, 'orca', [
      { args: ['create'], stdout: ok({ browserPageId: 'P1' }) },
      { args: ['show'], stdout: ok({ tab: { worktreeId: 'repo::/work/tree' } }) },
      { stdout: ok({}) },
    ])
    const done = box.run(['open', 'https://a.example'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, 'P1\n', '탭 위치: /work/tree\n'])
    assert.deepEqual(argvs(), [
      ['tab', 'create', '--url', 'https://a.example', '--json'],
      ['wait', '--fn', "document.readyState==='complete'", '--timeout', '30000', '--page', 'P1', '--json'],
      ['tab', 'show', '--page', 'P1', '--json'],
    ])
  })

  test('ORCA_WORKTREE 가 있으면 워크트리를 고정한다', (t) => {
    const { box, argvs } = backend(t, 'orca', [{ args: ['create'], stdout: ok({ browserPageId: 'P1' }) }, { stdout: ok({ tab: { worktreeId: 'plain' } }) }])
    const done = box.run(['open', 'https://a', '4000'], { ORCA_WORKTREE: 'path:/x y' })
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, 'P1\n', '탭 위치: plain\n'])
    assert.deepEqual(argvs()[0], ['tab', 'create', '--url', 'https://a', '--worktree', 'path:/x y', '--json'])
    assert.deepEqual(argvs()[1].slice(3, 5), ['--timeout', '4000'])
  })

  test('위치를 읽지 못하면 알림 줄만 없다', (t) => {
    const { box } = backend(t, 'orca', [{ args: ['create'], stdout: ok({ browserPageId: 'P1' }) }, { args: ['show'], stdout: json({ ok: false }) }, { stdout: ok({}) }])
    const done = box.run(['open', 'https://a'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, 'P1\n', ''])
  })

  test('워크트리 id 가 비면 (워크트리 없음) 이다', (t) => {
    const { box } = backend(t, 'orca', [{ args: ['create'], stdout: ok({ browserPageId: 'P1' }) }, { stdout: ok({ tab: { worktreeId: '' } }) }])
    assert.equal(box.run(['open', 'https://a']).stderr, '탭 위치: (워크트리 없음)\n')
    assert.equal(box.run(['worktree', 'P1']).stdout, '(워크트리 없음)\n')
  })

  test('nav, ready, waitjs, close 는 인자를 넘기고 아무것도 내지 않는다', (t) => {
    const { box, argvs } = backend(t, 'orca', [{ stdout: ok({}) }])
    for (const args of [['nav', 'P', 'https://b'], ['nav', 'P', 'https://b', '99'], ['ready', 'P'], ['ready', 'P', '55'], ['waitjs', 'P', 'window.x'], ['waitjs', 'P', 'window.x', '77'], ['close', 'P']]) {
      const done = box.run(args)
      assert.deepEqual([done.code, done.stdout, done.stderr], [0, '', ''], args.join(' '))
    }
    const wait = (timeout: string) => ['wait', '--fn', "document.readyState==='complete'", '--timeout', timeout, '--page', 'P', '--json']
    assert.deepEqual(argvs(), [
      ['goto', '--url', 'https://b', '--page', 'P', '--json'], wait('30000'),
      ['goto', '--url', 'https://b', '--page', 'P', '--json'], wait('99'),
      wait('30000'), wait('55'),
      ['wait', '--fn', 'window.x', '--timeout', '10000', '--page', 'P', '--json'],
      ['wait', '--fn', 'window.x', '--timeout', '77', '--page', 'P', '--json'],
      ['tab', 'close', '--page', 'P', '--json'],
    ])
  })

  test('준비 시간은 int() 가 읽는 꼴만 받고 틀리면 1 로 끝난다', (t) => {
    const { box, argvs } = backend(t, 'orca', [{ stdout: ok({}) }])
    for (const [raw, want] of [[' 15 ', '15'], ['1_5', '15'], ['+15', '15'], ['١٥', '15'], ['015', '15'], ['-5', '-5']] as const) {
      assert.equal(box.run(['ready', 'P', raw]).code, 0, raw)
      assert.equal(argvs().at(-1)![4], want, raw)
    }
    for (const raw of ['x', '1.5', '', '1e3', '0x1']) assert.equal(box.run(['ready', 'P', raw]).code, 1, JSON.stringify(raw))
  })

  test('js 는 문자열은 그대로, 나머지는 여백 없는 JSON 으로 낸다', (t) => {
    const cases: [unknown, string][] = [
      ['text', 'text\n'], ['한글', '한글\n'], [null, 'null\n'], [true, 'true\n'], [false, 'false\n'], [0, '0\n'], [2.5, '2.5\n'],
      [{ a: [1, 2], b: '한' }, '{"a":[1,2],"b":"한"}\n'], [[], '[]\n'], ['', '\n'],
    ]
    for (const [value, want] of cases) {
      const { box } = backend(t, 'orca', [{ stdout: ok({ result: value }) }])
      const done = box.run(['js', 'P', 'expr'])
      assert.deepEqual([done.code, done.stdout], [0, want], JSON.stringify(value))
    }
  })

  test('js 의 실수는 Python float 의 꼴로 낸다', (t) => {
    const raw = '{"ok":true,"result":{"result":{"a":1.0,"b":[1,2.50,1e3,1E-7,-0.0,10000000000000000.0,123456789012345678901234567890,1e400]}}}\n'
    const { box } = backend(t, 'orca', [{ stdout: raw }])
    assert.equal(box.run(['js', 'P', 'e']).stdout, '{"a":1.0,"b":[1,2.5,1000.0,1e-07,-0.0,1e+16,123456789012345678901234567890,Infinity]}\n')
  })

  test('js 결과 키가 없으면 1 로 끝나고 받은 응답을 보인다', (t) => {
    const { box } = backend(t, 'orca', [{ stdout: ok({ other: 1 }) }])
    const done = box.run(['js', 'P', 'e'])
    assert.equal(done.code, 1)
    assert.equal(done.stderr, '응답에 result 가 없다: {"other": 1}\n')
  })

  test('url, snap 은 응답의 값을 그대로 낸다', (t) => {
    const { box, argvs } = backend(t, 'orca', [{ args: ['url'], stdout: ok({ url: 'https://u' }) }, { args: ['snapshot'], stdout: ok({ snapshot: '- 트리' }) }])
    assert.equal(box.run(['url', 'P']).stdout, 'https://u\n')
    assert.equal(box.run(['snap', 'P']).stdout, '- 트리\n')
    assert.deepEqual(argvs(), [['get', '--what', 'url', '--page', 'P', '--json'], ['snapshot', '--page', 'P', '--json']])
  })

  test('console, errors 는 응답을 JSON 이나 문자열로 낸다', (t) => {
    const cases: [unknown, string][] = [
      [{ a: 1.0 }, '{"a": 1}\n'], [[], '{}\n'], [null, '{}\n'], ['문자열', '문자열\n'], [0, '{}\n'], [5, '5\n'], [true, 'True\n'],
      [[1, { b: null }, '한'], '[1, {"b": null}, "한"]\n'],
    ]
    for (const [value, want] of cases) {
      const { box, argvs } = backend(t, 'orca', [{ stdout: ok(value) }])
      const done = box.run(['console', 'P'])
      assert.deepEqual([done.code, done.stdout], [0, want], JSON.stringify(value))
      assert.deepEqual(argvs()[0], ['exec', '--command', 'console', '--page', 'P', '--json'])
    }
  })

  test('console 의 수와 실수는 Python 출력 꼴이다', (t) => {
    const raw = '{"ok":true,"result":{"a":1.0,"b":[1,2.50,1e3],"c":null,"d":"한글","e":true,"f":{}}}\n'
    const { box } = backend(t, 'orca', [{ stdout: raw }])
    assert.equal(box.run(['errors', 'P']).stdout, '{"a": 1.0, "b": [1, 2.5, 1000.0], "c": null, "d": "한글", "e": true, "f": {}}\n')
    const scalar = backend(t, 'orca', [{ stdout: '{"ok":true,"result":1e3}\n' }])
    assert.equal(scalar.box.run(['console', 'P']).stdout, '1000.0\n')
  })

  test('shot 은 base64 를 풀어 파일로 쓰고 경로를 낸다', (t) => {
    const { box } = backend(t, 'orca', [{ stdout: ok({ data: Buffer.from([1, 2, 255]).toString('base64') }) }])
    const out = join(box.root, 'a.JPG')
    const done = box.run(['shot', 'P', out])
    assert.deepEqual([done.code, done.stdout], [0, `${out}\n`])
    assert.deepEqual([...readFileSync(out)], [1, 2, 255])
    const { argvs } = backend(t, 'orca', [{ stdout: ok({ data: '' }) }])
    assert.ok(argvs)
  })

  test('shot 의 형식은 확장자로 고른다', (t) => {
    const { box, argvs } = backend(t, 'orca', [{ stdout: ok({ data: '' }) }])
    for (const [name, format] of [['a.png', 'png'], ['a.jpg', 'jpeg'], ['a.JPEG', 'jpeg'], ['a', 'png'], ['a.jpeg.txt', 'png']] as const) {
      assert.equal(box.run(['shot', 'P', join(box.root, name)]).code, 0, name)
      assert.deepEqual(argvs().at(-1), ['screenshot', '--format', format, '--page', 'P', '--json'], name)
    }
  })

  test('ok 가 거짓이면 오류 코드와 문장으로 1 로 끝난다', (t) => {
    const cases: [unknown, string][] = [
      [{ ok: false, error: { code: 'E_X', message: '없다' } }, 'orca 실패 [E_X] 없다\n'],
      [{ ok: false, error: { message: 'm' } }, 'orca 실패 [unknown] m\n'],
      [{ ok: false, error: { code: 3, message: null } }, 'orca 실패 [3] None\n'],
      ['{"ok":false,"error":{"code":["a",1.0,2],"message":{"k":"v","n":null,"t":true}}}\n', "orca 실패 [['a', 1.0, 2]] {'k': 'v', 'n': None, 't': True}\n"],
      [{ ok: false, error: null }, 'orca 실패 [unknown] {"ok":false,"error":null}\n\n'],
      [{ ok: false }, 'orca 실패 [unknown] {"ok":false}\n\n'],
      [{ ok: 0, result: {} }, 'orca 실패 [unknown] {"ok":0,"result":{}}\n\n'],
      [{}, 'orca 실패 [unknown] {}\n\n'],
    ]
    for (const [body, want] of cases) {
      const { box } = backend(t, 'orca', [{ stdout: typeof body === 'string' ? body : json(body) }])
      const done = box.run(['url', 'P'])
      assert.equal(done.code, 1, JSON.stringify(body))
      assert.equal(done.stderr, want, JSON.stringify(body))
    }
  })

  test('응답이 JSON 이 아니면 받은 글을 보이고 1 로 끝난다', (t) => {
    const { box } = backend(t, 'orca', [{ stdout: 'not json\n', stderr: 'warn\n' }])
    const done = box.run(['url', 'P'])
    assert.equal(done.code, 1)
    assert.equal(done.stderr, 'orca 응답이 JSON 이 아니다:\nnot json\nwarn\n\n')
  })

  test('JSON 이 객체가 아니면 처리하지 못한 오류로 1 로 끝난다', (t) => {
    for (const body of ['[1]\n', 'null\n', '"s"\n', '5\n']) {
      const { box } = backend(t, 'orca', [{ stdout: body }])
      assert.equal(box.run(['url', 'P']).code, 1, body)
    }
  })

  test('NaN 과 Infinity 도 읽는다', (t) => {
    const { box } = backend(t, 'orca', [{ stdout: '{"ok":true,"result":{"result":[NaN,Infinity,-Infinity]}}\n' }])
    assert.equal(box.run(['js', 'P', 'e']).stdout, '[NaN,Infinity,-Infinity]\n')
  })

  test('JSON 문법을 어기면 JSON 이 아닌 것으로 본다', (t) => {
    for (const body of ["{'ok': true}", '{"ok":true,}', '{"ok":true} x', '{"a":"\t"}', '{"ok":01}', '{"ok":+1}', '', '{"ok":true} ']) {
      const { box } = backend(t, 'orca', [{ stdout: body }])
      const done = box.run(['url', 'P'])
      assert.equal(done.code, 1, JSON.stringify(body))
      assert.ok(done.stderr.startsWith('orca 응답이 JSON 이 아니다:\n'), JSON.stringify(body))
    }
  })
})

describe('cmux', () => {
  test('open 은 surface 를 읽고 준비를 기다린다', (t) => {
    const { box, argvs } = backend(t, 'cmux', [{ args: ['open'], stdout: 'OK surface=surface:2 pane=p1 placement=x\n' }])
    const done = box.run(['open', 'https://c', '800'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, 'surface:2\n', ''])
    assert.deepEqual(argvs(), [['browser', 'open', 'https://c'], ['browser', 'surface:2', 'wait', '--load-state', 'complete', '--timeout-ms', '800']])
  })

  test('surface 번호는 유니코드 숫자도 읽는다', (t) => {
    const { box } = backend(t, 'cmux', [{ args: ['open'], stdout: 'OK surface=surface:٢\n' }])
    assert.equal(box.run(['open', 'https://c']).stdout, 'surface:٢\n')
  })

  test('출력에서 surface 를 못 읽으면 BROWSER_CMUX_SURFACE 를 쓴다', (t) => {
    const { box, argvs } = backend(t, 'cmux', [{ args: ['open'], stdout: 'OK\n' }])
    const done = box.run(['open', 'https://c'])
    assert.equal(done.code, 1)
    assert.equal(done.stderr, 'open 출력에서 surface 를 찾지 못했다. BROWSER_CMUX_SURFACE 로 지정한다.\nOK\n')
    assert.equal(box.run(['open', 'https://c'], { BROWSER_CMUX_SURFACE: '5' }).stdout, 'surface:5\n')
    assert.equal(box.run(['open', 'https://c'], { BROWSER_CMUX_SURFACE: 'surface:7' }).stdout, 'surface:7\n')
    assert.deepEqual(argvs().at(-1)!.slice(0, 3), ['browser', 'surface:7', 'wait'])
  })

  test('핸들에 surface: 접두가 없으면 붙인다', (t) => {
    const { box, argvs } = backend(t, 'cmux', [{ stdout: 'https://now\n' }])
    assert.equal(box.run(['url', '4']).stdout, 'https://now\n')
    assert.equal(box.run(['url', 'surface:4']).stdout, 'https://now\n')
    assert.deepEqual(argvs(), [['browser', 'surface:4', 'url'], ['browser', 'surface:4', 'url']])
  })

  test('명령마다 인자를 넘기고 줄 끝 줄바꿈만 뗀다', (t) => {
    const { box, argvs } = backend(t, 'cmux', [{ stdout: 'out\n\n', stderr: ' err \n' }])
    const cases: [string[], string][] = [
      [['nav', 'S', 'https://n', '9'], ''], [['ready', 'S'], ''], [['ready', 'S', '5'], ''], [['waitjs', 'S', 'cond'], ''], [['waitjs', 'S', 'cond', '6'], ''],
      [['url', 'S'], 'out\n\n err '], [['snap', 'S'], 'out\n\n err '], [['console', 'S'], 'out\n\n err '], [['errors', 'S'], 'out\n\n err '], [['close', 'S'], ''],
    ]
    for (const [args, want] of cases) {
      const done = box.run(args)
      assert.equal(done.code, 0, args.join(' '))
      assert.equal(done.stdout, want === '' ? '' : `${want}\n`, args.join(' '))
    }
    assert.deepEqual(argvs(), [
      ['browser', 'surface:S', 'goto', 'https://n'], ['browser', 'surface:S', 'wait', '--load-state', 'complete', '--timeout-ms', '9'],
      ['browser', 'surface:S', 'wait', '--load-state', 'complete', '--timeout-ms', '30000'], ['browser', 'surface:S', 'wait', '--load-state', 'complete', '--timeout-ms', '5'],
      ['browser', 'surface:S', 'wait', '--function', 'cond', '--timeout-ms', '10000'], ['browser', 'surface:S', 'wait', '--function', 'cond', '--timeout-ms', '6'],
      ['browser', 'surface:S', 'url'], ['browser', 'surface:S', 'snapshot'], ['browser', 'surface:S', 'console', 'list'], ['browser', 'surface:S', 'errors', 'list'], ['browser', 'surface:S', 'tab', 'close'],
    ])
  })

  test('js 는 eval 결과를 JSON 으로 읽어 형식을 맞추고 못 읽으면 그대로 낸다', (t) => {
    const cases: [string, string][] = [
      ['{ "a": 1 }\n', '{"a":1}\n'], ['"str"\n', 'str\n'], ['undefined\n', 'undefined\n'], ['NaN\n', 'NaN\n'], ['1.0\n', '1.0\n'], ['null\n', 'null\n'], ['\n', '\n'],
      ['[1, 2.50]\n\n\n', '[1,2.5]\n'], [' 5 \n', '5\n'], ['{"a": 1} x\n', '{"a": 1} x\n'],
    ]
    for (const [raw, want] of cases) {
      const { box, argvs } = backend(t, 'cmux', [{ stdout: raw }])
      const done = box.run(['js', 'S', 'expr'])
      assert.deepEqual([done.code, done.stdout], [0, want], JSON.stringify(raw))
      assert.deepEqual(argvs()[0], ['browser', 'surface:S', 'eval', 'expr'])
    }
  })

  test('shot 은 경로를 낸다', (t) => {
    const { box, argvs } = backend(t, 'cmux', [{ stdout: 'OK /x.png\n' }])
    const done = box.run(['shot', 'S', '/tmp/bd-test-shot.png'])
    assert.deepEqual([done.code, done.stdout], [0, '/tmp/bd-test-shot.png\n'])
    assert.deepEqual(argvs()[0], ['browser', 'surface:S', 'screenshot', '--out', '/tmp/bd-test-shot.png'])
  })

  test('종료 코드가 0 이 아니면 출력을 보이고 1 로 끝난다', (t) => {
    const { box } = backend(t, 'cmux', [{ stdout: '  \n', stderr: 'Access denied\n', code: 3 }])
    const done = box.run(['url', 'S'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [1, '', 'Access denied\n'])
  })

  test('종료 코드가 0 이면 출력에 error 가 있어도 성공이다', (t) => {
    const { box } = backend(t, 'cmux', [{ stdout: 'error page\n' }])
    assert.deepEqual([box.run(['url', 'S']).code, box.run(['url', 'S']).stdout], [0, 'error page\n'])
  })

  test('지원하지 않는 명령은 2 로 끝난다', (t) => {
    const { box } = backend(t, 'cmux', [{}])
    for (const args of [['worktree', 'S'], ['pages'], ['click', 'S', '1', '2']]) assert.equal(box.run(args).code, 2, args.join(' '))
  })
})

describe('agent-browser', () => {
  const wait = (cond: string, timeout: number) =>
    `(async () => {\n  const t0 = Date.now();\n  while (true) {\n    let ok = false;\n    try { ok = !!(${cond}); } catch (e) { ok = false; }\n` +
    `    if (ok) return 'ok in ' + (Date.now() - t0) + 'ms';\n    if (Date.now() - t0 > ${timeout}) throw new Error('waitjs timeout after ${timeout}ms');\n` +
    `    await new Promise(r => setTimeout(r, 150));\n  }\n})()`

  test('open 은 세션 이름을 핸들로 낸다', (t) => {
    const { box, argvs } = backend(t, 'agent-browser', [{ args: ['session'], stdout: ' s-1 \n' }])
    const done = box.run(['open', 'https://ab'])
    assert.deepEqual([done.code, done.stdout], [0, 's-1\n'])
    assert.deepEqual(argvs(), [['open', 'https://ab'], ['session']])
  })

  test('세션을 못 읽으면 default 다', (t) => {
    for (const rule of [{ args: ['session'], stdout: '  \n' }, { args: ['session'], stdout: '✗ no session\n' }]) {
      const { box } = backend(t, 'agent-browser', [rule])
      assert.equal(box.run(['open', 'https://ab']).stdout, 'default\n')
    }
  })

  test('cdpPort 가 있으면 먼저 연결한다', (t) => {
    for (const [port, want] of [[9222, '9222'], ['9333', '9333']] as const) {
      const { box, argvs } = backend(t, 'agent-browser', [{ args: ['session'], stdout: 's\n' }], { cdpPort: port })
      assert.equal(box.run(['open', 'https://ab']).code, 0)
      assert.deepEqual(argvs()[0], ['connect', want])
    }
    const { box, argvs } = backend(t, 'agent-browser', [{}], { cdpPort: 0 })
    box.run(['open', 'https://ab'])
    assert.deepEqual(argvs()[0], ['open', 'https://ab'])
  })

  test('줄머리의 ✗ 만 실패로 본다', (t) => {
    const { box } = backend(t, 'agent-browser', [{ stdout: 'ok ✗ 가운데\n  ✗ 들여쓴\n' }])
    assert.equal(box.run(['url', 'x']).code, 0)
    const bad = backend(t, 'agent-browser', [{ stdout: '정상\n✗ 실패했다\n' }])
    const done = bad.box.run(['url', 'x'])
    assert.deepEqual([done.code, done.stderr], [1, '정상\n✗ 실패했다\n'])
  })

  test('출력의 줄 경계는 splitlines 가 본다', (t) => {
    for (const sep of ['\r', '\v', '\f', '\u0085', ' ', '\x1c']) {
      const { box } = backend(t, 'agent-browser', [{ stdout: `a${sep}✗ x\n` }])
      assert.equal(box.run(['url', 'x']).code, 1, JSON.stringify(sep))
    }
  })

  test('종료 코드가 0 이 아니어도 ✗ 가 없으면 성공이다', (t) => {
    const { box } = backend(t, 'agent-browser', [{ stdout: 'u\n', code: 5 }])
    assert.deepEqual([box.run(['url', 'x']).code, box.run(['url', 'x']).stdout], [0, 'u\n'])
  })

  test('명령마다 인자를 넘긴다', (t) => {
    const { box, argvs } = backend(t, 'agent-browser', [{ stdout: 'v\n\n' }])
    const cases: [string[], string][] = [
      [['nav', 'S', 'https://n'], ''], [['url', 'S'], 'v'], [['snap', 'S'], 'v'], [['console', 'S'], 'v'], [['errors', 'S'], 'v'], [['close', 'S'], ''],
      [['waitjs', 'S', 'window.x'], ''], [['waitjs', 'S', 'window.x', '321'], ''], [['ready', 'S'], ''], [['ready', 'S', '44'], ''], [['shot', 'S', '/tmp/bd-ab.png'], '/tmp/bd-ab.png'],
    ]
    for (const [args, want] of cases) {
      const done = box.run(args)
      assert.equal(done.code, 0, args.join(' '))
      assert.equal(done.stdout, want === '' ? '' : `${want}\n`, args.join(' '))
    }
    assert.deepEqual(argvs(), [
      ['open', 'https://n'], ['get', 'url'], ['snapshot'], ['console'], ['errors'], ['close'],
      ['eval', wait('window.x', 10000)], ['eval', wait('window.x', 321)],
      ['eval', wait("document.readyState==='complete'", 30000)], ['eval', wait("document.readyState==='complete'", 44)],
      ['screenshot', '/tmp/bd-ab.png'],
    ])
  })

  test('js 는 eval 결과를 JSON 으로 읽어 형식을 맞춘다', (t) => {
    const cases: [string, string][] = [['"a b"\n', 'a b\n'], ['{"x": [1, 2.0]}\n', '{"x":[1,2.0]}\n'], ['undefined\n', 'undefined\n'], ['true\n', 'true\n']]
    for (const [raw, want] of cases) {
      const { box } = backend(t, 'agent-browser', [{ stdout: raw }])
      assert.equal(box.run(['js', 'S', 'e']).stdout, want, JSON.stringify(raw))
    }
  })

  test('지원하지 않는 명령은 2 로 끝난다', (t) => {
    const { box } = backend(t, 'agent-browser', [{}])
    for (const args of [['worktree', 'S'], ['spaces'], ['hover', 'S', '1', '2']]) assert.equal(box.run(args).code, 2, args.join(' '))
  })
})

describe('백엔드 선택', () => {
  test('환경변수, 설정, 자동 감지 순이다', (t) => {
    const box = new Box(t)
    for (const name of ['cmux', 'agent-browser', 'orca']) box.fake(name)
    assert.equal(box.run(['driver']).stdout, 'orca\n')
    box.setConfig({ driver: 'cmux' })
    assert.equal(box.run(['driver']).stdout, 'cmux\n')
    assert.equal(box.run(['driver'], { BROWSER_DRIVER: 'agent-browser' }).stdout, 'agent-browser\n')
    box.fake('ego-browser')
    box.setConfig({})
    assert.equal(box.run(['driver']).stdout, 'ego\n')
  })

  test('자동 감지 순서는 ego, orca, agent-browser, cmux 다', (t) => {
    const box = new Box(t)
    box.fake('cmux')
    assert.equal(box.run(['driver']).stdout, 'cmux\n')
    box.fake('agent-browser')
    assert.equal(box.run(['driver']).stdout, 'agent-browser\n')
  })

  test('모르는 백엔드 이름은 출처와 함께 2 로 끝난다', (t) => {
    const box = new Box(t)
    const done = box.run(['driver'], { BROWSER_DRIVER: 'nope' })
    assert.deepEqual([done.code, done.stderr], [2, '모르는 백엔드: nope (환경변수 BROWSER_DRIVER). 쓸 수 있는 값: ego, orca, agent-browser, cmux\n'])
    box.setConfig({ driver: 'zzz' })
    assert.equal(box.run(['driver']).stderr, `모르는 백엔드: zzz (${box.config} 의 driver). 쓸 수 있는 값: ego, orca, agent-browser, cmux\n`)
    assert.equal(box.run(['open', 'about:blank']).stderr, `모르는 백엔드: zzz (${box.config} 의 driver). 쓸 수 있는 값: ego, orca, agent-browser, cmux\n`)
  })

  test('설정의 driver 값은 문자열이 아니어도 이름으로 보고한다', (t) => {
    const box = new Box(t)
    for (const [value, shown] of [[5, '5'], [true, 'True'], [1.5, '1.5']] as const) {
      box.setConfig({ driver: value })
      assert.equal(box.run(['driver']).stderr, `모르는 백엔드: ${shown} (${box.config} 의 driver). 쓸 수 있는 값: ego, orca, agent-browser, cmux\n`)
    }
    for (const value of [[], {}, null, 0, '', false]) {
      box.setConfig({ driver: value })
      assert.equal(box.run(['driver']).code, 2, JSON.stringify(value))
    }
    box.setConfig({ driver: ['ego'] })
    assert.equal(box.run(['driver']).code, 1)
  })

  test('설정 파일이 깨졌거나 객체가 아니면 알린다', (t) => {
    const box = new Box(t)
    box.setConfig('{"driver": ')
    const done = box.run(['driver'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.startsWith(`${box.config} 를 읽지 못했다: `))
    box.setConfig('[1]')
    assert.equal(box.run(['driver']).code, 1)
  })

  test('설치되지 않은 백엔드를 고정하면 2 로 끝난다', (t) => {
    const box = new Box(t)
    const done = box.run(['open', 'about:blank'], { BROWSER_DRIVER: 'cmux' })
    assert.deepEqual([done.code, done.stderr], [2, 'cmux 을 찾지 못했다 (환경변수 BROWSER_DRIVER). 설치했는지 doctor 로 본다.\n'])
  })

  test('명령 이름과 인자 개수를 검사한다', (t) => {
    const box = new Box(t)
    box.fake('orca')
    box.env.BROWSER_DRIVER = 'orca'
    let done = box.run(['nope'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.startsWith('모르는 명령: nope\n쓸 수 있는 명령: open, nav, js, jsfile,'))
    assert.ok(done.stderr.endsWith(', driver, doctor, config-path, help, install\n자세한 사용법은 help 로 본다.\n'))
    done = box.run(['nav', 'P'])
    assert.deepEqual([done.code, done.stderr], [2, '인자가 모자란다.\n사용법: nav <handle> <url> [ready_timeout_ms]\n  이미 열린 탭을 다른 주소로 보낸다\n'])
    golden('misc.json', 'unknown-command', box.run(['nope']).stderr)
  })

  test('help 없이 부르면 도움말을 내고 2 로 끝난다', (t) => {
    const box = new Box(t)
    const bare = box.run([])
    const help = box.run(['help'])
    assert.equal(bare.code, 2)
    assert.equal(help.code, 0)
    assert.equal(bare.stdout, help.stdout)
    for (const flag of ['-h', '--help']) assert.equal(box.run([flag]).stdout, help.stdout)
    assert.equal(box.run(['help', 'extra']).stdout, help.stdout)
  })
})
