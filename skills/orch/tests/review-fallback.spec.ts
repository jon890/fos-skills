// 리뷰 봇 장애 때의 대체 리뷰(loop/steps/review-fallback.ts 머리 주석)를 순수 함수와 실제 틱 프로세스로 본다.
// 틱은 가짜 gh, orca 와 orch spec review, launch-worker 대역으로 돈다. GitHub 와 Orca 에는 닿지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { autoMergeConfig } from '../scripts/core/auto-merge.ts'
import type { Config } from '../scripts/core/config.ts'
import { ConfigError } from '../scripts/core/config.ts'
import { fallbackSpec, reviewOutage, reviewRunning, verdictSince } from '../scripts/core/review-fallback.ts'
import { GIT_ISOLATION } from '../../../modules/testkit/git.ts'

const T0 = '2026-11-20T01:51:00Z'
const after = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString()
const run = (conclusion: string, sec: number, startedAt = T0) => ({ __typename: 'CheckRun', name: 'claude-review', status: 'COMPLETED', conclusion, startedAt, completedAt: new Date(Date.parse(startedAt) + sec * 1000).toISOString(), detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2' })
const FALLBACK = { check: 'claude-review', failWithinSec: 120, passText: '판정: 머지 가능', blockText: '판정: 반영 필요' }

describe('reviewOutage', () => {
  test('기준 안에 실패로 끝난 리뷰 체크만 장애다', () => {
    assert.deepEqual(reviewOutage([run('FAILURE', 8)], 'claude-review', 120), { check: 'claude-review', sec: 8, url: 'https://github.com/o/r/actions/runs/1/job/2' })
    assert.equal(reviewOutage([run('FAILURE', 400)], 'claude-review', 120), null)
    assert.equal(reviewOutage([run('SUCCESS', 8)], 'claude-review', 120), null)
    assert.equal(reviewOutage([run('FAILURE', 8)], 'other', 120), null)
    assert.equal(reviewOutage([{ ...run('FAILURE', 8), startedAt: null }], 'claude-review', 120), null)
    assert.equal(reviewOutage(null, 'claude-review', 120), null)
  })

  test('다시 돌린 실행이 있으면 가장 늦게 시작한 것만 본다', () => {
    assert.equal(reviewOutage([run('FAILURE', 8), run('SUCCESS', 300, after(60))], 'claude-review', 120), null)
    assert.ok(reviewOutage([run('SUCCESS', 300), run('FAILURE', 5, after(600))], 'claude-review', 120))
  })
})

describe('reviewRunning', () => {
  const going = (status: string, startedAt = T0) => ({ __typename: 'CheckRun', name: 'claude-review', status, conclusion: null, startedAt })
  test('마지막 리뷰 체크가 끝나지 않았을 때만 도는 중이다', () => {
    assert.equal(reviewRunning([going('IN_PROGRESS')], 'claude-review'), true)
    assert.equal(reviewRunning([going('QUEUED')], 'claude-review'), true)
    assert.equal(reviewRunning([run('FAILURE', 8)], 'claude-review'), false)
    assert.equal(reviewRunning([going('IN_PROGRESS')], 'other'), false)
    assert.equal(reviewRunning([], 'claude-review'), false)
    assert.equal(reviewRunning(null, 'claude-review'), false)
  })

  test('다시 돌린 실행이 있으면 가장 늦게 시작한 것을 보고, StatusContext 는 state 로 본다', () => {
    assert.equal(reviewRunning([run('FAILURE', 8), going('IN_PROGRESS', after(60))], 'claude-review'), true)
    assert.equal(reviewRunning([going('IN_PROGRESS'), run('SUCCESS', 30, after(60))], 'claude-review'), false)
    assert.equal(reviewRunning([{ __typename: 'StatusContext', context: 'claude-review', state: 'PENDING' }], 'claude-review'), true)
    assert.equal(reviewRunning([{ __typename: 'StatusContext', context: 'claude-review', state: 'FAILURE' }], 'claude-review'), false)
  })
})

describe('verdictSince', () => {
  const rule = { pass: /^판정: 머지 가능/m, block: /^판정: 반영 필요/m }
  test('기준 시각 뒤에 판정 문구가 든 본문이 있을 때만 참이다', () => {
    assert.equal(verdictSince([{ body: '판정: 머지 가능', at: after(10) }], T0, rule), true)
    assert.equal(verdictSince([{ body: '판정: 반영 필요', at: after(10) }], T0, rule), true)
    assert.equal(verdictSince([{ body: '판정: 머지 가능', at: after(-10) }], T0, rule), false)
    assert.equal(verdictSince([{ body: '좋아 보인다', at: after(10) }], T0, rule), false)
    assert.equal(verdictSince([{ body: '판정: 머지 가능', at: '' }], T0, rule), false)
    assert.equal(verdictSince([{ body: '판정: 머지 가능', at: after(10) }], '', rule), false)
  })
})

const SPEC = [
  '# PR 리뷰 (PR #7)',
  '',
  '리뷰 PR: #7',
  '브랜치: `review/pr-7-fbabcdef12`',
  '허락: PR #7 에 COMMENT 리뷰를 등록하는 것은 사용자가 허락했다.',
  'worker 선택: `codex` `gpt-6.1-sol` effort `medium`. 행: review. 이유: 다른 제공자.',
  '',
  '## 배경',
  '',
  '- {{채울 것: PR 이 하는 일 한 줄}} ([PR #7](https://github.com/o/r/pull/7))',
  '',
  '## 특히 볼 것',
  '',
  '- {{채울 것: 리뷰어가 특히 볼 곳과 이유}}',
  '',
  '## 할 일',
  '',
  '1. 리뷰한다.',
  '',
  '## 완료 기준',
  '',
  '- 리뷰를 등록한다.',
  '',
].join('\n')

describe('fallbackSpec', () => {
  test('자리 둘을 채우고 허락 줄과 판정 댓글 절을 더한다', () => {
    const out = fallbackSpec(SPEC, { pr: 7, head: 'abcdef1234567890', outage: { check: 'claude-review', sec: 8, url: null }, fallback: FALLBACK })
    assert.ok(!out.includes('{{채울 것'))
    assert.match(out, /^- 리뷰 봇 `claude-review` 이 HEAD abcdef12 에서 시작 8초 만에 실패했다\(실행 장애로 본다\)/m)
    assert.match(out, /^허락: .* PR #7 에 판정 댓글 하나를 다는 것도 허락했다/m)
    assert.ok(out.indexOf('## 판정 댓글') < out.indexOf('## 완료 기준'))
    assert.match(out, /첫 줄은 차단\(P1, P2\)이 0건이면 `판정: 머지 가능`, 1건 이상이면 `판정: 반영 필요`/)
  })

  test('틀이 바뀌어 자리나 절이 없으면 던진다', () => {
    const opts = { pr: 7, head: 'abcdef12', outage: { check: 'c', sec: 1, url: null }, fallback: FALLBACK }
    assert.throws(() => fallbackSpec(SPEC.replace('- {{채울 것: 리뷰어가 특히 볼 곳과 이유}}', ''), opts), /채울 자리/)
    assert.throws(() => fallbackSpec(SPEC.replace('## 완료 기준', '## 끝'), opts), /완료 기준/)
  })
})

describe('queue.auto_review.fallback 설정', () => {
  const parse = (fallback: unknown, pass = '판정: 머지 가능', block = '판정: 반영 필요') => autoMergeConfig({ queue: { auto_review: { pass, block, fallback } } } as unknown as Config).review?.fallback
  test('기본값을 채우고 없으면 null 이다', () => {
    assert.deepEqual(parse({ check: 'claude-review' }), FALLBACK)
    assert.equal(parse(undefined), null)
    assert.deepEqual(parse({ check: 'r', fail_within_sec: 30, pass_text: 'LGTM', block_text: 'BLOCK' }, 'LGTM', 'BLOCK'), { check: 'r', failWithinSec: 30, passText: 'LGTM', blockText: 'BLOCK' })
  })
  test('판정 문구가 pass, block 정규식에 맞지 않거나 값이 틀리면 ConfigError 다', () => {
    for (const bad of [{}, { check: '' }, { check: 'r', fail_within_sec: 0 }, { check: 'r', typo: 1 }, { check: 'r', pass_text: 'ok' }, { check: 'r', block_text: 'no' }, 'r']) {
      assert.throws(() => parse(bad), ConfigError, JSON.stringify(bad))
    }
  })
})

describe('틱', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/loop/orch-loop.ts', import.meta.url))
  const PASSED = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }
  const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'

  function setup(t: { after: (fn: () => void) => void }, opts: { specFails?: boolean } = {}) {
    const root = tempDir('review-fallback-', t as never)
    const repo = join(root, 'repo')
    const orch = join(root, 'orch')
    const specs = join(root, 'specs')
    for (const dir of [repo, orch, specs]) mkdirSync(dir)
    writeFileSync(join(orch, 'config.json'), JSON.stringify({
      finish: { specs_dir: specs },
      queue: { required: ['test'], auto_review: { pass: '판정: 머지 가능', block: '판정: 반영 필요', fallback: { check: 'claude-review' } } },
    }))
    const reply = (data: unknown) => JSON.stringify({ ok: true, result: data })
    const orca = fakeBin(root, 'orca', [
      { args: ['send'], stdout: reply({ message: { id: 'n' } }) },
      { args: ['run-current'], stdout: reply({ run: null }) },
      { args: ['worker-list'], stdout: reply({ workers: [], page: {} }) },
      { args: ['task-list'], stdout: reply({ tasks: [] }) },
      { stdout: reply({ messages: [] }) },
    ])
    const gh = fakeBin(root, 'gh', [])
    const pr = (fields: { head?: string; draft?: boolean; rollup?: unknown[] } = {}) => gh.setRules([
      { args: ['api', 'user'], stdout: 'me' },
      { args: ['pr', 'list'], stdout: JSON.stringify([{ number: 7, title: 'PR 7', headRefName: 'feat-7', headRefOid: fields.head ?? HEAD, isCrossRepository: false, isDraft: fields.draft ?? false, author: { login: 'me' }, url: 'https://github.com/o/r/pull/7', baseRefName: 'main', statusCheckRollup: fields.rollup ?? [PASSED, run('FAILURE', 6)] }]) },
      { stdout: '[]' },
    ])
    pr()
    const noop = join(root, 'noop.ts')
    writeFileSync(noop, '')
    const reviewSpec = join(root, 'review-spec.ts')
    writeFileSync(reviewSpec, opts.specFails
      ? `console.log('REVIEW-SPEC-FAIL 구현 worker 를 이력에서 찾지 못했다')\nprocess.exitCode = 1\n`
      : `import { writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
writeFileSync(argv[argv.indexOf('--out') + 1], ${JSON.stringify(SPEC)})
console.log('REVIEW-SPEC ' + argv[argv.indexOf('--out') + 1])
`)
    const launched = join(root, 'launched.jsonl')
    const launcher = join(root, 'launch.ts')
    writeFileSync(launcher, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(launched)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`)
    const env: NodeJS.ProcessEnv = { ...process.env, ORCH_DIR: orch, ORCH_MACHINE_DIR: join(root, 'machine'), CODEX_BIN: join(root, 'no-codex'), CLAUDE_CONFIG_DIR: join(root, 'cfg'), ORCA: orca.path, GH: gh.path, CLEANUP_SWEEP: noop, BOARD_SYNC: noop, SEND_TO_WORKER: noop, REVIEW_SPEC: reviewSpec, LAUNCH_WORKER: launcher, ORCH_LOOP_BOUND: '{"run":null}', GIT_CEILING_DIRECTORIES: root, ...GIT_ISOLATION, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    delete env.NODE_OPTIONS
    const git = (cwd: string, ...args: string[]) => {
      const done = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
      assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
      return done.stdout.trim()
    }
    const once = () => {
      const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--run', 'r', '--foreground', '--once'], { env, encoding: 'utf8', timeout: 60_000 })
      assert.equal(done.status, 0, done.stdout + done.stderr)
      return readFileSync(join(orch, 'state', 'loop.log'), 'utf8')
    }
    // 띄운 launch-worker 의 인자. 분리 실행이라 count 개가 쌓이기를 잠깐 기다린다
    const launches = async (count = 1): Promise<string[][]> => {
      const read = () => (existsSync(launched) ? readFileSync(launched, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : [])
      for (let i = 0; i < 60 && read().length < count; i++) await new Promise((r) => setTimeout(r, 50))
      return read()
    }
    const notices = () => orca.calls().filter((call) => call.argv.includes('send')).map((call) => call.argv[call.argv.indexOf('--body') + 1] ?? '')
    const records = () => JSON.parse(readFileSync(join(orch, 'state', 'review-fallback.json'), 'utf8'))
    return { once, launches, notices, records, specs, root, repo, git, pr }
  }

  test('필수 체크가 통과했고 리뷰 봇이 몇 초 만에 실패하면 채운 리뷰 지시서로 worker 를 한 번 띄운다', async (t) => {
    const env = setup(t)
    assert.match(env.once(), /REVIEW-FALLBACK #7 claude-review 6초/)
    const [args] = await env.launches()
    const spec = join(env.specs, 'spec-review-pr-7-fbabcdef12.md')
    assert.deepEqual(args, ['--spec', spec, '--repo', args[3], '--name', 'review-pr-7-fbabcdef12', '--run', 'r', '--watch', '0', '--', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium'])
    assert.match(readFileSync(spec, 'utf8'), /## 판정 댓글/)
    assert.ok(env.notices().some((body) => body.includes('대체 리뷰 worker 를 띄웠다')))
    assert.equal(env.records()[`7@${HEAD}`].value, 'launched')
    // 같은 HEAD 에는 다시 띄우지 않는다
    assert.equal(env.once().match(/REVIEW-FALLBACK #7/g)?.length, 1)
    assert.equal((await env.launches(2)).length, 1)
  })

  test('필수 체크가 아직 돌거나, 리뷰 봇이 오래 돌다 실패했거나, draft 면 띄우지 않는다', async (t) => {
    const env = setup(t)
    env.pr({ rollup: [{ ...PASSED, status: 'IN_PROGRESS', conclusion: null }, run('FAILURE', 6)] })
    assert.doesNotMatch(env.once(), /REVIEW-FALLBACK/)
    env.pr({ rollup: [PASSED, run('FAILURE', 600)] })
    assert.doesNotMatch(env.once(), /REVIEW-FALLBACK/)
    env.pr({ draft: true })
    assert.doesNotMatch(env.once(), /REVIEW-FALLBACK/)
    assert.deepEqual(await env.launches(), [])
  })

  test('지시서를 만들지 못하면 REVIEW-FALLBACK-FAIL 을 한 번 알리고 기록한다', async (t) => {
    const env = setup(t, { specFails: true })
    assert.match(env.once(), /REVIEW-FALLBACK-FAIL #7 REVIEW-SPEC-FAIL 구현 worker 를 이력에서 찾지 못했다/)
    assert.ok(env.notices().some((body) => body.includes('대체 리뷰를 띄우지 못했다: REVIEW-SPEC-FAIL') && body.endsWith('독립 리뷰를 직접 맡긴다')))
    assert.equal(env.records()[`7@${HEAD}`].value, 'failed')
    env.once()
    assert.equal(env.notices().filter((body) => body.includes('대체 리뷰를 띄우지 못했다')).length, 1)
    assert.deepEqual(await env.launches(), [])
  })

  test('기준 브랜치 merge 만 더한 HEAD 에는 다시 띄우지 않고, 코드 커밋이 더해진 HEAD 에는 다시 띄운다', async (t) => {
    const env = setup(t)
    const origin = join(env.root, 'origin.git')
    env.git(env.root, 'init', '-q', '--bare', '-b', 'main', origin)
    env.git(env.repo, 'init', '-q', '-b', 'main')
    env.git(env.repo, 'remote', 'add', 'origin', origin)
    const commit = (file: string, body: string) => {
      writeFileSync(join(env.repo, file), body)
      env.git(env.repo, 'add', '-A')
      env.git(env.repo, 'commit', '-q', '-m', file)
    }
    commit('a.txt', 'a\n')
    env.git(env.repo, 'push', '-q', 'origin', 'main')
    env.git(env.repo, 'checkout', '-q', '-b', 'feat-7')
    commit('b.txt', 'b\n')
    env.git(env.repo, 'push', '-q', 'origin', 'feat-7')
    const first = env.git(env.repo, 'rev-parse', 'HEAD')
    env.pr({ head: first })
    env.once()
    assert.equal((await env.launches()).length, 1)
    // main 이 움직이고 PR 이 main 만 합쳤다
    env.git(env.repo, 'checkout', '-q', 'main')
    commit('c.txt', 'c\n')
    env.git(env.repo, 'push', '-q', 'origin', 'main')
    env.git(env.repo, 'checkout', '-q', 'feat-7')
    env.git(env.repo, 'merge', '-q', '--no-edit', 'main')
    env.git(env.repo, 'push', '-q', 'origin', 'feat-7')
    const merged = env.git(env.repo, 'rev-parse', 'HEAD')
    env.pr({ head: merged })
    assert.match(env.once(), new RegExp(`REVIEW-FALLBACK-SKIP #7 HEAD ${merged.slice(0, 8)}: 기준 브랜치 merge 만 더한 HEAD 라 ${first.slice(0, 8)} 의 대체 리뷰를 쓴다`))
    assert.equal(env.records()[`7@${merged}`].value, 'skipped')
    // 코드 커밋을 더하면 새 HEAD 를 다시 판정해 띄운다
    commit('d.txt', 'd\n')
    env.git(env.repo, 'push', '-q', 'origin', 'feat-7')
    const fixed = env.git(env.repo, 'rev-parse', 'HEAD')
    env.pr({ head: fixed })
    env.once()
    assert.equal(env.records()[`7@${fixed}`].value, 'launched')
    assert.equal((await env.launches(2)).length, 2)
  })
})
