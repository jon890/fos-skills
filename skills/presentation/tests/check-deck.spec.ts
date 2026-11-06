// presentation 의 check-deck 명령 경계 테스트. 덱 HTML 을 임시 폴더에 쓰고 stdout 줄, stderr, 종료 코드를 본다.
// 명령은 자기 위치로 저장소 루트와 korean-check, browser-driver 를 찾으므로 임시 root 에 복사해 부르고, 가짜 드라이버를 둔다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const SKILL = join(import.meta.dirname, '..')
const RUNNER = ['python3']
const SCRIPTS = ['check-deck.py']
// ──

// 전역 금지어 표를 가진 korean-check. 저장소의 내보내기 전용 원본을 쓴다
const KOREAN_CHECK = join(SKILL, '..', '..', 'export-only-skills', 'korean-check')

const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

const SLIDE = (n: number, active: boolean, title = `제목 ${n}`) =>
  `<!-- ${String(n).padStart(2, '0')} -->\n<section class="slide${active ? ' active' : ''}" data-title="${title}"><h1>안녕 ${n}</h1></section>\n<template class="note">노트 ${n}</template>\n`

const DECK = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>d</title><style>body{color:#000}</style></head>
<body>
<div id="pageno"></div><div id="ovgrid"></div><div id="sv-body"></div>
${SLIDE(1, true)}${SLIDE(2, false)}<script>var a = 1;</script>
</body></html>
`

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'check-deck-')))
  roots.push(root)
  const scripts = join(root, 'skills', 'presentation', 'scripts')
  mkdirSync(scripts, { recursive: true })
  for (const name of SCRIPTS) copyFileSync(join(SKILL, 'scripts', name), join(scripts, name))
  const home = join(root, 'home')
  mkdirSync(home)
  const write = (body: string, name = 'deck.html') => {
    const path = join(root, name)
    writeFileSync(path, body)
    return path
  }
  const driver = (body: string) => {
    const path = join(root, 'tools', 'browser-driver', 'browser_driver.py')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!${process.execPath}\n${body}`)
    chmodSync(path, 0o755)
    return path
  }
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const merged: Record<string, string | undefined> = { ...process.env, HOME: home, KOREAN_CHECK_DIR: KOREAN_CHECK, ...env }
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
    const done = spawnSync(RUNNER[0], [...RUNNER.slice(1), join(scripts, SCRIPTS[0]), ...args], { cwd: root, encoding: 'utf8', env: merged as NodeJS.ProcessEnv })
    return { code: done.status, stdout: done.stdout, stderr: done.stderr }
  }
  return { root, write, driver, run }
}

const bad = (...lines: string[]) => `\n${lines.map((line) => `✗ ${line}\n`).join('')}`

