import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FIELDS, parse, parseLegacy } from '../scripts/lib/feedback.ts'
import { syncCommon } from '../scripts/spec/sync-common.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/feedback/feedback-candidates.ts', import.meta.url))
let repo: string
let dir: string
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'feedback-test-')))
  dir = join(repo, '.orch', 'feedback')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))
function runAt(cwd: string, ...args: string[]) {
  const env = { ...process.env }
  delete env.ORCH_DIR
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' })
}
function run(...args: string[]) { return runAt(repo, ...args) }
const fields = ['--slug', 'a', '--title', '필수 칸이 빠진 메모를 저장했다', '--skill', 'orch', '--file', 'skills/orch/SKILL.md', '--situation', '후보를 적다가', '--problem', '칸이 빠져 다시 조사했다', '--want', '필수 칸을 검사한다', '--evidence', '로그:12', '--significance', '조사를 줄인다', '--nontrivial', '수기 양식의 반복 문제다', '--structural', '명령이 검사한다']

test('필수 옵션은 하나씩 빠지거나 비면 사용법 오류이고 파일을 만들지 않는다', () => {
  for (let i = 0; i < fields.length; i += 2) {
    const args = fields.filter((_, index) => index !== i && index !== i + 1)
    const result = run('add', ...args)
    assert.equal(result.status, 2, `${fields[i]}: ${result.stderr}`)
    const blank = [...fields]; blank[i + 1] = '  '
    assert.equal(run('add', ...blank).status, 2, fields[i])
  }
  assert.equal(existsSync(dir), false)
})

test('정해진 순서로 저장하고 목록과 상태를 바꾸며 다른 칸을 유지한다', () => {
  assert.equal(run('add', ...fields).status, 0)
  const file = join(dir, 'a.md')
  const before = parse(readFileSync(file, 'utf8'))!
  assert.deepEqual(Object.keys(before.values), FIELDS)
  assert.equal(before.values.스킬, 'orch (skills/orch/SKILL.md)')
  assert.equal(run('add', ...fields).status, 1)
  assert.match(run('list', '--open').stdout, /^a\t후보\t/)
  for (const status of ['보류(재발 기록을 기다린다)', '채택 #123', '기각(이미 해결했다)', '후보']) {
    const result = run('set', '--slug', 'a', '--status', status)
    assert.equal(result.status, 0, result.stderr)
    const after = parse(readFileSync(file, 'utf8'))!
    assert.deepEqual({ ...after.values, 상태: '후보' }, before.values)
    assert.equal(run('list', '--open').stdout.includes('a\t'), status === '후보' || status.startsWith('보류('))
    assert.ok(run('list').stdout.includes(status))
  }
  for (const status of ['채택', '기각()', '보류()', '기각( )', '보류(  )', '채택 #0', '아무거나']) assert.equal(run('set', '--slug', 'a', '--status', status).status, 2)
  assert.equal(run('set', '--slug', 'absent', '--status', '후보').status, 1)
  assert.equal(run('add', ...fields, '--apply').status, 2)
  assert.equal(run('add', ...fields.slice(0, 1), '../bad', ...fields.slice(2)).status, 2)
})

test('옛 메모는 기본으로 미리 보기만 하고 모르는 칸과 상태를 확인 필요로 남긴다', () => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'old.md')
  const text = '# 메모\n\n## 첫 문제\n- 상황: 실행하다가\n- 실제로 한 것: 다른 명령\n\n## 둘째 문제\n- 근거: log:2\n'
  writeFileSync(file, text)
  const result = run('migrate')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /DRY-RUN 1 files 2 candidates/)
  assert.match(result.stdout, /- 상황: 실행하다가/)
  assert.match(result.stdout, /- 문제: 확인 필요/)
  assert.match(result.stdout, /보류\(확인 필요/)
  assert.match(result.stdout, /실제로 한 것: 다른 명령/)
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.deepEqual(readdirSync(dir), ['old.md'])
  assert.match(run('list').stderr, /feedback migrate/)
  const trash = join(repo, 'trash')
  const applied = run('migrate', '--apply', '--trash', trash)
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(readFileSync(join(trash, 'old.md'), 'utf8'), text)
  assert.equal(existsSync(file), false)
  assert.ok(readdirSync(dir).every(name => parse(readFileSync(join(dir, name), 'utf8'))))
  assert.match(run('migrate').stdout, /DRY-RUN 0 files 0 candidates/)
})

