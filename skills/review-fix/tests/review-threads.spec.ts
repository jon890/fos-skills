// review-fix 의 review_threads 명령 경계 테스트. 가짜 gh 가 GraphQL 인자에 맞춰 JSON 을 내고, 받은 인자와 stdout 바이트, 종료 코드를 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setup, threadsResponse, type Rule } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', join(import.meta.dirname, '..', 'scripts', 'review_threads.ts')]
// ──

type S = ReturnType<typeof setup>

// 호스트 탐색을 건너뛰도록 GH_HOST 를 준다
function rt(s: S, args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  return s.exec(COMMAND, args, { GH_HOST: 'github.com', ...env }, input)
}

function listRule(flags: boolean[], total?: number, patch?: (node: Record<string, unknown>, index: number) => void): Rule {
  return { match: ['graphql', 'owner=o'], stdout: threadsResponse(flags, total, patch) }
}

function variable(argv: string[], name: string): string | undefined {
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}

describe('list', () => {
  test('미해결 스레드만 한 줄 JSON 으로 낸다', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([false, true])])
    const done = rt(s, ['list', 'o', 'r', '1'])
    assert.deepEqual([done.code, done.stdout], [0, '{"author":"bot","head":"x","id":"T0","line":0,"outdated":false,"path":"a.py","resolved":false}\n'])
    const [call] = s.gh.calls()
    assert.deepEqual(call.argv.slice(0, 2), ['api', 'graphql'])
    assert.deepEqual([variable(call.argv, 'owner'), variable(call.argv, 'repo'), variable(call.argv, 'num'), call.ghHost], ['o', 'r', '1', 'github.com'])
  })

  test('list-all 은 resolve 된 것도 낸다', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([false, true])])
    const lines = rt(s, ['list-all', 'o', 'r', '1']).stdout.split('\n').filter(Boolean)
    assert.deepEqual(lines.map((l) => JSON.parse(l).resolved), [false, true])
  })

  test('outdated 스레드는 line 이 비면 originalLine 을 낸다', (t) => {
    const s = setup(t)
    s.gh.setRules([
      listRule([false, false], undefined, (node, i) => {
        if (i === 0) Object.assign(node, { line: null, originalLine: 7, isOutdated: true })
        else Object.assign(node, { line: 12, originalLine: 9 })
      }),
    ])
    const lines = rt(s, ['list', 'o', 'r', '1']).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => l.line), [7, 12])
    assert.equal(lines[0].outdated, true)
  })

  test('head 는 120자에서 잘리고 첫 댓글이 없으면 null 작성자와 빈 head', (t) => {
    const s = setup(t)
    s.gh.setRules([
      listRule([false, false], undefined, (node, i) => {
        node.comments = { nodes: i === 0 ? [{ author: { login: 'bot' }, body: '가'.repeat(300) }] : [] }
      }),
    ])
    const lines = rt(s, ['list', 'o', 'r', '1']).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(Array.from(lines[0].head).length, 120)
    assert.deepEqual([lines[1].author, lines[1].head], [null, ''])
  })

  test('100건을 넘으면 첫 줄에 경고를 낸다', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([false], 150)])
    const done = rt(s, ['list', 'o', 'r', '1'])
    assert.equal(done.stdout.split('\n')[0], '경고: 스레드 150건 중 100건만 조회했다')
    assert.equal(done.code, 0)
  })

  test('gh 가 실패하면 1 과 gh 의 stderr', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql'], stderr: 'boom\n', code: 1 }])
    const done = rt(s, ['list', 'o', 'r', '1'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [1, '', 'boom\n'])
  })

  test('인자 수가 틀리면 2', (t) => {
    const s = setup(t)
    for (const args of [['list', 'o', 'r'], ['list-all', 'o', 'r', '1', '2']]) assert.equal(rt(s, args).code, 2)
    assert.equal(s.gh.calls().length, 0)
  })
})

