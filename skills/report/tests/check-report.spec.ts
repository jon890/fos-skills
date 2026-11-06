// report 의 check-report 명령 경계 테스트. HTML 파일을 임시 폴더에 쓰고 stdout 줄, stderr, 종료 코드를 본다.
// 옛 Python html.parser 와 같은 태그 짝, 줄 번호, 문자 참조 처리를 사례로 고정한다.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../../modules/testkit/command.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const SKILL = join(import.meta.dirname, '..')
const SCRIPT_NAME = 'check-report.ts'
const COMMAND = ['node', join(SKILL, 'scripts', SCRIPT_NAME)]
// ──

const OK_BODY = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>t</title>
<style>body{color:#000}.x{background:url(data:image/png;base64,AAAA)}</style></head>
<body>
<nav><a href="#concl">결론</a></nav>
<section id="concl"><p>본문이다 <a class="ref" href="#src-A1">[A1]</a>.</p>
<p>밖의 글은 <a href="https://example.com/doc">여기</a> 에 있다.</p>
<img src="data:image/png;base64,AAAA" alt="">
</section>
<table><tbody><tr id="src-A1"><td>A1</td><td><a href="https://example.com">문서</a></td></tr></tbody></table>
</body></html>
`

function setup(t: { after(fn: () => void): void }) {
  const dir = tempDir('check-report-', t)
  const write = (body: string, name = 'sample-report.html') => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }
  const run = (...args: string[]) => runCommand([...COMMAND, ...args], { cwd: dir })
  return { dir, write, run }
}

describe('검사', () => {
  test('정상 보고서는 통과', (t) => {
    const s = setup(t)
    const path = s.write(OK_BODY)
    const done = s.run(path)
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, `통과: ${path}\n`, ''])
  })

  const external: [string, string][] = [
    ['밖의 script', OK_BODY.replace('</head>', '<script src="https://cdn.example.com/a.js"></script></head>')],
    ['상대 경로 스타일시트', OK_BODY.replace('</head>', '<link rel="stylesheet" href="x.css"></head>')],
    ['상대 경로 이미지', OK_BODY.replace('src="data:image/png;base64,AAAA"', 'src="a.png"')],
    ['CSS url', OK_BODY.replace('body{color:#000}', 'body{background:url(https://x.example/bg.png)}')],
    ['CSS import', OK_BODY.replace('<style>', "<style>@import 'https://fonts.example/f.css';")],
    ['style 속성의 url', OK_BODY.replace('<section ', '<section style="background:url(bg.png)" ')],
    ['svg use', OK_BODY.replace('</section>', '<svg><use href="icons.svg#a"/></svg></section>')],
    ['meta refresh', OK_BODY.replace('<title>', '<meta http-equiv="refresh" content="0; url=https://x.example"><title>')],
    ['body background', OK_BODY.replace('<body>', '<body background="https://x.example/a.png">')],
    ['srcset', OK_BODY.replace('</section>', '<img srcset="data:image/png;base64,AA 1x, b.png 2x" alt=""></section>')],
    ['input image', OK_BODY.replace('</section>', '<input type=IMAGE src=x.png></section>')],
    ['object data', OK_BODY.replace('</section>', '<object data="x.swf"></object></section>')],
    ['대문자 태그와 따옴표 없는 속성', OK_BODY.replace('</section>', '<IMG SRC=x.png ALT=""></section>')],
  ]
  for (const [name, body] of external) {
    test(`밖의 자원: ${name}`, (t) => {
      const s = setup(t)
      const done = s.run(s.write(body))
      assert.equal(done.code, 1, done.stdout)
      assert.match(done.stdout, /: external: /)
    })
  }

  test('내부 svg use, CSS 주석 안의 url 은 통과', (t) => {
    const s = setup(t)
    assert.equal(s.run(s.write(OK_BODY.replace('</section>', '<svg><defs><g id="dot"></g></defs><use href="#dot"/></svg></section>'))).code, 0)
    assert.equal(s.run(s.write(OK_BODY.replace('body{color:#000}', '/* url(https://x.example/a.png) */body{color:#000}'))).code, 0)
  })

  test('위반 줄은 줄 번호 순이고 끝 줄에 건수를 낸다', (t) => {
    const s = setup(t)
    const body = OK_BODY.replace('</head>', '<script src="https://cdn.example.com/a.js"></script></head>').replace('href="#src-A1"', 'href="#src-B9"').replace('<nav>', '<nav id="concl">')
    const path = s.write(body)
    const done = s.run(path)
    assert.equal(done.code, 1)
    assert.equal(
      done.stdout,
      [
        `${path}:3: external: <script src> 가 밖의 자원을 불러온다: https://cdn.example.com/a.js`,
        `${path}:6: id: id "concl" 가 5줄에도 있다`,
        `${path}:6: ref: #src-B9 를 가리키지만 그 id 가 없다`,
        `${path}:10: source: 출처 src-A1 를 가리키는 본문 링크가 없다`,
        '위반 4건',
        '',
      ].join('\n'),
    )
  })

  test('빈 파일은 tag 위반', (t) => {
    const s = setup(t)
    const path = s.write('')
    const done = s.run(path)
    assert.deepEqual([done.code, done.stdout], [1, `${path}:1: tag: <html> 요소가 없다. 틀을 복사해 채운 보고서가 아니다\n위반 1건\n`])
  })

  test('태그 짝: 닫히지 않음, 엇갈림, 여는 태그 없음', (t) => {
    const s = setup(t)
    const unclosed = s.run(s.write(OK_BODY.replace('</section>', '<div></section>')))
    assert.match(unclosed.stdout, /^.*:9: tag: <div> 가 닫히지 않고 <\/section> 를 만났다$/m)
    const crossed = s.run(s.write(OK_BODY.replace('<p>본문', '<div><span>x</div></span><p>본문')))
    assert.match(crossed.stdout, /: tag: <span> 가 닫히지 않고 <\/div> 를 만났다/)
    assert.match(crossed.stdout, /: tag: 여는 태그 없이 <\/span> 가 나온다/)
    const stray = s.run(s.write(OK_BODY.replace('<nav>', '</p><nav>')))
    assert.match(stray.stdout, /:5: tag: 여는 태그 없이 <\/p> 가 나온다/)
  })

  test('끝에 닫히지 않은 태그는 여는 줄을 알린다', (t) => {
    const s = setup(t)
    const path = s.write(OK_BODY.replace('<body>', '<body>\n<main>'))
    assert.match(s.run(path).stdout, new RegExp(`${path}:5: tag: <main> 가 닫히지 않고 </body> 를 만났다`))
  })

  test('대소문자를 섞은 태그, 따옴표 없는 속성, 홑따옴표, 자체 닫힘은 같게 읽는다', (t) => {
    const s = setup(t)
    const body = OK_BODY.replace('<nav><a href="#concl">', "<NAV><A HREF=#concl>").replace('</nav>', '</Nav><br/><div/><input disabled><hr>').replace('<section id="concl">', "<section id='concl'>")
    const done = s.run(s.write(body))
    assert.equal(done.code, 0, done.stdout)
  })

  test('문자 참조가 든 속성 값은 풀어서 본다', (t) => {
    const s = setup(t)
    const body = OK_BODY.replace('<nav>', '<nav id="a&amp;b"><a href="#a&amp;b">').replace('</nav>', '</a></nav>')
    assert.equal(s.run(s.write(body)).code, 0)
  })

  test('script 안의 꺾쇠와 닫는 태그, 주석 안의 태그는 보지 않는다', (t) => {
    const s = setup(t)
    const body = OK_BODY.replace('</body>', '<script>if (a<b) x = "</p>"; var s = "<div>";</script><!-- <div> --></body>')
    assert.equal(s.run(s.write(body)).code, 0)
  })

  test('<html 이 없거나 슬러그가 아니면 위반', (t) => {
    const s = setup(t)
    assert.match(s.run(s.write(OK_BODY, 'My Report.html')).stdout, /:1: name: 파일 이름 My Report\.html 이 슬러그/)
    assert.match(s.run(s.write(OK_BODY.replace('<html lang="ko">', '<HTML>').replace('</html>', '</HTML>'))).stdout, /^통과/)
  })

  test('출처, 참조, id 위반', (t) => {
    const s = setup(t)
    assert.match(s.run(s.write(OK_BODY.replace('href="#src-A1"', 'href="#src-B9"'))).stdout, /: ref: /)
    assert.match(s.run(s.write(OK_BODY.replace('</tbody>', '<tr id="src-Y"><td>Y</td><td>안 쓴 출처</td></tr></tbody>'))).stdout, /: source: /)
    assert.match(s.run(s.write(OK_BODY.replace('<nav>', '<nav id="concl">'))).stdout, /: id: /)
  })

  test('공통 틀은 통과한다', (t) => {
    const s = setup(t)
    const done = s.run(s.write(readFileSync(join(SKILL, 'assets', 'template.html'), 'utf8'), 'template-sample.html'))
    assert.equal(done.code, 0, done.stdout)
  })
})

