// make-worktree.ts 와 worktree-deny.ts 를 실제 git 저장소로 본다. 원격은 로컬 bare 저장소다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/make-worktree.ts', import.meta.url))
const DENY_SCRIPT = fileURLToPath(new URL('../scripts/worktree-deny.ts', import.meta.url))
const DENY = ['Bash(pkill:*)', 'Bash(killall:*)', 'Bash(gh pr merge:*)']

let tmp: string
let origin: string
let repo: string
let spec: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'make-worktree-')))
  // 사용자의 전역 ignore(~/.config/git/ignore)가 설정 파일을 무시하면 결과가 머신마다 달라진다.
  // make-worktree 가 worktree-deny 를 PATH 의 node 로 부르므로 이 테스트의 node 폴더를 앞에 둔다.
  env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: tmp,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    // 실제 Orca 를 부르지 않는다
    ORCA: join(tmp, 'no-orca'),
  }
  origin = join(tmp, 'repo-origin.git')
  repo = join(tmp, 'repo')
  git('init', '-q', '--bare', '-b', 'main', origin)
  git('clone', '-q', origin, repo)
  git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git('-C', repo, 'push', '-q', '-u', 'origin', 'main')
  spec = join(tmp, 'spec-x.md')
  writeFileSync(spec, '# 지시서\n\n대상 저장소: `owner/repo`.\n브랜치: `feature/x`(최신 origin/main 에서).\n')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function git(...args: string[]): string {
  const done = spawnSync('git', args, { env, encoding: 'utf8' })
  assert.equal(done.status, 0, `git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

function gitCode(...args: string[]): number | null {
  return spawnSync('git', args, { env, encoding: 'utf8' }).status
}

function node(script: string, args: string[]) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env, encoding: 'utf8' })
}

function runScript(args: string[], code = 0): string {
  const done = node(SCRIPT, args)
  assert.equal(done.status, code, done.stdout + done.stderr)
  return done.stdout + done.stderr
}

function make(extra: string[] = [], code = 0): string {
  return runScript(['--repo', repo, '--spec', spec, '--name', 'x', ...extra], code)
}

const wt = () => join(repo, 'worktrees', 'repo', 'x')

function fakeOrca(visibility: string): void {
  const fake = join(tmp, 'fake-orca')
  writeFileSync(fake, `#!/bin/sh\necho '{"result":{"repo":{"externalWorktreeVisibility":"${visibility}"}}}'\n`)
  chmodSync(fake, 0o755)
  env.ORCA = fake
}

function addToExclude(line: string): void {
  const exclude = join(repo, '.git/info/exclude')
  writeFileSync(exclude, `${readFileSync(exclude, 'utf8')}${line}\n`)
}

function settings(): { model?: string; permissions: { allow?: string[]; deny: string[] } } {
  return JSON.parse(readFileSync(join(wt(), '.claude/settings.local.json'), 'utf8'))
}

describe('워크트리 만들기', () => {
  test('지시서 브랜치를 최신 origin 기준 위에 upstream 없이 만든다', () => {
    const other = join(tmp, 'other')
    git('clone', '-q', origin, other)
    git('-C', other, 'commit', '-q', '--allow-empty', '-m', 'newer')
    git('-C', other, 'push', '-q', 'origin', 'main')
    const r = node(SCRIPT, ['--repo', repo, '--spec', spec, '--name', 'x', '--base', 'origin/main'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), wt())
    assert.equal(git('-C', wt(), 'branch', '--show-current'), 'feature/x')
    assert.equal(git('-C', wt(), 'rev-parse', 'HEAD'), git('-C', other, 'rev-parse', 'HEAD'))
    // push 전에는 upstream 이 없다. 있으면 gone 으로 보여 정리 스크립트가 머지된 것으로 읽는다
    assert.notEqual(gitCode('-C', wt(), 'rev-parse', '@{u}'), 0)
    assert.equal(git('-C', repo, 'status', '--porcelain'), '')
  })

  test('외부 워크트리를 숨기는 저장소는 만들기 전에 거부한다', () => {
    fakeOrca('hide')
    const out = make([], 1)
    assert.match(out, /externalWorktreeVisibility 가 hide/)
    assert.ok(out.includes(`orca repo set --repo path:${repo} --external-worktree-visibility show`), out)
    assert.equal(existsSync(join(repo, 'worktrees')), false)
    assert.equal(git('-C', repo, 'branch', '--list', 'feature/x'), '')
  })

  test('보이거나 읽지 못한 표시 설정이면 이어 간다', () => {
    fakeOrca('show')
    make()
    assert.ok(existsSync(wt()))
  })

  test('--resume-remote 는 원격 끝에서 만들고 upstream 을 건다', () => {
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'PR latest')
    git('-C', repo, 'push', '-q', 'origin', 'HEAD:feature/x')
    make(['--resume-remote'])
    assert.equal(git('-C', wt(), 'rev-parse', 'HEAD'), git('-C', repo, 'rev-parse', 'origin/feature/x'))
    assert.notEqual(git('-C', wt(), 'rev-parse', 'HEAD'), git('-C', repo, 'rev-parse', 'origin/main'))
    assert.equal(git('-C', wt(), 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/x')
    assert.equal(git('-C', repo, 'status', '--porcelain'), '')
  })

  test('--resume-remote 는 원격 브랜치가 없으면 거부한다', () => {
    assert.match(make(['--resume-remote'], 1), /이어 받을 원격 브랜치/)
    assert.equal(existsSync(wt()), false)
  })

  test('--resume-remote 는 로컬 브랜치를 덮어쓰지 않는다', () => {
    git('-C', repo, 'push', '-q', 'origin', 'HEAD:feature/x')
    git('-C', repo, 'branch', 'feature/x')
    assert.match(make(['--resume-remote'], 1), /로컬 브랜치/)
  })

  test('--resume-remote 는 지워진 원격 브랜치의 낡은 tracking ref 를 믿지 않는다', () => {
    git('-C', repo, 'push', '-q', 'origin', 'HEAD:feature/x')
    git('-C', repo, 'fetch', 'origin')
    git('--git-dir', origin, 'update-ref', '-d', 'refs/heads/feature/x')
    git('-C', repo, 'rev-parse', '--verify', 'origin/feature/x')
    assert.match(make(['--resume-remote'], 1), /이어 받을 원격 브랜치/)
    assert.equal(existsSync(wt()), false)
    assert.notEqual(gitCode('-C', repo, 'rev-parse', '--verify', 'feature/x'), 0)
  })

  test('로컬 설정을 복사한다', () => {
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(repo, '.claude/settings.local.json'), '{}')
    addToExclude('/.claude/')
    make()
    assert.ok(existsSync(join(wt(), '.claude/settings.local.json')))
  })

  test('기존 원격 브랜치는 거부한다', () => {
    git('-C', repo, 'push', '-q', 'origin', 'main:feature/x')
    assert.match(make([], 1), /origin\/feature\/x/)
    assert.equal(existsSync(wt()), false)
  })

  test('기존 로컬 브랜치는 거부한다', () => {
    git('-C', repo, 'branch', 'feature/x')
    make([], 1)
  })

  test('이미 있는 경로는 거부한다', () => {
    mkdirSync(wt(), { recursive: true })
    assert.match(make([], 1), /경로가 이미 있다/)
  })
})

describe('deny 규칙', () => {
  test('새 워크트리에 다른 worker 의 자원을 빼앗는 명령을 막는 규칙을 둔다', () => {
    make()
    assert.deepEqual(settings().permissions.deny, DENY)
    // 새로 만든 설정 파일 때문에 워크트리가 dirty 해지면 remove-worktree 가 거부한다
    assert.equal(git('-C', wt(), 'status', '--porcelain'), '')
  })

  test('복사한 설정의 키는 남기고 없는 규칙만 한 번 더한다', () => {
    mkdirSync(join(repo, '.claude'))
    writeFileSync(
      join(repo, '.claude/settings.local.json'),
      JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(pkill:*)'] } }),
    )
    addToExclude('/.claude/')
    make()
    const again = node(DENY_SCRIPT, [wt()])
    assert.equal(again.status, 0, again.stderr)
    const got = settings()
    assert.equal(got.model, 'opus')
    assert.deepEqual(got.permissions.allow, ['Bash(ls:*)'])
    assert.deepEqual(got.permissions.deny, DENY)
  })

  test('새 워크트리에 browser-driver reset 의 deny 규칙을 두지 않는다', () => {
    make()
    assert.ok(!settings().permissions.deny.includes('Bash(browser-driver reset:*)'))
  })

  test('이미 있는 browser-driver reset deny 줄만 지우고 나머지는 그대로 둔다', () => {
    make()
    const file = join(wt(), '.claude/settings.local.json')
    const stale = { model: 'opus', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(pkill:*)', 'Bash(browser-driver reset:*)', 'Bash(rm:*)'] } }
    writeFileSync(file, JSON.stringify(stale))
    const done = node(DENY_SCRIPT, [wt()])
    assert.equal(done.status, 0, done.stderr)
    const got = settings()
    assert.equal(got.model, 'opus')
    assert.deepEqual(got.permissions.allow, ['Bash(ls:*)'])
    assert.deepEqual(got.permissions.deny, ['Bash(pkill:*)', 'Bash(rm:*)', 'Bash(killall:*)', 'Bash(gh pr merge:*)'])
    // 두 번째는 바꾸지 않는다
    const before = readFileSync(file, 'utf8')
    assert.equal(node(DENY_SCRIPT, [wt()]).status, 0)
    assert.equal(readFileSync(file, 'utf8'), before)
  })

  test('git 이 추적하는 설정 파일은 고치지 않는다', () => {
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(repo, '.claude/settings.local.json'), '{}\n')
    git('-C', repo, 'add', '.claude/settings.local.json')
    git('-C', repo, 'commit', '-q', '-m', 'track settings')
    const done = node(DENY_SCRIPT, [repo])
    assert.equal(done.status, 1, done.stderr)
    assert.equal(readFileSync(join(repo, '.claude/settings.local.json'), 'utf8'), '{}\n')
  })

  test('깨진 JSON 과 객체가 아닌 설정, 사용법 오류는 2 다', () => {
    const dir = join(tmp, 'plain')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    for (const body of ['{broken', '[]', '{"permissions": []}', '{"permissions": {"deny": "x"}}']) {
      writeFileSync(join(dir, '.claude/settings.local.json'), body)
      const done = node(DENY_SCRIPT, [dir])
      assert.equal(done.status, 2, `${body}: ${done.stderr}`)
      assert.equal(readFileSync(join(dir, '.claude/settings.local.json'), 'utf8'), body)
    }
    assert.equal(node(DENY_SCRIPT, []).status, 2)
    assert.equal(node(DENY_SCRIPT, ['a', 'b']).status, 2)
  })
})

describe('지시서의 브랜치 줄', () => {
  test('브랜치 줄이 없으면 사용법 오류다', () => {
    writeFileSync(spec, '# 지시서\n\n브랜치 이름은 아직 없다.\n')
    assert.match(make([], 2), /브랜치/)
    assert.equal(existsSync(join(repo, 'worktrees')), false)
  })

  test('문장 안의 언급은 브랜치 줄이 아니다', () => {
    writeFileSync(spec, '# 지시서\n\n배경: 앞 작업은 브랜치: `feature/old` 에서 했다.\n\n- **브랜치**: `feature/x`\n')
    make()
    assert.equal(git('-C', wt(), 'branch', '--show-current'), 'feature/x')
  })

  test('줄 머리 브랜치 줄이 둘이면 사용법 오류다', () => {
    writeFileSync(spec, '# 지시서\n\n브랜치: `feature/a`\n  - 브랜치: `feature/b`\n')
    const out = make([], 2)
    assert.match(out, /feature\/a/)
    assert.match(out, /feature\/b/)
    assert.equal(existsSync(join(repo, 'worktrees')), false)
  })

  test('문장 안의 언급만 있으면 사용법 오류다', () => {
    writeFileSync(spec, '# 지시서\n\n앞 작업은 브랜치: `feature/old` 에서 했다.\n')
    make([], 2)
  })

  test('올바르지 않은 브랜치 이름과 없는 지시서, 빠진 옵션은 사용법 오류다', () => {
    writeFileSync(spec, '브랜치: `bad..name`\n')
    assert.match(make([], 2), /올바르지 않다/)
    assert.match(runScript(['--repo', repo, '--spec', join(tmp, 'none.md'), '--name', 'x'], 2), /지시서가 없다/)
    writeFileSync(spec, '브랜치: `feature/x`\n')
    assert.match(runScript(['--spec', spec, '--name', 'x'], 2), /--repo 와 --name/)
    runScript(['--repo', repo, '--name', 'x'], 2)
  })
})

describe('--check', () => {
  test('같은 이름으로 push 했으면 일치다', () => {
    make()
    git('-C', wt(), 'commit', '-q', '--allow-empty', '-m', 'work')
    git('-C', wt(), 'push', '-q', '-u', 'origin', 'HEAD')
    assert.match(runScript(['--check', wt(), '--spec', spec]), /일치: feature\/x/)
  })

  test('다른 원격 브랜치로 push 했으면 불일치다', () => {
    make()
    git('-C', wt(), 'commit', '-q', '--allow-empty', '-m', 'work')
    git('-C', wt(), 'push', '-q', '-u', 'origin', 'HEAD:dev/x')
    assert.match(runScript(['--check', wt(), '--spec', spec], 1), /upstream origin\/dev\/x/)
  })

  test('push 전이면 불일치다', () => {
    make()
    assert.match(runScript(['--check', wt(), '--spec', spec], 1), /\(없음\)/)
  })
})
