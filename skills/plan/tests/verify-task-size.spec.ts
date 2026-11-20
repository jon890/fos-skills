// verify_task 의 명령 경계 테스트: 신규 파일을 포함한 PR 줄 수 추정과 레포 설정의 「PR 줄 수 상한」.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkEstimatedSize, type Entry } from '../scripts/verify_task.ts'
import { NEW_FILE_LINES } from '../scripts/pr_size.ts'
import { number } from '../scripts/overlay_values.ts'
import { Repo, verify, writePlan } from './helpers.ts'

const set = (entries: Entry[]) => new Set(entries.map(([rel, action]) => `${rel}\0${action}`))

test('신규 파일은 미상이 아니라 운영 코드, 테스트, 문서의 평균 줄 수로 센다', () => {
  const repo = new Repo()
  repo.file('src/old.ts', 'x\n'.repeat(100))
  const entries: Entry[] = [['src/a.ts', '신규'], ['src/V1__init.sql', '신규'], ['tests/a.test.ts', '신규'], ['docs/a.md', '신규'], ['src/old.ts', '수정']]
  const warnings: string[] = []
  const estimate = checkEstimatedSize('plan', set(entries), repo.root, warnings)
  const core = NEW_FILE_LINES.production + NEW_FILE_LINES.other + 20
  assert.match(warnings[0], new RegExp(`운영 코드 ${core}줄, 테스트 ${NEW_FILE_LINES.tests}줄, 문서 ${NEW_FILE_LINES.docs}줄`))
  assert.doesNotMatch(warnings[0], /미상/)
  assert.equal(estimate!.core, core)
  assert.equal(estimate!.unknown, 0)
})

test('lock 파일, 빌드 결과물, 스냅샷은 설정이 없어도 세지 않는다', () => {
  const repo = new Repo()
  repo.file('web/pnpm-lock.yaml', 'x\n'.repeat(9000))
  repo.file('web/__snapshots__/a.snap', 'x\n'.repeat(500))
  const entries: Entry[] = [['web/pnpm-lock.yaml', '수정'], ['web/__snapshots__/a.snap', '수정'], ['web/dist/app.js', '신규'], ['web/app.min.js', '신규'], ['web/src/a.ts', '신규']]
  const warnings: string[] = []
  const estimate = checkEstimatedSize('plan', set(entries), repo.root, warnings)
  assert.equal(estimate!.core, NEW_FILE_LINES.production)
  assert.match(warnings[0], /1개 파일/)
})

test('파일째 지우는 운영 코드는 운영 코드에서 빼고, 같은 이름의 삭제와 신규는 이동으로 0줄이다', () => {
  const repo = new Repo()
  repo.file('src/old/Gone.java', 'x\n'.repeat(800))
  repo.file('src/old/Moved.java', 'x\n'.repeat(900))
  repo.file('tests/old.test.ts', 'x\n'.repeat(40))
  const entries: Entry[] = [['src/old/Gone.java', '삭제'], ['src/old/Moved.java', '삭제'], ['src/new/Moved.java', '신규'], ['tests/old.test.ts', '삭제']]
  const warnings: string[] = []
  const estimate = checkEstimatedSize('plan', set(entries), repo.root, warnings)
  assert.equal(estimate!.core, 0)
  assert.match(warnings[0], /테스트 40줄, 문서 0줄, 전체 840줄/)
  assert.match(warnings[0], /이동 2개는 0줄로 셌다, 파일째 지우는 운영 코드 800줄은 운영 코드에서 뺐다/)
})

test('문서를 테스트보다 먼저 보고, 레포 설정의 운영 코드 경로는 Markdown 이어도 운영 코드로 센다', () => {
  const repo = new Repo()
  const entries: Entry[] = [['tests/README.md', '신규'], ['hermes/connectors/shop/skills/buy/SKILL.md', '신규'], ['__tests__/a.ts', '신규']]
  const warnings: string[] = []
  const estimate = checkEstimatedSize('plan', set(entries), repo.root, warnings, [], ['hermes/connectors/*/skills/*/SKILL.md'])
  assert.equal(estimate!.core, NEW_FILE_LINES.docs)
  assert.match(warnings[0], new RegExp(`테스트 ${NEW_FILE_LINES.tests}줄, 문서 ${NEW_FILE_LINES.docs}줄`))
  const plain = checkEstimatedSize('plan', set(entries), repo.root, [])
  assert.equal(plain!.core, 0)
})

test('phase 별 추정은 운영 코드만 세고 여러 phase 에 나온 파일은 처음 phase 에 센다', () => {
  const repo = new Repo()
  const first: Entry[] = [['src/a.ts', '신규'], ['tests/a.test.ts', '신규']]
  const second: Entry[] = [['src/a.ts', '수정'], ['src/b.ts', '신규'], ['src/c.ts', '신규']]
  const estimate = checkEstimatedSize('plan', set([...first, ...second]), repo.root, [], [['tasks/p/phase-01.md', first], ['tasks/p/phase-02.md', second]])
  assert.deepEqual(estimate!.phases, [['phase-01', NEW_FILE_LINES.production], ['phase-02', 2 * NEW_FILE_LINES.production]])
})

