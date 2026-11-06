// content-preview 의 Dooray 미리보기 생성기 명령 경계 테스트. 옵션, 생성한 HTML, stderr 경고, 종료 코드를 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { generate, parsePreview } from './generator.ts'
import { SCRIPTS_DIR, tempDir } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = [process.execPath, join(SCRIPTS_DIR, 'dooray-preview', 'generate.ts')]
const PROG = 'generate.ts'
// ──

function messenger(body: string, strict = false, extra: string[] = []) {
  const args = ['--mode', 'messenger', '--title', 'example channel', '--author', 'example author', '--md-file', '-', ...extra]
  if (strict) args.push('--strict')
  return generate(COMMAND, args, { input: body })
}

describe('dooray-preview 메신저', () => {
  test('확인된 형식만 렌더한다', () => {
    const body = '[@example](dooray://example/members/example "member")\nhttps://example.com/project/tasks/example\n1. 첫째 `code https://example.com/in-code`\n\n[example](https://example.com/page)'
    const done = messenger(body, true)
    const parsed = parsePreview(done.html)
    assert.equal(done.code, 0)
    assert.equal(done.stderr, '')
    assert.equal(done.stdout, `생성 완료: ${done.out}\n`)
    assert.equal(parsed.alerts, 0)
    assert.deepEqual(parsed.links, ['dooray://example/members/example', 'https://example.com/project/tasks/example', 'https://example.com/page'])
    assert.ok(parsed.text.includes('example channel'))
    assert.ok(parsed.text.includes('example author'))
    assert.ok(parsed.text.includes('1. 첫째 '))
    assert.ok(done.html.includes('<code>code https://example.com/in-code</code>'))
    assert.ok(done.html.includes('>example</a>'))
    assert.ok(done.html.includes('<a class="dooray-mention" href="dooray://example/members/example">@example</a>'))
  })

  const FORMATS: Record<string, string> = {
    굵게: '**bold**',
    제목: '# 제목',
    표: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    목록: '- item',
    '코드 블록': '```python\npass\n```',
  }
  for (const [name, body] of Object.entries(FORMATS)) {
    for (const strict of [false, true]) {
      test(`${name} 형식은 경고하고 원문으로 둔다 (strict=${strict})`, () => {
        const done = messenger(body, strict)
        const parsed = parsePreview(done.html)
        assert.equal(done.code, strict ? 1 : 0)
        assert.equal(parsed.alerts, 1)
        assert.ok(done.stderr.includes(`메신저는 ${name} 형식을`))
        assert.ok(done.stderr.includes('평문 번호'))
        assert.ok(parsed.text.includes(done.stderr.trim()))
        assert.ok(done.html.indexOf('role="alert"') < done.html.indexOf('class="dooray-head"'))
        assert.ok(parsed.text.includes(body))
        assert.ok(!done.html.includes('<strong>'))
      })
    }
  }

  test('코드 안의 기호는 경고하지 않는다', () => {
    const done = messenger('`**not bold**` `- x`', true)
    assert.equal(done.code, 0)
    assert.equal(done.stderr, '')
    assert.equal(parsePreview(done.html).alerts, 0)
  })

  test('코드 블록 안의 기호는 다른 형식 판정에서 뺀다', () => {
    const done = messenger('```\n# comment\n- x\n```', true)
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('메신저는 코드 블록 형식을'))
    assert.ok(!done.stderr.includes('메신저는 제목'))
  })

  test('닫히지 않은 펜스도 코드 블록이다', () => {
    const done = messenger('~~~\n# x', true)
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('메신저는 코드 블록, 제목 형식을'))
  })

  test('링크 경고와 형식 경고는 따로 알린다', () => {
    const done = messenger('**bold** [example](dooray://example/tasks/example)')
    assert.equal(done.code, 0)
    assert.equal(parsePreview(done.html).alerts, 2)
    assert.equal(done.stderr.trim().split('\n').length, 2)
  })

  for (const resource of ['tasks', 'pages']) {
    for (const strict of [false, true]) {
      test(`${resource} 링크는 경고하고 HTML 은 만든다 (strict=${strict})`, () => {
        const body = `[example](dooray://example/${resource}/example "working")`
        const done = messenger(body, strict)
        const parsed = parsePreview(done.html)
        assert.equal(done.code, strict ? 1 : 0)
        assert.equal(parsed.alerts, 1)
        assert.deepEqual(parsed.links, [])
        assert.ok(parsed.text.includes(done.stderr.trim()))
        assert.ok(done.stderr.includes('https'))
        assert.ok(done.html.indexOf('role="alert"') < done.html.indexOf('class="dooray-head"'))
        assert.ok(parsed.text.includes(body))
      })
    }
  }

  test('확인된 링크는 strict 여도 경고가 없다', () => {
    const done = messenger('[@example](dooray://example/members/example "member") https://example.com', true)
    assert.equal(done.code, 0)
    assert.equal(done.stderr, '')
    assert.equal(parsePreview(done.html).alerts, 0)
  })

  for (const resource of ['tasks', 'pages']) {
    const url = `dooray://example/${resource}/example`
    for (const body of [url, `[example](<${url}>)`, `[example]( ${url})`]) {
      test(`${resource} 주소 꼴을 경고한다: ${body}`, () => {
        const done = messenger(body, true)
        assert.equal(done.code, 1)
        assert.equal(parsePreview(done.html).alerts, 1)
        assert.ok(done.stderr.includes('https'))
        assert.ok(parsePreview(done.html).text.includes(body))
      })
    }
  }

  const member = 'dooray://example/members/example'
  for (const body of [member, `[@example](<${member}>)`, `[@example]( ${member})`]) {
    test(`멤버 주소 꼴은 경고하지 않는다: ${body}`, () => {
      const done = messenger(body, true)
      assert.equal(done.code, 0)
      assert.equal(done.stderr, '')
      assert.equal(parsePreview(done.html).alerts, 0)
    })
  }

  test('HTML 은 글자로 두고 주소 속성은 이스케이프한다', () => {
    const done = messenger('<img src=x onerror=alert(1)> </script>\nhttps://example.com/?a=1&b=2')
    assert.equal(done.code, 0)
    assert.ok(!done.html.includes('<img src=x'))
    assert.ok(done.html.includes('&lt;/script&gt;'))
    assert.deepEqual(parsePreview(done.html).links, ['https://example.com/?a=1&b=2'])
    assert.ok(done.html.includes('href="https://example.com/?a=1&amp;b=2"'))
  })

  test('주소 끝의 문장부호와 짝이 맞는 괄호', () => {
    const done = messenger('(https://example.com/path). https://example.com/a(b) https://example.com/c)')
    assert.deepEqual(parsePreview(done.html).links, ['https://example.com/path', 'https://example.com/a(b)', 'https://example.com/c'])
    assert.ok(done.html.includes('>https://example.com/path</a>). '))
  })

  test('본문의 템플릿 표기는 그대로 남는다', () => {
    const done = messenger('{{MD_BODY}} {{MODE}} {{WARNING_HTML}}')
    assert.equal(done.code, 0)
    assert.ok(parsePreview(done.html).text.includes('{{MD_BODY}} {{MODE}} {{WARNING_HTML}}'))
  })

  test('따옴표는 이스케이프한다', () => {
    const done = generate(COMMAND, ['--mode', 'messenger', '--title', `a"b'c<`, '--md-file', '-'], { input: `x"y'z` })
    assert.ok(done.html.includes('a&quot;b&#x27;c&lt;'))
    assert.ok(done.html.includes('x&quot;y&#x27;z'))
  })
})