describe('list --count', () => {
  test('미해결 수만 정수로 낸다', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([false, true, false])])
    const done = rt(s, ['list', '--count', 'o', 'r', '1'])
    assert.deepEqual([done.code, done.stdout], [0, '2\n'])
  })

  test('옵션은 어느 자리에 와도 된다', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([true, true])])
    assert.deepEqual([rt(s, ['list', 'o', 'r', '1', '--count']).stdout, rt(s, ['--count', 'list', 'o', 'r', '1']).stdout], ['0\n', '0\n'])
  })

  test('list-all 의 수는 resolve 된 것을 포함한다', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([false, true])])
    assert.equal(rt(s, ['list-all', '--count', 'o', 'r', '1']).stdout, '2\n')
  })

  test('조회가 잘렸으면 수를 내지 않고 1', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([true], 150)])
    const done = rt(s, ['list', '--count', 'o', 'r', '1'])
    assert.deepEqual([done.code, done.stdout], [1, ''])
    assert.match(done.stderr, /150/)
  })

  test('옵션이 없으면 JSON 줄 하나다', (t) => {
    const s = setup(t)
    s.gh.setRules([listRule([false, true])])
    const lines = rt(s, ['list', 'o', 'r', '1']).stdout.split('\n').filter(Boolean)
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes('"resolved":false'))
  })
})

function showResponse(comments: [string | null, string][], opts: { total?: number; thread?: boolean } = {}): string {
  const node = opts.thread === false ? {} : {
    id: 'T1',
    isResolved: false,
    isOutdated: true,
    path: 'a.py',
    line: null,
    originalLine: 9,
    comments: { totalCount: opts.total ?? comments.length, nodes: comments.map(([login, body], i) => ({ author: login === null ? null : { login }, body, url: `u${i}` })) },
  }
  return JSON.stringify({ data: { node } })
}

describe('show', () => {
  test('첫 줄은 스레드 JSON 이고 댓글마다 머리줄과 본문 전체를 낸다', (t) => {
    const s = setup(t)
    const long = `${'근거 '.repeat(100)}\n둘째 줄`
    s.gh.setRules([{ match: ['graphql', 'id=T1'], stdout: showResponse([['bot', long], ['me', '반영했다']]) }])
    const done = rt(s, ['show', 'T1'])
    assert.equal(done.code, 0)
    assert.equal(
      done.stdout,
      `{"comments":2,"id":"T1","line":9,"outdated":true,"path":"a.py","resolved":false}\n\n--- 1. bot u0\n${long}\n\n--- 2. me u1\n반영했다\n`,
    )
    assert.equal(variable(s.gh.calls()[0].argv, 'id'), 'T1')
  })

  test('작성자나 본문이 없으면 None 과 빈 줄', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql'], stdout: JSON.stringify({ data: { node: { id: 'T1', isResolved: true, isOutdated: false, path: 'a', line: 1, comments: { totalCount: 1, nodes: [{ author: null, body: null, url: null }] } } } }) }])
    const done = rt(s, ['show', 'T1'])
    assert.equal(done.stdout.split('\n').slice(1).join('\n'), '\n--- 1. None\n\n')
  })

  test('스레드가 아닌 노드는 1', (t) => {
    const s = setup(t)
    for (const body of [showResponse([], { thread: false }), JSON.stringify({ data: { node: null } })]) {
      s.gh.setRules([{ match: ['graphql'], stdout: body }])
      const done = rt(s, ['show', 'X'])
      assert.deepEqual([done.code, done.stdout], [1, ''])
      assert.match(done.stderr, /리뷰 스레드가 아니거나 찾을 수 없다: X/)
    }
  })

  test('THREAD_ID 는 정확히 하나', (t) => {
    const s = setup(t)
    assert.equal(rt(s, ['show']).code, 2)
    assert.equal(rt(s, ['show', 'A', 'B']).code, 2)
  })

  test('댓글이 100건을 넘으면 stderr 에 경고한다', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql'], stdout: showResponse([['bot', 'x']], { total: 150 }) }])
    const done = rt(s, ['show', 'T1'])
    assert.equal(done.code, 0)
    assert.match(done.stderr, /경고: 댓글 150건 중 100건만 조회했다/)
  })
})