test('휴지통이나 대상 후보가 있으면 원본과 기존 파일을 덮어쓰지 않는다', () => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'old.md'), '## 옛 후보\n')
  const trash = join(repo, 'trash')
  mkdirSync(trash)
  writeFileSync(join(trash, 'old.md'), '보존')
  assert.equal(run('migrate', '--apply', '--trash', trash).status, 1)
  assert.equal(readFileSync(join(trash, 'old.md'), 'utf8'), '보존')
  assert.equal(run('migrate', '--apply', '--trash', join(dir, 'trash')).status, 2)
  const preview = run('migrate', '--trash', join(repo, 'new-trash'))
  const target = /^PREVIEW .* -> (.+)$/m.exec(preview.stdout)![1]
  writeFileSync(target, '기존 후보')
  assert.equal(run('migrate', '--apply', '--trash', join(repo, 'new-trash')).status, 1)
  assert.ok(existsSync(join(dir, 'old.md')))
})

test('한글 파일 이름도 상태를 바꿀 수 있는 이름으로 옮기고 앞 파일 추가로 옮길 이름이 바뀌지 않는다', () => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '옛 메모.md'), '## 문제\n- 상태: 기각(이미 해결했다)\n')
  const preview = run('migrate')
  const target = /^PREVIEW .* -> (.+)$/m.exec(preview.stdout)![1]
  writeFileSync(join(dir, 'a.md'), '## 다른 문제\n')
  assert.ok(run('migrate').stdout.includes(`-> ${target}\n`))
  assert.equal(run('migrate', '--apply', '--trash', join(repo, 'trash')).status, 0)
  const candidate = parse(readFileSync(target, 'utf8'))!
  assert.equal(candidate.values.상태, '기각(이미 해결했다)')
  const slug = target.slice(dir.length + 1, -3)
  assert.equal(run('set', '--slug', slug, '--status', '후보').status, 0)
})

test('워크트리에서 실행해도 주 checkout 의 후보 폴더에 쌓인다', () => {
  const git = (...args: string[]) => {
    const done = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
  }
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(repo, 'wt')
  git('worktree', 'add', '-q', '-b', 'test', wt)
  const result = runAt(wt, 'add', ...fields)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(join(dir, 'a.md')))
  assert.equal(existsSync(join(wt, '.orch')), false)
  assert.equal(runAt(wt, 'list').stdout, run('list').stdout)
})


test('공통 지시서 동기화가 후보 기록 명령과 필수 옵션을 함께 옮긴다', () => {
  const template = readFileSync(new URL('../templates/spec-common.md', import.meta.url), 'utf8')
  const result = syncCommon('## 스킬 개선 후보 보고\n', template, repo)
  assert.ok(result.output.includes('SYNC-ADD feedback-add'))
  assert.match(result.text, /orch feedback add --slug/)
  assert.match(result.text, /--structural/)
})


test('하이픈으로 시작하는 설명도 옵션 대신 값으로 저장한다', () => {
  const args = [...fields]
  args[args.indexOf('--want') + 1] = '--dry-run 을 기본으로'
  const result = run('add', ...args)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(parse(readFileSync(join(dir, 'a.md'), 'utf8'))!.values['바라는 기능'], '--dry-run 을 기본으로')
})


test('옛 메모의 새 판단 이름을 우선하고 실제로 쓰던 변형과 표도 읽는다', () => {
  const [candidate] = parseLegacy('## 문제\n- 유의미: 옛 값\n- 유의미한가: 새 값\n- 단순 함정 여부: 반복 구조 문제\n- 구조로 막는 방법: 검사기를 둔다\n', 'old.md')
  assert.equal(candidate.values.판단, '유의미한가: 새 값 / 단순 함정이 아닌가: 반복 구조 문제 / 구조로 막을 수 있는가: 검사기를 둔다')
  const [table] = parseLegacy('## 문제\n| 유의미함 | 시간을 줄인다 |\n| 단순 함정이 아님 | 반복된다 |\n| 구조로 막을 수 있음 | 검사를 둔다 |\n', 'old.md')
  assert.ok(!table.values.판단.includes('확인 필요'))
})


test('다시 보기와 보류 기록은 앞 후보의 근거에 붙이고 별도 후보로 만들지 않는다', () => {
  const candidates = parseLegacy('## 원래 문제\n- 문제: 실패\n## 다시 보기 (2026-11-04): 보류\n재발을 기다린다\n## 보류\n추가 근거\n## 다른 문제\n다른 기록\n', 'old.md')
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].title, '원래 문제')
  assert.match(candidates[0].values.근거, /재발을 기다린다.*추가 근거/)
  const [table] = parseLegacy('# 후보 모음\n| 후보 | 근거 |\n| a | log |\n## 보류\n다음에 본다\n', 'table.md')
  assert.equal(table.title, '후보 모음')
  assert.match(table.values.근거, /다음에 본다/)
})
