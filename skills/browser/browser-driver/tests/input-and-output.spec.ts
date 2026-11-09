// 출력 분리, 인자 해석, js 의 여러 문장과 --timeout, jsfile, 마우스 명령을 명령 경계에서 본다. 실제 브라우저는 열지 않는다.
// ego-browser 는 PATH 맨 앞의 가짜 실행 파일이다. 받은 스크립트(stdin)를 기록하고 정해 둔 출력을 stdout 으로 낸다.
// 스크립트 실행 사례는 가짜 실행 파일이 그 스크립트를 가짜 page 에 대고 Node 로 돌린다(prelude).

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { join } from 'node:path'
import { egoOut, MARKER, NOTICE, write, type T } from './helpers.ts'
import { FunctionBox as Box } from './function-box.ts'

function ego(t: T, stdout = '') {
  const box = new Box(t)
  box.env.BROWSER_DRIVER = 'ego'
  const fake = box.fake('ego-browser', [{ stdout }])
  return { box, fake, script: () => fake.calls().at(-1)?.stdin ?? '' }
}

describe('출력 분리', () => {
  test('open 의 stdout 은 핸들 한 줄뿐이다', (t) => {
    const { box } = ego(t, egoOut(`9:p2\tDefault\tPersonal\tbrowser-driver/Default${NOTICE} 업데이트가 있다`))
    const done = box.run(['open', 'about:blank'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, '9:p2\n')
    assert.match(done.stderr, /공간: browser-driver\/Default/)
    assert.ok(done.stderr.includes(NOTICE))
  })

  test('js 의 값에서 뒤따르는 알림을 떼어 stderr 로 보낸다', (t) => {
    const { box } = ego(t, egoOut(`"hello"${NOTICE} 업데이트가 있다\n`))
    const done = box.run(['js', '9:p2', "'hello'"])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, 'hello\n')
    assert.ok(!done.stdout.includes('업데이트'))
    assert.ok(done.stderr.includes(NOTICE))
  })

  test('알림이 없으면 stderr 에 아무것도 없다', (t) => {
    const { box } = ego(t, egoOut('"hello"'))
    const done = box.run(['js', '9:p2', "'hello'"])
    assert.deepEqual([done.stdout, done.stderr], ['hello\n', ''])
  })

  test('반환값 앞의 알림도 stderr 로 보낸다', (t) => {
    const { box } = ego(t, `${NOTICE} 먼저 온 알림\n${MARKER}\n"v"`)
    const done = box.run(['js', '9:p2', "'v'"])
    assert.deepEqual([done.code, done.stdout], [0, 'v\n'])
    assert.ok(done.stderr.includes(`${NOTICE} 먼저 온 알림`))
  })

  test('표식이 없으면 스크립트가 끝까지 돌지 않은 것으로 보고 1 로 끝난다', (t) => {
    const { box } = ego(t, 'ego 가 서비스에 붙지 못했다\n')
    const done = box.run(['url', '9:p2'])
    assert.equal(done.code, 1)
    assert.match(done.stderr, /^ego 스크립트가 끝까지 돌지 않았다\./)
    assert.ok(done.stderr.includes('ego 가 서비스에 붙지 못했다'))
  })

  test('출력이 비어도 같은 안내에 (출력이 없다) 를 적는다', (t) => {
    const { box } = ego(t, '')
    const done = box.run(['url', '9:p2'])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.endsWith('(출력이 없다)\n'))
  })

  test('핸들을 내지 않으면 실패한다', (t) => {
    const { box } = ego(t, egoOut(''))
    const done = box.run(['open', 'about:blank'])
    assert.equal(done.code, 1)
    assert.equal(done.stderr, 'ego 가 핸들을 내지 않았다\n')
  })
})