describe('구조 검사', () => {
  test('정상 덱은 통과', () => {
    const s = setup()
    const done = s.run([s.write(DECK)])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, '· 장 2개\n통과\n', ''])
  })

  test('공통 틀은 통과', () => {
    const s = setup()
    const done = s.run([s.write(readFileSync(join(SKILL, 'assets', 'deck-template.html'), 'utf8'))])
    assert.deepEqual([done.code, done.stdout], [0, '· 장 8개\n통과\n'])
  })

  test('속성 순서가 달라도 장을 센다', () => {
    const s = setup()
    const reordered = DECK.replace('<section class="slide active" data-title="제목 1">', '<section data-title="제목 1" id="a" class="slide active">')
    assert.equal(s.run([s.write(reordered)]).code, 0)
  })

  test('장 주석 개수가 다르다', () => {
    const s = setup()
    const done = s.run([s.write(DECK.replace('<!-- 02 -->\n', ''))])
    assert.deepEqual([done.code, done.stdout], [1, `· 장 2개\n${bad('장 주석 1개와 section 2개가 다르다')}`])
  })

  test('장 주석 번호가 어긋난다', () => {
    const s = setup()
    const done = s.run([s.write(DECK.replace('<!-- 02 -->', '<!-- 03 -->'))])
    assert.deepEqual([done.code, done.stdout], [1, `· 장 2개\n${bad('장 주석 번호가 어긋난다: 2번째가 <!-- 03 -->')}`])
  })

  test('active 장이 둘이거나 없다', () => {
    const s = setup()
    assert.equal(s.run([s.write(DECK.replace('class="slide" data-title="제목 2"', 'class="slide active" data-title="제목 2"'))]).stdout, `· 장 2개\n${bad('active 장이 2개다. 정확히 1개여야 한다')}`)
    assert.equal(s.run([s.write(DECK.replace('slide active', 'slide'))]).stdout, `· 장 2개\n${bad('active 장이 0개다. 정확히 1개여야 한다')}`)
  })

  test('data-title 이 없거나 비었다', () => {
    const s = setup()
    const missing = s.run([s.write(DECK.replace(' data-title="제목 2"', ''))])
    assert.equal(missing.stdout, `· 장 1개\n${bad('data-title 이 없는 장이 1개다', '장 주석 2개와 section 1개가 다르다', '노트가 2개, 장이 1개다. 장마다 노트가 있어야 한다')}`)
    const empty = s.run([s.write(DECK.replace('data-title="제목 2"', 'data-title=""'))])
    assert.equal(empty.stdout, `· 장 2개\n${bad('data-title 이 빈 장: [2]')}`)
  })

  test('노트가 모자란다', () => {
    const s = setup()
    const done = s.run([s.write(DECK.replace('<template class="note">노트 2</template>\n', ''))])
    assert.equal(done.stdout, `· 장 2개\n${bad('노트가 1개, 장이 2개다. 장마다 노트가 있어야 한다')}`)
  })

  test('옛 하드코딩 값이 남았다', () => {
    const s = setup()
    const done = s.run([s.write(DECK.replace('<div id="pageno"></div>', '<div id="pageno">3 / 8</div>').replace('<div id="sv-body"></div>', '<div id="sv-body"><p>옛</p></div>'))])
    assert.equal(done.stdout, `· 장 2개\n${bad("쪽 표시(pageno) 에 옛 내용이 박혀 있다: '3 / 8'", "스크립트 패널(sv-body) 에 옛 내용이 박혀 있다: '<p>옛'")}`)
  })

  test('script 블록은 하나여야 하고 문법이 맞아야 한다', () => {
    const s = setup()
    assert.equal(s.run([s.write(DECK.replace('</body>', '<script>var b = 2;</script></body>'))]).stdout, `· 장 2개\n${bad('<script> 블록이 2개다. 1개여야 한다')}`)
    assert.equal(s.run([s.write(DECK.replace('<script>var a = 1;</script>', ''))]).stdout, `· 장 2개\n${bad('<script> 블록이 0개다. 1개여야 한다')}`)
    const syntax = s.run([s.write(DECK.replace('var a = 1;', 'var = ;'))])
    assert.equal(syntax.code, 1)
    assert.match(syntax.stdout, /^· 장 2개\n\n✗ JS 문법 오류: .*\.js:1\n$/)
  })
})

describe('금지어', () => {
  test('전역 금지어는 korean-check 의 표에서 읽는다', () => {
    const s = setup()
    const done = s.run([s.write(DECK.replace('안녕 1', '시험 결과'))])
    assert.deepEqual([done.code, done.stdout], [1, `· 장 2개\n${bad('금지어: 시험')}`])
  })

  test('덱 고유 금지어', () => {
    const s = setup()
    const done = s.run([s.write(DECK.replace('안녕 2', '결과를 굳혔다 정직하게'))])
    assert.equal(done.stdout, `· 장 2개\n${bad('금지어: 굳혔다', '금지어: 정직하게')}`)
  })

  test('style 과 script 안의 낱말, 같은 낱말의 되풀이는 한 번만 센다', () => {
    const s = setup()
    const done = s.run([s.write(DECK.replace('body{color:#000}', 'body{content:"시험"}').replace('var a = 1;', 'var 시험 = 1;').replace('안녕 1', '시험 시험').replace('안녕 2', '시험'))])
    assert.equal(done.stdout, `· 장 2개\n${bad('금지어: 시험')}`)
  })

  test('korean-check 가 없으면 건너뛰었다고 알리고 덱 고유 금지어는 본다', () => {
    const s = setup()
    const missing = join(s.root, 'no-korean-check')
    const done = s.run([s.write(DECK.replace('안녕 1', '시험 굳혔다'))], { KOREAN_CHECK_DIR: missing })
    assert.equal(done.stdout, `· 장 2개\n· ${missing} 가 없어 전역 금지어를 못 봤다\n${bad('금지어: 굳혔다')}`)
  })

  test('옆 폴더의 korean-check 를 먼저 찾는다', () => {
    const s = setup()
    const sibling = join(s.root, 'skills', 'korean-check')
    mkdirSync(join(sibling, 'references'), { recursive: true })
    mkdirSync(join(sibling, 'scripts'), { recursive: true })
    copyFileSync(join(KOREAN_CHECK, 'references', 'korean-style.md'), join(sibling, 'references', 'korean-style.md'))
    copyFileSync(join(KOREAN_CHECK, 'scripts', 'korean-style-check.py'), join(sibling, 'scripts', 'korean-style-check.py'))
    const env = { KOREAN_CHECK_DIR: undefined }
    const done = s.run([s.write(DECK.replace('안녕 1', '시험 결과'))], env)
    assert.equal(done.stdout, `· 장 2개\n${bad('금지어: 시험')}`)
  })
})