describe('인자와 파일', () => {
  test('인자가 없거나 옵션만 있으면 사용법과 종료 코드 2', (t) => {
    const s = setup(t)
    for (const args of [[], ['--bogus'], ['--text'], ['a', 'b']]) {
      const done = s.run(...args)
      assert.equal(done.code, 2, args.join(' '))
      assert.equal(done.stdout, '')
      assert.match(done.stderr, /^사용법:\n/)
    }
  })

  test('파일이 없으면 2', (t) => {
    const s = setup(t)
    const missing = join(s.dir, 'none.html')
    const done = s.run(missing)
    assert.deepEqual([done.code, done.stderr], [2, `check-report: 파일이 없다: ${missing}\n`])
  })
})

describe('--text', () => {
  test('보이는 글만 블록마다 한 줄씩 낸다', (t) => {
    const s = setup(t)
    const body = OK_BODY.replace('</section>', '<p>코드 <code>secret_code</code> 끝</p><script>var hidden=1;</script></section>')
    const done = s.run('--text', s.write(body))
    assert.equal(done.code, 0)
    assert.equal(done.stdout, ['t', '결론', '본문이다 [A1].', '밖의 글은 여기 에 있다.', '코드 끝', 'A1', '문서', ''].join('\n'))
  })

  test('줄 머리의 <, |, # 에는 역슬래시를 붙인다', (t) => {
    const s = setup(t)
    const done = s.run('--text', s.write(OK_BODY.replace('</section>', '<p>&lt;저장소&gt; 경로</p><p>| 칸</p><p># 번호</p></section>')))
    const lines = done.stdout.split('\n')
    assert.ok(lines.includes('\\<저장소> 경로'))
    assert.ok(lines.includes('\\| 칸'))
    assert.ok(lines.includes('\\# 번호'))
  })

  test('문자 참조를 풀고 공백(nbsp 포함)을 한 칸으로 합친다', (t) => {
    const s = setup(t)
    const done = s.run('--text', s.write('<html><body><p>a&nbsp;&nbsp;b &amp; c&#x41;&#66; &unknownref; d\n\t e</p></body></html>'))
    assert.deepEqual(done.stdout, 'a b & cAB &unknownref; d e\n')
  })

  test('HTML5 이름 참조를 모두 푼다', (t) => {
    const s = setup(t)
    const done = s.run('--text', s.write('<html><body><p>&alpha; &eacute; &notit; &Eacute; &lrarr; &#x1F600;</p></body></html>'))
    assert.equal(done.stdout, 'α é ¬it; É ⇆ 😀\n')
  })

  test('주석은 닫는 꼴 `-->`, `--!>` 까지이고 뒤에 그런 꼴이 없을 때만 `<!-->` 가 빈 주석이다', (t) => {
    const s = setup(t)
    assert.equal(s.run('--text', s.write('<html><body><!-- a --!> <p>b</p> --></body></html>')).stdout, 'b\n-->\n')
    assert.equal(s.run('--text', s.write('<html><body><!--><p>b</p></body></html>')).stdout, 'b\n')
    assert.equal(s.run('--text', s.write('<html><body><!--><p>b</p> --><i>c</i></body></html>')).stdout, 'c\n')
  })

  test('CDATA 구역은 `]]>` 까지 건너뛰고, 끝에서 잘린 `</` 는 글이다', (t) => {
    const s = setup(t)
    assert.equal(s.run('--text', s.write('<html><body><![CDATA[ <p> ]]><p>b</p></body></html>')).stdout, 'b\n')
    assert.equal(s.run('--text', s.write('<p>x</')).stdout, 'x</\n')
    assert.equal(s.run('--text', s.write('<p>x</p')).stdout, 'x\n')
  })

  test('인라인 요소는 줄을 나누지 않고 br 은 나눈다', (t) => {
    const s = setup(t)
    const done = s.run('--text', s.write('<html><body><p>앞 <b>굵게</b> 뒤<br>다음 줄</p><ul><li>하나</li><li>둘</li></ul><pre>숨김</pre><template>숨김2</template></body></html>'))
    assert.equal(done.stdout, '앞 굵게 뒤\n다음 줄\n하나\n둘\n')
  })

  test('낱말이 없으면 아무것도 내지 않고 0', (t) => {
    const s = setup(t)
    const done = s.run('--text', s.write('<html><body></body></html>'))
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })
})