// Python re 와 JS 정규식이 다르게 읽는 글자. 옛 구현의 판정이 기준이다.
describe('dooray-preview 정규식 경계', () => {
  test('\\x85 는 공백이라 목록 항목의 내용이 아니다', () => {
    const done = messenger('- \u0085', true)
    assert.equal(done.code, 0, done.stderr)
  })

  test('U+FEFF 는 공백이 아니라 목록 항목의 내용이다', () => {
    const done = messenger('- \ufeff', true)
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('목록'))
  })

  test('\\x1c 는 공백이라 목록 항목의 내용이 아니다', () => {
    assert.equal(messenger('- \u001c', true).code, 0)
  })

  test('U+2028 뒤는 줄머리가 아니다', () => {
    const done = messenger('x\u2028# 제목\u2028- 목록', true)
    assert.equal(done.code, 0, done.stderr)
  })

  test('\\x0b 와 \\x0c 뒤도 줄머리가 아니다', () => {
    assert.equal(messenger('x\u000b# 제목', true).code, 0)
    assert.equal(messenger('x\u000c# 제목', true).code, 0)
  })

  test('주소는 \\x85 에서 끝나고 U+FEFF 는 주소에 든다', () => {
    assert.deepEqual(parsePreview(messenger('https://example.com/a\u0085b').html).links, ['https://example.com/a'])
    assert.deepEqual(parsePreview(messenger('https://example.com/a\ufeffb').html).links, ['https://example.com/a\ufeffb'])
  })

  test('멤버 주소의 공백도 같은 뜻이다', () => {
    const done = messenger('[@x](dooray://a/members/b\u0085c "member")')
    assert.equal(parsePreview(done.html).links.includes('dooray://a/members/b\u0085c'), false)
  })

  test('dooray 링크 검사는 대소문자와 ſ 를 가리지 않는다', () => {
    assert.equal(messenger('DOORAY://x/TASKS/y', true).code, 1)
    assert.equal(messenger('dooray://x/Pages/y', true).code, 1)
    assert.equal(messenger('dooray://x/taſks/y', true).code, 1)
  })

  test('굵게는 줄을 넘지 않는다', () => {
    assert.equal(messenger('**a\nb**', true).code, 0)
    assert.equal(messenger('__a__', true).code, 1)
  })

  test('제목은 # 여섯 개까지, 앞 공백 세 칸까지다', () => {
    assert.equal(messenger('   ###### x', true).code, 1)
    assert.equal(messenger('####### x', true).code, 0)
    assert.equal(messenger('    # x', true).code, 0)
    assert.equal(messenger('#x', true).code, 0)
  })

  test('표는 구분 줄로 판정한다', () => {
    assert.equal(messenger('|---|---|', true).code, 1)
    assert.equal(messenger(':---: | ---:', true).code, 1)
    assert.equal(messenger('| --- |', true).code, 0)
  })

  test('표준 입력의 CR 은 줄머리를 만들지 않고 바이트 그대로 남는다', () => {
    assert.equal(messenger('x\r# 제목', true).code, 0)
    const done = messenger('a\r\n# b', true)
    assert.equal(done.code, 1)
    assert.ok(done.html.includes('a\r\n# b'))
  })
})