describe('--browser', () => {
  // 인자를 기록하고 open 은 탭 이름을, js 는 넘침 문자열을 낸다
  const driverBody = (opts: { open?: number; js?: string; jsCode?: number; openErr?: string } = {}) => `const fs = require('node:fs')
const argv = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify('LOG')}, argv.slice(0, 2).join(' ') + '\\n')
if (argv[0] === 'open') {
  if (${opts.open ?? 0}) { process.stderr.write(${JSON.stringify(opts.openErr ?? '')}); process.exit(${opts.open ?? 0}) }
  console.log('warming'); console.log('tab-1')
} else if (argv[0] === 'js') {
  if (${opts.jsCode ?? 0}) { process.stderr.write('boom'); process.exit(${opts.jsCode ?? 0}) }
  process.stdout.write(${JSON.stringify(opts.js ?? '')} + '\\n')
}
`

  function withDriver(s: ReturnType<typeof setup>, opts?: Parameters<typeof driverBody>[0]) {
    const log = join(s.root, 'driver.log')
    s.driver(driverBody(opts).replace('"LOG"', JSON.stringify(log)))
    return () => (existsLog(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  }
  const existsLog = (path: string) => spawnSync('test', ['-f', path]).status === 0

  test('넘침이 없으면 통과하고 탭을 닫는다', () => {
    const s = setup()
    const calls = withDriver(s)
    const done = s.run([s.write(DECK), '--browser'])
    assert.deepEqual([done.code, done.stdout], [0, '· 장 2개\n· 세로 넘침 없음\n통과\n'])
    assert.deepEqual(calls(), ['open file://' + join(s.root, 'deck.html'), 'js tab-1', 'close tab-1'])
  })

  test('넘친 장을 알린다', () => {
    const s = setup()
    const calls = withDriver(s, { js: '2 제목 2 +40px' })
    const done = s.run(['--browser', s.write(DECK)])
    assert.deepEqual([done.code, done.stdout], [1, `· 장 2개\n${bad('세로 넘침: 2 제목 2 +40px')}`])
    assert.equal(calls().at(-1), 'close tab-1')
  })

  test('탭을 열지 못하거나 측정이 실패하면 위반이다', () => {
    const s = setup()
    withDriver(s, { open: 1, openErr: '연결 안 됨' })
    assert.equal(s.run([s.write(DECK), '--browser']).stdout, `· 장 2개\n${bad('브라우저 검사: 탭을 열지 못했다 연결 안 됨')}`)
    const calls = withDriver(s, { jsCode: 3 })
    const measured = s.run([s.write(DECK), '--browser'])
    assert.equal(measured.stdout, `· 장 2개\n${bad('브라우저 검사: 측정에 실패했다 boom')}`)
    assert.equal(calls().at(-1), 'close tab-1')
  })

  test('드라이버가 없으면 건너뛰고 통과한다', () => {
    const s = setup()
    const done = s.run([s.write(DECK), '--browser'])
    assert.deepEqual([done.code, done.stdout], [0, '· 장 2개\n· browser-driver 가 없어 넘침을 못 봤다\n통과\n'])
  })

  test('--browser 가 없으면 드라이버를 부르지 않는다', () => {
    const s = setup()
    const calls = withDriver(s)
    assert.equal(s.run([s.write(DECK)]).code, 0)
    assert.deepEqual(calls(), [])
  })
})

describe('인자', () => {
  test('덱 경로가 없으면 사용법과 2', () => {
    const s = setup()
    for (const args of [[], ['--browser']]) {
      const done = s.run(args)
      assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', '사용법: check-deck.py <deck.html> [--browser]\n'])
    }
  })

  test('파일이 없으면 2', () => {
    const s = setup()
    const done = s.run(['없는.html'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', '파일이 없다: 없는.html\n'])
  })

  test('모르는 -- 옵션은 무시한다', () => {
    const s = setup()
    assert.equal(s.run([s.write(DECK), '--whatever']).code, 0)
  })
})
