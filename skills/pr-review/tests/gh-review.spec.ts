// pr-review 의 gh-host, gh-review-list, gh-review-post, render-comments 명령 경계 테스트.
// 가짜 gh 와 ssh 를 PATH 앞에 두고 stdout 바이트, 가짜 gh 가 받은 인자와 payload, 종료 코드를 본다. GitHub 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../../modules/testkit/command.ts'
import { fakeBin, linkBin } from '../../../modules/testkit/fake-bin.ts'
import { git, gitEnv } from '../../../modules/testkit/git.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const SCRIPTS = join(import.meta.dirname, '..', 'scripts')
const COMMANDS = {
  host: ['node', join(SCRIPTS, 'gh-host.ts')],
  list: ['node', join(SCRIPTS, 'gh-review-list.ts')],
  post: ['node', join(SCRIPTS, 'gh-review-post.ts')],
  render: ['node', join(SCRIPTS, 'render-comments.ts')],
}
// ──

const NOTICE = '🤖 이 리뷰는 AI 가 작성했고, 등록 전에 사람이 확인했습니다.'

// 받은 인자와 --input 파일의 내용을 기록하고, 인자가 match 의 낱말을 모두 가진 첫 규칙의 stdout 과 종료 코드를 낸다
const GH_BODY = `const fs = require('node:fs')
const argv = process.argv.slice(2)
const cfg = JSON.parse(fs.readFileSync(process.argv[1] + '.cfg.json', 'utf8'))
const at = argv.indexOf('--input')
const input = at >= 0 ? fs.readFileSync(argv[at + 1], 'utf8') : null
fs.appendFileSync(process.argv[1] + '.calls.jsonl', JSON.stringify({ argv, input, ghHost: process.env.GH_HOST ?? null }) + '\\n')
const line = argv.join(' ')
const rule = cfg.find((r) => r.match.every((m) => line.includes(m))) || { stdout: '', code: 0 }
process.stdout.write(rule.stdout || '')
process.exitCode = rule.code || 0
`

type Rule = { match: string[]; stdout?: string; code?: number }
type Call = { argv: string[]; input: string | null; ghHost: string | null }

function setup(t: { after(fn: () => void): void }, opts: { origin?: string | null } = {}) {
  const root = tempDir('pr-review-', t)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const gh = linkBin(bin, 'gh', GH_BODY)
  const rulesPath = `${gh}.cfg.json`
  const logPath = `${gh}.calls.jsonl`
  const setRules = (rules: Rule[]) => writeFileSync(rulesPath, JSON.stringify(rules))
  setRules([])
  const ssh = fakeBin(bin, 'ssh', [{ stdout: 'hostname github.com\n' }])
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const env: NodeJS.ProcessEnv = { ...gitEnv(), PATH: `${bin}:${process.env.PATH}` }
  delete env.GH_HOST
  delete env.DRY_RUN
  git(repo, ['init', '-q'], env)
  if (opts.origin !== null) git(repo, ['remote', 'add', 'origin', opts.origin ?? 'git@github.com:o/r.git'], env)
  const calls = (): Call[] => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const run = (command: string[], args: string[], extra: NodeJS.ProcessEnv = {}) => runCommand([...command, ...args], { cwd: repo, env: { ...env, ...extra } })
  const write = (name: string, text: string) => {
    const path = join(root, name)
    writeFileSync(path, text)
    return path
  }
  return { root, repo, setRules, ssh, calls, run, write }
}

describe('gh-host', () => {
  test('GH_HOST 가 있으면 그것을 낸다', (t) => {
    const s = setup(t)
    const done = s.run(COMMANDS.host, [], { GH_HOST: 'ghe.example.com' })
    assert.deepEqual([done.code, done.stdout], [0, 'ghe.example.com\n'])
  })

  test('origin 주소에서 호스트를 읽고 ssh -G 가 되돌린 이름을 쓴다', (t) => {
    const s = setup(t, { origin: 'git@github-personal:o/r.git' })
    const done = s.run(COMMANDS.host, [])
    assert.deepEqual([done.code, done.stdout], [0, 'github.com\n'])
    assert.deepEqual(s.ssh.calls().map((c) => c.argv), [['-G', 'github-personal']])
  })

  for (const [origin, host] of [
    ['https://ghe.example.com/o/r.git', 'ghe.example.com'],
    // ssh:// 주소의 사용자 부분은 sed 가 떼지 않는다. 실제로는 ssh -G 가 호스트로 되돌린다
    ['ssh://git@ghe.example.com/o/r.git', 'git@ghe.example.com'],
    ['git@ghe.example.com:o/r.git', 'ghe.example.com'],
  ]) {
    test(`주소 ${origin}`, (t) => {
      const s = setup(t, { origin })
      s.ssh.setRules([])
      const done = s.run(COMMANDS.host, [])
      assert.deepEqual([done.code, done.stdout], [0, `${host}\n`])
    })
  }

  test('origin 이 없으면 0 이 아니게 끝난다', (t) => {
    const s = setup(t, { origin: null })
    const done = s.run(COMMANDS.host, [])
    assert.equal(done.code, 2)
    assert.equal(done.stdout, '')
  })
})

