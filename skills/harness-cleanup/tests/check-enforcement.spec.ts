// check_enforcement 의 명령 경계 테스트. gitignore, lint, grep, tools 네 모드의 판정과 출력, 사용법 오류를 본다.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Repo } from './helpers.ts'

describe('gitignore 모드', () => {
  test('무시되는 경로는 막힌다고 보고 0', () => {
    const r = new Repo('hc-enf-', true)
    r.file('.gitignore', 'secret.txt\n')
    const done = r.run('check_enforcement', [r.root, 'gitignore', 'secret.txt'])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '대상: secret.txt\n막힌다 — .gitignore:1:secret.txt\tsecret.txt\n판정: gitignore 가 강제한다. 같은 내용의 문장 지침은 지울 수 있다.\n')
  })

  test('무시되지 않으면 막히지 않는다고 보고 1', () => {
    const r = new Repo('hc-enf-', true)
    const done = r.run('check_enforcement', [r.root, 'gitignore', 'open.txt'])
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '대상: open.txt\n막히지 않는다 (git check-ignore 히트 없음)\n판정: gitignore 가 강제하지 않는다. 문장 지침을 남기거나 gitignore 를 고친다.\n')
  })

  test('경로를 안 주면 사용법 오류 2', () => {
    const r = new Repo('hc-enf-', true)
    const done = r.run('check_enforcement', [r.root, 'gitignore'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('사용법:'), done.stderr)
    assert.equal(done.stdout, '')
  })
})

