// review-fix 의 check_reply_body 명령 경계 테스트. 본문 파일을 쓰고 stdout 바이트와 종료 코드를 본다.
// Python 의 \b, \w, \d 는 유니코드 뜻이라 한글이 붙은 경계 사례를 따로 둔다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { run, tempDir, writeBody } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', join(import.meta.dirname, '..', 'scripts', 'check_reply_body.py')]
// ──

const GUIDE = '\n의도한 참조면 백틱으로 감싸고, 아니면 평문으로 바꾼다.\n이미 등록한 댓글이면 gh api 로 body 를 PATCH 한다.\n'

function check(t: Parameters<typeof tempDir>[1], ...bodies: string[]) {
  const dir = tempDir('reply-body-', t)
  const files = bodies.map((text, i) => writeBody(dir, `b${i}.md`, text))
  const done = run([...COMMAND, ...files])
  return { ...done, files, out: done.stdout.split(files[0]).join('F0').split(files[1] ?? '\0').join('F1') }
}

describe('check_reply_body', () => {
  test('걸린 것이 없으면 0 이고 아무것도 내지 않는다', (t) => {
    const done = check(t, '## 반영 완료\n\n수정했다. `/review` 와 `#12` 는 코드 스팬이다.\n')
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, '', ''])
  })

  test('재트리거 토큰을 위치와 함께 낸다', (t) => {
    const done = check(t, '## /review 반영 완료\n@claude 봐줘\n@github-actions 와 @dependabot\n')
    assert.equal(done.code, 1)
    assert.equal(
      done.out,
      `F0:1: 재트리거 토큰 \`/review\`\nF0:2: 재트리거 토큰 \`@claude\`\nF0:3: 재트리거 토큰 \`@github-actions\`\nF0:3: 재트리거 토큰 \`@dependabot\`\n${GUIDE}`,
    )
  })

  test('토큰 뒤에 낱말 글자가 이어지면 걸리지 않고, 한글이 이어져도 낱말로 본다', (t) => {
    const done = check(t, '/reviewer @claude2 @claude_x /review반영 @claude가\n')
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })

  test('하이픈이나 마침표가 이어지면 걸린다', (t) => {
    const done = check(t, '/review-all @claude.\n')
    assert.equal(done.out, `F0:1: 재트리거 토큰 \`/review\`\nF0:1: 재트리거 토큰 \`@claude\`\n${GUIDE}`)
  })

  test('auto-link 꼴을 낸다', (t) => {
    const done = check(t, '#12 와 o/r#34 와 GH-56 그리고 issue#7 과 foo/bar.baz#3\n')
    assert.equal(done.code, 1)
    assert.equal(
      done.out,
      `F0:1: auto-link \`#12\`\nF0:1: auto-link \`o/r#34\`\nF0:1: auto-link \`GH-56\`\nF0:1: auto-link \`#7\`\nF0:1: auto-link \`foo/bar.baz#3\`\n${GUIDE}`,
    )
  })

  test('숫자 없는 #, 낱말에 붙은 GH, 숫자 뒤의 글자는 걸리지 않는다', (t) => {
    const done = check(t, 'C# 과 # 12 와 xGH-12 와 GH-12a 와 한글GH-12 와 GH-12한글\n')
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })

  test('유니코드 십진 숫자도 숫자로 읽는다', (t) => {
    const done = check(t, '#١٢ 와 GH-१२\n')
    assert.equal(done.out, `F0:1: auto-link \`#١٢\`\nF0:1: auto-link \`GH-१२\`\n${GUIDE}`)
  })

  test('한 줄에서는 재트리거 토큰을 먼저, auto-link 를 나중에 낸다', (t) => {
    const done = check(t, 'see #12 and /review\n')
    assert.equal(done.out, `F0:1: 재트리거 토큰 \`/review\`\nF0:1: auto-link \`#12\`\n${GUIDE}`)
  })

  test('코드 펜스 안은 검사하지 않고 줄 번호는 펜스 줄도 센다', (t) => {
    const done = check(t, '앞 /review\n```text\n/review #1\n```\n  ```\n뒤 #2\n   ```\n뒤뒤 @claude\n')
    assert.equal(done.out, `F0:1: 재트리거 토큰 \`/review\`\nF0:8: 재트리거 토큰 \`@claude\`\n${GUIDE}`)
  })

  test('닫히지 않은 펜스는 끝까지 검사하지 않는다', (t) => {
    const done = check(t, '```\n/review\n#12\n')
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })

  test('코드 스팬은 한 줄 안에서만 닫힌다', (t) => {
    const done = check(t, '`/review\n`#3\n`ok` #4\n')
    assert.equal(done.out, `F0:1: 재트리거 토큰 \`/review\`\nF0:2: auto-link \`#3\`\nF0:3: auto-link \`#4\`\n${GUIDE}`)
  })

  test('줄바꿈은 \\n, \\r\\n, \\r 만 줄로 센다', (t) => {
    const done = check(t, 'a\r\nb\rc /review\nd e\u000bf #9\n')
    assert.equal(done.out, `F0:3: 재트리거 토큰 \`/review\`\nF0:4: auto-link \`#9\`\n${GUIDE}`)
  })

  test('들여쓴 펜스의 공백은 유니코드 공백도 센다', (t) => {
    const done = check(t, ' ```\n/review\n```\n')
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })

  test('여러 파일은 파일 이름과 함께 낸다. 안내는 끝에 한 번이다', (t) => {
    const done = check(t, '/review\n', '깨끗하다\n', '#5\n')
    const dir = done.files[0].slice(0, done.files[0].lastIndexOf('/'))
    assert.equal(done.code, 1)
    assert.equal(done.stdout, `${dir}/b0.md:1: 재트리거 토큰 \`/review\`\n${dir}/b2.md:1: auto-link \`#5\`\n${GUIDE}`)
  })

  test('파일을 읽지 못하면 2. 앞 파일의 결과는 이미 나갔고 안내는 없다', (t) => {
    const dir = tempDir('reply-body-', t)
    const first = writeBody(dir, 'a.md', '/review\n')
    const done = run([...COMMAND, first, join(dir, 'nope.md')])
    assert.equal(done.code, 2)
    assert.equal(done.stdout, `${first}:1: 재트리거 토큰 \`/review\`\n`)
    assert.match(done.stderr, /읽지 못했다/)
  })

  test('인자가 없으면 2 와 사용법', () => {
    const done = run(COMMAND)
    assert.deepEqual([done.code, done.stdout], [2, ''])
    assert.match(done.stderr, /check_reply_body/)
  })
})