describe('dooray-preview task, comment', () => {
  test('업무 모드의 머리', () => {
    const done = generate(COMMAND, ['--title', '제목 <1>', '--project', '프로젝트', '--tag', 'a', '--tag', 'b&c', '--meta', '담당자:이름', '--meta', '참조', '--meta', 'a:b:c', '--md-file', '-'], { input: '**x**' })
    assert.equal(done.code, 0)
    assert.ok(done.html.includes('<div class="dooray-proj">프로젝트</div>'))
    assert.ok(done.html.includes('<div class="dooray-title">제목 &lt;1&gt;</div>'))
    assert.ok(done.html.includes('<div class="tags"><span class="tag">a</span><span class="tag">b&amp;c</span></div>'))
    assert.ok(done.html.includes('<span>담당자 <b>이름</b></span><span>참조 <b></b></span><span>a <b>b:c</b></span>'))
    assert.ok(done.html.includes('data-mode="task"'))
    assert.ok(done.html.includes('**x**'))
  })

  test('프로젝트가 없으면 그 줄을 그리지 않는다', () => {
    const done = generate(COMMAND, ['--title', 't', '--md-file', '-'], { input: 'x' })
    assert.ok(!done.html.includes('class="dooray-proj"'))
  })

  test('댓글 모드의 머리는 작성자 첫 글자를 아바타로 쓴다', () => {
    const done = generate(COMMAND, ['--mode', 'comment', '--title', '업무 제목', '--author', '홍길동', '--md-file', '-'], { input: 'x' })
    assert.ok(done.html.includes('<div class="dooray-avatar">홍</div>'))
    assert.ok(done.html.includes('<div class="dooray-author">홍길동</div>'))
    assert.ok(done.html.includes('<div class="dooray-on">업무 제목</div>'))
  })

  test('작성자 기본값은 「작성자」 이고 아바타는 이스케이프한 뒤의 첫 글자다', () => {
    const plain = generate(COMMAND, ['--mode', 'comment', '--title', 't', '--md-file', '-'], { input: 'x' })
    assert.ok(plain.html.includes('<div class="dooray-avatar">작</div>'))
    const tricky = generate(COMMAND, ['--mode', 'comment', '--title', 't', '--author', '<b', '--md-file', '-'], { input: 'x' })
    assert.ok(tricky.html.includes('<div class="dooray-avatar">&</div>'))
    const astral = generate(COMMAND, ['--mode', 'comment', '--title', 't', '--author', '😀x', '--md-file', '-'], { input: 'x' })
    assert.ok(astral.html.includes('<div class="dooray-avatar">😀</div>'))
  })

  test('업무와 댓글은 viewer 본문을 그대로 둔다', () => {
    const body = '[example](dooray://example/tasks/example "working")\n**bold**'
    for (const mode of ['task', 'comment']) {
      const done = generate(COMMAND, ['--mode', mode, '--title', 't', '--md-file', '-', '--strict'], { input: body })
      assert.equal(done.code, 0)
      assert.equal(done.stderr, '')
      assert.ok(done.html.includes(body))
      assert.equal(parsePreview(done.html).alerts, 0)
      assert.ok(done.html.includes(`data-mode="${mode}"`))
    }
  })

  test('본문의 </script> 는 거부한다 (메신저는 허용)', () => {
    for (const mode of ['task', 'comment']) {
      const done = generate(COMMAND, ['--mode', mode, '--title', 't', '--md-file', '-'], { input: 'a </script> b' })
      assert.equal(done.code, 1)
      assert.ok(done.stderr.includes("본문에 '</script>' 가 포함되어"))
      assert.equal(done.html, '')
    }
    assert.equal(messenger('a </script> b').code, 0)
  })

  test('제목과 작성자의 템플릿 표기는 다시 치환하지 않는다', () => {
    const done = generate(COMMAND, ['--mode', 'comment', '--title', '{{MD_BODY}}', '--author', '{{MODE}}', '--md-file', '-'], { input: 'body' })
    assert.ok(done.html.includes('<div class="dooray-on">{{MD_BODY}}</div>'))
    assert.ok(done.html.includes('<div class="dooray-author">{{MODE}}</div>'))
  })
})