describe('lint 와 grep 모드', () => {
  test('lint: 검사 명령이 실패하면 잡는다고 보고 0 이고 probe 를 지운다', () => {
    const r = new Repo('hc-enf-', true)
    const done = r.run('check_enforcement', [r.root, 'lint', 'src/probe.txt', 'BAD', 'grep -q BAD src/probe.txt && exit 1 || exit 0'])
    assert.equal(done.code, 0, done.stdout)
    assert.equal(
      done.stdout,
      '모드: lint (검출 신호 = non-zero)\nprobe: src/probe.txt\n명령: grep -q BAD src/probe.txt && exit 1 || exit 0\n---\n---\nexit code: 1\n판정: 검사가 probe 를 잡는다. 같은 내용의 문장 지침은 지울 수 있다.\n',
    )
    assert.ok(!existsSync(join(r.root, 'src/probe.txt')))
  })

  test('lint: 통과시키면 1 과 안내', () => {
    const r = new Repo('hc-enf-', true)
    const done = r.run('check_enforcement', [r.root, 'lint', 'p.txt', 'x', 'true'])
    assert.equal(done.code, 1)
    assert.equal(
      done.stdout,
      '모드: lint (검출 신호 = non-zero)\nprobe: p.txt\n명령: true\n---\n---\nexit code: 0\n판정: 검사가 통과시킨다. 규칙이 없거나 probe 위치가 검사 범위 밖이다.\n      모드를 반대로 고르지 않았는지 먼저 확인하고, 규칙 설정을 본다.\n      규칙이 없으면 문장 지침을 남긴다.\n',
    )
  })

  test('grep: 0 으로 끝나면 히트라서 잡는다', () => {
    const r = new Repo('hc-enf-', true)
    const done = r.run('check_enforcement', [r.root, 'grep', 'p.txt', 'FORBIDDEN', 'grep -q FORBIDDEN p.txt'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('모드: grep (검출 신호 = exit 0 히트)\n'))
    assert.ok(done.stdout.endsWith('exit code: 0\n판정: 검사가 probe 를 잡는다. 같은 내용의 문장 지침은 지울 수 있다.\n'))
  })

  test('출력은 마지막 서른 줄만 보여 주고 표준 출력 뒤에 표준 오류를 붙인다', () => {
    const r = new Repo('hc-enf-', true)
    const done = r.run('check_enforcement', [r.root, 'lint', 'p.txt', 'x', 'seq 1 40; echo ERR >&2; exit 1'])
    assert.equal(done.code, 0)
    const body = done.stdout.split('---\n')[1].split('\n')
    assert.equal(body.length, 31)
    assert.equal(body[0], '12')
    assert.equal(body[28], '40')
    assert.equal(body[29], 'ERR')
  })

  test('이미 있는 probe 경로는 거부하고 2', () => {
    const r = new Repo('hc-enf-', true)
    r.file('exists.txt', 'keep\n')
    const done = r.run('check_enforcement', [r.root, 'lint', 'exists.txt', 'x', 'true'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '이미 있는 파일이다 — 다른 경로를 쓰라: exists.txt\n')
    assert.equal(done.stdout, '')
  })

  test('probe 본문 끝에 줄바꿈을 붙여 쓴다', () => {
    const r = new Repo('hc-enf-', true)
    const done = r.run('check_enforcement', [r.root, 'grep', 'p.txt', 'a b', 'test "$(wc -c < p.txt | tr -d \' \')" = 4'])
    assert.equal(done.code, 0, done.stdout)
  })

  test('인자가 모자라면 2', () => {
    const r = new Repo('hc-enf-', true)
    assert.equal(r.run('check_enforcement', [r.root, 'lint', 'p', 'x']).code, 2)
    assert.equal(r.run('check_enforcement', [r.root, 'grep']).code, 2)
  })
})

describe('tools 모드', () => {
  const agent = (fm: string) => `---\nname: a\n${fm}---\n본문\n`

  test('선언이 없으면 우회 도구가 모두 남는다', () => {
    const r = new Repo('hc-enf-')
    r.file('a.md', agent(''))
    const done = r.run('check_enforcement', [r.root, 'tools', 'a.md'])
    assert.equal(done.code, 1)
    assert.equal(
      done.stdout,
      '대상: a.md\n  (도구 제한 선언 없음 — 전체 도구 사용 가능)\n---\n  우회 가능: Bash\n  우회 가능: Agent\n  우회 가능: Task\n  우회 가능: NotebookEdit\n---\n판정: 위 도구로 우회할 수 있어 도구 제한이 파일 수정을 막지 못한다.\n      (예: Bash 의 리다이렉트로 Write 없이 파일을 덮어쓸 수 있다)\n      문장 지침을 지우지 않는다.\n',
    )
  })

  test('허용 목록에 우회 도구가 없으면 막는다', () => {
    const r = new Repo('hc-enf-')
    r.file('a.md', agent('tools: Read, Grep\n'))
    const done = r.run('check_enforcement', [r.root, 'tools', 'a.md'])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '대상: a.md\ntools: Read, Grep\n---\n---\n판정: 파일을 고칠 도구가 남아 있지 않다. 도구 제한이 강제한다.\n')
  })

  test('금지 목록과 와일드카드와 허용 목록의 낱말 경계를 본다', () => {
    const r = new Repo('hc-enf-')
    r.file('a.md', agent('allowed-tools: Read, Bash\ndisallowedTools: Bash\n'))
    r.file('b.md', agent('tools: *\ndisallowedTools: Bash, Agent, Task\n'))
    r.file('c.md', agent('tools: Read, Bashful\n'))
    r.file('d.md', agent('TOOLS: Read, Task\n'))
    assert.equal(r.run('check_enforcement', [r.root, 'tools', 'a.md']).code, 0)
    const b = r.run('check_enforcement', [r.root, 'tools', 'b.md'])
    assert.equal(b.code, 1)
    assert.equal(b.stdout.split('\n').filter((l) => l.includes('우회 가능')).join(','), '  우회 가능: NotebookEdit')
    assert.equal(r.run('check_enforcement', [r.root, 'tools', 'c.md']).code, 0)
    const d = r.run('check_enforcement', [r.root, 'tools', 'd.md'])
    assert.equal(d.stdout.split('\n').filter((l) => l.includes('우회 가능')).join(','), '  우회 가능: Task')
  })

  test('한글 낱말에 붙은 도구 이름은 같은 낱말로 본다', () => {
    const r = new Repo('hc-enf-')
    r.file('a.md', agent('tools: Read, 가Bash\n'))
    // 파이썬의 \b 는 한글을 낱말 글자로 본다. 가Bash 는 Bash 를 포함하지만 낱말 경계가 없다
    assert.equal(r.run('check_enforcement', [r.root, 'tools', 'a.md']).code, 0)
  })

  test('프런트매터가 없거나 닫히지 않으면 선언 없음이다', () => {
    const r = new Repo('hc-enf-')
    r.file('a.md', 'tools: Read\n본문\n')
    r.file('b.md', '---\ntools: Read\n본문\n')
    for (const f of ['a.md', 'b.md']) {
      const done = r.run('check_enforcement', [r.root, 'tools', f])
      assert.equal(done.code, 1)
      assert.ok(done.stdout.includes('(도구 제한 선언 없음'))
    }
  })

  test('파일이 없으면 2', () => {
    const r = new Repo('hc-enf-')
    const done = r.run('check_enforcement', [r.root, 'tools', 'none.md'])
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '파일이 없다: none.md\n')
  })
})

describe('공통 인자', () => {
  test('인자가 모자라면 사용법과 2', () => {
    const r = new Repo('hc-enf-')
    const done = r.run('check_enforcement', [])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('사용법:'))
    assert.equal(r.run('check_enforcement', [r.root]).code, 2)
  })

  test('저장소가 없거나 모르는 모드면 2', () => {
    const r = new Repo('hc-enf-')
    const missing = r.run('check_enforcement', [join(r.root, 'nope'), 'tools', 'a.md'])
    assert.equal(missing.code, 2)
    assert.equal(missing.stderr, `대상 저장소가 없다: ${join(r.root, 'nope')}\n`)
    const unknown = r.run('check_enforcement', [r.root, 'bogus', 'x'])
    assert.equal(unknown.code, 2)
    assert.ok(unknown.stderr.startsWith('알 수 없는 모드: bogus\n'))
    assert.ok(unknown.stderr.includes('사용법:'))
  })
})
