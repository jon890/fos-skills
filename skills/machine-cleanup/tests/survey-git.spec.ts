// survey_git 의 명령 경계 테스트. 임시 저장소와 임시 origin 을 쓰고 gh, lsof, orca 는 가짜 실행 파일이다.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Repo, Sandbox } from './helpers.ts'

const short = (tip: string) => tip.slice(0, 8)

// 저장소 하나와 그 origin. 브랜치와 워크트리는 분류마다 하나씩 둔다. baseEpoch 가 있으면 첫 커밋의 시각이다
function build(box: Sandbox, root: string, name = 'a', baseEpoch?: number) {
  const origin = join(box.root, `${name}-origin.git`)
  const bare = new Repo(origin, false)
  bare.git('init', '-q', '--bare', '-b', 'main')
  const dir = join(root, name)
  const repo = new Repo(dir)
  repo.git('remote', 'add', 'origin', origin)
  const base = repo.commit('init', baseEpoch)
  repo.git('push', '-q', '-u', 'origin', 'main')
  repo.git('remote', 'set-head', 'origin', 'main')
  const tips: Record<string, string> = {}
  const pushed = (branch: string) => {
    repo.git('checkout', '-q', '-b', branch)
    tips[branch] = repo.commit(branch)
    repo.git('push', '-q', '-u', 'origin', branch)
    repo.git('checkout', '-q', 'main')
  }
  repo.git('branch', 'merged-br')
  repo.git('branch', 'release/1.0')
  for (const b of ['squash-br', 'diverged-br', 'err-br', 'gone-br', 'squash-wt']) pushed(b)
  repo.git('checkout', '-q', '-b', 'local-br')
  tips['local-br'] = repo.commit('local')
  repo.git('checkout', '-q', 'main')
  bare.git('branch', '-D', 'gone-br')
  const wts = join(box.root, `${name}-wts`)
  repo.git('worktree', 'add', '-q', '-b', 'wm', join(wts, 'wm'), 'main')
  repo.git('worktree', 'add', '-q', '-b', 'wd', join(wts, 'wd'), 'main')
  writeFileSync(join(wts, 'wd', 'untracked.txt'), 'x')
  repo.git('worktree', 'add', '-q', '-b', 'wu', join(wts, 'wu'), 'main')
  repo.git('worktree', 'add', '-q', join(wts, 'wsq'), 'squash-wt')
  repo.git('worktree', 'add', '-q', '-b', 'wp', join(wts, 'wp'), 'main')
  rmSync(join(wts, 'wp'), { recursive: true })
  return { origin, dir, repo, bare, base, tips, wts }
}

const prs = (...items: [number, string][]) => JSON.stringify(items.map(([number, headRefOid]) => ({ number, headRefOid })))

function standard(baseEpoch?: number) {
  const box = new Sandbox()
  const roots = join(box.root, 'roots')
  mkdirSync(roots)
  const fx = build(box, roots, 'a', baseEpoch)
  const gh = box.fake('gh', [
    { args: ['--head', 'squash-br'], stdout: prs([11, fx.tips['squash-br']]) },
    { args: ['--head', 'squash-wt'], stdout: prs([12, fx.tips['squash-wt']]) },
    { args: ['--head', 'diverged-br'], stdout: prs([13, 'f'.repeat(40)]) },
    { args: ['--head', 'err-br'], stderr: 'HTTP 502: bad gateway', code: 1 },
    { stdout: '[]' },
  ])
  box.fake('lsof', [{ stdout: `n${join(fx.wts, 'wu')}\nn/elsewhere\nn${join(fx.wts, 'wd')}/sub\n` }])
  box.fake('orca', [{ stdout: JSON.stringify({ result: { worktrees: [{ path: join(fx.wts, 'wm') }, { path: join(fx.wts, 'wsq') }, {}] } }) }])
  const run = (args: string[] = []) => box.run('survey_git', ['--roots', roots, ...args])
  // git worktree list 의 순서대로 linked worktree 경로
  const wtOrder = () =>
    fx.repo
      .git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice(9))
      .slice(1)
  const commitTs = (branch: string) => Number(fx.repo.git('log', '-1', '--format=%ct', branch))
  return { box, roots, fx, gh, run, wtOrder, commitTs }
}

