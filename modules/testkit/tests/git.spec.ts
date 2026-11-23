import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { copyRepo, git, GIT_CONFIG_FILE, gitEnv, templateRepo } from '../git.ts'
import { tempDir } from '../temp.ts'

describe('git 도우미', () => {
  it('gitEnv 아래 커밋의 작성자가 testkit 값이다', () => {
    const { dir } = copyRepo(join(tempDir(), 'r'))
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'x'])
    assert.equal(git(dir, ['log', '-1', '--format=%an%n%ae']), 't\nt@example.com')
  })

  it('base env 의 전역 설정을 덮어 무시한다', () => {
    const root = tempDir()
    const cfg = join(root, 'gitconfig')
    writeFileSync(cfg, '[user]\n\tname = leak\n')
    const env = gitEnv({ ...process.env, GIT_CONFIG_GLOBAL: cfg })
    assert.equal(env.GIT_CONFIG_GLOBAL, GIT_CONFIG_FILE)
    const { dir } = copyRepo(join(root, 'r'))
    assert.throws(() => git(dir, ['config', 'user.name'], env), /실패 \(종료 1\)/)
  })

  it('gitEnv 아래 commit 과 push 받는 쪽 모두 자동 정리를 백그라운드로 돌리지 않는다', () => {
    const root = tempDir()
    const { dir } = copyRepo(join(root, 'r'))
    const trace = join(root, 'trace.json')
    const env = { ...gitEnv(), GIT_TRACE2_EVENT: trace }
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'x'], env)
    git(dir, ['push', '-q', 'origin', 'main'], env)
    // 자동 정리 명령 줄만 모은다. 로컬 push 는 receive-pack 의 환경에서 GIT_CONFIG_COUNT 를 지워 그 방식으로는 받는 쪽에 닿지 않았다
    const runs = readFileSync(trace, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((e) => e.event === 'start' && e.argv?.includes('maintenance'))
      .map((e) => e.argv!.slice(1).join(' '))
    assert.ok(runs.length >= 2, runs.join('\n'))
    assert.ok(runs.every((r) => r.includes('--no-detach')), runs.join('\n'))
  })

  it('호출자가 넘긴 GIT_CONFIG_COUNT 설정을 그대로 둔다', () => {
    const { dir } = copyRepo(join(tempDir(), 'r'))
    const env = gitEnv({ ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x.y', GIT_CONFIG_VALUE_0: 'z' })
    assert.equal(git(dir, ['config', '--get', 'x.y'], env), 'z')
  })

  it('ceiling 을 주면 GIT_CEILING_DIRECTORIES 를 건다', () => {
    assert.equal(gitEnv({}, { ceiling: '/x' }).GIT_CEILING_DIRECTORIES, '/x')
    assert.equal(gitEnv({}).GIT_CEILING_DIRECTORIES, undefined)
  })

  it('templateRepo 는 같은 값을 돌려준다', () => {
    assert.equal(templateRepo(), templateRepo())
  })

  it('copyRepo 두 번이 서로 다른 origin 을 가리키고 push 는 자기 origin 에만 들어간다', () => {
    const root = tempDir()
    const a = copyRepo(join(root, 'a'))
    const b = copyRepo(join(root, 'b'))
    assert.notEqual(a.origin, b.origin)
    assert.equal(git(a.dir, ['remote', 'get-url', 'origin']), a.origin)
    git(a.dir, ['commit', '-q', '--allow-empty', '-m', 'only-a'])
    git(a.dir, ['push', '-q', 'origin', 'main'])
    assert.match(git(a.origin, ['log', '-1', '--format=%s', 'main']), /only-a/)
    assert.equal(git(b.origin, ['log', '-1', '--format=%s', 'main']), 'init')
  })

  it('실패한 명령은 stderr 를 담아 던진다', () => {
    const { dir } = copyRepo(join(tempDir(), 'r'))
    assert.throws(() => git(dir, ['rev-parse', '--verify', 'nope']), /nope/)
  })
})
