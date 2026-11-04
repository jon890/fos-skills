import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { conflicts, defaultBase, mainCheckout, repoArgProblem } from '../scripts/lib/git.ts'

// CI 에는 git 작성자 설정이 없어 커밋이 실패하고, 로컬의 전역 설정은 결과를 바꿀 수 있어 둘 다 고정한다.
// 라이브러리가 부르는 git 도 같은 값을 받도록 process.env 에 둔다. 테스트 파일마다 프로세스가 나뉘어 다른 파일에 새지 않는다.
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'orch-test',
  GIT_AUTHOR_EMAIL: 'orch-test@example.com',
  GIT_COMMITTER_NAME: 'orch-test',
  GIT_COMMITTER_EMAIL: 'orch-test@example.com',
}
const saved: Record<string, string | undefined> = {}

let tmp: string
let origin: string
let repo: string

function sh(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(done.status, 0, `git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

function commitFile(branch: string, file: string, body: string) {
  sh(repo, 'checkout', '-q', '-B', branch, 'trunk')
  writeFileSync(join(repo, file), body)
  sh(repo, 'add', file)
  sh(repo, 'commit', '-q', '-m', `${branch} ${file}`)
}

before(() => {
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-git-')))
  origin = join(tmp, 'origin.git')
  repo = join(tmp, 'repo')
  // 기본 브랜치를 main 이 아닌 trunk 로 두어 defaultBase 가 main 을 가정하지 않고 origin/HEAD 를 읽는지 본다.
  sh(tmp, 'init', '-q', '--bare', '-b', 'trunk', origin)
  sh(tmp, 'clone', '-q', origin, repo)
  writeFileSync(join(repo, 'a.txt'), 'line\n')
  sh(repo, 'add', 'a.txt')
  sh(repo, 'commit', '-q', '-m', 'init')
  sh(repo, 'push', '-q', '-u', 'origin', 'trunk')
  sh(repo, 'remote', 'set-head', 'origin', '-a')
  commitFile('one', 'a.txt', 'one\n')
  commitFile('two', 'a.txt', 'two\n')
  commitFile('other', 'b.txt', 'b\n')
  sh(repo, 'checkout', '-q', 'trunk')
})

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('defaultBase', () => {
  test('origin/HEAD 에서 origin/ 을 뗀 브랜치 이름을 낸다', () => {
    assert.equal(defaultBase(repo), 'trunk')
  })

  test('origin/HEAD 가 없는 저장소는 null 이다', () => {
    const lone = join(tmp, 'lone')
    sh(tmp, 'init', '-q', '-b', 'main', lone)
    assert.equal(defaultBase(lone), null)
  })
})

describe('repoArgProblem', () => {
  test('작업 트리와 그 하위 폴더는 받는다', () => {
    mkdirSync(join(repo, 'sub'), { recursive: true })
    assert.equal(repoArgProblem(repo), null)
    assert.equal(repoArgProblem(join(repo, 'sub')), null)
  })

  test('없는 경로가 owner/name 모양이면 로컬 경로라고 알린다', () => {
    const cwd = process.cwd()
    process.chdir(tmp)
    try {
      const got = repoArgProblem('jon890/fos-assistant')
      assert.match(got ?? '', /디렉터리가 아니다: jon890\/fos-assistant/)
      assert.match(got ?? '', /--repo 는 로컬 경로다/)
    } finally {
      process.chdir(cwd)
    }
  })

  test('없는 절대 경로, 파일, git 밖 폴더, bare 저장소는 이유를 낸다. 경로 모양이면 owner/name 안내는 없다', () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain, { recursive: true })
    const file = join(tmp, 'file.txt')
    writeFileSync(file, 'x\n')
    const saved = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = tmp
    try {
      assert.match(repoArgProblem(join(tmp, 'missing')) ?? '', /디렉터리가 아니다/)
      assert.match(repoArgProblem(file) ?? '', /디렉터리가 아니다/)
      assert.match(repoArgProblem(plain) ?? '', /git 작업 트리가 아니다/)
      assert.match(repoArgProblem(origin) ?? '', /git 작업 트리가 아니다/)
      assert.doesNotMatch(repoArgProblem(join(tmp, 'missing')) ?? '', /owner\/name/)
      assert.doesNotMatch(repoArgProblem('./missing/dir') ?? '', /owner\/name/)
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = saved
    }
  })
})

describe('mainCheckout', () => {
  test('워크트리에서 부르면 주 checkout 이다', () => {
    const wt = join(tmp, 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat', wt, 'trunk')
    assert.equal(mainCheckout(wt), repo)
    assert.equal(mainCheckout(repo), repo)
  })

  test('주 checkout 의 하위 폴더에서 불러도 주 checkout 이다', () => {
    const sub = join(repo, 'sub')
    mkdirSync(sub, { recursive: true })
    assert.equal(mainCheckout(sub), repo)
  })

  test('bare 저장소는 그 폴더다', () => {
    assert.equal(mainCheckout(origin), origin)
  })

  test('git 밖 폴더는 그 폴더다', () => {
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    assert.equal(mainCheckout(outside), outside)
  })
})

describe('conflicts', () => {
  test('다른 파일을 고친 두 브랜치는 충돌하지 않는다', () => {
    assert.deepEqual(conflicts(repo, 'one', 'other'), { ok: true, conflict: false, files: [] })
  })

  test('같은 줄을 고친 두 브랜치는 conflict: true 와 파일 목록이다', () => {
    assert.deepEqual(conflicts(repo, 'one', 'two'), { ok: true, conflict: true, files: ['a.txt'] })
  })

  test('없는 커밋을 주면 충돌이 아니라 ok: false 다', () => {
    // merge-tree 는 이때도 1 로 끝나 종료 코드만 보면 파일 없는 충돌로 읽힌다.
    const r = conflicts(repo, 'no-such-branch', 'one')
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', /no-such-branch/)
  })
})
