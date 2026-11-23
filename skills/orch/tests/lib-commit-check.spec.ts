// lib/commit-check.ts 와 githooks/dispatch.mjs 를 임시 저장소의 연결된 워크트리에서 실제 git commit 으로 본다.
// 검사기는 이 번들의 export-only-skills/korean-check 를 그대로 복사해 쓴다. 금지어 낱말은 실제 매핑 표의 것이다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { HOOK_NAMES, installCommitCheck } from '../scripts/lib/commit-check.ts'
import { GIT_ISOLATION } from '../../../modules/testkit/git.ts'

// 전역 설정과 작성자를 고정한다. 프로세스가 파일마다 나뉘어 다른 파일에 새지 않는다.
const GIT_ENV: Record<string, string> = {
  // 사용자의 실제 비공개 낱말 목록과 떼어 놓는다. 목록이 없으면 훅이 그 검사를 하지 않는다(lib/private-words.ts)
  ORCH_PRIVATE_WORDS: '/dev/null',
  ...GIT_ISOLATION,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
// 훅이 부르는 검사기가 개발자 환경의 규칙 경로나 테스트 실행기 문맥을 물려받지 않게 한다
const CLEARED = ['KOREAN_STYLE_RULES', 'KOREAN_CHECK_ALLOW', 'NODE_TEST_CONTEXT']
const saved: Record<string, string | undefined> = {}

const BANNED = '결과를 스윕한다.\n'
const WARNED = '배포 + 검증을 쓴다.\n'
const CLEAN = '문제 없는 문장이다.\n'

let tmp: string
let proj: string
let wt: string

function g(cwd: string, ...args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function put(path: string, text: string, mode = 0o644): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

// 파일을 쓰고 스테이징한 뒤 커밋한다
function commit(cwd: string, name: string, text: string, message = 'work') {
  put(join(cwd, name), text)
  assert.equal(g(cwd, 'add', '--', name).status, 0)
  return g(cwd, 'commit', '-m', message)
}

function subjects(cwd: string): string[] {
  return g(cwd, 'log', '--format=%s').stdout.trim().split('\n')
}

function gitDir(cwd: string): string {
  return g(cwd, 'rev-parse', '--path-format=absolute', '--git-dir').stdout.trim()
}

// 받은 인자를 표지 파일에 적는 원래 훅
function marker(dir: string, name: string, exit = 0): string {
  const file = join(tmp, `ran-${name}`)
  put(join(dir, name), `#!/bin/sh\necho "${name} $@" >> '${file}'\nexit ${exit}\n`, 0o755)
  return file
}

function addWorktree(name: string, branch: string): string {
  const path = join(tmp, name)
  assert.equal(g(proj, 'worktree', 'add', '-q', '-b', branch, path).status, 0)
  return path
}

before(() => {
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  for (const key of CLEARED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'commit-check-')))
  proj = join(tmp, 'proj')
  spawnSync('git', ['init', '-q', '-b', 'main', proj])
  g(proj, 'commit', '-q', '--allow-empty', '-m', 'init')
  wt = addWorktree('wt', 'feature/x')
})

