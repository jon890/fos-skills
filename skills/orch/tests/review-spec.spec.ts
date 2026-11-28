// orch spec review: 리뷰 worker 지시서를 PR 번호로 만든다. 가짜 gh 와 임시 영구 이력으로 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin, type FakeBin } from './fixtures/fake-bin.ts'
import { BOT_SETTING } from './fixtures/codex-review.ts'
import { recordHistory, type LaunchHistory } from '../scripts/lib/launch-history.ts'
import { fillReviewSpec, implementerOf, reviewBranchFor, reviewerFor, unfilled } from '../scripts/lib/review-spec.ts'
import { reviewPrOfSpec } from '../scripts/lib/review.ts'
import { selectionsOf } from '../scripts/lib/spec.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/spec/review-spec.ts', import.meta.url))
const LINT = fileURLToPath(new URL('../scripts/spec/spec-lint.ts', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../templates/spec-review.md', import.meta.url))
let repo: string, specs: string, gh: FakeBin, env: NodeJS.ProcessEnv
const VIEW = { number: 262, title: 'fix: 변경 조각 형식을 검사한다', url: 'https://github.com/o/r/pull/262', headRefName: 'fix/precommit', state: 'OPEN' }

const row = (dispatch: string, branch: string, agent: string, at: string, extra: Partial<LaunchHistory> = {}): LaunchHistory => ({
  dispatch, terminal: null, worktree: repo, run: 'R', branch, agent, model: agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', effort: 'medium',
  at, title: null, row: null, retry_of: null, ...extra,
})

beforeEach(t => {
  repo = tempDir('review-spec-', t)
  specs = join(repo, 'specs'); mkdirSync(specs)
  spawnSync('git', ['init', '-q', repo])
  gh = fakeBin(repo, 'gh', [{ args: ['view'], stdout: JSON.stringify(VIEW) }])
  env = { ...process.env, ORCH_DIR: join(repo, '.orch'), GIT_CEILING_DIRECTORIES: repo, GH: gh.path, ORCH_GH_CACHE: '0' }
})
afterEach(() => {})

function make(...args: string[]) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--specs-dir', specs, ...args], { env, encoding: 'utf8', timeout: 60_000 })
  return { code: done.status, stdout: done.stdout.trim(), stderr: done.stderr }
}
const file = () => join(specs, 'spec-review-pr-262.md')

test('믿는 봇을 설정하면 봇 이름을 보여 주며 코디네이터가 요청하면 리뷰 지시서를 만든다', () => {
  mkdirSync(join(repo, '.orch'), { recursive: true })
  const auto_review = { pass: 'PASS', block: 'BLOCK', trusted_bots: [BOT_SETTING] }
  writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ queue: { auto_review } }))
  const waiting = make('262', '--force')
  assert.equal(waiting.code, 0, waiting.stdout + waiting.stderr)
  assert.match(waiting.stdout, /^REVIEW-SPEC-BOT-WAIT #262 봇 리뷰 대기 \(chatgpt-codex-connector\)$/)
  assert.equal(existsSync(file()), false)
  assert.deepEqual(gh.calls(), [])
  const explicit = make('262', '--review-worker', '--impl-agent', 'claude')
  assert.equal(explicit.code, 0, explicit.stdout + explicit.stderr)
  assert.equal(existsSync(file()), true)
})