function overlay(repo: Repo, value: string): void {
  repo.file('.claude/plan-overlay.md', `# plan 레포 설정\n\n| 값 | 값 |\n| --- | --- |\n| PR 줄 수 상한 | ${value} |\n`)
}

// 운영 코드 신규 파일을 phase 둘에 나눠 담은 계획을 만들어 구현 전 검사로 돌린다
function sized(repo: Repo, files: number, createdAt = '2026-11-20') {
  repo.file('docs/flow.md')
  const entries = (prefix: string, count: number) => Array.from({ length: count }, (_, n): Entry => [`src/${prefix}${n}.ts`, '신규'])
  const half = Math.ceil(files / 2)
  writePlan(repo, 'plan1-a', [{ entries: entries('a', half) }, { entries: entries('b', files - half) }], { index: { created_at: createdAt, pr_scope: '파일을 더한다', deferred: [] } })
  return verify(repo, ['plan1-a'])
}

test('PR 줄 수 상한의 80% 를 넘으면 phase 별 추정과 함께 경고한다', () => {
  const repo = new Repo('size-', true)
  overlay(repo, `\`${NEW_FILE_LINES.production * 10}\``)
  const under = sized(repo, 8)
  assert.ok(!under.stdout.includes('PR 줄 수 상한'), under.stdout)
  const near = sized(repo, 9)
  const found = near.warnings.find((line) => line.includes('PR 줄 수 상한'))
  assert.ok(found, near.stdout)
  assert.match(found, /의 80%\(\d+줄\)를 넘는다/)
  assert.ok(found.includes(`phase-01 ${5 * NEW_FILE_LINES.production}줄, phase-02 ${4 * NEW_FILE_LINES.production}줄`), found)
  assert.ok(!near.violations.some((line) => line.includes('PR 줄 수 상한')), near.stdout)
})

test('PR 줄 수 상한을 넘으면 위반이고, 이전에 만든 계획은 경고로만 낸다', () => {
  const repo = new Repo('size-', true)
  overlay(repo, `\`${NEW_FILE_LINES.production * 10}\``)
  const over = sized(repo, 11)
  assert.equal(over.code, 1, over.stdout)
  assert.ok(over.violations.some((line) => line.includes('PR 줄 수 상한') && line.includes('plan 을 나누고')), over.stdout)
  const legacy = sized(repo, 11, '2026-11-19')
  assert.ok(!legacy.violations.some((line) => line.includes('PR 줄 수 상한')), legacy.stdout)
  assert.ok(legacy.warnings.some((line) => line.includes('PR 줄 수 상한') && line.includes('을 넘는다')), legacy.stdout)
})

test('레포 설정의 「PR 줄 수 운영 코드」 경로를 상한 비교에 넣는다', () => {
  const repo = new Repo('size-', true)
  repo.file('.claude/plan-overlay.md', `| 값 | 값 |\n| --- | --- |\n| PR 줄 수 상한 | \`${NEW_FILE_LINES.production * 10}\` |\n| PR 줄 수 운영 코드 | \`skills/*/SKILL.md\` |\n`)
  repo.file('docs/flow.md')
  const entries = Array.from({ length: 11 }, (_, n): Entry => [`skills/s${n}/SKILL.md`, '신규'])
  writePlan(repo, 'plan1-a', [{ entries }], { index: { created_at: '2026-11-20', pr_scope: '스킬을 더한다', deferred: [] } })
  const r = verify(repo, ['plan1-a'])
  assert.ok(r.violations.some((line) => line.includes('PR 줄 수 상한')), r.stdout)
})

test('PR 줄 수 상한은 JS 상수를 읽고, 읽지 못하면 경고하고 보지 않는다', () => {
  const repo = new Repo('size-', true)
  repo.file('scripts/pr-size.mjs', `export const LARGE = 400;\nexport const MAX_LINES = ${NEW_FILE_LINES.production * 10};\n`)
  overlay(repo, '`scripts/pr-size.mjs#MAX_LINES`')
  assert.equal(sized(repo, 11).code, 1)
  overlay(repo, '`scripts/pr-size.mjs#MISSING`')
  const broken = sized(repo, 11)
  assert.ok(broken.warnings.some((line) => line.includes('「PR 줄 수 상한」 을 읽지 못해') && line.includes('MISSING')), broken.stdout)
  assert.ok(!broken.violations.some((line) => line.includes('PR 줄 수 상한')), broken.stdout)
})

test('JS·TS 상수는 export, 타입 표기, 숫자 구분자를 받고 다른 상수와 섞지 않는다', () => {
  const repo = new Repo()
  repo.file('a.ts', 'const MAX_LINES_OLD = 1\nexport const MAX_LINES: number = 1_500 // 상한\n')
  assert.equal(number(repo.root, '`a.ts#MAX_LINES`'), 1500)
  assert.throws(() => number(repo.root, '`a.ts#MAX`'), /정수 상수 MAX 이 없다/)
  assert.throws(() => number(repo.root, '`a.ts#a.b`'), /상수 이름이 아니다/)
})