describe('걸기', () => {
  test('그 워크트리에만 훅 폴더를 걸고 주 checkout 과 다른 워크트리는 그대로다', () => {
    const other = addWorktree('other', 'feature/y')
    const r = installCommitCheck(wt)
    const hooks = join(gitDir(wt), 'orch-hooks')
    assert.deepEqual(r, { status: 'set', hooks })
    assert.equal(g(wt, 'config', '--worktree', '--get', 'core.hooksPath').stdout.trim(), hooks)
    assert.equal(g(proj, 'config', '--get', 'core.hooksPath').status, 1)
    assert.equal(g(other, 'config', '--get', 'core.hooksPath').status, 1)
    assert.equal(g(proj, 'config', '--local', '--get', 'core.repositoryformatversion').stdout.trim(), '0')
  })

  test('훅 폴더에 본체, 모듈 종류 표시, 훅 이름 링크, 검사기 사본이 있다', () => {
    installCommitCheck(wt)
    const hooks = join(gitDir(wt), 'orch-hooks')
    assert.ok(lstatSync(join(hooks, 'dispatch.mjs')).mode & 0o100)
    assert.deepEqual(JSON.parse(readFileSync(join(hooks, 'package.json'), 'utf8')), { type: 'module' })
    for (const name of HOOK_NAMES) assert.ok(lstatSync(join(hooks, name)).isSymbolicLink(), name)
    assert.ok(existsSync(join(hooks, 'korean-check', 'scripts', 'check.ts')))
    assert.ok(existsSync(join(hooks, 'korean-check', 'scripts', 'kit', 'py.ts')))
    assert.ok(existsSync(join(hooks, 'korean-check', 'references', 'korean-style.md')))
    assert.equal(g(wt, 'status', '--porcelain').stdout, '')
  })

  test('두 번 걸어도 같고, 망가진 훅 폴더는 다시 걸면 복구된다', () => {
    installCommitCheck(wt)
    const hooks = join(gitDir(wt), 'orch-hooks')
    rmSync(join(hooks, 'korean-check', 'references', 'korean-style.md'))
    assert.deepEqual(installCommitCheck(wt), { status: 'set', hooks })
    assert.ok(existsSync(join(hooks, 'korean-check', 'references', 'korean-style.md')))
    assert.deepEqual(readdirNames(gitDir(wt)).filter((name) => name.startsWith('orch-hooks')), ['orch-hooks'])
    assert.notEqual(commit(wt, 'doc.md', BANNED).status, 0)
  })

  test('워크트리를 지우면 훅 폴더도 없다', () => {
    installCommitCheck(wt)
    const admin = gitDir(wt)
    assert.equal(g(proj, 'worktree', 'remove', '--force', wt).status, 0)
    assert.equal(existsSync(admin), false)
  })
})

function readdirNames(dir: string): string[] {
  return spawnSync('ls', ['-A', dir], { encoding: 'utf8' }).stdout.trim().split('\n')
}

describe('건너뜀과 실패', () => {
  test('주 checkout 은 걸지 않고 알린다', () => {
    const r = installCommitCheck(proj)
    assert.deepEqual(r, { status: 'skipped', reason: '주 checkout 이라 걸지 않는다', quiet: false })
    assert.equal(g(proj, 'config', '--get', 'core.hooksPath').status, 1)
    assert.equal(g(proj, 'config', '--local', '--get', 'extensions.worktreeConfig').status, 1)
  })

  test('git 작업 트리가 아니면 조용히 건너뛴다', () => {
    const r = installCommitCheck(tmp)
    assert.equal(r.status, 'skipped')
    assert.equal(r.status === 'skipped' && r.quiet, true)
  })

  test('검사기 번들이 없으면 알리고 설정을 건드리지 않는다', () => {
    const r = installCommitCheck(wt, { checker: join(tmp, 'none') })
    assert.equal(r.status, 'skipped')
    assert.equal(r.status === 'skipped' && r.quiet, false)
    assert.match(r.status === 'skipped' ? r.reason : '', /한국어 검사기 번들이 없다/)
    assert.equal(g(wt, 'config', '--get', 'core.hooksPath').status, 1)
    assert.equal(g(proj, 'config', '--local', '--get', 'extensions.worktreeConfig').status, 1)
  })

  test('워크트리에 사용자가 둔 core.hooksPath 는 덮지 않는다', () => {
    g(proj, 'config', '--local', 'extensions.worktreeConfig', 'true')
    g(wt, 'config', '--worktree', 'core.hooksPath', '/elsewhere')
    const r = installCommitCheck(wt)
    assert.deepEqual(r, { status: 'skipped', reason: '워크트리에 core.hooksPath 가 이미 있다: /elsewhere', quiet: false })
    assert.equal(g(wt, 'config', '--worktree', '--get', 'core.hooksPath').stdout.trim(), '/elsewhere')
  })

  test('앞서 둔 값이 옛 경로를 가리키면 지금 훅 폴더로 바꾼다', () => {
    g(proj, 'config', '--local', 'extensions.worktreeConfig', 'true')
    g(wt, 'config', '--worktree', 'core.hooksPath', '/moved/away/.git/worktrees/wt/orch-hooks')
    const hooks = join(gitDir(wt), 'orch-hooks')
    assert.deepEqual(installCommitCheck(wt), { status: 'set', hooks })
    assert.equal(g(wt, 'config', '--worktree', '--get', 'core.hooksPath').stdout.trim(), hooks)
  })

  test('공유 설정의 잠금이 풀리지 않으면 실패로 알리고, 풀리면 걸린다', () => {
    const lock = join(proj, '.git', 'config.lock')
    writeFileSync(lock, '')
    const r = installCommitCheck(wt)
    assert.equal(r.status, 'failed')
    assert.match(r.status === 'failed' ? r.reason : '', /could not lock config file/)
    rmSync(lock)
    assert.equal(installCommitCheck(wt).status, 'set')
  })
})