function carriedResponse(threads: [string, boolean, string[]][]): string {
  const nodes = threads.map(([id, resolved, replies]) => ({
    id,
    isResolved: resolved,
    path: 'a.py',
    line: 3,
    comments: { nodes: [{ author: { login: 'bot' }, body: '지적', url: 'u0' }, ...replies.map((body, i) => ({ author: { login: 'me' }, body, url: `u${i + 1}` }))] },
  }))
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: nodes.length, nodes } } } } })
}

describe('carried', () => {
  test('회신에 표지 문구가 든 스레드만 resolve 된 것까지 낸다', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql'], stdout: carriedResponse([['T1', true, ['다음 PR 에서 반영한다']], ['T2', false, ['반영했다']], ['T3', false, []]]) }])
    const done = rt(s, ['carried', 'o', 'r', '7'])
    assert.deepEqual([done.code, done.stdout], [0, '{"author":"bot","head":"지적","id":"T1","line":3,"path":"a.py","pr":7,"reply_url":"u1","resolved":true}\n'])
  })

  test('첫 댓글의 문구는 회신이 아니다', (t) => {
    const s = setup(t)
    const data = JSON.parse(carriedResponse([['T1', false, []]]))
    data.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].body = '다음 PR'
    s.gh.setRules([{ match: ['graphql'], stdout: JSON.stringify(data) }])
    const done = rt(s, ['carried', 'o', 'r', '7'])
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })

  test('--marker 로 문구를 바꾸고 마지막 일치 댓글의 url 을 낸다', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql'], stdout: carriedResponse([['T1', false, ['후속 처리 1', '무관', '후속 처리 2']]]) }])
    const done = rt(s, ['carried', 'o', 'r', '7', '--marker', '후속'])
    assert.equal(JSON.parse(done.stdout).reply_url, 'u3')
  })

  test('--marker 에 값이 없으면 2', (t) => {
    const s = setup(t)
    assert.equal(rt(s, ['carried', 'o', 'r', '7', '--marker']).code, 2)
  })

  test('스레드가 100건을 넘으면 첫 줄에 경고', (t) => {
    const s = setup(t)
    const data = JSON.parse(carriedResponse([['T1', false, ['다음 PR']]]))
    data.data.repository.pullRequest.reviewThreads.totalCount = 150
    s.gh.setRules([{ match: ['graphql'], stdout: JSON.stringify(data) }])
    assert.equal(rt(s, ['carried', 'o', 'r', '7']).stdout.split('\n')[0], '경고: 스레드 150건 중 100건만 조회했다')
  })
})

describe('reply', () => {
  test('본문 파일을 -F body=@경로 로 넘기고 url 을 낸다', (t) => {
    const s = setup(t)
    const body = s.write('body.md', '`코드` $HOME')
    s.gh.setRules([{ match: ['graphql', 'threadId=T1'], stdout: 'https://x/T1\n' }])
    const done = rt(s, ['reply', 'T1', body])
    assert.deepEqual([done.code, done.stdout], [0, 'https://x/T1\n'])
    const argv = s.gh.calls()[0].argv
    assert.deepEqual(argv.slice(-4), ['-F', `body=@${body}`, '--jq', '.data.addPullRequestReviewThreadReply.comment.url'])
  })

  test('본문 파일이 없으면 gh 를 부르지 않고 2', (t) => {
    const s = setup(t)
    const done = rt(s, ['reply', 'T1', join(s.root, 'nope.md')])
    assert.equal(done.code, 2)
    assert.match(done.stderr, /본문 파일을 읽을 수 없다: .*nope\.md/)
    assert.equal(s.gh.calls().length, 0)
  })

  test('gh 가 실패하면 1', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql'], stderr: 'boom\n', code: 1 }])
    const done = rt(s, ['reply', 'T1', s.write('b.md', 'x')])
    assert.deepEqual([done.code, done.stdout, done.stderr], [1, '', 'boom\n'])
  })

  test('인자 수가 틀리면 2', (t) => {
    const s = setup(t)
    assert.equal(rt(s, ['reply', 'T1']).code, 2)
  })
})