describe('jsfile', () => {
  test('파일의 내용을 표현식으로 보낸다', (t) => {
    const { box, script } = ego(t, egoOut('3'))
    const src = write(join(box.root, 'probe.js'), 'const a = 1;\na + 2')
    const done = box.run(['jsfile', '9:p2', src, '--timeout', '40000'])
    assert.deepEqual([done.code, done.stdout], [0, '3\n'], done.stderr)
    assert.ok(script().includes('const a = 1;\\na + 2'))
    assert.ok(script().includes('timeout: 40000'))
  })

  test('파일이 없으면 2 로 끝나고 OSError 문장을 적는다', (t) => {
    const { box, fake } = ego(t)
    const done = box.run(['jsfile', '9:p2', '/no/such/file.js'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, "스크립트 파일을 읽지 못했다: [Errno 2] No such file or directory: '/no/such/file.js'\n")
    assert.equal(fake.calls().length, 0)
  })

  test('폴더를 주면 2 로 끝난다', (t) => {
    const { box } = ego(t)
    const done = box.run(['jsfile', '9:p2', box.root])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, `스크립트 파일을 읽지 못했다: [Errno 21] Is a directory: '${box.root}'\n`)
  })

  test('줄바꿈은 \\n 으로 읽는다', (t) => {
    const { box, script } = ego(t, egoOut('1'))
    const src = write(join(box.root, 'crlf.js'), 'a\r\nb\rc')
    assert.equal(box.run(['jsfile', '9:p2', src]).code, 0)
    assert.ok(script().includes('"a\\nb\\nc"'))
  })

  test('UTF-8 이 아닌 파일은 1 로 멈춘다', (t) => {
    const { box } = ego(t)
    const src = write(join(box.root, 'bad.js'), Buffer.from([0x61, 0xff, 0x0a]))
    assert.equal(box.run(['jsfile', '9:p2', src]).code, 1)
  })

  test('ASCII 밖의 글자는 \\u 표기로 스크립트에 들어간다', (t) => {
    const { box, script } = ego(t, egoOut('1'))
    assert.equal(box.run(['js', '9:p2', '"한글😀\u007f"']).code, 0)
    assert.ok(script().includes('const code = "\\"\\ud55c\\uae00\\ud83d\\ude00\\u007f\\"";'))
  })
})

describe('도움말', () => {
  test('ego 에서 새 명령을 못 쓴다고 표시하지 않는다', (t) => {
    const { box } = ego(t)
    const lines = box.run(['help']).stdout.split('\n')
    for (const name of ['jsfile', 'click', 'drag', 'hover', 'spaces', 'reset']) {
      const line = lines.find((l) => l.startsWith(`  ${name} `))
      assert.ok(line, name)
      assert.ok(!line.includes('(이 백엔드는 못 씀)'), line)
    }
    assert.ok(lines.some((l) => l.includes('--timeout')))
  })
})