describe('--korean', () => {
  test('금지어를 찾으면 1 이고 보고서 이름으로 알린다', (t) => {
    const s = setup(t)
    const done = s.run('--korean', s.write(OK_BODY.replace('본문이다', '트리아지 결과다')))
    assert.equal(done.code, 1, done.stdout + done.stderr)
    assert.match(done.stdout, /트리아지/)
    assert.match(done.stdout, /sample-report\.html \(--text 줄\):/)
  })

  test('표 셀 머리의 파이프 때문에 금지어를 놓치지 않는다', (t) => {
    const s = setup(t)
    assert.equal(s.run('--korean', s.write(OK_BODY.replace('<td>A1</td>', '<td>| 트리아지</td>'))).code, 1)
  })

  test('깨끗한 보고서와 공통 틀은 통과', (t) => {
    const s = setup(t)
    assert.equal(s.run('--korean', s.write(OK_BODY)).code, 0)
    assert.equal(s.run('--korean', join(SKILL, 'assets', 'template.html')).code, 0)
  })

  test('korean-check 를 찾지 못하면 2', (t) => {
    const s = setup(t)
    const scripts = join(s.dir, 'lonely', 'report', 'scripts')
    mkdirSync(scripts, { recursive: true })
    cpSync(join(SKILL, 'scripts'), scripts, { recursive: true })
    const env = { ...process.env, HOME: join(s.dir, 'home') }
    delete env.KOREAN_CHECK
    const done = runCommand([COMMAND[0], join(scripts, SCRIPT_NAME), '--korean', s.write(OK_BODY)], { env })
    assert.equal(done.code, 2, done.stdout + done.stderr)
    assert.equal(done.stderr, 'check-report: korean-check 를 찾지 못했다. KOREAN_CHECK 로 그 스킬 경로를 준다\n')
  })
})