describe('reply-batch', () => {
  function batch(s: S, text: string, failIds: string[] = [], files = ['a.md', 'b.md', 'c.md']) {
    for (const name of files) s.write(name, name)
    const map = s.write('map.tsv', text)
    s.gh.setRules([
      ...failIds.map((id): Rule => ({ match: [`threadId=${id}`], stderr: 'boom\n', code: 1 })),
      ...['T1', 'T2', 'T3'].map((id): Rule => ({ match: [`threadId=${id}`], stdout: `https://x/${id}\n` })),
    ])
    const done = rt(s, ['reply-batch', map])
    return { ...done, ids: s.gh.calls().map((c) => variable(c.argv, 'threadId')) }
  }

  test('빈 줄과 # 줄을 건너뛰고 줄마다 회신한다', (t) => {
    const done = batch(setup(t), 'T1\ta.md\n# 주석\n\nT2\tb.md\n')
    assert.deepEqual([done.code, done.ids, done.stdout], [0, ['T1', 'T2'], '[T1] https://x/T1\n[T2] https://x/T2\n'])
  })

  test('상대 경로는 map 파일이 있는 폴더 기준이다', (t) => {
    const s = setup(t)
    batch(s, 'T1\ta.md\n')
    assert.equal(s.gh.calls()[0].argv.find((a) => a.startsWith('body=@')), `body=@${join(s.root, 'a.md')}`)
  })

  test('실패한 줄을 이름으로 알리고 나머지는 계속 돈 뒤 1', (t) => {
    const done = batch(setup(t), 'T1\ta.md\nT2\tb.md\nT3\tc.md\n', ['T2'])
    assert.equal(done.code, 1)
    assert.deepEqual(done.ids, ['T1', 'T2', 'T3'])
    assert.equal(done.stdout, '[T1] https://x/T1\n[T2] [T3] https://x/T3\n')
    assert.equal(done.stderr, 'boom\n회신 실패 1/3건: 줄 2 T2\n')
  })

  test('본문 파일이 없는 줄은 실패로 센다', (t) => {
    const done = batch(setup(t), 'T1\tnope.md\nT2\tb.md\n')
    assert.deepEqual([done.code, done.ids], [1, ['T2']])
    assert.match(done.stderr, /줄 1 T1/)
  })

  test('탭이 없는 줄은 실패로 센다', (t) => {
    const done = batch(setup(t), 'T1 a.md\nT2\tb.md\n')
    assert.deepEqual([done.code, done.ids], [1, ['T2']])
    assert.match(done.stderr, /줄 1: `THREAD_ID<탭>본문파일` 꼴이 아니다: T1 a\.md/)
    assert.match(done.stderr, /회신 실패 1\/2건: 줄 1\n/)
  })

  test('회신할 줄이 없으면 2', (t) => {
    const done = batch(setup(t), '# 비었다\n')
    assert.deepEqual([done.code, done.ids], [2, []])
  })

  test('map 파일을 읽지 못하면 2', (t) => {
    const s = setup(t)
    const done = rt(s, ['reply-batch', join(s.root, 'none.tsv')])
    assert.equal(done.code, 2)
    assert.match(done.stderr, /map 파일을 읽을 수 없다/)
  })
})

