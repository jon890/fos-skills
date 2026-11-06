// implementation 의 plan_precheck 명령 경계 테스트. 임시 git 저장소와 bare origin, 가짜 gh 로 판정과 출력을 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', join(import.meta.dirname, '..', 'scripts', 'plan_precheck.ts')]
// ──

const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

type GhAnswer = { stdout?: string; code?: number }

// gh pr list --state open|merged 의 답을 정한다. 다른 호출은 실패한다
const GH_BODY = `const fs = require('node:fs')
const cfg = JSON.parse(fs.readFileSync(__filename + '.cfg.json', 'utf8'))
const argv = process.argv.slice(2)
const state = argv[argv.indexOf('--state') + 1]
const answer = cfg[state] || { code: 1 }
if (answer.stdout) process.stdout.write(answer.stdout)
process.exit(answer.code || 0)
`

function setup(t: { after(fn: () => void): void } | null = null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-precheck-')))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const gh = join(bin, 'gh')
  writeFileSync(gh, `#!${process.execPath}\n${GH_BODY}`)
  chmodSync(gh, 0o755)
  const answer = (open: GhAnswer, merged: GhAnswer = { stdout: '[]' }) => writeFileSync(`${gh}.cfg.json`, JSON.stringify({ open, merged }))
  answer({ stdout: '[]' })
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  const env = { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` }
  const git = (...args: string[]) => {
    const done = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' })
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
    return done.stdout.trim()
  }
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env })
  mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'origin', origin)
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }
  const commit = (message: string) => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
  }
  write('README.md', 'initial\n')
  commit('initial')
  git('push', '-q', 'origin', 'main')
  const run = (args: string[]) => {
    const done = spawnSync(COMMAND[0], [...COMMAND.slice(1), ...args], { env, encoding: 'utf8' })
    return { code: done.status, stdout: done.stdout, stderr: done.stderr }
  }
  const index = (dir: string, extra: Record<string, unknown> = {}) =>
    write(`${dir}/index.json`, JSON.stringify({ status: 'pending', current_phase: 1, total_phases: 1, ...extra }))
  return { root, repo, git, write, commit, run, answer, index }
}

const PENDING = '진행 가능. status=pending phase=1/1'

// plan001-x 브랜치에 계획서를 올린 상태
function planBranch(s: ReturnType<typeof setup>, opts: { push?: boolean; extra?: Record<string, unknown>; dir?: string } = {}) {
  const dir = opts.dir ?? 'tasks/plan001-x'
  s.git('checkout', '-q', '-b', 'plan001-x')
  s.index(dir, opts.extra)
  s.commit('plan')
  if (opts.push !== false) s.git('push', '-q', 'origin', 'plan001-x')
}

describe('판정과 출력', () => {
  test('올린 브랜치에 계획서만 있으면 진행 가능', () => {
    const s = setup()
    planBranch(s)
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, `plan001-x: ${PENDING}\n`, ''])
  })

  test('기준 브랜치는 origin HEAD 에서 읽는다', () => {
    const s = setup()
    planBranch(s)
    assert.equal(s.run(['plan001', '--repo', s.repo]).code, 0)
  })

  test('저장소 설정의 기준 브랜치를 쓰고 옛 이름 설정도 읽는다', () => {
    const s = setup()
    planBranch(s)
    s.git('config', 'build-with-teams.baseBranch', 'main')
    assert.equal(s.run(['plan001', '--repo', s.repo]).code, 0)
    s.git('config', 'implementation.baseBranch', 'nope-branch')
    const done = s.run(['plan001', '--repo', s.repo])
    assert.equal(done.code, 2)
    assert.match(done.stderr, /^검사를 돌리지 못했다: /)
  })

  test('origin/ 접두가 붙은 기준 브랜치도 같다', () => {
    const s = setup()
    planBranch(s)
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'origin/main'])
    assert.deepEqual([done.code, done.stdout], [0, `plan001-x: ${PENDING}\n`])
  })

  test('올리지 않은 브랜치는 진행 가능이고 안내 줄이 붙는다', () => {
    const s = setup()
    planBranch(s, { push: false })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout], [0, `plan001-x: ${PENDING}\n  - \`plan001-x\` 브랜치가 로컬에만 있다. push 전 브랜치로 보고 진행한다.\n`])
  })

  test('올리지 않은 브랜치에 구현 변경이 있으면 사용자 결정', () => {
    const s = setup()
    planBranch(s, { push: false })
    s.write('src/app.py', 'impl\n')
    s.commit('implementation')
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout], [1, 'plan001-x: 사용자 결정이 필요하다.\n  - 브랜치에 이미 구현 변경이 있다: src/app.py\n'])
  })

  test('구현 변경 여섯 개는 다섯 개와 외 N개로 낸다', () => {
    const s = setup()
    planBranch(s)
    for (const n of [1, 2, 3, 4, 5, 6]) s.write(`src/f${n}.py`, 'x\n')
    s.commit('implementation')
    s.git('push', '-q', 'origin', 'plan001-x')
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main'])
    assert.equal(done.stdout, 'plan001-x: 사용자 결정이 필요하다.\n  - 브랜치에 이미 구현 변경이 있다: src/f1.py, src/f2.py, src/f3.py, src/f4.py, src/f5.py 외 1개\n')
  })

  test('마크다운과 한글 경로의 문서는 구현이 아니다', () => {
    const s = setup()
    planBranch(s)
    s.write('docs/adr/ADR-132-스키마.md', 'adr\n')
    s.write('설명.md', 'readme\n')
    s.write('CLAUDE.md', 'x\n')
    s.commit('docs')
    s.git('push', '-q', 'origin', 'plan001-x')
    assert.equal(s.run(['plan001', '--repo', s.repo, '--base', 'main']).code, 0)
  })

  test('열린 PR 이 있으면 사용자 결정', () => {
    const s = setup()
    planBranch(s)
    s.answer({ stdout: JSON.stringify([{ number: 7, title: 'current work', url: 'u' }]) })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout], [1, 'plan001-x: 사용자 결정이 필요하다.\n  - 이 브랜치로 열린 PR 이 있다: #7 current work\n'])
  })

  test('gh pr list 가 실패하면 2', () => {
    const s = setup()
    planBranch(s)
    s.answer({ code: 1 })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stderr], [2, '검사를 돌리지 못했다: gh pr list 가 실패했다. 인증과 GH_HOST 를 확인한다.\n'])
  })

  test('완료된 계획은 두 가지로 알린다', () => {
    const s = setup()
    planBranch(s, { extra: { status: 'completed' } })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout], [
      1,
      'plan001-x: 사용자 결정이 필요하다.\n  - index.json 상태가 completed 다. 이미 끝난 plan 을 다시 도는 중일 수 있다.\n  - completed 인데 브랜치가 main 에 머지되지 않았다. 완료 표기가 실제와 어긋난다.\n',
    ])
  })

  test('취소된 계획은 사유를 낸다, 사유가 없으면 사유 없음', () => {
    const s = setup()
    planBranch(s, { extra: { status: 'cancelled', blocked_reason: '설계 변경' } })
    assert.equal(s.run(['plan001', '--repo', s.repo, '--base', 'main']).stdout, 'plan001-x: 사용자 결정이 필요하다.\n  - index.json 상태가 `cancelled` 다: 설계 변경\n')
    s.index('tasks/plan001-x', { status: 'failed' })
    s.commit('failed')
    s.git('push', '-q', 'origin', 'plan001-x')
    assert.equal(s.run(['plan001', '--repo', s.repo, '--base', 'main']).stdout, 'plan001-x: 사용자 결정이 필요하다.\n  - index.json 상태가 `failed` 다: 사유 없음\n')
  })

  test('완료인데 브랜치가 어디에도 없으면 머지 후 정리로 본다', () => {
    const s = setup()
    planBranch(s, { extra: { status: 'completed' } })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main', '--branch', 'gone'])
    assert.equal(
      done.stdout,
      'plan001-x: 사용자 결정이 필요하다.\n  - index.json 상태가 completed 다. 이미 끝난 plan 을 다시 도는 중일 수 있다.\n  - 원격에 `gone` 브랜치가 없다. 머지 후 정리된 것으로 보인다.\n',
    )
  })

  test('브랜치 이름이 다르면 사용자 결정', () => {
    const s = setup()
    planBranch(s)
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main', '--branch', 'plan/001-x'])
    assert.deepEqual([done.code, done.stdout], [1, 'plan001-x: 사용자 결정이 필요하다.\n  - 원격에 `plan/001-x` 브랜치가 없다. plan 이 push 하지 않았거나 브랜치 이름 형식이 다르다.\n'])
  })

  test('계획서가 로컬에 없고 브랜치에만 있으면 알린다', () => {
    const s = setup()
    s.git('checkout', '-q', '-b', 'plan002-y')
    s.index('tasks/plan002-y')
    s.commit('plan')
    s.git('push', '-q', 'origin', 'plan002-y')
    s.git('checkout', '-q', 'main')
    s.git('branch', '-q', '-D', 'plan002-y')
    const done = s.run(['plan002-y', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout], [1, 'plan002-y: 사용자 결정이 필요하다.\n  - task 가 로컬 tasks/ 에 없고 `plan002-y` 브랜치에만 있다.\n'])
  })

  test('지운 계획서는 이력에서 찾는다', () => {
    const s = setup()
    s.index('tasks/plan005-done')
    s.commit('add')
    s.git('rm', '-r', '-q', 'tasks/plan005-done')
    s.commit('delete')
    const sha = s.git('rev-parse', '--short', 'HEAD')
    const done = s.run(['plan005', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout], [1, `plan005-done: 사용자 결정이 필요하다.\n  - \`plan005-done\` 은 커밋 ${sha} 에서 지운 계획서다. 구현이 끝난 plan 을 다시 도는 중일 수 있다.\n`])
  })

  test('계획서 이력이 없어도 그 브랜치로 머지된 PR 이 있으면 알린다', () => {
    const s = setup()
    s.answer({ stdout: '[]' }, { stdout: JSON.stringify([{ number: 41, title: '로그인', url: 'u' }]) })
    const done = s.run(['plan/fe-027-login', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout], [1, 'plan/fe-027-login: 사용자 결정이 필요하다.\n  - `plan/fe-027-login` 브랜치로 머지된 PR 이 있다: #41 로그인. 구현을 마치고 계획서를 지운 뒤 squash 머지한 plan 일 수 있다.\n'])
  })

  test('머지된 PR 조회가 실패해도 처음 안내로 돌아간다', () => {
    const s = setup()
    s.index('tasks/plan006-live')
    s.commit('plan')
    s.answer({ stdout: '[]' }, { code: 1 })
    const done = s.run(['plan007', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', "검사를 돌리지 못했다: 'plan007' 의 index.json 을 로컬 tasks/ 에서도 원격 브랜치에서도 찾지 못했다. plan 을 먼저 돌린다.\n"])
  })

  test('번호가 비슷한 계획서를 잡지 않는다', () => {
    const s = setup()
    for (const name of ['plan002-beta', 'plan0020-gamma']) s.index(`tasks/${name}`)
    s.commit('plans')
    const done = s.run(['plan002', '--repo', s.repo, '--base', 'main', '--branch', 'zzz'])
    assert.match(done.stdout, /^plan002-beta: /)
    s.index('tasks/be-plan027-a')
    s.commit('prefixed')
    assert.equal(s.run(['plan027', '--repo', s.repo, '--base', 'main']).code, 2)
    assert.match(s.run(['be-plan027', '--repo', s.repo, '--base', 'main', '--branch', 'zzz']).stdout, /^be-plan027-a: /)
  })

  test('두 디렉터리가 맞으면 2 와 두 이름', () => {
    const s = setup()
    for (const name of ['plan008-a', 'plan008-b']) s.index(`tasks/${name}`)
    s.commit('plans')
    const done = s.run(['plan008', '--repo', s.repo, '--base', 'main'])
    assert.deepEqual([done.code, done.stderr], [2, "검사를 돌리지 못했다: 'plan008' 이 여러 디렉터리에 맞는다: plan008-a, plan008-b\n"])
  })

  test('index.json 이 깨졌으면 2', () => {
    const s = setup()
    s.write('tasks/plan009-x/index.json', '{')
    s.commit('plan')
    const done = s.run(['plan009', '--repo', s.repo, '--base', 'main'])
    assert.equal(done.code, 2)
    assert.match(done.stderr, /^검사를 돌리지 못했다: .*plan009-x\/index.json 를 읽지 못했다: /)
  })

  test('잘못된 기준 브랜치 이름은 2', () => {
    const s = setup()
    planBranch(s)
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'bad..name'])
    assert.equal(done.code, 2)
    assert.match(done.stderr, /^검사를 돌리지 못했다: git check-ref-format --branch bad\.\.name 실패/)
  })
})