test('구현 worker 가 Claude 면 Codex 리뷰 지시서를 PR 번호·제목·브랜치로 만든다', () => {
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  const r = make('262')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`^REVIEW-SPEC ${file()}$`, 'm'))
  assert.match(r.stdout, /^REVIEW-SPEC-WORKER impl=claude\/claude-sonnet-5-5 review=codex\/gpt-6\.2-sol\/medium$/m)
  assert.match(r.stdout, /^REVIEW-SPEC-FILL PR 이 하는 일 한 줄; 리뷰어가 특히 볼 곳과 이유$/m)
  const text = readFileSync(file(), 'utf8')
  assert.doesNotMatch(text, /비교:|^experiment:/m)
  assert.match(text, /^# fix: 변경 조각 형식을 검사한다 리뷰 \(PR #262\)\n\n공통 지시서 `.*\/spec-common\.md` 를 먼저 읽는다\./)
  assert.equal(reviewPrOfSpec(text), 262)
  assert.match(text, /^브랜치: `review\/pr-262`$/m)
  assert.match(text, /git fetch origin pull\/262\/head/)
  const [choice] = selectionsOf(text)
  assert.deepEqual([choice.agent, choice.model, choice.effort, choice.row, choice.problems], ['codex', 'gpt-6.2-sol', 'medium', 'review', []])
  assert.match(text, /^## 특히 볼 것$/m)
  assert.deepEqual(unfilled(text), ['PR 이 하는 일 한 줄', '리뷰어가 특히 볼 곳과 이유'])
  assert.ok(!/<!--/.test(text.split('## 배경')[0]), '틀의 복사 안내 주석은 남기지 않는다')
  assert.doesNotMatch(text.replace(/\{\{채울 것:[^}]*\}\}/g, ''), /\{\{/)
})
test('구현 worker 가 Codex 면 Claude 리뷰이고 가장 늦은 구현 행의 제공자를 따른다', () => {
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  recordHistory(repo, row('d2', 'fix/precommit', 'codex', '2026-11-10T00:05:00Z', { retry_of: 'd1' }))
  recordHistory(repo, row('rv', 'review/pr-262', 'claude', '2026-11-10T00:09:00Z'))
  const r = make('#262')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /review=claude\/claude-sonnet-5-5\/high/)
  assert.match(r.stdout, /^REVIEW-SPEC-WARN 구현 이력의 제공자가 둘 이상이다\(claude, codex\)/m)
  const [choice] = selectionsOf(readFileSync(file(), 'utf8'))
  assert.deepEqual([choice.agent, choice.model, choice.effort], ['claude', 'claude-sonnet-5-5', 'high'])
})
test('REQ6: 리뷰는 지시서나 차례의 제공자 대신 실제 구현 제공자의 반대쪽을 고른다', () => {
  const from = { agent: 'codex', model: 'gpt-6.2-sol', effort: 'medium' }
  recordHistory(repo, row('d1', 'fix/precommit', 'codex', '2026-11-10T00:00:00Z', {
    effective: { agent: 'claude', model: 'opus', modelId: 'claude-opus-5-5', alternation: {
      grade: 'opus', agent: 'codex', reason: '번갈아: opus 차례', from,
    } },
  }))
  const r = make('262')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /impl=claude\/claude-opus-5-5 review=codex\/gpt-6\.2-sol\/medium/)
})
test('만든 지시서는 spec-lint 가 막지 않고 남은 자리표시는 채움 경고로 알린다', () => {
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  assert.equal(make('262').code, 0)
  const lint = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', LINT, '--repo', repo, file()], { env, encoding: 'utf8' })
  assert.equal(lint.status, 0, lint.stdout + lint.stderr)
  assert.equal((lint.stderr + lint.stdout).match(/채움: 자리표시가 남았다/g)?.length, 2)
  writeFileSync(file(), readFileSync(file(), 'utf8').replace(/\{\{채울 것:[^}]*\}\}/g, '채웠다'))
  const filled = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', LINT, '--repo', repo, file()], { env, encoding: 'utf8' })
  assert.equal(filled.status, 0); assert.doesNotMatch(filled.stderr + filled.stdout, /채움:/)
})
test('이력에 구현 worker 가 없으면 만들지 않고 --impl-agent 로 알리면 만든다', () => {
  const missing = make('262')
  assert.equal(missing.code, 1); assert.match(missing.stdout, /^REVIEW-SPEC-FAIL 구현 worker 를 이력에서 찾지 못했다.*--impl-agent/)
  assert.equal(existsSync(file()), false)
  const given = make('262', '--impl-agent', 'claude')
  assert.equal(given.code, 0, given.stdout + given.stderr)
  assert.match(given.stdout, /impl=claude review=codex\//)
  assert.match(readFileSync(file(), 'utf8'), /구현한 쪽: claude\./)
})
test('있는 파일은 --force 없이 덮지 않는다', () => {
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  assert.equal(make('262').code, 0)
  writeFileSync(file(), '채운 배경')
  const again = make('262')
  assert.equal(again.code, 1); assert.match(again.stdout, new RegExp(`^REVIEW-SPEC-EXISTS ${file()}$`))
  assert.equal(readFileSync(file(), 'utf8'), '채운 배경')
  assert.equal(make('262', '--force').code, 0)
  assert.match(readFileSync(file(), 'utf8'), /리뷰 PR: #262/)
})
test('닫힌 PR 은 경고하고, PR 을 읽지 못하거나 번호가 틀리면 실패한다', () => {
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  gh.setRules([{ args: ['view'], stdout: JSON.stringify({ ...VIEW, state: 'MERGED' }) }])
  assert.match(make('262', '--out', join(specs, 'spec-review-pr-262-2.md')).stdout, /^REVIEW-SPEC-WARN PR #262 의 상태가 MERGED 다$/m)
  gh.setRules([{ stderr: 'no pull requests found', code: 1 }])
  const failed = make('262', '--force')
  assert.equal(failed.code, 1); assert.match(failed.stdout, /^REVIEW-SPEC-FAIL PR #262 를 읽지 못했다/)
  const bad = make('abc')
  assert.equal(bad.code, 2); assert.match(bad.stderr, /PR 번호 하나를 준다/)
})
test('지원하지 않는 제공자는 고르지 않고 틀에 모르는 자리표시가 있으면 만들지 않는다', () => {
  assert.equal(reviewerFor('cursor'), null)
  const fill = { number: 1, title: 't', url: 'u', specsDir: '/s', implementer: { agent: 'claude', model: null, effort: null, dispatch: '-' }, reviewer: reviewerFor('claude')! }
  assert.throws(() => fillReviewSpec(`${readFileSync(TEMPLATE, 'utf8')}\n{{새 자리표시}}\n`, fill), /채우지 못한 자리표시가 있다: 새 자리표시/)
  assert.deepEqual(implementerOf([row('x', 'review/pr-5', 'claude', '2026-11-10T00:00:00Z')], 'review/pr-5'), { found: null, agents: [] })
})
test('틀에 「특히 볼 것」 절이 이미 있으면 하나만 둔다', () => {
  const template = readFileSync(TEMPLATE, 'utf8').replace('## 할 일', '## 특히 볼 것\n\n- {{채울 것: 이미 있는 자리}}\n\n## 할 일')
  const fill = { number: 1, title: 't', url: 'u', specsDir: '/s', implementer: { agent: 'codex', model: 'm', effort: 'high', dispatch: 'd' }, reviewer: reviewerFor('codex')! }
  assert.equal(fillReviewSpec(template, fill).match(/^## 특히 볼 것$/gm)?.length, 1)
})

const branchOf = (name: string) => /^브랜치: `(.*)`$/m.exec(readFileSync(join(specs, name), 'utf8'))?.[1]
// 커밋이 하나 있는 저장소의 ref 를 만든다. 로컬 브랜치와 원격 추적 브랜치를 흉내 낸다
function ref(name: string): void {
  const identity = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' }
  assert.equal(spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'x'], { env: identity }).status, 0)
  const sha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(spawnSync('git', ['-C', repo, 'update-ref', name, sha]).status, 0)
}

test('같은 PR 의 두 번째와 세 번째 리뷰 지시서는 파일 이름의 꼬리로 서로 다른 브랜치를 쓴다', () => {
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  for (const name of ['spec-review-pr-262.md', 'spec-review-pr-262-2.md', 'spec-review-pr-262-3.md']) {
    const r = make('262', '--out', join(specs, name))
    assert.equal(r.code, 0, r.stdout + r.stderr)
  }
  assert.deepEqual(['spec-review-pr-262.md', 'spec-review-pr-262-2.md', 'spec-review-pr-262-3.md'].map(branchOf), ['review/pr-262', 'review/pr-262-2', 'review/pr-262-3'])
  // 리뷰 지시서 이름 규칙(lib/review.ts)이 읽는 브랜치 꼴이다
  assert.equal(reviewPrOfSpec(readFileSync(join(specs, 'spec-review-pr-262-3.md'), 'utf8')), 262)
})
test('꼬리 꼴이 아니거나 번호가 PR 과 다른 파일 이름은 기본 브랜치를 쓴다', () => {
  assert.equal(reviewBranchFor(262, '/x/spec-review-pr-262.md'), 'review/pr-262')
  assert.equal(reviewBranchFor(262, '/x/spec-review-pr-262-r2.md'), 'review/pr-262-r2')
  assert.equal(reviewBranchFor(262, '/x/spec-review-pr-999-2.md'), 'review/pr-262')
  assert.equal(reviewBranchFor(262, '/x/other.md'), 'review/pr-262')
  assert.equal(reviewBranchFor(262, '/x/spec-review-pr-262-a..b.md'), 'review/pr-262')
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  assert.equal(make('262', '--out', join(specs, 'custom.md')).code, 0)
  assert.equal(branchOf('custom.md'), 'review/pr-262')
})
test('같은 이름의 리뷰 브랜치가 로컬이나 원격 추적에 있으면 만들지 않고 다른 꼬리를 안내한다', () => {
  recordHistory(repo, row('d1', 'fix/precommit', 'claude', '2026-11-10T00:00:00Z'))
  ref('refs/heads/review/pr-262')
  const local = make('262')
  assert.equal(local.code, 1, local.stdout)
  assert.match(local.stdout, /^REVIEW-SPEC-FAIL 리뷰 브랜치 review\/pr-262 가 이미 있다\(로컬 브랜치\).*spec-review-pr-262-<꼬리>\.md/m)
  assert.equal(existsSync(file()), false)
  // 꼬리를 바꾸면 만든다
  assert.equal(make('262', '--out', join(specs, 'spec-review-pr-262-2.md')).code, 0)
  // 원격 추적 브랜치도 같다
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/r.git'])
  ref('refs/remotes/origin/review/pr-262-3')
  const remote = make('262', '--out', join(specs, 'spec-review-pr-262-3.md'))
  assert.equal(remote.code, 1, remote.stdout)
  assert.match(remote.stdout, /^REVIEW-SPEC-FAIL 리뷰 브랜치 review\/pr-262-3 가 이미 있다\(원격 추적 브랜치 origin\/review\/pr-262-3\)/m)
  // --force 는 같은 브랜치를 다시 쓰는 용도라 보지 않는다
  assert.equal(make('262', '--force').code, 0)
  assert.equal(branchOf('spec-review-pr-262.md'), 'review/pr-262')
})