describe('gh-review-list', () => {
  const rows = [
    { id: 1, user: { login: 'alice' }, path: 'src/a.ts', line: 10, body: '첫 줄\n둘째 줄' },
    { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, path: 'src/a.ts', line: 10, body: 'x'.repeat(60) },
    { id: 3, user: { login: 'bob' }, path: 'b.ts', line: null, body: '다른 스레드' },
  ]
  const pages = JSON.stringify([rows.slice(0, 2), rows.slice(2)])
  const head = '주의: line 이 null 인 댓글은 이 목록에서 빠질 수 있다. 개수로 등록 성공을 판정하지 않는다.\n\n'
  const entry = (kind: string, id: number, login: string, where: string, first: string) => `${kind} ${id}  ${login.padEnd(16)} ${where}\n     ${first}\n`

  test('모든 댓글을 낸다', (t) => {
    const s = setup(t)
    s.setRules([{ match: ['--slurp', 'repos/o/r/pulls/7/comments?per_page=100'], stdout: pages }])
    const done = s.run(COMMANDS.list, ['o/r', '7'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(
      done.stdout,
      `댓글 3건\n${head}${entry('루트', 1, 'alice', 'a.ts:10', '첫 줄')}${entry('답글', 2, 'bob', 'a.ts:10', 'x'.repeat(50))}${entry('루트', 3, 'bob', 'b.ts:None', '다른 스레드')}`,
    )
    assert.equal(s.calls()[0].ghHost, 'github.com')
  })

  test('--thread 는 루트와 그 답글만 낸다', (t) => {
    const s = setup(t)
    s.setRules([{ match: ['--slurp'], stdout: pages }])
    const done = s.run(COMMANDS.list, ['o/r', '7', '--thread', '1'])
    assert.equal(done.stdout, `댓글 2건\n${head}${entry('루트', 1, 'alice', 'a.ts:10', '첫 줄')}${entry('답글', 2, 'bob', 'a.ts:10', 'x'.repeat(50))}`)
  })

  test('--mine 은 gh api user 의 로그인만 낸다', (t) => {
    const s = setup(t)
    s.setRules([
      { match: ['api', 'user', '--jq', '.login'], stdout: 'bob\n' },
      { match: ['--slurp'], stdout: pages },
    ])
    const done = s.run(COMMANDS.list, ['o/r', '7', '--mine'])
    assert.equal(done.stdout, `댓글 2건\n${head}${entry('답글', 2, 'bob', 'a.ts:10', 'x'.repeat(50))}${entry('루트', 3, 'bob', 'b.ts:None', '다른 스레드')}`)
  })

  test('모르는 옵션과 빠진 인자는 1', (t) => {
    const s = setup(t)
    const unknown = s.run(COMMANDS.list, ['o/r', '7', '--nope'])
    assert.equal(unknown.code, 1)
    assert.match(unknown.stderr, /알 수 없는 옵션: --nope/)
    assert.equal(s.run(COMMANDS.list, ['o/r']).code, 1)
    assert.equal(s.run(COMMANDS.list, ['o/r', '7', '--thread']).code, 1)
  })

  test('gh 가 실패하면 0 이 아니게 끝난다', (t) => {
    const s = setup(t)
    s.setRules([{ match: ['--slurp'], code: 1 }])
    assert.notEqual(s.run(COMMANDS.list, ['o/r', '7']).code, 0)
  })
})

describe('render-comments', () => {
  test('JSON 파일과 인자로 같은 출력을 낸다', (t) => {
    const s = setup(t)
    const file = s.write('rows.json', JSON.stringify([{ id: 5, user: { login: 'me' }, path: 'a/b.ts', line: 3, body: '한글 본문' }, { id: 6, in_reply_to_id: 5, user: { login: 'you' }, path: 'a/b.ts', line: 3, body: 'r' }]))
    const done = s.run(COMMANDS.render, [file, '5', '0', 'me'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, `댓글 2건\n주의: line 이 null 인 댓글은 이 목록에서 빠질 수 있다. 개수로 등록 성공을 판정하지 않는다.\n\n루트 5  ${'me'.padEnd(16)} b.ts:3\n     한글 본문\n답글 6  ${'you'.padEnd(16)} b.ts:3\n     r\n`)
    assert.equal(s.run(COMMANDS.render, [file, '', '1', 'you']).stdout.startsWith('댓글 1건\n'), true)
  })
})

describe('gh-review-post', () => {
  const REVIEW = '🟠 **P2 높음**\n본문 낱말A\n'
  const SUMMARY = '## 코드 리뷰\n요약 낱말S\n'

  function post(s: ReturnType<typeof setup>, args: string[], extra: NodeJS.ProcessEnv = {}) {
    return s.run(COMMANDS.post, args, extra)
  }

  test('DRY_RUN 은 검증만 하고 모드별 머리 줄을 낸다', (t) => {
    const s = setup(t)
    const body = s.write('body.md', REVIEW)
    const summary = s.write('summary.md', SUMMARY)
    const dry = { DRY_RUN: '1' }
    const tail = `첫 줄   : 🟠 **P2 높음**\n검증    : 통과\nDRY_RUN=1 이므로 등록하지 않고 종료합니다.\n`
    const top = '호스트  : github.com\n대상    : o/r PR #5\n'
    assert.equal(post(s, ['o/r', '5', 'a/b.ts', '12', body, '낱말A'], dry).stdout, `${top}위치    : a/b.ts:12\n${tail}`)
    assert.equal(post(s, ['--reply', 'o/r', '5', '9', body, '낱말A'], dry).stdout, `${top}답글 대상: 댓글 9\n${tail}`)
    assert.equal(post(s, ['--edit', 'o/r', '5', '9', body, '낱말A'], dry).stdout, `${top}수정 대상: 댓글 9\n${tail}`)
    assert.equal(post(s, ['--summary', 'o/r', '5', summary, '낱말S'], dry).stdout, `${top}위치    : 리뷰 요약\n첫 줄   : ## 코드 리뷰\n검증    : 통과\nDRY_RUN=1 이므로 등록하지 않고 종료합니다.\n`)
    const batch = post(s, ['--batch', 'o/r', '5', summary, '낱말S', '--', `a/b.ts:3:${body}`, `c.ts:4:${body}`], dry)
    assert.equal(batch.stdout, `${top}위치    : 리뷰 요약과 인라인 2건\n첫 줄   : ## 코드 리뷰\n검증    : 통과\nDRY_RUN=1 이므로 등록하지 않고 종료합니다.\n`)
    assert.deepEqual(s.calls(), [])
  })

  describe('등록 전 거부는 1 과 stderr 문구', () => {
    const cases: [string, (s: ReturnType<typeof setup>) => string[], RegExp][] = [
      ['등급 줄이 아님', (s) => ['o/r', '5', 'a.ts', '1', s.write('b.md', '그냥 글\n'), '글'], /본문 첫 줄이 색 원과 등급/],
      ['핵심 낱말 없음', (s) => ['o/r', '5', 'a.ts', '1', s.write('b.md', REVIEW)], /핵심 낱말을 하나 이상 넘기세요/],
      ['본문에 낱말이 없음', (s) => ['o/r', '5', 'a.ts', '1', s.write('b.md', REVIEW), '없는낱말'], /본문에 '없는낱말' 가 없습니다/],
      ['빈 본문 파일', (s) => ['o/r', '5', 'a.ts', '1', s.write('b.md', ''), '글'], /본문 파일이 비어 있습니다/],
      ['봇 재트리거 토큰', (s) => ['o/r', '5', 'a.ts', '1', s.write('b.md', `${REVIEW}@claude 봐줘\n`), '낱말A'], /봇 재트리거 토큰/],
      ['요약 첫 줄', (s) => ['--summary', 'o/r', '5', s.write('b.md', REVIEW), '낱말A'], /요약 첫 줄이 '## 코드 리뷰' 로 시작하지 않습니다/],
      ['묶음에 인라인 없음', (s) => ['--batch', 'o/r', '5', s.write('b.md', SUMMARY), '낱말S'], /묶음 모드는 '--' 뒤에/],
      ['묶음 줄 번호', (s) => ['--batch', 'o/r', '5', s.write('b.md', SUMMARY), '낱말S', '--', `a.ts:x:${s.write('i.md', REVIEW)}`], /줄 번호를 읽지 못했습니다/],
      ['묶음 인라인 등급', (s) => ['--batch', 'o/r', '5', s.write('b.md', SUMMARY), '낱말S', '--', `a.ts:3:${s.write('i.md', '글\n')}`], /첫 줄이 색 원과 등급/],
      ['수정 모드 등급', (s) => ['--edit', 'o/r', '5', '9', s.write('b.md', '글\n'), '글'], /본문 첫 줄이 색 원과 등급/],
    ]
    for (const [name, args, message] of cases) {
      test(name, (t) => {
        const s = setup(t)
        const done = post(s, args(s))
        assert.equal(done.code, 1, done.stdout)
        assert.match(done.stderr, message)
        assert.equal(s.calls().length, 0)
      })
    }
    test('봇 토큰 바로 뒤의 한글은 낱말이 이어진 것이라 막지 않고, 공백이나 문장 부호가 오면 막는다', (t) => {
      const s = setup(t)
      const dry = { DRY_RUN: '1' }
      assert.equal(post(s, ['o/r', '5', 'a.ts', '1', s.write('b.md', `${REVIEW}@claude가 봐줘\n`), '낱말A'], dry).code, 0)
      assert.equal(post(s, ['o/r', '5', 'a.ts', '1', s.write('b2.md', `${REVIEW}/review.\n`), '낱말A'], dry).code, 1)
    })

    test('줄 번호가 정수가 아니면 등록 전에 1', (t) => {
      const s = setup(t)
      for (const line of ['abc', '1e3', '12.0', '0x10']) {
        const done = post(s, ['o/r', '5', 'a.ts', line, s.write('b.md', REVIEW), '낱말A'])
        assert.equal(done.code, 1, line)
      }
      assert.deepEqual(s.calls(), [])
    })

    test('빠진 인자', (t) => {
      const s = setup(t)
      assert.equal(post(s, ['o/r']).code, 1)
    })
  })

  const posted = (id = 77) => JSON.stringify({ id, html_url: `http://x/${id}` })
  const verifyLine = '  댓글 11  a/b.ts:12  첫 줄: 🟠 **P2 높음**\n'

  test('인라인 등록: payload 바이트와 검증 출력', (t) => {
    const s = setup(t)
    const body = s.write('body.md', REVIEW)
    s.setRules([
      { match: ['reviews', 'POST'], stdout: posted() },
      { match: ['--paginate', 'pulls/5/comments', '--jq'], stdout: verifyLine },
    ])
    const done = post(s, ['o/r', '5', 'a/b.ts', '12', body, '낱말A'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, `호스트  : github.com\n대상    : o/r PR #5\n위치    : a/b.ts:12\n첫 줄   : 🟠 **P2 높음**\n검증    : 통과\n등록 완료: 리뷰 77\n${verifyLine}`)
    const [create] = s.calls()
    assert.equal(create.ghHost, 'github.com')
    assert.equal(create.input, `{"event": "COMMENT", "comments": [{"path": "a/b.ts", "line": 12, "side": "RIGHT", "body": "🟠 **P2 높음**\\n본문 낱말A\\n\\n<sub>${NOTICE}</sub>"}]}\n`)
  })

  test('이미 AI 안내가 있으면 다시 붙이지 않는다', (t) => {
    const s = setup(t)
    const body = s.write('body.md', `${REVIEW}\n<sub>${NOTICE}</sub>\n`)
    s.setRules([{ match: ['reviews', 'POST'], stdout: posted() }, { match: ['--jq'], stdout: verifyLine }])
    assert.equal(post(s, ['o/r', '5', 'a/b.ts', '12', body, '낱말A']).code, 0)
    assert.equal(s.calls()[0].input, `{"event": "COMMENT", "comments": [{"path": "a/b.ts", "line": 12, "side": "RIGHT", "body": "🟠 **P2 높음**\\n본문 낱말A\\n\\n<sub>${NOTICE}</sub>"}]}\n`)
  })

  test('줄에 붙은 댓글이 모자라면 1 과 stderr 경고', (t) => {
    const s = setup(t)
    s.setRules([{ match: ['reviews', 'POST'], stdout: posted() }, { match: ['--jq'], stdout: '' }])
    const done = post(s, ['o/r', '5', 'a/b.ts', '12', s.write('body.md', REVIEW), '낱말A'])
    assert.equal(done.code, 1)
    assert.match(done.stdout, /등록 완료: 리뷰 77\n$/)
    assert.equal(done.stderr, '경고: 인라인 1건을 등록했지만 줄에 붙은 것은 0건입니다. 줄이 diff 에 없을 수 있습니다.\n')
  })

  test('요약 등록', (t) => {
    const s = setup(t)
    s.setRules([{ match: ['reviews', 'POST'], stdout: posted() }])
    const done = post(s, ['--summary', 'o/r', '5', s.write('s.md', SUMMARY), '낱말S'])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.endsWith('등록 완료: 요약 리뷰 77 http://x/77\n'))
    assert.equal(s.calls()[0].input, `{"event": "COMMENT", "body": "## 코드 리뷰\\n요약 낱말S\\n\\n---\\n\\n${NOTICE}"}\n`)
  })

  test('묶음 등록', (t) => {
    const s = setup(t)
    const first = s.write('i1.md', '🔴 **P1 치명**\n첫 인라인\n')
    const second = s.write('i2.md', '🔵 **P4 낮음**\n둘째\n')
    s.setRules([
      { match: ['reviews', 'POST'], stdout: posted(80) },
      { match: ['--jq'], stdout: '  댓글 1  a.ts:3  첫 줄: x\n  댓글 2  b:c.ts:4  첫 줄: y\n' },
    ])
    const done = post(s, ['--batch', 'o/r', '5', s.write('s.md', SUMMARY), '낱말S', '첫 인라인', '--', `a.ts:3:${first}`, `b:c.ts:4:${second}`])
    assert.equal(done.code, 0, done.stderr)
    assert.match(done.stdout, /등록 완료: 리뷰 80\n/)
    assert.equal(
      s.calls()[0].input,
      `{"event": "COMMENT", "body": "## 코드 리뷰\\n요약 낱말S\\n\\n---\\n\\n${NOTICE}", "comments": [{"path": "a.ts", "line": 3, "side": "RIGHT", "body": "🔴 **P1 치명**\\n첫 인라인\\n\\n<sub>${NOTICE}</sub>"}, {"path": "b:c.ts", "line": 4, "side": "RIGHT", "body": "🔵 **P4 낮음**\\n둘째\\n\\n<sub>${NOTICE}</sub>"}]}\n`,
    )
  })

  test('수정 등록', (t) => {
    const s = setup(t)
    s.setRules([{ match: ['pulls/comments/9', 'PATCH'], stdout: '수정 완료: 댓글 9  a.ts  첫 줄: 🟠 **P2 높음**\n' }])
    const done = post(s, ['--edit', 'o/r', '5', '9', s.write('b.md', REVIEW), '낱말A'])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.endsWith('수정 완료: 댓글 9  a.ts  첫 줄: 🟠 **P2 높음**\n'))
    assert.equal(s.calls()[0].input, `{"body": "🟠 **P2 높음**\\n본문 낱말A\\n\\n<sub>${NOTICE}</sub>"}\n`)
  })

  test('답글 등록은 본문 파일을 -F 로 보낸다', (t) => {
    const s = setup(t)
    const body = s.write('b.md', REVIEW)
    s.setRules([{ match: ['comments/9/replies'], stdout: JSON.stringify({ id: 11, in_reply_to_id: 9 }) }])
    const done = post(s, ['--reply', 'o/r', '5', '9', body, '낱말A'])
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.endsWith('등록 완료: 답글 11 (in_reply_to 9)\n'))
    assert.deepEqual(s.calls()[0].argv, ['api', 'repos/o/r/pulls/5/comments/9/replies', '-X', 'POST', '-F', `body=@${body}`])
  })
})