describe('모노레포 경로', () => {
  test('--tasks-dir 와 --docs-dir 로 하위 프로젝트를 본다', () => {
    const s = setup()
    s.git('checkout', '-q', '-b', 'plan/fe-027-login')
    s.index('frontend/tasks/fe-plan027-login')
    s.write('frontend/docs/flow.md', 'x\n')
    s.write('frontend/src/app.ts', 'x\n')
    s.commit('plan')
    s.git('push', '-q', 'origin', 'plan/fe-027-login')
    const args = ['fe-plan027', '--repo', s.repo, '--base', 'main', '--branch', 'plan/fe-027-login']
    const found = s.run([...args, '--tasks-dir', 'frontend/tasks', '--docs-dir', 'frontend/docs'])
    assert.deepEqual([found.code, found.stdout], [1, 'fe-plan027-login: 사용자 결정이 필요하다.\n  - 브랜치에 이미 구현 변경이 있다: frontend/src/app.ts\n'])
    // 기본값에서는 하위 프로젝트의 docs 도 구현으로 센다
    s.git('rm', '-q', 'frontend/src/app.ts')
    s.write('frontend/docs/flow.ts', 'x\n')
    s.commit('code under docs')
    s.git('push', '-q', 'origin', 'plan/fe-027-login')
    const defaults = s.run([...args, '--tasks-dir', 'frontend/tasks'])
    assert.match(defaults.stdout, /구현 변경이 있다: frontend\/docs\/flow\.ts/)
  })

  test('옵션은 고유 접두로 줄이고 값을 =로 붙여도 된다', () => {
    const s = setup()
    s.git('checkout', '-q', '-b', 'plan/fe-027-login')
    s.index('frontend/tasks/fe-plan027-login')
    s.commit('plan')
    s.git('push', '-q', 'origin', 'plan/fe-027-login')
    const done = s.run(['fe-plan027', '--rep', s.repo, '--ba=main', '--br=plan/fe-027-login', '--ta', 'frontend/tasks', '--doc=frontend/docs', '--js'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(JSON.parse(done.stdout).task, join(s.repo, 'frontend/tasks/fe-plan027-login'))
  })
})

describe('--json', () => {
  test('사실을 들여쓴 JSON 으로 낸다', () => {
    const s = setup()
    planBranch(s)
    s.answer({ stdout: JSON.stringify([{ number: 7, title: '한글 제목', url: 'u' }]) })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main', '--json'])
    assert.equal(done.code, 1, done.stderr)
    const parsed = JSON.parse(done.stdout)
    assert.equal(done.stdout, `${JSON.stringify(parsed, null, 2)}\n`)
    assert.deepEqual(parsed, {
      task: join(s.repo, 'tasks/plan001-x'),
      found_in: '로컬',
      deleted_in: null,
      status: 'pending',
      total_phases: 1,
      current_phase: 1,
      branch: { branch: 'plan001-x', remote_exists: true, base: 'main', impl_files: [], has_impl_commits: false, merged_into_base: false },
      open_prs: [{ number: 7, title: '한글 제목', url: 'u' }],
      findings: ['이 브랜치로 열린 PR 이 있다: #7 한글 제목'],
      notes: [],
    })
    assert.deepEqual(Object.keys(parsed), ['task', 'found_in', 'deleted_in', 'status', 'total_phases', 'current_phase', 'branch', 'open_prs', 'findings', 'notes'])
  })

  test('계획서가 없을 때의 found_in 값', () => {
    const s = setup()
    s.index('tasks/plan005-done')
    s.commit('add')
    s.git('rm', '-r', '-q', 'tasks/plan005-done')
    s.commit('delete')
    const deleted = JSON.parse(s.run(['plan005', '--repo', s.repo, '--base', 'main', '--json']).stdout)
    assert.deepEqual([deleted.found_in, deleted.task, deleted.status, typeof deleted.deleted_in], ['지운 계획서', 'plan005-done', null, 'string'])
    s.answer({ stdout: '[]' }, { stdout: JSON.stringify([{ number: 41, title: 't', url: 'u' }]) })
    const merged = JSON.parse(s.run(['plan/x', '--repo', s.repo, '--base', 'main', '--json']).stdout)
    assert.deepEqual([merged.found_in, merged.task], ['머지된 PR', 'plan/x'])
  })
})

describe('--resume', () => {
  test('인계된 브랜치의 구현 변경과 열린 PR 을 허용한다', () => {
    const s = setup()
    planBranch(s)
    s.write('src/app.py', 'x\n')
    s.commit('impl')
    s.git('push', '-q', 'origin', 'plan001-x')
    s.answer({ stdout: JSON.stringify([{ number: 7, title: 'w', url: 'u' }]) })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main', '--branch', 'plan001-x', '--resume'])
    assert.deepEqual([done.code, done.stdout], [0, `plan001-x: ${PENDING}\n`])
  })

  test('--branch 없이 쓰면 사용법 오류 2', () => {
    const s = setup()
    planBranch(s)
    const done = s.run(['plan001', '--repo', s.repo, '--resume'])
    assert.equal(done.code, 2)
    assert.match(done.stderr, /--resume 은 인계된 --branch 를 명시해야 한다/)
  })

  test('머지된 PR 이 있으면 재개하지 않는다', () => {
    const s = setup()
    planBranch(s)
    s.answer({ stdout: '[]' }, { stdout: JSON.stringify([{ number: 7, title: 't', url: 'u' }]) })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main', '--branch', 'plan001-x', '--resume'])
    assert.deepEqual([done.code, done.stdout], [1, 'plan001-x: 사용자 결정이 필요하다.\n  - 이미 머지된 PR 의 계획은 재개하지 않는다: #7\n'])
  })

  test('머지된 PR 조회가 실패하면 2', () => {
    const s = setup()
    planBranch(s)
    s.answer({ stdout: '[]' }, { code: 1 })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main', '--branch', 'plan001-x', '--resume'])
    assert.deepEqual([done.code, done.stderr], [2, '검사를 돌리지 못했다: 재개할 브랜치의 머지된 PR 을 확인하지 못했다. gh 인증과 연결을 확인한다.\n'])
  })

  test('완료·취소 계획과 어긋난 단계는 재개해도 막는다', () => {
    const s = setup()
    planBranch(s, { extra: { current_phase: 3 } })
    const done = s.run(['plan001', '--repo', s.repo, '--base', 'main', '--branch', 'plan001-x', '--resume'])
    assert.equal(done.stdout, 'plan001-x: 사용자 결정이 필요하다.\n  - 재개는 pending 계획의 유효한 current_phase/total_phases 가 필요하다\n')
    s.index('tasks/plan001-x', { status: 'completed' })
    s.commit('done')
    s.git('push', '-q', 'origin', 'plan001-x')
    assert.equal(s.run(['plan001', '--repo', s.repo, '--base', 'main', '--branch', 'plan001-x', '--resume']).code, 1)
  })
})

describe('옵션', () => {
  test('모르는 옵션, 모호한 접두, 빠진 계획 이름은 사용법 오류 2', () => {
    const s = setup()
    planBranch(s)
    assert.equal(s.run(['plan001', '--nope']).code, 2)
    const ambiguous = s.run(['plan001', '--re'])
    assert.equal(ambiguous.code, 2)
    assert.equal(s.run([]).code, 2)
    assert.equal(s.run(['plan001', '--repo']).code, 2)
  })
})