describe('다른 백엔드', () => {
  function orca(t: T) {
    const box = new Box(t)
    box.env.BROWSER_DRIVER = 'orca'
    box.fake('orca', [{ stdout: '{"ok":true,"result":{"result":"x"}}\n' }])
    return box
  }

  test('--timeout 없는 js 는 그대로 돈다', (t) => {
    const done = orca(t).run(['js', 'tab1', '1'])
    assert.deepEqual([done.code, done.stdout], [0, 'x\n'], done.stderr)
  })

  test('--timeout 은 무시하지 않고 거절한다', (t) => {
    const done = orca(t).run(['js', 'tab1', '1', '--timeout', '1000'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, 'orca 백엔드는 js 의 --timeout 을 지원하지 않는다.\n')
  })

  test('공간 명령은 거절한다', (t) => {
    const box = orca(t)
    for (const args of [['spaces'], ['reset', '--space-id', '3']]) {
      const done = box.run(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.match(done.stderr, /대응 명령을 확인하지 못했다/)
    }
  })

  test('마우스 명령은 거절한다', (t) => {
    const box = orca(t)
    for (const args of [['click', 'tab1', '1', '2'], ['hover', 'tab1', '1', '2'], ['drag', 'tab1', '1', '2', '3', '4']]) {
      const done = box.run(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.match(done.stderr, /대응 명령을 확인하지 못했다/)
    }
  })
})

describe('인자 해석', () => {
  test('js 의 --timeout 은 표현식 앞뒤 어디에 와도 된다', (t) => {
    const { box, script } = ego(t, egoOut('2'))
    assert.equal(box.run(['js', '9:p2', '1+1']).code, 0)
    assert.ok(!script().includes('waitForFunction'))
    assert.equal(box.run(['js', '9:p2', '1+1', '--timeout', '500']).code, 0)
    assert.ok(script().includes('timeout: 500 }'))
    assert.equal(box.run(['js', '9:p2', '--timeout', '700', '1+1']).code, 0)
    assert.ok(script().includes('timeout: 700 }'))
  })

  test('--timeout 값은 float 으로 읽어 정수로 자른다', (t) => {
    const { box, script } = ego(t, egoOut('2'))
    for (const [raw, want] of [['1e3', 1000], ['500.9', 500], [' 7 ', 7], ['1_000', 1000]] as const) {
      assert.equal(box.run(['js', '9:p2', '1', '--timeout', raw]).code, 0, raw)
      assert.ok(script().includes(`timeout: ${want} }`), raw)
    }
  })

  test('js 인자가 틀리면 2 로 끝나고 백엔드를 부르지 않는다', (t) => {
    const { box, fake } = ego(t)
    const cases: [string[], string][] = [
      [['js', '9:p2', 'x', '--timeout'], '--timeout 에 값이 없다'],
      [['js', '9:p2', 'x', '--timeout', '0'], '--timeout 은 1 이상의 밀리초여야 한다: 0'],
      [['js', '9:p2', 'x', '--timeout', '0.5'], '--timeout 은 1 이상의 밀리초여야 한다: 0.5'],
      [['js', '9:p2', 'x', '--timeout', '-5'], '--timeout 은 1 이상의 밀리초여야 한다: -5'],
      [['js', '9:p2', 'x', '--timeout', 'soon'], '숫자여야 한다 (--timeout): soon'],
      [['js', '9:p2', 'x', '--timeout', '--'], '숫자여야 한다 (--timeout): --'],
      [['js', '9:p2', 'x', 'y'], '인자가 모자라거나 남는다. js <handle> <expression> [--timeout <ms>]'],
      [['js', '9:p2', 'x', '--timeout', '5', '--timeout', '6'], '인자가 모자라거나 남는다. js <handle> <expression> [--timeout <ms>]'],
      [['js', '9:p2'], '인자가 모자란다.\n사용법: js <handle> <expression> [--timeout <ms>]\n  JS 표현식을 실행한다'],
    ]
    for (const [args, message] of cases) {
      const done = box.run(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.equal(done.stderr, `${message}\n`, args.join(' '))
    }
    assert.equal(fake.calls().length, 0)
  })

  test('--timeout 이 inf 나 nan 이면 처리하지 못한 오류로 1 로 끝난다', (t) => {
    const { box } = ego(t)
    for (const raw of ['inf', 'nan']) assert.equal(box.run(['js', '9:p2', 'x', '--timeout', raw]).code, 1, raw)
  })

  test('핸들 형식이 아니면 2 로 끝난다', (t) => {
    const { box, fake } = ego(t)
    for (const handle of ['h', '9', ':p1', 'a:p1', '9:']) {
      const done = box.run(['url', handle])
      assert.equal(done.code, 2, handle)
      assert.equal(done.stderr, `ego 핸들 형식이 아니다: ${handle}. open 이 낸 '<spaceId>:<pageLabel>' 을 그대로 넘긴다\n`)
    }
    assert.equal(fake.calls().length, 0)
  })

  test('핸들의 공간 번호는 유니코드 숫자도 받는다', (t) => {
    const { box, script } = ego(t, egoOut('https://x'))
    assert.equal(box.run(['url', '٣:p1']).code, 0)
    assert.ok(script().includes('taskSpace(3)'))
  })

  test('숫자로 보이지만 int 로 못 읽는 공간 번호는 1 로 끝난다', (t) => {
    const { box } = ego(t)
    assert.equal(box.run(['url', '²:p1']).code, 1)
  })

  test('reset 인자를 검사한다', (t) => {
    const { box, fake, script } = (() => {
      const e = ego(t, egoOut(JSON.stringify({ space: 12, refused: null, res: { closedSpace: true, closedManagedLabels: [] }, closing: [] })))
      return e
    })()
    const cases: [string[], string][] = [
      [['reset', '--space-id'], '--space-id 에 값이 없다'],
      [['reset', '--space-id', 'abc'], '--space-id 는 spaces 가 낸 숫자 id 여야 한다: abc'],
      [['reset', '--space-id', '-1'], '--space-id 는 spaces 가 낸 숫자 id 여야 한다: -1'],
      [['reset', 'Default', '--space-id', '3'], '--space-id 와 프로필은 함께 줄 수 없다. id 가 공간을 정한다'],
      [['reset', 'a', 'b'], '인자가 남는다. reset [profile] [--space-id <id>]'],
      [['reset', '--space-id', ''], '--space-id 는 spaces 가 낸 숫자 id 여야 한다: '],
    ]
    for (const [args, message] of cases) {
      const done = box.run(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.equal(done.stderr, `${message}\n`, args.join(' '))
    }
    assert.equal(fake.calls().length, 0)
    const ok = box.run(['reset', '--space-id', '12'])
    assert.equal(ok.code, 0, ok.stderr)
    assert.ok(script().includes('const targetId = 12;'))
  })

  test('기본 공간에서는 프로필을 줘도 reset 을 거절한다', (t) => {
    const { box, fake } = ego(t)
    for (const args of [['reset'], ['reset', 'Default']]) {
      const done = box.run(args)
      assert.equal(done.code, 2)
      assert.match(done.stderr, /^기본 공간에서는 reset 하지 않는다\./)
    }
    assert.equal(fake.calls().length, 0)
  })
})

describe('마우스 스크립트', () => {
  test('click 은 좌표와 버튼을 그대로 넘긴다', (t) => {
    const { box, script } = ego(t, egoOut(''))
    assert.equal(box.run(['click', '1:p1', '50', '60', '--button', 'right']).code, 0)
    assert.ok(script().includes('page.mouse.click(50.0, 60.0, { button: "right" })'))
    assert.equal(box.run(['click', '1:p1', '1', '2.5']).code, 0)
    assert.ok(script().includes('page.mouse.click(1.0, 2.5, { button: "left" })'))
  })

  test('hover 는 움직이기만 한다', (t) => {
    const { box, script } = ego(t, egoOut(''))
    assert.equal(box.run(['hover', '1:p1', '5', '6']).code, 0)
    assert.ok(script().includes('page.mouse.move(5.0, 6.0)'))
    assert.ok(!script().includes('mouse.down'))
    assert.ok(!script().includes('mouse.click'))
  })

  test('drag 은 누르고 옮기고 놓는 순서다', (t) => {
    const { box, script } = ego(t, egoOut(''))
    assert.equal(box.run(['drag', '1:p1', '1', '2', '30', '40']).code, 0)
    const s = script()
    const order = ['mouse.move(1.0, 2.0)', 'mouse.down', 'mouse.move(30.0, 40.0', 'mouse.up'].map((token) => s.indexOf(token))
    assert.ok(order.every((at) => at >= 0))
    assert.deepEqual(order, [...order].sort((a, b) => a - b))
    assert.ok(s.includes('{ steps: 10 }'))
  })

  test('좌표는 Python float 의 문자열 꼴로 들어간다', (t) => {
    const { box, script } = ego(t, egoOut(''))
    const cases: [string, string][] = [
      ['50', '50.0'], ['2.5', '2.5'], ['1e-5', '1e-05'], ['1e16', '1e+16'], ['1_0', '10.0'], [' 5 ', '5.0'], ['.5', '0.5'], ['5.', '5.0'],
      ['+3', '3.0'], ['-0', '-0.0'], ['inf', 'inf'], ['-Infinity', '-inf'], ['nan', 'nan'], ['١٢', '12.0'], ['0.0001', '0.0001'],
      ['0.00001', '1e-05'], ['\u00a010\u0085', '10.0'], ['\u300010\u2028', '10.0'], ['123456789012345678', '1.2345678901234568e+17'], ['1e400', 'inf'], ['0.1', '0.1'], ['100', '100.0'],
    ]
    for (const [raw, want] of cases) {
      assert.equal(box.run(['hover', '1:p1', raw, '0']).code, 0, raw)
      assert.ok(script().includes(`page.mouse.move(${want}, 0.0)`), `${raw} → ${want}`)
    }
  })

  test('좌표나 버튼이 틀리면 2 로 끝나고 백엔드를 부르지 않는다', (t) => {
    const { box, fake } = ego(t)
    const cases: [string[], string][] = [
      [['click', 'h', 'a', '2'], '숫자여야 한다 (좌표): a'],
      [['click', '1:p1', '0x10', '2'], '숫자여야 한다 (좌표): 0x10'],
      [['click', '1:p1', '1__0', '2'], '숫자여야 한다 (좌표): 1__0'],
      [['click', '1:p1', '1e', '2'], '숫자여야 한다 (좌표): 1e'],
      ...['\x1c', '\x1d', '\x1e', '\x1f'].flatMap((c): [string[], string][] => [[['click', '1:p1', `${c}10`, '2'], `숫자여야 한다 (좌표): ${c}10`], [['click', '1:p1', `10${c}`, '2'], `숫자여야 한다 (좌표): 10${c}`]]),
      [['click', '1:p1', '', '2'], '숫자여야 한다 (좌표): '],
      [['click', '1:p1', '1'], '인자가 모자란다.\n사용법: click <handle> <x> <y> [--button left|middle|right]\n  CSS 픽셀 좌표를 실제 마우스 입력으로 누른다'],
      [['click', '1:p1', '1', '2', '3'], '인자가 모자라거나 남는다. 핸들 뒤에 좌표 2개가 필요하다 (click)'],
      [['click', '1:p1', '1', '2', '--button'], '--button 에 값이 없다'],
      [['click', '1:p1', '1', '2', '--button', 'back'], '--button 은 left, middle, right 중 하나여야 한다: back'],
      [['click', '1:p1', '1', '2', '--button', 'left', '--button', 'right'], '인자가 모자라거나 남는다. 핸들 뒤에 좌표 2개가 필요하다 (click)'],
      [['hover', '1:p1', '1', '2', '--button', 'right'], '인자가 모자라거나 남는다. 핸들 뒤에 좌표 2개가 필요하다 (hover)'],
      [['drag', '1:p1', '1', '2', '3'], '인자가 모자란다.\n사용법: drag <handle> <x1> <y1> <x2> <y2> [--button left|middle|right]\n  한 좌표에서 눌러 다른 좌표까지 끌고 놓는다'],
    ]
    for (const [args, message] of cases) {
      const done = box.run(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.equal(done.stderr, `${message}\n`, args.join(' '))
    }
    assert.equal(fake.calls().length, 0)
  })
})

// 가짜 page 에 대고 ego 가 만든 스크립트를 실제로 돌린다
const FAKE_API = `
const calls = [];
const fakePage = {
  label: 'p1',
  evaluate: async (src) => (0, eval)(src),
  waitForFunction: async (src, _arg, opts) => {
    calls.push(opts.timeout);
    for (let i = 0; i < 50 && !(await (0, eval)(src)); i += 1) await new Promise((r) => setTimeout(r, 10));
  },
  mouse: { click: async () => {}, move: async () => {}, down: async () => {}, up: async () => {} },
};
globalThis.window = globalThis;
const taskSpace = async () => ({ spaceId: 1, page: () => fakePage });
`

describe('ego 스크립트 실행', () => {
  function run(t: T, expression: string, extra: string[] = []) {
    const box = new Box(t)
    box.env.BROWSER_DRIVER = 'ego'
    box.fake('ego-browser', [{ prelude: FAKE_API }])
    return box.run(['js', '1:p1', expression, ...extra])
  }

  test('표현식 모양마다 값을 낸다', (t) => {
    const cases: [string, string][] = [
      ['1 + 1', '2'], ['({a: 1})', '{"a":1}'], ["'text'", 'text'], ['(async () => "x")()', 'x'], ['null', 'null'], ['undefined', ''],
      ['[1, "a", null]', '[1,"a",null]'], ['true', 'true'], ['"한글"', '한글'], ['({k: "한글"})', '{"k":"한글"}'], ['1.5', '1.5'], ['1e21', '1e+21'],
    ]
    for (const [code, want] of cases) {
      const done = run(t, code)
      assert.equal(done.code, 0, `${code}: ${done.stderr}`)
      assert.equal(done.stdout, `${want}\n`, code)
    }
  })

  test('여러 문장이면 마지막 문장의 값을 낸다', (t) => {
    assert.equal(run(t, 'const a = 4; a * 2').stdout, '8\n')
    assert.equal(run(t, '1; 2').stdout, '2\n')
  })

  test('--timeout 이 있으면 페이지 안에서 시작하고 기다린다', (t) => {
    const done = run(t, '(async () => { await new Promise((r) => setTimeout(r, 30)); return "late"; })()', ['--timeout', '45000'])
    assert.deepEqual([done.code, done.stdout], [0, 'late\n'], done.stderr)
  })

  test('--timeout 에서 페이지 오류가 나오면 1 로 끝난다', (t) => {
    const done = run(t, '(async () => { throw new Error("boom"); })()', ['--timeout', '45000'])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('boom'))
  })

  test('15초 안내는 evaluate 시간 초과에만 붙는다', (t) => {
    const box = new Box(t)
    box.env.BROWSER_DRIVER = 'ego'
    box.fake('ego-browser', [{ stderr: 'Error: page.evaluate timed out after 15000ms\n    at x\n', code: 1 }])
    const done = box.run(['js', '1:p1', 'new Promise(() => {})'])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.startsWith('표현식이 15초 안에 끝나지 않았다. 더 걸리는 비동기 표현식은 --timeout <ms> 를 준다.\nError: page.evaluate timed out'))
    const timed = box.run(['js', '1:p1', 'new Promise(() => {})', '--timeout', '900'])
    assert.ok(timed.stderr.startsWith('표현식이 --timeout 900ms 안에 끝나지 않았다. 페이지 안에서는 계속 돌고 있을 수 있다.\n'))
  })

  test('제어권을 가져간 공간과 page 한도는 첫 줄에 할 일을 적는다', (t) => {
    const box = new Box(t)
    box.env.BROWSER_DRIVER = 'ego'
    const fake = box.fake('ego-browser', [{ stderr: 'Error: the user has taken control of this space\n', code: 1 }])
    let done = box.run(['url', '1:p1'])
    assert.ok(done.stderr.startsWith('사용자가 이 TaskSpace 의 제어권을 가지고 있어 조작이 거절됐다. 브라우저에서 제어권을 돌려주거나, open 을 다시 불러 새 공간을 만든다.\n'))
    assert.equal(done.code, 1)
    fake.setRules([{ stderr: 'PageBudget exceeded\n', code: 1 }])
    done = box.run(['url', '1:p1'])
    assert.ok(done.stderr.startsWith('이 공간의 page 수가 한도에 찼다. pages 로 무엇이 열려 있는지 보고 close 로 골라 닫는다.'))
  })

  test('0 이 아닌 종료 코드는 출력이 없어도 종료 코드를 적는다', (t) => {
    const box = new Box(t)
    box.env.BROWSER_DRIVER = 'ego'
    box.fake('ego-browser', [{ code: 7 }])
    const done = box.run(['url', '1:p1'])
    assert.equal(done.code, 1)
    assert.equal(done.stderr, 'ego-browser 가 종료 코드 7 로 끝났다\n')
  })
})