describe('resolve', () => {
  function resolveIds(s: S, args: string[], input = '') {
    s.gh.setRules(['T1', 'T2'].map((id): Rule => ({ match: [`threadId=${id}`], stdout: `${id} resolved=true\n` })))
    const done = rt(s, ['resolve', '--repo', 'o/r', ...args], input)
    return { ...done, ids: s.gh.calls().map((c) => variable(c.argv, 'threadId')) }
  }

  test('인자를 하나씩 resolve 하고 결과 줄을 낸다', (t) => {
    const s = setup(t)
    const done = resolveIds(s, ['T1', 'T2'])
    assert.deepEqual([done.code, done.ids, done.stdout], [0, ['T1', 'T2'], 'T1 resolved=true\nT2 resolved=true\n'])
    assert.equal(s.gh.calls()[0].argv.at(-1), '.data.resolveReviewThread.thread | "\\(.id) resolved=\\(.isResolved)"')
  })

  test('zsh 가 나누지 않은 변수는 인자 하나로 오지만 공백으로 나눈다', (t) => {
    assert.deepEqual(resolveIds(setup(t), ['T1 T2']).ids, ['T1', 'T2'])
  })

  test('- 는 표준 입력에서 읽는다', (t) => {
    assert.deepEqual(resolveIds(setup(t), ['-'], 'T1\nT2\n\n').ids, ['T1', 'T2'])
  })

  test('읽은 ID 가 없으면 2', (t) => {
    const done = resolveIds(setup(t), ['-'], '\n')
    assert.deepEqual([done.code, done.ids], [2, []])
  })

  test('하나가 실패해도 나머지를 돌고 1', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['threadId=T1'], stderr: 'boom\n', code: 1 }, { match: ['threadId=T2'], stdout: 'T2 resolved=true\n' }])
    const done = rt(s, ['resolve', 'T1', 'T2'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [1, 'T2 resolved=true\n', 'boom\n'])
  })
})

describe('--repo 와 호스트', () => {
  test('--repo 는 어느 자리에 와도 되고 = 꼴도 받는다. origin 과 같은 저장소면 gh 로 호스트를 찾지 않는다', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['graphql'], stdout: 'U\n' }])
    const body = s.write('b.md', 'x')
    for (const args of [['reply', '--repo', 'o/r', 'T1', body], ['reply', 'T1', body, '--repo=o/r']]) {
      const done = s.exec(COMMAND, args)
      assert.deepEqual([done.code, done.stdout], [0, 'U\n'])
    }
    assert.deepEqual(s.gh.calls().map((c) => [c.argv[0], c.ghHost]), [['api', 'github.com'], ['api', 'github.com']])
  })

  test('다른 저장소면 로그인 호스트로 정한다', (t) => {
    const s = setup(t)
    s.gh.setRules([{ match: ['auth', 'status'], stdout: 'ghe.example.com\n' }, { match: ['graphql'], stdout: 'U\n' }])
    const done = s.exec(COMMAND, ['reply', '--repo', 'x/y', 'T1', s.write('b.md', 'x')])
    assert.equal(done.code, 0)
    assert.equal(s.gh.calls().at(-1)!.ghHost, 'ghe.example.com')
  })

  test('list 는 받은 owner repo 로 호스트를 정한다', (t) => {
    const s = setup(t, { origin: 'git@wrong.example:a/b.git' })
    s.gh.setRules([{ match: ['auth', 'status'], stdout: 'ghe.example.com\n' }, listRule([false])])
    const done = s.exec(COMMAND, ['list', 'o', 'r', '1'])
    assert.equal(done.code, 0)
    assert.equal(s.gh.calls().at(-1)!.ghHost, 'ghe.example.com')
  })

  test('--repo 에 / 가 없으면 2', (t) => {
    const s = setup(t)
    for (const args of [['show', 'T1', '--repo', 'bad'], ['show', 'T1', '--repo=bad']]) {
      const done = rt(s, args)
      assert.deepEqual([done.code, done.stdout], [2, ''])
      assert.match(done.stderr, /--repo 는 <owner>\/<repo> 꼴이어야 한다: bad/)
    }
  })

  test('호스트를 구하지 못하면 2', (t) => {
    const s = setup(t, { origin: null })
    const done = s.exec(COMMAND, ['show', 'T1'])
    assert.deepEqual([done.code, done.stdout], [2, ''])
    assert.match(done.stderr, /origin 리모트에서 호스트를 읽지 못했다/)
  })
})

describe('사용법', () => {
  test('인자가 없거나 모르는 명령이면 2 와 사용법', (t) => {
    const s = setup(t)
    for (const args of [[], ['frob']]) {
      const done = rt(s, args)
      assert.deepEqual([done.code, done.stdout], [2, ''])
      assert.match(done.stderr, /list/)
    }
  })
})