describe('커밋 거절과 통과', () => {
  beforeEach(() => assert.equal(installCommitCheck(wt).status, 'set'))

  test('더한 줄에 금지어가 있으면 발견 줄과 권장 표현을 보이고 커밋하지 않는다', () => {
    const r = commit(wt, 'doc.md', BANNED)
    assert.notEqual(r.status, 0, r.stderr)
    assert.match(r.stderr, /doc\.md:1: 금지어 "스윕"/)
    assert.match(r.stderr, /권장 표현: "스윕" → \S/)
    assert.match(r.stderr, /커밋하지 않았다/)
    assert.deepEqual(subjects(wt), ['init'])
  })

  test('고쳐서 다시 스테이징하면 커밋된다', () => {
    commit(wt, 'doc.md', BANNED)
    const r = commit(wt, 'doc.md', '결과를 한 번에 검사한다.\n', 'fixed')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(subjects(wt), ['fixed', 'init'])
  })

  test('경고만 있으면 보여 주고 커밋한다', () => {
    const r = commit(wt, 'doc.md', WARNED, 'warned')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /doc\.md:1: 경고/)
    assert.match(r.stderr, /커밋을 막지 않는다/)
    assert.deepEqual(subjects(wt), ['warned', 'init'])
  })

  test('깨끗한 .md 와 .md 가 아닌 파일은 훅 출력 없이 커밋된다', () => {
    const clean = commit(wt, 'doc.md', CLEAN, 'clean')
    assert.equal(clean.status, 0, clean.stderr)
    assert.equal(clean.stderr, '')
    const text = commit(wt, 'a.txt', BANNED, 'text')
    assert.equal(text.status, 0, text.stderr)
    assert.equal(text.stderr, '')
  })

  test('git commit -a 로 스테이징한 내용도 본다', () => {
    assert.equal(commit(wt, 'doc.md', CLEAN, 'clean').status, 0)
    put(join(wt, 'doc.md'), CLEAN + '\n' + BANNED)
    const r = g(wt, 'commit', '-a', '-m', 'all')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /doc\.md:3: 금지어/)
  })

  test('손대지 않은 기존 줄의 금지어로는 막지 않는다', () => {
    assert.equal(commit(proj, 'old.md', BANNED, 'legacy').status, 0)
    const next = addWorktree('next', 'feature/next')
    assert.equal(installCommitCheck(next).status, 'set')
    const r = commit(next, 'old.md', BANNED + '\n' + CLEAN, 'append')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stderr, '')
  })

  test('머지 중인 커밋은 검사하지 않는다', () => {
    g(proj, 'checkout', '-q', '-b', 'incoming')
    assert.equal(commit(proj, 'incoming.md', BANNED, 'incoming').status, 0)
    g(proj, 'checkout', '-q', 'main')
    assert.equal(commit(wt, 'mine.md', CLEAN, 'mine').status, 0)
    assert.equal(g(wt, 'merge', '--no-ff', '--no-commit', 'incoming').status, 0)
    const r = g(wt, 'commit', '--no-edit')
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(wt, 'incoming.md')))
  })

  test('환경의 KOREAN_STYLE_RULES 대신 사본의 규칙을 쓴다', () => {
    process.env.KOREAN_STYLE_RULES = join(tmp, 'no-such-rules.md')
    try {
      const r = commit(wt, 'doc.md', BANNED)
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /금지어 "스윕"/)
    } finally {
      delete process.env.KOREAN_STYLE_RULES
    }
  })
})