describe('보고서', () => {
  const s = standard()
  const t = s.fx.tips
  const wtName = (p: string) => p.split('/').at(-1)!

  test('워크트리와 브랜치를 분류해 텍스트로 낸다', () => {
    const { fx, run, wtOrder } = s
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    const wtLine: Record<string, string> = {
      wm: `  [워크트리 제거 후보] orca ${join(fx.wts, 'wm')}  브랜치=wm 변경=0 stash=0 앞섬=0 경과=0일 사용중=False 끝=${short(fx.base)}`,
      wsq: `  [워크트리 제거 후보(PR 머지됨)] orca ${join(fx.wts, 'wsq')}  브랜치=squash-wt 변경=0 stash=0 앞섬=1 경과=0일 사용중=False 끝=${short(t['squash-wt'])}`,
      wp: `  [워크트리 기록만 남음] 비-orca ${join(fx.wts, 'wp')}  브랜치=wp 변경=0 stash=0 앞섬=None 경과=None일 사용중=False 끝=${short(fx.base)}`,
    }
    const expected = [
      `## ${fx.dir}  (기준 origin/main)`,
      ...wtOrder().map((p) => wtLine[wtName(p)]).filter(Boolean),
      `  [브랜치 PR 확인 필요(-D)] diverged-br  끝=${short(t['diverged-br'])}`,
      `  [브랜치 유지] err-br  끝=${short(t['err-br'])} gh확인실패`,
      `  [브랜치 PR 확인 필요(-D)] gone-br  끝=${short(t['gone-br'])}`,
      `  [브랜치 삭제 후보(-d)] merged-br  끝=${short(fx.base)}`,
      `  [브랜치 PR 머지됨(-D)] squash-br  끝=${short(t['squash-br'])}`,
      '',
      '## 합계 (저장소 1개 조사, 후보가 있는 저장소 1개)',
      '   1  브랜치 PR 머지됨(-D)',
      '   2  브랜치 PR 확인 필요(-D)',
      '   1  브랜치 삭제 후보(-d)',
      '   1  워크트리 기록만 남음',
      '   1  워크트리 제거 후보',
      '   1  워크트리 제거 후보(PR 머지됨)',
      '   1  gh 확인 실패',
    ]
    assert.equal(done.stdout, `${expected.join('\n')}\n`)
    assert.equal(done.stderr, `경고: gh 실패 ${fx.dir} err-br: HTTP 502: bad gateway\n`)
  })

  test('gh 는 저장소에서 머지된 PR 을 묻고 브랜치마다 한 번만 묻는다', () => {
    const { gh, run, fx } = s
    const before = gh.calls().length
    run()
    const calls = gh.calls().slice(before)
    assert.deepEqual(calls.map((c) => c.argv[3]).sort(), ['diverged-br', 'err-br', 'gone-br', 'squash-br', 'squash-wt'])
    assert.deepEqual(calls[0].argv.slice(0, 3), ['pr', 'list', '--head'])
    assert.deepEqual(calls[0].argv.slice(4), ['--state', 'merged', '--json', 'number,headRefOid'])
    assert.equal(calls[0].cwd, fx.dir)
  })

  test('--no-check-prs 는 gh 를 부르지 않고 합계에 gh 줄이 없다', () => {
    const { gh, run } = s
    const before = gh.calls().length
    const done = run(['--no-check-prs'])
    assert.equal(gh.calls().length, before)
    assert.ok(!done.stdout.includes('gh 확인 실패') && !done.stdout.includes('gh확인실패'))
    assert.ok(done.stdout.includes('  [브랜치 PR 확인 필요(-D)] gone-br  끝='))
    assert.ok(!done.stdout.includes('squash-br'))
    assert.ok(!done.stdout.includes('[워크트리 제거 후보(PR 머지됨)]'))
    assert.equal(done.stderr, '')
  })

  test('사용 중이거나 변경이 있는 워크트리는 후보가 아니다', () => {
    const out = s.run(['--no-check-prs']).stdout
    assert.ok(!out.includes(join(s.fx.wts, 'wu')))
    assert.ok(!out.includes(join(s.fx.wts, 'wd')))
  })

  test('--json 은 key 순서까지 옛 꼴로 낸다', () => {
    const { fx, run, wtOrder, commitTs } = s
    const done = run(['--json'])
    assert.equal(done.code, 0, done.stderr)
    const branch = (name: string, extra: Record<string, unknown>) => ({
      name,
      upstream_gone: false,
      commit_ts: commitTs(name),
      worktreepath: '',
      has_upstream: true,
      tip: name === 'merged-br' ? fx.base : t[name],
      merged: false,
      pr_state: null,
      class: '',
      ...extra,
    })
    const wt = (path: string, extra: Record<string, unknown>) => ({ path, branch: '', tip: '', prunable: false, orca: false, dirty: 0, stash: 0, in_use: false, merged: false, ahead: 0, age_days: 0, upstream_gone: false, pr_state: null, class: '', ...extra })
    const wtByName: Record<string, object> = {
      wm: wt(join(fx.wts, 'wm'), { branch: 'wm', tip: fx.base, orca: true, merged: true, class: '제거 후보' }),
      wsq: wt(join(fx.wts, 'wsq'), { branch: 'squash-wt', tip: t['squash-wt'], orca: true, ahead: 1, pr_state: 'merged', class: '제거 후보(PR 머지됨)' }),
      wp: wt(join(fx.wts, 'wp'), { branch: 'wp', tip: fx.base, prunable: true, ahead: null, age_days: null, class: '기록만 남음' }),
    }
    const expected = [
      {
        repo: fx.dir,
        base: 'origin/main',
        gh_errors: ['err-br'],
        worktrees: wtOrder().map((p) => wtByName[wtName(p)]).filter(Boolean),
        branches: [
          branch('diverged-br', { pr_state: 'diverged', class: 'PR 확인 필요(-D)' }),
          branch('err-br', { pr_state: 'error', class: '유지' }),
          branch('gone-br', { upstream_gone: true, class: 'PR 확인 필요(-D)' }),
          branch('merged-br', { has_upstream: false, merged: true, class: '삭제 후보(-d)' }),
          branch('squash-br', { pr_state: 'merged', class: 'PR 머지됨(-D)' }),
        ],
      },
    ]
    // worktreepath 는 git 이 채운다: 워크트리에 체크아웃된 브랜치만 경로를 갖고, 여기 보이는 브랜치는 모두 비어 있다
    assert.equal(done.stdout, `${JSON.stringify(expected, null, 2)}\n`)
  })

  test('--json-out 은 텍스트를 내면서 같은 조사를 파일에 쓴다', () => {
    const { box, run } = s
    const file = join(box.root, 'survey.json')
    const text = run(['--json-out', file])
    assert.ok(text.stdout.startsWith('## '))
    const json = run(['--json'])
    assert.equal(readFileSync(file, 'utf8'), json.stdout)
  })

  test('--json 과 --json-out 을 함께 주면 둘 다 JSON 이다', () => {
    const { box, run } = s
    const file = join(box.root, 'both.json')
    const json = run(['--json', '--json-out', file])
    assert.equal(readFileSync(file, 'utf8'), json.stdout)
  })

  test('--json-out 을 쓸 수 없으면 실패한다', () => {
    const { box, run } = s
    const done = run(['--json-out', join(box.root, 'no/such/dir/o.json')])
    assert.notEqual(done.code, 0)
  })
})

