// content-preview 의 Dooray 미리보기 생성기 명령 경계 테스트. 옵션, 생성한 HTML, stderr 경고, 종료 코드를 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { generate, parsePreview } from './generator.ts'
import { lines, linkFake, SCRIPTS_DIR, tempDir } from './helpers.ts'

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
  const lookupJson = JSON.stringify({
    project: { code: 'example' }, number: 18, subject: '[Example] 제목', workflowClass: 'working',
  })

  function preview(mode: string, input: string, state: 'ok' | 'missing' | 'failed' | Record<string, unknown> = 'ok', strict = false) {
    const dir = tempDir('content-preview-task-link-')
    const log = join(dir, 'dooray.log')
    if (state !== 'missing') linkFake(join(dir, 'dooray'), 'dooray')
    const env = { ...process.env, PATH: dir, FAKE_LOG: log, FAKE_DOORAY_JSON: typeof state === 'string' ? lookupJson : JSON.stringify(state), FAKE_DOORAY_RC: state === 'failed' ? '1' : '0' }
    const args = ['--mode', mode, '--title', 't', '--md-file', '-']
    if (strict) args.push('--strict')
    const done = generate(COMMAND, args, { dir, input, env, stale: 'STALE' })
    return { ...done, calls: lines(log) }
  }

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
    const body = '[example/18 &#91;Example&#93; 제목](dooray://example/tasks/post-example "working")\n**bold**'
    for (const mode of ['task', 'comment']) {
      const done = preview(mode, body, 'ok', true)
      assert.equal(done.code, 0)
      assert.equal(done.stderr, '')
      assert.ok(done.html.includes(body))
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
      assert.equal(parsePreview(done.html).alerts, 0)
      assert.ok(done.html.includes(`data-mode="${mode}"`))
    }
  })

  test('링크 앞의 독립된 대괄호 문구를 링크 표시 글에 넣지 않는다', () => {
    const body = '[참고 [보충]] 다음 업무를 확인하세요. [example/18 제목](dooray://example/tasks/post-example "working")'
    const done = preview('comment', body)
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(done.calls, ['--json post get --id post-example'])
  })

  test('링크 앞의 백슬래시가 짝수면 표시 글을 읽고 홀수면 주소만 검사한다', () => {
    const link = '[example/18 제목](dooray://example/tasks/post-example "working")'
    for (const count of [2, 4]) {
      const done = preview('comment', '\\'.repeat(count) + link)
      assert.equal(done.code, 0, done.stderr)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
    for (const count of [1, 3]) {
      const done = preview('comment', '\\'.repeat(count) + link)
      assert.equal(done.code, 1, done.stderr)
      assert.match(done.stderr, /주소만 적은 링크를 .*인라인 링크로 바꾸세요/u)
    }
  })

  test('표시 글의 대괄호와 두레이 웹 주소를 각각 고치도록 안내한다', () => {
    const badLabel = '[참고] [example/18 [Example] 제목](dooray://example/tasks/post-example "working")'
    const webLinks = [
      '[example/18 제목](https://example.dooray.com/project/tasks/post-example?x=y)',
      '[example/18 제목](//example.dooray.com/project/tasks/post-example)',
      '[example/18 제목]( </task/project-example/post-example> )',
      'https://example.dooray.com/task/project-example/post-example.',
    ]
    const body = [badLabel, ...webLinks].join('\n')
    const done = preview('task', body)
    assert.equal(done.code, 1)
    assert.equal(done.html, '')
    assert.match(done.stderr, /대괄호를.*\n  고친 예 \[example\/18 &#91;Example&#93; 제목\]/u)
    assert.equal((done.stderr.match(/웹 주소를/g) ?? []).length, webLinks.length)
    assert.equal((done.stderr.match(/고친 예 /g) ?? []).length, webLinks.length + 1)
    assert.match(done.stderr, /dooray:\/\/ORG_ID\/tasks\/post-example "working"/u)
    assert.deepEqual(done.calls, ['--json post get --id post-example'])
  })

  test('업무 경로를 가리키는 절대·프로토콜 상대·루트 상대·상대 주소를 막는다', () => {
    const paths = [
      'HTTPS://example.DOORAY.com/project/tasks/post-example',
      'https://dooray.com/project/tasks/post-example',
      '//example.dooray.com/project/tasks/post-example',
      '/project/tasks/post-example',
      '/task/project-example/post-example',
      'project/tasks/post-example',
      '../task/project-example/post-example',
      './other/../project/tasks/post-example',
      'https://example.dooray.com/project/%74asks/post-example',
    ]
    for (const target of paths) {
      const done = preview('task', `[example/18 제목](  ${target}  )`)
      assert.equal(done.code, 1, target)
      assert.match(done.stderr, /웹 주소를 dooray:\/\/ 링크로 바꾸세요/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
  })

  test('인라인 주소 앞뒤의 공백과 스킴 대소문자는 허용한다', () => {
    const body = '[example/18 제목]( \tDOORAY://example/tasks/post-example "working" \t )'
    const done = preview('comment', body)
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(done.calls, ['--json post get --id post-example'])
  })

  test('같은 주소라도 표시 글마다 프로젝트와 업무 번호를 대조한다', () => {
    const link = (ref: string) => `[${ref} 제목](dooray://example/tasks/post-example "working")`
    const done = preview('comment', [link('example/18'), link('example/20'), link('other/18')].join(' · '))
    assert.equal(done.code, 1)
    assert.equal(done.html, '')
    assert.equal((done.stderr.match(/실제 업무 example\/18 가 다릅니다/g) ?? []).length, 2)
    assert.ok(done.stderr.includes('[example/18 &#91;Example&#93; 제목](dooray://example/tasks/post-example "working")'))
    assert.deepEqual(done.calls, ['--json post get --id post-example'])
  })

  test('CLI가 프로젝트와 업무 번호를 한 필드로 보내도 대조한다', () => {
    const compact = { taskNumber: 'example/18', subject: '[예제] 제목', workflowClass: 'working' }
    const link = (ref: string) => `[${ref} 제목](dooray://example/tasks/post-example "working")`
    const good = preview('comment', link('example/18'), compact)
    assert.equal(good.code, 0)
    assert.equal(good.stderr, '')
    assert.deepEqual(good.calls, ['--json post get --id post-example'])

    const mismatch = preview('task', [link('example/20'), link('other-example/18')].join('\n'), compact)
    assert.equal(mismatch.code, 1)
    assert.match(mismatch.stderr, /실제 업무 example\/18 가 다릅니다/u)
    assert.ok(mismatch.stderr.includes('[example/18 &#91;예제&#93; 제목]'))
    assert.doesNotMatch(mismatch.stderr, /조회하지 못해/u)
    assert.deepEqual(mismatch.calls, ['--json post get --id post-example'])
  })

  test('표시 글, 주소, 상태값이 한 블록 안에서 줄을 넘어도 업무 링크를 검사한다', () => {
    const address = 'dooray://example/tasks/post-example'
    for (const body of [
      `[example/20\n제목](${address} "working")`,
      `[example/20\r\n제목](\r\n<${address}>\r\n"working"\r\n)`,
      `- [example/20\n  제목](\n  ${address}\n  'working'\n  )`,
      `> [example/20\n> 제목](\n> ${address}\n> "working"\n> )`,
      `[example/20 제목](${address}\n"예시\n제목")`,
    ]) {
      const done = preview('task', body)
      assert.equal(done.code, 1, done.stderr)
      assert.match(done.stderr, /「example\/20 제목」과 실제 업무 example\/18/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }

    const good = `[example/18\n&#91;예제&#93; 제목](\n${address}\n"working"\n)`
    const done = preview('task', good)
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(done.calls, ['--json post get --id post-example'])
    assert.ok(done.html.includes(good))

    const malformed = preview('comment', `[example/18\n[예제] 제목](\n${address}\n"working"\n)`, 'missing')
    assert.equal(malformed.code, 1)
    assert.ok(malformed.stderr.includes(`고친 예 [example/18 &#91;예제&#93; 제목](${address} "working")`))

    const web = preview('comment', '[example/18 제목](\n/task/project-example/post-example\n"working"\n)')
    assert.equal(web.code, 1, web.stderr)
    assert.match(web.stderr, /웹 주소를 dooray:\/\/ 링크로 바꾸세요/u)
    assert.deepEqual(web.calls, ['--json post get --id post-example'])
  })

  test('표시 글과 주소를 문단이나 목록 항목 너머의 내용과 이어 붙이지 않는다', () => {
    const address = 'dooray://example/tasks/post-example'
    for (const body of [
      `[example/20\n\n제목](${address} "working")`,
      `- [example/20\n- 제목](${address} "working")`,
      `[example/20 제목](\n\n${address} "working")`,
    ]) {
      const done = preview('comment', body)
      assert.equal(done.code, 1, done.stderr)
      assert.match(done.stderr, /주소만 적은 링크를 .*인라인 링크로 바꾸세요/u)
      assert.doesNotMatch(done.stderr, /표시 글.*실제 업무/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
  })

  test('인용 기호나 목록 들여쓰기를 생략한 문단에서도 여러 줄 업무 링크를 검사한다', () => {
    const address = 'dooray://example/tasks/post-example'
    for (const prefix of ['> ', '- ', '1. ', '> - ']) {
      const body = `${prefix}[example/18\n제목](${address} "working")`
      const done = preview('comment', body)
      assert.equal(done.code, 0, done.stderr)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
      const mismatch = preview('comment', body.replace('example/18', 'example/20'))
      assert.equal(mismatch.code, 1, mismatch.stderr)
      assert.match(mismatch.stderr, /「example\/20 제목」과 실제 업무 example\/18/u)
    }
  })

  const internalAddress = 'dooray://example/tasks/post-example'
  const webAddress = 'https://example.dooray.com/project/tasks/post-example'
  const unsupportedLinks = [
    ['참조식 정의', (address: string) => `[example/18 제목][task]\n\n[task]: ${address} "working"`],
    ['참조식 정의', (address: string) => `[unused]:\n  <${address}>`],
    ['자동 링크', (address: string) => `<${address}>`],
    ['HTML 링크', (address: string) => `<A data-example="href='https://example.com/'" HREF='${address}'>제목</A>`],
    ['주소만 적은 링크', (address: string) => `업무 주소 ${address}.`],
  ] as const

  test('참조식 정의, 자동 링크, HTML 링크, 주소만 적은 링크를 인라인 형식으로 안내한다', () => {
    for (const [kind, makeBody] of unsupportedLinks) {
      for (const [address, org] of [[internalAddress, 'example'], [webAddress, 'ORG_ID'], [webAddress.slice('https:'.length), 'ORG_ID']]) {
        const done = preview('comment', makeBody(address))
        assert.equal(done.code, 1, makeBody(address))
        assert.ok(done.stderr.includes(address === internalAddress ? kind : '웹 주소를 dooray:// 링크로'), done.stderr)
        assert.ok(done.stderr.includes(`고친 예 [example/18 &#91;Example&#93; 제목](dooray://${org}/tasks/post-example "working")`), done.stderr)
        assert.deepEqual(done.calls, ['--json post get --id post-example'])
      }
    }
    const done = preview('task', `<${internalAddress}>`, 'missing')
    assert.equal(done.code, 1, done.stderr)
    assert.match(done.stderr, /인라인 링크로 바꾸세요/u)
  })

  test('코드 예제 안의 다른 링크 형식은 검사하지 않는다', () => {
    const examples = unsupportedLinks.map(([, makeBody]) => makeBody(internalAddress))
    const body = ['```text', ...examples, '```'].join('\n')
    const done = preview('task', body)
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(done.calls, [])
  })

  test('업무 인라인 링크는 주소와 큰따옴표로 감싼 상태값을 요구한다', () => {
    for (const target of [
      internalAddress,
      `${internalAddress} 'working'`,
      `${internalAddress} (working)`,
      `<${internalAddress}> "working"`,
      `${internalAddress} "example"`,
      `${internalAddress}?example=value "working"`,
    ]) {
      const done = preview('task', `[example/18 제목](${target})`)
      assert.equal(done.code, 1, done.stderr)
      assert.match(done.stderr, /상태값을 큰따옴표로 감싸세요/u)
      assert.ok(done.stderr.includes(`고친 예 [example/18 제목](${internalAddress} "working")`))
    }
  })

  test('주소의 문자 참조와 Markdown 이스케이프를 풀어 실제 업무를 확인한다', () => {
    for (const address of [
      'dooray&#58;//example/tasks/post-example',
      'dooray&#x3a;&#47;/example/task&#115;/post-example',
      'dooray&colon;&sol;&sol;example/tasks/post-example',
      'dooray\\://example/tasks/post\\-example',
    ]) {
      const done = preview('comment', `[example/20 제목](${address} "working")`)
      assert.equal(done.code, 1, done.stderr)
      assert.match(done.stderr, /실제 업무 example\/18/u)
      assert.ok(done.stderr.includes(`고친 예 [example/18 &#91;Example&#93; 제목](${internalAddress} "working")`))
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }

    const canonicalLabel = preview('task', '[example/18 제목](dooray&#58;//example/tasks/post-example "working")')
    assert.equal(canonicalLabel.code, 1)
    assert.ok(canonicalLabel.stderr.includes(`고친 예 [example/18 제목](${internalAddress} "working")`))
    assert.doesNotMatch(canonicalLabel.stderr, /실제 업무/u)

    for (const body of [
      `[task]: dooray&colon;//example/tasks/post-example`,
      '<a href="dooray&#58;//example/tasks/post-example">제목</a>',
      '[example/18 제목](https://example&period;dooray.com/project/tasks/post-example)',
      '업무 주소 dooray://example/tasks/post-exampl&#101;',
    ]) {
      const done = preview('comment', body)
      assert.equal(done.code, 1, done.stderr)
      assert.ok(done.stderr.includes(`고친 예 [example/18`))
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }

    const escapedEntity = preview('task', '[example/18 제목](dooray\\&colon;//example/tasks/post-example "working")')
    assert.equal(escapedEntity.code, 0, escapedEntity.stderr)
    assert.deepEqual(escapedEntity.calls, [])
  })

  test('표시 글의 문자 참조와 이스케이프를 풀어 프로젝트와 업무 번호를 대조한다', () => {
    for (const label of [
      'exampl&#101;&sol;18 제목',
      'example&#x2f;&#x31;&#56; 제목',
      'example\\/18 \\[예제\\] 제목',
      'example/18 &lbrack;예제&rbrack; 제목',
    ]) {
      const body = `[${label}](${internalAddress} "working")`
      const done = preview('task', body)
      assert.equal(done.code, 0, done.stderr)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
      assert.ok(done.html.includes(body))
    }
  })

  test('CLI 가 없거나 조회에 실패하면 --strict 에서도 경고와 함께 생성한다', () => {
    const link = '[example/18 제목](dooray://example/tasks/post-example "working")'
    for (const state of ['missing', 'failed'] as const) {
      const done = preview('comment', `${link}\n${link}`, state, true)
      assert.equal(done.code, 0)
      assert.equal(parsePreview(done.html).alerts, 1)
      assert.match(done.stderr, /프로젝트와 번호를 확인하지 못했습니다/u)
      assert.deepEqual(done.calls, state === 'missing' ? [] : ['--json post get --id post-example'])
    }
    const invalid = preview('comment', '[example/18 [제목](dooray://example/tasks/post-example "working")', 'missing')
    assert.equal(invalid.code, 1)
    assert.match(invalid.stderr, /고친 예 \[example\/18 &#91;제목\]/u)
  })

  test('CLI 없이도 업무 링크 표시 글의 프로젝트와 번호 형식을 검사한다', () => {
    for (const state of ['missing', 'failed'] as const) {
      for (const label of ['제목만 표시', 'example/18x 제목', '']) {
        const done = preview('comment', `[${label}](dooray://example/tasks/post-example "working")`, state)
        assert.equal(done.code, 1, done.stderr)
        assert.match(done.stderr, /표시 글은 프로젝트\/업무번호로 시작해야 합니다/u)
        assert.match(done.stderr, /프로젝트와 번호를 확인하지 못했습니다/u)
        assert.ok(done.stderr.includes('고친 예 [PROJECT/NUMBER '))
        assert.equal(done.html, '')
      }
    }
  })

  test('코드 예제와 업무 이외 링크는 검사하지 않는다', () => {
    const link = '[example/18 [제목]](dooray://example/tasks/post-example "working")'
    const body = [
      '````markdown', '```', link, '````',
      '[example](dooray://example/pages/page-example "publish")',
      '[example](https://example.com/project/tasks/post-example)',
      '[example](https://example.dooray.com.example.com/project/tasks/post-example)',
      '[example](//example.dooray.com.example.com/project/tasks/post-example)',
      '//example.com/task/project-example/post-example',
      '<a href="https://example.com/task/project-example/post-example">예제</a>',
      '[example][reference]\n\n[reference]: https://example.com/project/tasks/post-example',
    ].join('\n')
    const done = preview('task', body)
    assert.equal(done.code, 0)
    assert.equal(done.stderr, '')
    assert.deepEqual(done.calls, [])
  })

  test('울타리 코드 블록 뒤에서도 업무 링크를 검사한다', () => {
    const inside = '[예제](https://example.dooray.com/project/tasks/post-example-code)'
    const outside = '[example/18 제목](https://example.dooray.com/project/tasks/post-example)'
    for (const block of [
      ['```text', inside, '```'],
      ['- ```text', `  ${inside}`, '  ```'],
      ['10. 예제', '', '    - ~~~~text', `      ${inside}`, '      ~~~~'],
      ['앞 문단', '1. ~~~', `   ${inside}`, '   ~~~'],
      ['2. 같은 목록의 첫 항목', '3. ~~~', `   ${inside}`, '   ~~~'],
      ['> ```text', `> ${inside}`, '> ```'],
      ['- > ```text', `  > ${inside}`, '  > ```'],
    ]) {
      const done = preview('task', [...block, '', outside].join('\n'))
      assert.equal(done.code, 1)
      assert.match(done.stderr, /웹 주소를 dooray:\/\/ 링크로 바꾸세요/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
  })

  test('문단을 끊을 수 없는 번호 뒤의 링크는 펜스 코드로 건너뛰지 않는다', () => {
    const link = '[example/18 제목](https://example.dooray.com/project/tasks/post-example)'
    for (const lines of [
      ['앞 문단', '2. ~~~', '   ' + link, '   ~~~'],
      ['> 앞 문단', '> 2. ~~~', '>    ' + link, '>    ~~~'],
    ]) {
      const done = preview('comment', lines.join('\n'))
      assert.equal(done.code, 1, done.stderr)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
  })

  test('닫는 줄이 없는 코드 블록 뒤의 업무 링크도 검사한다', () => {
    const link = '[example/18 제목](https://example.dooray.com/project/tasks/post-example)'
    for (const opening of ['````text', '- ````text']) {
      const indent = opening.startsWith('-') ? '  ' : ''
      const done = preview('comment', [opening, indent + '예제', indent + '```', indent + link].join('\n'))
      assert.equal(done.code, 1)
      assert.match(done.stderr, /웹 주소를 dooray:\/\/ 링크로 바꾸세요/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
  })

  test('들여쓴 코드 예제와 문단의 업무 링크를 검사하고 펜스 코드 블록을 안내한다', () => {
    const inside = '[예제](https://example.dooray.com/project/tasks/post-example-code)'
    const outside = '[example/18 제목](https://example.dooray.com/project/tasks/post-example)'
    for (const lines of [
      ['코드 예제', '', `    ${inside}`, '', outside],
      ['코드 예제', '', `\t${inside}`, '', outside],
      ['- 코드 예제', '', `      ${inside}`, '', `  ${outside}`],
      ['> 코드 예제', '>', `>     ${inside}`, '>', `> ${outside}`],
      ['> - 코드 예제', '>', `>       ${inside}`, '>', `>   ${outside}`],
    ]) {
      const done = preview('comment', lines.join('\n'))
      assert.equal(done.code, 1)
      assert.match(done.stderr, /웹 주소를 dooray:\/\/ 링크로 바꾸세요/u)
      assert.match(done.stderr, /예시는 펜스 코드 블록으로 쓰세요/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example-code', '--json post get --id post-example'])
    }
    const paragraph = preview('comment', ['문단을 이어서 씁니다.', '    ' + outside].join('\n'))
    assert.equal(paragraph.code, 1)
    assert.deepEqual(paragraph.calls, ['--json post get --id post-example'])
  })

  test('밑줄 제목 바로 아래의 들여쓴 코드 예제도 검사한다', () => {
    const inside = '[예제](https://example.dooray.com/project/tasks/post-example-code)'
    const outside = '[example/18 제목](https://example.dooray.com/project/tasks/post-example)'
    for (const lines of [
      ['제목', '======', '    ' + inside, '', outside],
      ['제목', '-', '    ' + inside, '', outside],
      ['- 목록 제목', '  ======', '      ' + inside, '', outside],
      ['> 인용 제목', '> ------', '>     ' + inside, '', outside],
      ['#', '    ' + inside, '', outside],
    ]) {
      const done = preview('comment', lines.join('\r\n'))
      assert.equal(done.code, 1, done.stderr)
      assert.match(done.stderr, /예시는 펜스 코드 블록으로 쓰세요/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example-code', '--json post get --id post-example'])
    }
    const paragraph = preview('comment', ['문단', '    ===', '    ' + outside].join('\n'))
    assert.equal(paragraph.code, 1)
    assert.deepEqual(paragraph.calls, ['--json post get --id post-example'])
  })

  test('문단, 목록 항목, 인용, 표의 칸에 백틱이 있어도 업무 링크를 검사한다', () => {
    const link = '[example/18 제목](https://example.dooray.com/project/tasks/post-example)'
    for (const lines of [
      ['앞 문단의 백틱 `', '', link, '', '뒤 문단의 백틱 `'],
      ['- 앞 항목의 백틱 `', `- ${link}`, '- 뒤 항목의 백틱 `'],
      ['> 앞 문단의 백틱 `', '>', `> ${link}`, '>', '> 뒤 문단의 백틱 `'],
      ['앞 문단의 백틱 `', `# ${link}`, '뒤 문단의 백틱 `'],
      ['| 앞 | 업무 | 뒤 |', '| --- | --- | --- |', '| 백틱 ` | ' + link + ' | 백틱 ` |'],
    ]) {
      const done = preview('comment', lines.join('\n'))
      assert.equal(done.code, 1)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
  })

  test('정상 업무 링크는 표의 다른 칸에 백틱이 있어도 통과한다', () => {
    const link = '[example/18 제목](dooray://example/tasks/post-example "working")'
    const body = ['| 앞 | 업무 | 뒤 |', '| --- | --- | --- |', '| 백틱 ` | ' + link + ' | 백틱 ` |'].join('\n')
    const done = preview('comment', body)
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(done.calls, ['--json post get --id post-example'])
  })

  test('인라인 코드의 잘못된 업무 주소나 링크는 막고 펜스 코드 블록을 안내한다', () => {
    const mismatch = '[example/20 제목](' + internalAddress + ' "working")'
    for (const example of [internalAddress, webAddress, '<' + internalAddress + '>', mismatch, '예시 ' + mismatch]) {
      const done = preview('comment', '`' + example + '`')
      assert.equal(done.code, 1, done.stderr)
      assert.match(done.stderr, /예시는 펜스 코드 블록으로 쓰세요/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example'])
    }
  })

  test('올바른 업무 링크는 백틱 안팎에서 같은 검사 결과를 낸다', () => {
    for (const title of ['제목', '예제 A | B']) {
      const link = `[example/18 ${title}](${internalAddress} "working")`
      for (const body of [link, '`' + link + '`', '`예시 ' + link + '`']) {
        const done = preview('comment', body)
        assert.equal(done.code, 0, done.stderr)
        assert.deepEqual(done.calls, ['--json post get --id post-example'])
      }
    }
  })

  test('같은 문단 안의 여러 줄 인라인 코드도 업무 링크를 검사한다', () => {
    const inside = '[예제](https://example.dooray.com/project/tasks/post-example-code)'
    const outside = '[example/18 제목](https://example.dooray.com/project/tasks/post-example)'
    for (const lines of [
      ['예제는 ``이렇게', inside + '`` 입니다.'],
      ['- 예제는 ``이렇게', '  ' + inside + '`` 입니다.'],
      ['> 예제는 ``이렇게', '> ' + inside + '`` 입니다.'],
      ['> - 예제는 ``이렇게', '>   ' + inside + '`` 입니다.'],
    ]) {
      const done = preview('task', [...lines, '', outside].join('\n'))
      assert.equal(done.code, 1)
      assert.match(done.stderr, /예시는 펜스 코드 블록으로 쓰세요/u)
      assert.deepEqual(done.calls, ['--json post get --id post-example-code', '--json post get --id post-example'])
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

  test('mermaid 렌더러는 손그림을 기본값으로 초기화한다', () => {
    const done = generate(COMMAND, ['--mode', 'comment', '--title', 'T', '--md-file', '-'], { input: 'x' })
    assert.match(done.html, /mermaid\.initialize\(\{[^}]*look: 'handDrawn'/)
  })
})