describe('검사기가 돌지 못할 때', () => {
  beforeEach(() => assert.equal(installCommitCheck(wt).status, 'set'))

  const OFF = /orch config set worker\.commit_check false/

  test('검사기 사본이 없으면 .md 가 든 커밋을 거절하고 원인과 끄는 방법을 알린다', () => {
    rmSync(join(gitDir(wt), 'orch-hooks', 'korean-check'), { recursive: true })
    const r = commit(wt, 'doc.md', CLEAN, 'no checker')
    assert.notEqual(r.status, 0, r.stderr)
    assert.match(r.stderr, /한국어 검사기 사본이 없다/)
    assert.match(r.stderr, /한국어 검사 없이 \.md 를 커밋할 수 없어 커밋하지 않았다/)
    assert.match(r.stderr, OFF)
    assert.deepEqual(subjects(wt), ['init'])
  })

  test('검사기가 발견 줄 없이 1 로 죽으면 금지어가 아니라 고장으로 거절한다', () => {
    writeFileSync(join(gitDir(wt), 'orch-hooks', 'korean-check', 'scripts', 'check.ts'), 'throw new Error("x")\n')
    const r = commit(wt, 'doc.md', BANNED, 'broken checker')
    assert.notEqual(r.status, 0, r.stderr)
    assert.match(r.stderr, /한국어 검사기가 돌지 못했다/)
    assert.match(r.stderr, /Error: x/)
    assert.match(r.stderr, OFF)
    assert.doesNotMatch(r.stderr, /금지어가 있어 커밋하지 않았다/)
    assert.deepEqual(subjects(wt), ['init'])
  })

  test('검사기 안쪽이 예외로 죽어도 조용히 지나가지 않고 거절한다', () => {
    const style = join(gitDir(wt), 'orch-hooks', 'korean-check', 'scripts', 'korean-style-check.ts')
    writeFileSync(style, `if (process.argv[1]?.endsWith('korean-style-check.ts')) throw new Error('boom')\n${readFileSync(style, 'utf8')}`)
    const r = commit(wt, 'doc.md', BANNED, 'inner crash')
    assert.notEqual(r.status, 0, r.stderr)
    assert.match(r.stderr, /한국어 검사기가 돌지 못했다/)
    assert.deepEqual(subjects(wt), ['init'])
  })

  test('고장이어도 스테이징한 .md 가 없는 커밋은 한 줄로 알리고 커밋한다', () => {
    rmSync(join(gitDir(wt), 'orch-hooks', 'korean-check'), { recursive: true })
    const r = commit(wt, 'a.txt', BANNED, 'text only')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /스테이징한 \.md 가 없어 그대로 커밋한다/)
    assert.doesNotMatch(r.stderr, OFF)
    assert.deepEqual(subjects(wt), ['text only', 'init'])
  })

  test('고장이어도 머지 중인 커밋은 막지 않는다', () => {
    g(proj, 'checkout', '-q', '-b', 'incoming')
    assert.equal(commit(proj, 'incoming.md', CLEAN, 'incoming').status, 0)
    g(proj, 'checkout', '-q', 'main')
    assert.equal(commit(wt, 'mine.txt', CLEAN, 'mine').status, 0)
    rmSync(join(gitDir(wt), 'orch-hooks', 'korean-check'), { recursive: true })
    assert.equal(g(wt, 'merge', '--no-ff', '--no-commit', 'incoming').status, 0)
    const r = g(wt, 'commit', '--no-edit')
    assert.equal(r.status, 0, r.stderr)
  })
})

describe('대상 저장소의 package.json', () => {
  function withPackage(text: string): string {
    assert.equal(commit(proj, 'package.json', text, 'package').status, 0)
    const next = addWorktree('pkg', 'feature/pkg')
    assert.equal(installCommitCheck(next).status, 'set')
    return next
  }

  test('type 이 commonjs 여도 검사기가 돌아 금지어는 거절하고 깨끗한 문서는 커밋한다', () => {
    const next = withPackage('{"type":"commonjs"}\n')
    const banned = commit(next, 'doc.md', BANNED)
    assert.notEqual(banned.status, 0)
    assert.match(banned.stderr, /doc\.md:1: 금지어 "스윕"/)
    const clean = commit(next, 'doc.md', CLEAN, 'clean')
    assert.equal(clean.status, 0, clean.stderr)
    assert.equal(clean.stderr, '')
  })

  test('type 이 없어도 Node 경고가 섞이지 않는다', () => {
    const next = withPackage('{"name":"x"}\n')
    const r = commit(next, 'doc.md', WARNED, 'warned')
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /MODULE_TYPELESS_PACKAGE_JSON|Warning:/)
  })
})

