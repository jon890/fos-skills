// 임시 저장소에서 공통 지시서 미리보기와 적용, lint 와의 비교 규칙을 확인한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { syncCommon } from '../scripts/spec/sync-common.ts'

let repo: string
const rule = (name: string, body: string, keep = false) => `- ${body} <!-- orch-rule: ${name}${keep ? ' keep' : ''} -->\n`
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sync-common-'))
  mkdirSync(join(repo, '.orch', 'specs'), { recursive: true })
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

test('낡은 본문과 빠진 표지만 바꾸고 저장소 항목은 그대로 보존하며 재실행은 같다', () => {
  const local = '- 저장소에서만 쓰는 규칙\n'
  const template = rule('first', '새 본문') + rule('middle', '중간') + rule('last', '끝')
  const copy = local + rule('first', '옛 본문') + rule('last', '끝')
  const result = syncCommon(copy, template, repo)
  assert.equal(result.text, local + rule('first', '새 본문') + rule('middle', '중간') + '\n' + rule('last', '끝'))
  assert.match(result.output.join('\n'), /SYNC-UPDATE first\n@@/)
  assert.match(result.output.join('\n'), /SYNC-ADD middle/)
  assert.equal(syncCommon(result.text, template, repo).text, result.text)
  assert.deepEqual(syncCommon(result.text, template, repo).output, [])
})

test('keep 항목과 채운 자리표시자는 보존한다', () => {
  const template = rule('custom', '새 규칙') + rule('verify', '검증 {{COMMAND}}')
  const copy = rule('custom', '저장소 결정', true) + rule('verify', '검증 node check.ts')
  const result = syncCommon(copy, template, repo)
  assert.equal(result.text, copy)
  assert.equal(result.manual, false)
  assert.deepEqual(result.output, ['SYNC-KEEP custom'])
})

test('자리표시자가 있는 낡은 항목과 빠진 항목은 수동 확인으로 남겨 저장소 값을 잃지 않는다', () => {
  const template = rule('verify', '새 검증 {{COMMAND}}') + rule('missing', '{{VALUE}}') + rule('safe', '갱신')
  const copy = rule('verify', '옛 검증 node check.ts') + rule('safe', '옛것')
  const result = syncCommon(copy, template, repo)
  assert.equal(result.manual, true)
  assert.ok(result.text.includes(rule('verify', '옛 검증 node check.ts')))
  assert.ok(result.text.includes(rule('safe', '갱신')))
  assert.ok(!result.text.includes('{{'))
})

test('migration 과 adr 은 lint 와 같은 설정으로 추가하고 이미 있으면 조건과 무관하게 갱신한다', () => {
  const template = rule('migration', '예약') + rule('adr', 'ADR 예약')
  assert.equal(syncCommon('# 공통\n', template, repo).text, '# 공통\n')
  writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ migrations: { watch: { api: 'db' } }, adr: { dirs: { root: 'docs/adr' } } }))
  const result = syncCommon('# 공통\n', template, repo)
  assert.match(result.text, /orch-rule: migration/)
  assert.match(result.text, /orch-rule: adr/)
  writeFileSync(join(repo, '.orch', 'config.json'), '{}')
  assert.match(syncCommon(rule('migration', '옛것'), template, repo).text, /예약/)
})

test('여러 빠진 항목의 틀 순서와 번호, CRLF, 이어지는 코드 블록을 보존한다', () => {
  const template = rule('a', '처음') + rule('b', '둘째') + rule('c', '셋째') + rule('d', '새것') + '  ```text\n  code\n  ```\n'
  const copy = ('## 제목\n\n7. 옛것 <!-- orch-rule: d -->\n  예전 코드\n\n- 고유 항목\n').replaceAll('\n', '\r\n')
  const result = syncCommon(copy, template, repo)
  assert.ok(result.text.indexOf('orch-rule: a') < result.text.indexOf('orch-rule: b'))
  assert.ok(result.text.indexOf('orch-rule: b') < result.text.indexOf('orch-rule: c'))
  assert.match(result.text, /7\. 새것/)
  assert.match(result.text, /  ```text\r\n  code\r\n  ```/)
  assert.match(result.text, /- 고유 항목\r\n$/)
  assert.equal(syncCommon(result.text, template, repo).text, result.text)
})