describe('fetch', () => {
  test('기본은 fetch --prune 이라 사라진 upstream 을 알아본다', () => {
    const s = standard()
    assert.ok(s.run().stdout.includes('[브랜치 PR 확인 필요(-D)] gone-br'))
  })

  test('--no-fetch 는 원격 ref 를 갱신하지 않는다', () => {
    const s = standard()
    const done = s.run(['--no-fetch'])
    assert.ok(!done.stdout.includes('gone-br'), done.stdout)
  })

  test('fetch 가 실패하면 경고하고 계속한다', () => {
    const box = new Sandbox()
    const roots = join(box.root, 'r')
    const repo = new Repo(join(roots, 'a'))
    repo.commit('init')
    repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'HEAD'))
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    repo.git('branch', 'merged-br')
    const done = box.run('survey_git', ['--roots', roots, '--no-check-prs'])
    assert.equal(done.code, 0)
    assert.match(done.stderr, new RegExp(`^경고: fetch 실패 ${join(roots, 'a')}: .+`))
    assert.ok(done.stdout.includes('[브랜치 삭제 후보(-d)] merged-br'))
  })
})

describe('경과 일수', () => {
  test('마지막 커밋 시각으로 정수 일을 센다', () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 86400 - 3600
    const s = standard(old)
    const out = s.run(['--no-check-prs']).stdout
    assert.ok(out.includes(`브랜치=wm 변경=0 stash=0 앞섬=0 경과=10일 사용중=False`), out)
  })
})