describe('원래 훅 이어 부르기', () => {
  test('공통 git 폴더의 훅을 인자와 함께 부른다. 걸고 난 뒤에 만든 훅도 불린다', () => {
    assert.equal(installCommitCheck(wt).status, 'set')
    const pre = marker(join(proj, '.git', 'hooks'), 'pre-commit')
    const msg = marker(join(proj, '.git', 'hooks'), 'commit-msg')
    assert.equal(commit(wt, 'doc.md', CLEAN, 'forward').status, 0)
    assert.equal(readFileSync(pre, 'utf8'), 'pre-commit \n')
    assert.equal(readFileSync(msg, 'utf8'), `commit-msg ${join(gitDir(wt), 'COMMIT_EDITMSG')}\n`)
  })

  test('원래 pre-commit 이 실패하면 커밋이 거절된다', () => {
    assert.equal(installCommitCheck(wt).status, 'set')
    marker(join(proj, '.git', 'hooks'), 'pre-commit', 3)
    assert.notEqual(commit(wt, 'doc.md', CLEAN, 'blocked').status, 0)
    assert.deepEqual(subjects(wt), ['init'])
  })

  test('금지어로 거절하면 원래 pre-commit 은 부르지 않는다', () => {
    assert.equal(installCommitCheck(wt).status, 'set')
    const pre = marker(join(proj, '.git', 'hooks'), 'pre-commit')
    assert.notEqual(commit(wt, 'doc.md', BANNED).status, 0)
    assert.equal(existsSync(pre), false)
  })

  test('공유 설정의 상대 core.hooksPath 는 워크트리 최상위 기준으로 푼다', () => {
    g(proj, 'config', '--local', 'core.hooksPath', '.hooks')
    assert.equal(installCommitCheck(wt).status, 'set')
    const pre = marker(join(wt, '.hooks'), 'pre-commit')
    const ignored = marker(join(proj, '.git', 'hooks'), 'commit-msg')
    assert.equal(g(wt, 'commit', '--allow-empty', '-m', 'husky').status, 0)
    assert.equal(readFileSync(pre, 'utf8'), 'pre-commit \n')
    assert.equal(existsSync(ignored), false)
  })

  test('실행 권한 없는 훅과 없는 훅 폴더는 지나간다', () => {
    g(proj, 'config', '--local', 'core.hooksPath', '.missing')
    assert.equal(installCommitCheck(wt).status, 'set')
    assert.equal(commit(wt, 'doc.md', CLEAN, 'missing dir').status, 0)
    g(proj, 'config', '--local', '--unset', 'core.hooksPath')
    put(join(proj, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', 0o644)
    assert.equal(commit(wt, 'doc2.md', CLEAN, 'not executable').status, 0)
  })

  test('shebang 없는 훅은 sh 로 부른다', () => {
    assert.equal(installCommitCheck(wt).status, 'set')
    const ran = join(tmp, 'ran-plain')
    put(join(proj, '.git', 'hooks', 'pre-commit'), `echo ran > '${ran}'\n`, 0o755)
    assert.equal(commit(wt, 'doc.md', CLEAN, 'plain').status, 0)
    assert.equal(readFileSync(ran, 'utf8'), 'ran\n')
  })

  test('pre-push 의 인자와 표준 입력이 원래 훅에 닿는다', () => {
    assert.equal(installCommitCheck(wt).status, 'set')
    const got = join(tmp, 'ran-pre-push')
    put(join(proj, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho "$@" > '${got}'\ncat >> '${got}'\n`, 0o755)
    const r = spawnSync(join(gitDir(wt), 'orch-hooks', 'pre-push'), ['origin', 'git@example.com:x/y.git'], { cwd: wt, input: 'refs/heads/a 1 refs/heads/a 0\n', encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(got, 'utf8'), 'origin git@example.com:x/y.git\nrefs/heads/a 1 refs/heads/a 0\n')
  })

  test('원래 훅이 이 훅을 다시 불러도 한 번만 돈다', () => {
    assert.equal(installCommitCheck(wt).status, 'set')
    const count = join(tmp, 'ran-count')
    put(join(proj, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho x >> '${count}'\nexec "$(git rev-parse --git-path hooks)/pre-commit" "$@"\n`, 0o755)
    const r = spawnSync('git', ['-C', wt, 'commit', '--allow-empty', '-m', 'chain'], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(count, 'utf8'), 'x\n')
  })

  test('원래 훅 폴더가 이 훅 폴더 자신이면 다시 부르지 않고 끝난다', () => {
    assert.equal(installCommitCheck(wt).status, 'set')
    g(proj, 'config', '--local', 'core.hooksPath', join(gitDir(wt), 'orch-hooks'))
    const r = spawnSync('git', ['-C', wt, 'commit', '--allow-empty', '-m', 'self'], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, r.stderr)
  })
})
