// content-preview 의 GitHub 미리보기 생성기 명령 경계 테스트. 옵션, 생성한 HTML, 종료 코드를 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { generate } from './generator.ts'
import { SCRIPTS_DIR, tempDir } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = [process.execPath, join(SCRIPTS_DIR, 'github-preview', 'generate.ts')]
const PROG = 'generate.ts'
// ──

const TEMPLATE = readFileSync(join(SCRIPTS_DIR, 'github-preview', 'template.html'), 'utf8')
// 연쇄 치환 기댓값. 문자열 치환은 $& 같은 표기를 해석하므로 split/join 으로 바꾼다
const replaceAll = (text: string, from: string, to: string) => text.split(from).join(to)
const fill = (steps: [string, string][]) => steps.reduce((text, [from, to]) => replaceAll(text, from, to), TEMPLATE)

describe('github-preview', () => {
  test('issue 와 pr 의 머리 표기', () => {
    const issue = generate(COMMAND, ['--title', '제목 <a>', '--repo', 'o/r', '--md-file', '-'], { input: '# 본문' })
    assert.equal(issue.code, 0)
    assert.equal(issue.stdout, `생성 완료: ${issue.out}\n`)
    assert.equal(issue.stderr, '')
    assert.ok(issue.html.includes('제목 &lt;a&gt;'))
    assert.ok(issue.html.includes('Issue'))
    assert.ok(issue.html.includes('# 본문'))
    const pr = generate(COMMAND, ['--type', 'pr', '--title', 't', '--repo', 'o/r', '--md-file', '-'], { input: 'x' })
    assert.ok(pr.html.includes('Pull Request'))
    assert.notEqual(pr.html, issue.html)
  })

  test('치환 결과가 템플릿 표기의 자리를 정확히 채운다', () => {
    const done = generate(COMMAND, ['--type', 'pr', '--title', 'T', '--repo', 'o/r', '--md-file', '-'], { input: 'BODY' })
    assert.equal(done.html, fill([['{{TITLE}}', 'T'], ['{{REPO}}', 'o/r'], ['{{TYPE_CLASS}}', 'pr'], ['{{TYPE_LABEL}}', 'Pull Request'], ['{{MD_BODY}}', 'BODY']]))
  })

  test('저장소를 주지 않으면 빈 칸이다', () => {
    const done = generate(COMMAND, ['--title', 'T', '--md-file', '-'], { input: 'x' })
    assert.equal(done.html, fill([['{{TITLE}}', 'T'], ['{{REPO}}', ''], ['{{TYPE_CLASS}}', 'issue'], ['{{TYPE_LABEL}}', 'Issue'], ['{{MD_BODY}}', 'x']]))
  })

  test('연쇄 치환이라 제목 안의 표기도 뒤 단계에서 바뀌고 본문은 마지막에 넣어 그대로 남는다', () => {
    const done = generate(COMMAND, ['--type', 'pr', '--title', '{{REPO}} {{TYPE_LABEL}}', '--repo', 'zz/repo', '--md-file', '-'], { input: '{{REPO}} {{TITLE}} {{TYPE_LABEL}} $& $1' })
    const body = '{{REPO}} {{TITLE}} {{TYPE_LABEL}} $& $1'
    assert.equal(done.html, fill([['{{TITLE}}', '{{REPO}} {{TYPE_LABEL}}'], ['{{REPO}}', 'zz/repo'], ['{{TYPE_CLASS}}', 'pr'], ['{{TYPE_LABEL}}', 'Pull Request'], ['{{MD_BODY}}', body]]))
    assert.ok(done.html.includes(`>${body}</script>`))
  })

  test('따옴표와 부호는 이스케이프한다', () => {
    const done = generate(COMMAND, ['--title', `a"b'c&d`, '--repo', '<o>/r', '--md-file', '-'], { input: 'x' })
    assert.ok(done.html.includes('a&quot;b&#x27;c&amp;d'))
    assert.ok(done.html.includes('&lt;o&gt;/r'))
  })

  test('본문의 </script> 는 거부하고 이전 산출물을 지운다', () => {
    const done = generate(COMMAND, ['--title', 't', '--md-file', '-'], { input: 'a </script> b', stale: 'STALE' })
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes("본문에 '</script>' 가 포함되어"))
    assert.equal(done.html, '')
  })

  test('본문 파일은 CRLF 를 LF 로 읽고 표준 입력은 그대로 읽는다', () => {
    const dir = tempDir('content-preview-')
    const md = join(dir, 'body.md')
    writeFileSync(md, 'a\r\nb\r', 'utf8')
    const file = generate(COMMAND, ['--title', 't', '--md-file', md], { dir })
    assert.ok(file.html.includes('a\nb\n'))
    const stdin = generate(COMMAND, ['--title', 't', '--md-file', '-'], { input: 'a\r\nb\r' })
    assert.ok(stdin.html.includes('a\r\nb\r'))
  })

  test('고유 접두와 =값 꼴', () => {
    const done = generate(COMMAND, ['--ty', 'pr', '--ti=t', '--re', 'o/r', '--md', '-'], { input: 'x' })
    assert.equal(done.code, 0)
    assert.ok(done.html.includes('Pull Request'))
  })

  test('여러 옵션의 접두, 필수 빠짐, 잘못된 값, 모르는 옵션은 사용법 오류이고 이전 산출물은 그대로다', () => {
    const cases = [['--t', 'x', '--title', 't', '--md-file', '-'], ['--md-file', '-'], ['--title', 't', '--md-file', '-', '--type', 'bogus'], ['--title', 't', '--md-file', '-', '--bogus'], ['--title', 't', '--md-file', '-', 'extra']]
    for (const args of cases) {
      const done = generate(COMMAND, args, { input: 'x', stale: 'STALE' })
      assert.equal(done.code, 2, args.join(' '))
      assert.equal(done.html, 'STALE', args.join(' '))
      assert.ok(done.stderr.startsWith(`usage: ${PROG}`), args.join(' '))
    }
  })

  test('같은 선택형 옵션을 거듭 주면 앞뒤 어느 값이 틀려도 사용법 오류이고 이전 산출물은 그대로다', () => {
    for (const types of [['bogus', 'pr'], ['pr', 'bogus']]) {
      const done = generate(COMMAND, ['--type', types[0], '--type', types[1], '--title', 't', '--md-file', '-'], { input: 'x', stale: 'STALE' })
      assert.equal(done.code, 2, types.join(' '))
      assert.equal(done.html, 'STALE', types.join(' '))
    }
    const last = generate(COMMAND, ['--type', 'issue', '--type', 'pr', '--title', 't', '--md-file', '-'], { input: 'x' })
    assert.equal(last.code, 0)
    assert.ok(last.html.includes('Pull Request'))
  })

  test('--help 는 사용법을 stdout 에 내고 0 으로 끝난다', () => {
    const done = generate(COMMAND, ['--help'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith(`usage: ${PROG} [-h] [--type {issue,pr}] [--repo REPO] --title TITLE`))
    for (const name of ['--type {issue,pr}', '--repo REPO', '--title TITLE', '--md-file MD_FILE', '--out OUT']) assert.ok(done.stdout.includes(name), name)
  })

  test('본문 파일이 없으면 실패하고 이전 산출물이 남지 않는다', () => {
    const dir = tempDir('content-preview-')
    const done = generate(COMMAND, ['--title', 't', '--md-file', join(dir, 'missing.md')], { dir, stale: 'STALE' })
    assert.notEqual(done.code, 0)
    assert.equal(done.html, '')
  })
})
