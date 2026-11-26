// 임시 저장소에서 공통 지시서 미리보기와 적용, lint 와의 비교 규칙을 확인한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { atomicWrite, syncCommon } from '../scripts/spec/sync-common.ts'

const TEMPLATE = fileURLToPath(new URL('../templates/spec-common.md', import.meta.url))

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

test('번호 예약은 마이그레이션 또는 ADR 설정이 있으면 추가하고 옛 ADR 예외는 보존한다', () => {
  const template = rule('migration', '번호 예약')
  assert.equal(syncCommon('', template, repo).text, '')
  const config = join(repo, '.orch', 'config.json')
  for (const options of [{ migrations: { watch: { api: 'db' } } }, { adr: { dirs: { root: 'docs/adr' } } }]) {
    writeFileSync(config, JSON.stringify(options))
    assert.match(syncCommon('', template, repo).text, /orch-rule: migration/)
  }
  const legacy = rule('adr', 'ADR 예약 예외', true)
  const result = syncCommon(legacy, template, repo)
  assert.ok(result.text.includes(legacy))
  assert.match(result.text, /orch-rule: migration/)
  assert.match(result.output.join('\n'), /^SYNC-MANUAL adr: adr 표지는 migration/m)
  assert.equal(result.manual, true)
  writeFileSync(config, '{}')
  assert.match(syncCommon(rule('migration', '옛것'), template, repo).text, /번호 예약/)
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


test('중복 표지는 수동 확인으로 남기고 겹친 항목은 원문을 잘못 덮지 않도록 거부한다', () => {
  const duplicate = syncCommon(rule('a', '하나') + rule('a', '둘'), rule('a', '새것'), repo)
  assert.equal(duplicate.manual, true)
  assert.match(duplicate.output.join('\n'), /SYNC-MANUAL 사본: 같은 표지 a 가 둘 이상 있다: 1, 2줄/)
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


test('하위 항목에만 붙은 표지는 표지 없는 부모를 수동 확인으로 보존한다', () => {
  const copy = '- 저장소 부모\n  - 하위 <!-- orch-rule: a -->\n'
  const result = syncCommon(copy, rule('a', '새것'), repo)
  assert.equal(result.text, copy)
  assert.equal(result.manual, true)
  assert.match(result.output.join('\n'), /SYNC-MANUAL a/)
})

test('표지가 붙은 줄 아래의 하위 목록은 그 규칙의 일부로 비교하고 교체한다', () => {
  const template = rule('a', '규칙') + '  - 이유\n  - 예외\n' + rule('b', '다음')
  // 틀과 같으면 손대지 않는다
  const same = syncCommon(template, template, repo)
  assert.equal(same.text, template)
  assert.deepEqual(same.output, [])
  assert.equal(same.manual, false)
  // 옛 한 줄 본문이나 낡은 하위 목록은 하위 목록까지 틀로 바꾼다
  for (const old of [rule('a', '옛 규칙. 이유도 한 줄에'), rule('a', '규칙') + '  - 옛 이유\n']) {
    const result = syncCommon(old + rule('b', '다음'), template, repo)
    assert.equal(result.text, template)
    assert.equal(result.manual, false)
    assert.match(result.output.join('\n'), /SYNC-UPDATE a\n@@/)
    assert.equal(syncCommon(result.text, template, repo).text, result.text)
  }
  // 저장소가 바꾼 하위 목록은 keep 으로 지킨다
  const kept = rule('a', '규칙', true) + '  - 저장소 예외\n' + rule('b', '다음')
  assert.equal(syncCommon(kept, template, repo).text, kept)
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


test('저장소가 바꾼 절 제목과 실제로 넣은 위치를 알린다', () => {
  const template = '## 공통\n' + rule('first', '처음') + rule('last', '끝')
  const copy = '## 저장소 규칙\n' + rule('last', '끝') + '\n## 다른 절\n'
  const result = syncCommon(copy, template, repo)
  assert.match(result.text, /## 저장소 규칙\n- 처음.*\n\n- 끝/)
  assert.match(result.output.join('\n'), /^SYNC-LOCATION first: ## 저장소 규칙, 2줄 앞, 표지 last 앞$/m)
  assert.equal(syncCommon(result.text, template, repo).text, result.text)
})


test('원자적 쓰기는 이름 변경 실패 때 원본을 지키고 임시 파일을 치우며 성공 때 권한을 유지한다', () => {
  const file = join(repo, 'common.md')
  writeFileSync(file, '원본')
  chmodSync(file, 0o640)
  assert.throws(() => atomicWrite(file, '새것', () => { throw new Error('rename 실패') }), /rename 실패/)
  assert.equal(readFileSync(file, 'utf8'), '원본')
  assert.deepEqual(readdirSync(repo).sort(), ['.orch', 'common.md'])
  const previousMask = process.umask(0o077)
  try { atomicWrite(file, '새것') } finally { process.umask(previousMask) }
  assert.equal(readFileSync(file, 'utf8'), '새것')
  assert.equal(statSync(file).mode & 0o777, 0o640)
})


test('변경 범위 밖의 혼합 줄바꿈과 유니코드 줄 구분자를 바이트 그대로 보존한다', () => {
  const before = '## 제목\r\n- 고유 앞\u2028'
  const after = '- 고유 뒤\r- 끝\r\n'
  const copy = before + rule('a', '옛것') + after
  const result = syncCommon(copy, rule('a', '새것'), repo)
  assert.equal(result.text, before + rule('a', '새것') + after)
  assert.equal(syncCommon(result.text, rule('a', '새것'), repo).text, result.text)
  assert.equal(syncCommon('- 고유 항목', rule('a', '새것'), repo).text, '- 고유 항목\n' + rule('a', '새것'))
})


test('코드 블록 안의 표지와 절 제목을 규칙이나 삽입 위치로 읽지 않는다', () => {
  for (const fence of ['```md', '~~~md']) {
    const end = fence.slice(0, 3)
    const example = `${fence}\n## 예시 제목\n- 예시 <!-- orch-rule: a -->\n${end}\n`
    const template = rule('a', '새 규칙')
    const result = syncCommon(example + rule('a', '옛 규칙'), template, repo)
    assert.equal(result.text, example + template)
    assert.equal(syncCommon(example, example, repo).text, example)
  }
})


test('파일 첫 줄 앞 삽입은 diff 의 기존 범위를 0줄로 표시한다', () => {
  const result = syncCommon(rule('b', '유지'), rule('a', '추가') + rule('b', '유지'), repo)
  assert.match(result.output.join('\n'), /@@ -0,0 \+1,/)
})

test('표지에 딸린 옛 셸 예시를 제거하고 새 명령은 한 번만 남긴다', () => {
  const template = readFileSync(TEMPLATE, 'utf8')
  const marker = '<!-- orch-rule: study-candidates -->'
  const copy = template.replace(marker, [
    marker, '', '  ```bash', '  SLUG=""', '  orch study add --slug "$SLUG"', '  ```',
  ].join('\n'))
  const result = syncCommon(copy, template, repo)
  assert.equal(result.text.split('orch study add').length - 1, 1)
  assert.doesNotMatch(result.text, /--slug/)
  assert.equal(result.manual, false)
  assert.equal(result.text, template)
  assert.deepEqual(syncCommon(result.text, template, repo).output, [])
})


test('표지 없는 항목 뒤에 별도 목록으로 풀어 쓴 설명도 같은 내용이면 합친다', () => {
  const template = rule('feedback-add', '후보를 남긴다.') + '  `SLUG` 는 이름이다.\n\n  ```bash\n  orch feedback add --slug "$SLUG"\n  ```\n'
  const copy = template.replace(' <!-- orch-rule: feedback-add -->', '')
    .replace('  `SLUG` 는', '- `SLUG` 는')
  assert.notEqual(copy, template)
  const result = syncCommon(copy, template, repo)
  assert.equal(result.text, template)
  assert.equal(result.text.match(/^  orch feedback add /gm)?.length, 1)
  assert.match(result.output.join('\n'), /SYNC-UPDATE feedback-add/)
  assert.deepEqual(syncCommon(result.text, template, repo).output, [])
})

test('이미 중복된 사본은 표지 항목을 남기고 표지 없는 쪽의 제거 diff 를 낸다', () => {
  // 인접한 보드 규칙, 떨어진 질문 블록, 목록 기호 차이, 여러 중복이 섞인 사본을 본뜬다.
  for (const copy of [
    '- 같은 항목\n' + rule('a', '같은 항목'),
    '- 같은 항목\n  ```bash\n  old command\n  ```\n- 저장소 규칙\n' + rule('a', '같은 항목'),
    rule('a', '같은 항목') + '7. 같은 항목\n',
    '- 같은 항목\n' + rule('a', '같은 항목') + '- 다른 항목\n' + rule('b', '다른 항목'),
  ]) {
    const template = rule('a', '같은 항목') + rule('b', '다른 항목')
    const result = syncCommon(copy, template, repo)
    assert.equal(result.manual, false)
    assert.equal(result.text.match(/같은 항목/g)?.length, 1)
    assert.equal(result.text.match(/다른 항목/g)?.length, 1)
    assert.ok(!result.text.includes('old command'))
    assert.match(result.output.join('\n'), /SYNC-UPDATE a: 중복된 표지 없는 사본 항목 제거\n@@ -/)
    assert.equal(syncCommon(result.text, template, repo).text, result.text)
  }
})

test('모호한 중복은 수동 확인으로 남기고 다른 안전한 규칙은 계속 갱신한다', () => {
  for (const ambiguous of [
    '- 같은 항목\n- 같은 항목\n',
    rule('a', '같은 항목') + rule('b', '같은 항목'),
    rule('a', '하나') + rule('a', '둘'),
    '- 같은 항목\n  - 저장소 하위 항목\n' + rule('a', '같은 항목'),
  ]) {
    const copy = ambiguous + rule('safe', '옛것')
    const result = syncCommon(copy, rule('a', '같은 항목') + rule('safe', '새것'), repo)
    assert.equal(result.text, ambiguous + rule('safe', '새것'))
    assert.equal(result.manual, true)
    assert.match(result.output.join('\n'), /SYNC-MANUAL/)
    assert.match(result.output.join('\n'), /SYNC-UPDATE safe/)
  }
})


test('갱신으로 다른 항목과 머리 줄이 같아지면 결과를 거부한다', () => {
  assert.throws(() => syncCommon(rule('a', '옛 항목') + '- 새 항목\n', rule('a', '새 항목'), repo), /같은 머리 줄/)
})


test('옛 항목 옆의 다른 저장소 항목과 코드 예시의 같은 머리 줄은 건드리지 않는다', () => {
  const template = rule('a', '공통 항목')
  const example = '```md\n- 공통 항목\n```\n'
  const copy = example + '- 공통 항목\n- 저장소 항목\n  ```text\n  keep me\n  ```\n'
  const result = syncCommon(copy, template, repo)
  assert.equal(result.text, example + template + '- 저장소 항목\n  ```text\n  keep me\n  ```\n')
})


test('실제 적용은 모호한 중복을 보존하고 안전한 항목을 쓰며 코드 1 로 끝난다', () => {
  const file = join(repo, '.orch', 'specs', 'spec-common.md')
  const template = join(repo, 'template.md')
  const ambiguous = '- 같은 항목\n- 같은 항목\n'
  writeFileSync(file, ambiguous + rule('safe', '옛것'))
  writeFileSync(template, rule('a', '같은 항목') + rule('safe', '새것'))
  const entry = fileURLToPath(new URL('../scripts/spec/sync-common.ts', import.meta.url))
  const result = spawnSync(process.execPath, [entry, '--repo', repo, '--apply'], {
    encoding: 'utf8', env: { ...process.env, ORCH_DIR: join(repo, '.orch'), SPEC_TEMPLATE: template },
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /SYNC-MANUAL 사본: 중복 머리 줄/)
  assert.match(result.stdout, /SYNC-APPLIED/)
  assert.equal(readFileSync(file, 'utf8'), ambiguous + rule('safe', '새것'))
})


test('중복을 정리해도 keep 본문과 혼합 줄바꿈을 보존한다', () => {
  const kept = rule('a', '같은 항목', true) + '  저장소가 정한 본문\r\n'
  const copy = '- 같은 항목\r\n  옛 본문\r\n' + kept
  const result = syncCommon(copy, rule('a', '같은 항목') + '  틀 본문\n', repo)
  assert.equal(result.text, kept)
  assert.equal(result.manual, false)
  assert.match(result.output.join('\n'), /SYNC-KEEP a/)
})


test('오류와 중복 안내는 줄 번호가 사본과 틀 중 어디에 속하는지 밝힌다', () => {
  assert.throws(() => syncCommon(rule('a', '사본'), rule('a', '중복') + rule('b', '중복'), repo), /틀: 같은 머리 줄/)
  assert.throws(() => syncCommon('- 규칙 <!-- orch-rule: a unknown -->\n', rule('a', '새것'), repo), /사본: 표지 a:1 의 뒤꼬리/)
  const result = syncCommon('- 중복\n- 중복\n', rule('a', '중복'), repo)
  assert.match(result.output.join('\n'), /SYNC-MANUAL 사본: 중복 머리 줄 1, 2줄/)
})


test('표지 없는 옛 항목을 덮는 diff 에 keep 으로 보존하는 방법을 안내한다', () => {
  const result = syncCommon('- 같은 첫 줄\n  저장소 본문\n', rule('a', '같은 첫 줄') + '  틀 본문\n', repo)
  assert.match(result.output.join('\n'), /SYNC-UPDATE a: 저장소가 일부러 바꾼 항목이면 <!-- orch-rule: a keep --> 을 붙인다\n@@/)
  const kept = '- 같은 첫 줄 <!-- orch-rule: a keep -->\n  저장소 본문\n'
  assert.equal(syncCommon(kept, rule('a', '같은 첫 줄') + '  틀 본문\n', repo).text, kept)
})