describe('dooray-preview 옵션과 입력', () => {
  test('본문 파일을 읽고 CRLF 와 CR 을 LF 로 읽는다', () => {
    const dir = tempDir('content-preview-')
    const md = join(dir, 'body.md')
    writeFileSync(md, 'a\r\nb\rc\n', 'utf8')
    const done = generate(COMMAND, ['--mode', 'comment', '--title', 't', '--md-file', md], { dir })
    assert.equal(done.code, 0)
    assert.ok(done.html.includes('a\nb\nc\n'))
  })

  test('고유 접두로 줄여 쓴다', () => {
    const done = generate(COMMAND, ['--mod', 'comment', '--tit', 't', '--md', '-'], { input: 'x' })
    assert.equal(done.code, 0)
    assert.ok(done.html.includes('data-mode="comment"'))
  })

  test('--옵션=값 꼴을 받는다', () => {
    const done = generate(COMMAND, ['--mode=comment', '--title=a=b', '--md-file=-'], { input: 'x' })
    assert.equal(done.code, 0)
    assert.ok(done.html.includes('a=b'))
  })

  test('여러 옵션의 접두라면 사용법 오류다', () => {
    for (const prefix of ['--m', '--t']) {
      const done = generate(COMMAND, [prefix, 'x', '--title', 't', '--md-file', '-'], { input: 'x' })
      assert.equal(done.code, 2, prefix)
      assert.equal(done.html, '')
    }
  })

  test('필수 옵션이 빠지거나 값이 틀리거나 모르는 옵션이면 사용법 오류이고 이전 산출물은 그대로다', () => {
    const cases = [['--md-file', '-'], ['--title', 't'], ['--title', 't', '--md-file', '-', '--mode', 'bogus'], ['--title', 't', '--md-file', '-', '--bogus'], ['--title', 't', '--md-file', '-', 'extra'], ['--title', 't', '--md-file', '-', '--strict=yes']]
    for (const args of cases) {
      const done = generate(COMMAND, args, { input: 'x', stale: 'STALE' })
      assert.equal(done.code, 2, args.join(' '))
      assert.equal(done.html, 'STALE', args.join(' '))
      assert.ok(done.stderr.startsWith(`usage: ${PROG}`), args.join(' '))
    }
  })

  test('같은 선택형 옵션을 거듭 주면 앞뒤 어느 값이 틀려도 사용법 오류이고 이전 산출물은 그대로다', () => {
    for (const modes of [['bogus', 'task'], ['task', 'bogus']]) {
      const done = generate(COMMAND, ['--mode', modes[0], '--mode', modes[1], '--title', 't', '--md-file', '-'], { input: 'x', stale: 'STALE' })
      assert.equal(done.code, 2, modes.join(' '))
      assert.equal(done.html, 'STALE', modes.join(' '))
    }
    const last = generate(COMMAND, ['--mode', 'task', '--mode', 'comment', '--title', 't', '--md-file', '-'], { input: 'x' })
    assert.equal(last.code, 0)
    assert.ok(last.html.includes('data-mode="comment"'))
  })

  test('--help 는 사용법을 stdout 에 내고 0 으로 끝난다', () => {
    const done = generate(COMMAND, ['--help'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith(`usage: ${PROG} [-h] --title TITLE`))
    for (const name of ['--mode {task,comment,messenger}', '--author AUTHOR', '--strict', '--project PROJECT', '--tag TAG', '--meta META', '--md-file MD_FILE', '--out OUT']) assert.ok(done.stdout.includes(name), name)
    assert.equal(done.html, '')
  })

  test('본문 파일이 없으면 실패하고 이전 산출물이 남지 않는다', () => {
    const dir = tempDir('content-preview-')
    const done = generate(COMMAND, ['--title', 't', '--md-file', join(dir, 'missing.md')], { dir, stale: 'STALE' })
    assert.notEqual(done.code, 0)
    assert.equal(done.html, '')
  })

  test('본문이 UTF-8 이 아니면 실패한다', () => {
    const dir = tempDir('content-preview-')
    const md = join(dir, 'bad.md')
    writeFileSync(md, Buffer.from([0xff, 0xfe, 0x41]))
    const done = generate(COMMAND, ['--title', 't', '--md-file', md], { dir, stale: 'STALE' })
    assert.notEqual(done.code, 0)
    assert.equal(done.html, '')
  })

  test('생성한 HTML 은 템플릿의 머리와 끝을 가진다', () => {
    const done = generate(COMMAND, ['--mode', 'comment', '--title', 'T', '--md-file', '-'], { input: 'x' })
    const template = readFileSync(join(SCRIPTS_DIR, 'dooray-preview', 'template.html'), 'utf8')
    assert.ok(done.html.startsWith(template.slice(0, template.indexOf('{{TITLE}}'))))
    assert.ok(done.html.endsWith(template.slice(template.lastIndexOf('{{MD_BODY}}') + '{{MD_BODY}}'.length)))
    assert.ok(done.html.includes('<title>Dooray 미리보기 — T</title>'))
  })
})
