import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ruleBodies } from '../scripts/lib/common-rules.ts'

const template = readFileSync(new URL('../templates/spec-common.md', import.meta.url), 'utf8')
const entry = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))
const scripts = fileURLToPath(new URL('../scripts', import.meta.url))

test('공통 지시서의 표지 항목은 규칙 한 줄과 하위 bullet 이고 실행기 설치와 인자 설명은 넣지 않는다', () => {
  assert.doesNotMatch(template, /ORCH_SCRIPTS|\$SKILL_DIR|bin\/orch\.ts|installed_plugins|command -v orch/)
  for (const [name, item] of ruleBodies(template)) {
    const [head, ...rest] = item.body.split('\n')
    assert.ok(head.includes(`orch-rule: ${name}`), name)
    for (const line of rest) assert.match(line, /^ {2,3}- \S/, `${name}: ${line}`)
  }
})

for (const [name, command, helpText] of [
  ['worker-ask', 'worker ask', /SENT-RUN.*\n.*5 면/],
  ['migration', 'queue reserve', /renewed.*기존 파일/],
  ['wait-in-turn', 'queue gate', /GATE-FAIL.*다시 검사/],
  ['feedback-add', 'feedback add', /--structural/],
  ['study-candidates', 'study add', /--memo.*실제 선택/],
] as const) {
  test(`${command} 의 도움말과 사용법 오류에 실행 안내가 나온다`, () => {
    assert.ok(ruleBodies(template).get(name)?.body.includes(`orch ${command}`))
    const run = (arg: string) => spawnSync(process.execPath, [entry, ...command.split(' '), arg], {
      encoding: 'utf8',
      env: { ...process.env, ORCH_SCRIPTS_DIR: scripts },
    })
    const help = run('--help')
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, helpText)
    const error = run('--invalid-option')
    assert.equal(error.status, 2, error.stderr)
    assert.match(error.stderr, helpText)
  })
}

test('자동 리뷰 workflow 를 바꾼 경우 독립 리뷰를 요청한다', () => {
  const policy = ruleBodies(template).get('review-workflow')?.body ?? ''
  const replying = readFileSync(new URL('../references/replying.md', import.meta.url), 'utf8')
  for (const text of [policy, replying]) {
    assert.match(text, /workflow/)
    assert.match(text, /Ready 뒤 자동 리뷰를 기다리지 않고 코디네이터에게 독립 리뷰를 요청/)
    assert.match(text, /review-fix/)
  }
})