describe('저장소 찾기', () => {
  const repoAt = (dir: string) => {
    const repo = new Repo(dir)
    repo.commit('init')
    repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'HEAD'))
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    repo.git('branch', 'merged-br')
    return repo
  }
  const names = (stdout: string) => stdout.split('\n').filter((l) => l.startsWith('## ') && l.includes('(기준')).map((l) => l.slice(3, l.indexOf('  (기준')))

  test('깊이 3 까지 찾고 건너뛰는 폴더와 링크 폴더는 보지 않는다', () => {
    const box = new Sandbox()
    const r = join(box.root, 'r')
    const found = ['a', 'b/c', 'b/d/e'].map((p) => repoAt(join(r, p)).dir)
    repoAt(join(r, 'x/y/z/too-deep'))
    for (const skip of ['node_modules', 'worktrees', '.orca-worktree-trash']) repoAt(join(r, skip, 'inner'))
    repoAt(join(box.root, 'outside'))
    symlinkSync(join(box.root, 'outside'), join(r, 'link'))
    const done = box.run('survey_git', ['--roots', r, '--no-fetch', '--no-check-prs'])
    assert.deepEqual(names(done.stdout), found.sort())
    assert.ok(done.stdout.includes('## 합계 (저장소 3개 조사, 후보가 있는 저장소 3개)'))
  })

  test('저장소 안은 더 내려가지 않고 루트 자신이 저장소여도 찾는다', () => {
    const box = new Sandbox()
    const root = repoAt(join(box.root, 'top')).dir
    repoAt(join(root, 'nested'))
    const done = box.run('survey_git', ['--roots', root, '--no-fetch', '--no-check-prs'])
    assert.deepEqual(names(done.stdout), [root])
  })

  test('--roots 는 여러 값을 받고 겹쳐도 한 번만 세며 이름순으로 정렬한다', () => {
    const box = new Sandbox()
    const r = join(box.root, 'r')
    const z = repoAt(join(r, 'z')).dir
    const a = repoAt(join(r, 'a')).dir
    const done = box.run('survey_git', ['--roots', r, join(r, 'z'), '--no-fetch', '--no-check-prs'])
    assert.deepEqual(names(done.stdout), [a, z])
  })

  test('기본 roots 는 ~/projects 와 ~/personal 이고 ~ 는 홈으로 푼다', () => {
    const box = new Sandbox()
    const a = repoAt(join(box.home, 'projects', 'p')).dir
    const b = repoAt(join(box.home, 'personal', 'q')).dir
    const done = box.run('survey_git', ['--no-fetch', '--no-check-prs'])
    assert.deepEqual(names(done.stdout), [b, a].sort())
    const tilde = box.run('survey_git', ['--roots', '~/projects', '--no-fetch', '--no-check-prs'])
    assert.deepEqual(names(tilde.stdout), [a])
  })

  test('없는 roots 는 조용히 건너뛴다', () => {
    const box = new Sandbox()
    const done = box.run('survey_git', ['--roots', join(box.root, 'none'), '--no-fetch'])
    assert.equal(done.code, 0)
    assert.equal(done.stdout, '\n## 합계 (저장소 0개 조사, 후보가 있는 저장소 0개)\n   0  gh 확인 실패\n후보 없음\n')
  })

  test('기준 브랜치가 없는 저장소는 조사 개수에만 들고 보이지 않는다', () => {
    const box = new Sandbox()
    const r = join(box.root, 'r')
    const repo = new Repo(join(r, 'nobase'), false)
    repo.git('init', '-q', '-b', 'trunk')
    repo.commit('init')
    const done = box.run('survey_git', ['--roots', r, '--no-fetch', '--no-check-prs'])
    assert.equal(done.stdout, '\n## 합계 (저장소 1개 조사, 후보가 있는 저장소 0개)\n후보 없음\n')
  })

  test('기준은 origin/HEAD, origin/main, origin/master, main, master 순으로 찾는다', () => {
    const box = new Sandbox()
    const r = join(box.root, 'r')
    const mk = (name: string, setup: (repo: Repo) => void) => {
      const repo = new Repo(join(r, name))
      repo.commit('init')
      setup(repo)
      repo.git('branch', 'merged-br')
      return repo.dir
    }
    const head = mk('head', (repo) => {
      repo.git('update-ref', 'refs/remotes/origin/dev', repo.git('rev-parse', 'HEAD'))
      repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev')
    })
    const om = mk('om', (repo) => repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'HEAD')))
    const omaster = mk('omaster', (repo) => repo.git('update-ref', 'refs/remotes/origin/master', repo.git('rev-parse', 'HEAD')))
    const local = mk('local', () => {})
    const done = box.run('survey_git', ['--roots', r, '--no-fetch', '--no-check-prs'])
    const bases = Object.fromEntries(done.stdout.split('\n').filter((l) => l.includes('(기준')).map((l) => [l.slice(3, l.indexOf('  (기준')), l.slice(l.indexOf('(기준 ') + 4, -1)]))
    assert.deepEqual([bases[head], bases[om], bases[omaster], bases[local]], ['origin/dev', 'origin/main', 'origin/master', 'main'])
  })
})