test('실제 진입점은 기본 diff 만 내고 --apply 일 때만 쓰며 오류를 구분한다', () => {
  const file = join(repo, '.orch', 'specs', 'spec-common.md')
  const template = join(repo, 'template.md')
  writeFileSync(file, rule('ready', '옛것'))
  writeFileSync(template, rule('ready', '준비 알림'))
  const entry = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'spec', 'sync-common', '--repo', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, ORCH_DIR: join(repo, '.orch'), CLAUDE_CONFIG_DIR: join(repo, 'empty-profile'), ORCA: join(repo, 'no-orca'), SPEC_TEMPLATE: template },
  })
  const preview = run()
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /SYNC-PREVIEW/)
  assert.match(preview.stdout, /-.*옛것/)
  assert.match(preview.stdout, /\+.*준비 알림/)
  assert.equal(readFileSync(file, 'utf8'), rule('ready', '옛것'))
  const applied = run('--apply')
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(applied.stdout, /SYNC-APPLIED/)
  assert.equal(readFileSync(file, 'utf8'), rule('ready', '준비 알림'))
  assert.match(run('--apply').stdout, /SYNC-UNCHANGED/)
  writeFileSync(template, rule('ready', '{{VALUE}} 변경'))
  assert.equal(run('--apply').status, 1)
  assert.equal(readFileSync(file, 'utf8'), rule('ready', '준비 알림'))
  assert.equal(run('--unknown').status, 2)
})


test('중복 표지와 겹친 항목은 원문을 잘못 덮지 않도록 거부한다', () => {
  assert.throws(() => syncCommon(rule('a', '하나') + rule('a', '둘'), rule('a', '새것'), repo), /같은 표지 a 가 둘 이상 있다: 1, 2줄/)
  for (const keep of ['', ' keep']) {
    assert.throws(() => syncCommon(`- 옛것 <!-- orch-rule: a${keep} --> <!-- orch-rule: b -->\n`, rule('a', '새것') + rule('b', '다른 것'), repo), /범위가 겹친다/)
  }
})


test('keep 대소문자와 이유를 받아 보존하고 모르는 뒤꼬리는 적용 전에 거부한다', () => {
  for (const tail of ['KEEP', 'keep 이유: 팀 결정']) {
    const copy = `- 저장소 결정 <!-- orch-rule: a ${tail} -->\n`
    assert.equal(syncCommon(copy, rule('a', '새것'), repo).text, copy)
  }
  assert.throws(() => syncCommon('- 저장소 결정 <!-- orch-rule: a unknown -->\n', rule('a', '새것'), repo), /뒤꼬리/)
})


test('하위 표지의 부모와 표지 아래 저장소 하위 목록을 수동 확인으로 보존한다', () => {
  for (const copy of ['- 저장소 부모\n  - 하위 <!-- orch-rule: a -->\n', rule('a', '옛것') + '  - 저장소 하위 규칙\n']) {
    const result = syncCommon(copy, rule('a', '새것'), repo)
    assert.equal(result.text, copy)
    assert.equal(result.manual, true)
    assert.match(result.output.join('\n'), /SYNC-MANUAL a/)
  }
})


test('빠진 표지는 틀의 절 안에 넣고 위치를 알리며 없는 절은 제목과 함께 만든다', () => {
  const template = '## 공통\n' + rule('migration', '예약') + '\n## 판단\n' + rule('ask', '묻기')
  writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ migrations: { dirs: { api: 'db' } } }))
  const copy = '## 공통\n- 저장소 규칙\n\n## 판단\n' + rule('ask', '묻기')
  const result = syncCommon(copy, template, repo)
  assert.ok(result.text.indexOf('orch-rule: migration') < result.text.indexOf('## 판단'))
  assert.match(result.output.join('\n'), /SYNC-LOCATION migration: ## 공통/)
  assert.equal(syncCommon(result.text, template, repo).text, result.text)
  const absent = syncCommon('## 판단\n' + rule('ask', '묻기'), template, repo)
  assert.match(absent.text, /## 공통\n\n- 예약/)
})