describe('옵션', () => {
  test('--gh-timeout 은 정수여야 하고 줄임과 =값을 받는다', () => {
    const box = new Sandbox()
    const base = ['--roots', join(box.root, 'none'), '--no-fetch']
    assert.equal(box.run('survey_git', [...base, '--gh-timeout', '5']).code, 0)
    assert.equal(box.run('survey_git', [...base, '--gh=5']).code, 0)
    assert.equal(box.run('survey_git', [...base, '--gh-timeout', '5.5']).code, 2)
    assert.equal(box.run('survey_git', [...base, '--gh-timeout']).code, 2)
  })

  test('--fetch 와 --check-prs 는 받기만 하고 --no- 가 이긴다', () => {
    const s = standard()
    const base = ['--roots', s.roots]
    assert.equal(s.box.run('survey_git', [...base, '--fetch', '--check-prs']).code, 0)
    const off = s.box.run('survey_git', [...base, '--fetch', '--check-prs', '--no-fetch', '--no-check-prs'])
    assert.equal(off.stderr, '')
    assert.ok(!off.stdout.includes('gh 확인 실패'))
  })

  test('모호한 접두와 모르는 옵션은 사용법 오류 2 다', () => {
    const box = new Sandbox()
    for (const args of [['--no'], ['--nope'], ['--roots'], ['--json=1'], ['extra']]) {
      const done = box.run('survey_git', args)
      assert.equal(done.code, 2, args.join(' '))
    }
    const ambiguous = box.run('survey_git', ['--no'])
    assert.ok(ambiguous.stderr.includes('ambiguous option: --no could match --no-fetch, --no-check-prs'), ambiguous.stderr)
    assert.equal(box.run('survey_git', ['--roots', join(box.root, 'none'), '--no-f', '--no-c']).code, 0)
  })

  test('--roots 는 위치 인자처럼 값을 먹고 다음 옵션에서 끊긴다', () => {
    const box = new Sandbox()
    const done = box.run('survey_git', ['--roots', join(box.root, 'n1'), join(box.root, 'n2'), '--no-fetch'])
    assert.equal(done.code, 0)
    assert.equal(box.run('survey_git', ['--roots', '--', join(box.root, 'n1')]).code, 2)
  })

  test('-h 는 도움말을 내고 0 이다', () => {
    const box = new Sandbox()
    const done = box.run('survey_git', ['-h'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('usage: '))
  })
})
