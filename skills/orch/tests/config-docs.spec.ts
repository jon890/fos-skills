// 설정 명령 안내, 공유 설정의 worker 금지와 타입 문서 누락을 확인한다.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FINISH_KEYS } from '../scripts/core/finish-options.ts'
import { CLEANUP_KEYS } from '../scripts/core/config.ts'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

test('설정을 바꾸라는 안내는 config 명령으로 이어진다', () => {
  for (const name of ['overlay', 'replying', 'heavy-checks', 'board', 'hooks', 'cleanup', 'spec-writing']) {
    assert.match(read(`../references/${name}.md`), /orch config set/, name)
  }
  const overlay = read('../references/overlay.md')
  for (const command of ['show', 'get', 'set', 'unset']) assert.ok(overlay.includes(`orch config ${command}`), command)
  assert.match(overlay, /--json/)
  assert.match(overlay, /여러 경로/)
  assert.match(overlay, /주 checkout/)
  assert.match(overlay, /--run/)
})

test('공통 지시서는 worker 의 설정 변경 명령 호출을 금지한다', () => {
  const template = read('../templates/spec-common.md')
  const line = template.split('\n').find(line => line.includes('<!-- orch-rule: no-config-edit -->'))
  assert.ok(line)
  for (const text of ['worker', 'orch config set', 'orch config unset', '부르지 않는다', '코디네이터']) assert.ok(line.includes(text), text)
})

test('마무리와 정리의 키는 문서 표에 모두 있고 타입을 설명한다', () => {
  const overlay = read('../references/overlay.md').split('## 마무리 설정 파일')[1].split('```json')[0]
  for (const [section, keys] of [['finish', FINISH_KEYS], ['cleanup', CLEANUP_KEYS]] as const) {
    const lines = overlay.split('\n').filter(line => line.startsWith(`| \`${section}\` |`))
    const documented = lines.flatMap(line => [...line.split('|')[2].matchAll(/`([a-z_]+)`/g)].map(match => match[1]))
    assert.deepEqual([...new Set(documented)].sort(), [...keys].sort(), section)
    for (const line of lines) assert.match(line, /문자열|참거짓|유한한 수/, line)
  }
  const schema = read('../../../docs/data-schema.md')
  for (const key of ['tick_sec', 'digest_sec']) assert.ok(schema.includes(`| \`${key}\` | 양수, 타이머 상한 이하 |`), key)
  assert.ok(schema.includes('| `ready_slots` | 1 이상의 정수 |'))
  assert.ok(schema.includes('`config.json.lock`'))
  assert.match(schema, /기존 명령이 읽을 때의 검사는 그대로/)
})

test('개발 의존 설치와 core 의 zod 예외를 안내한다', () => {
  assert.match(read('../../../README.md'), /npm ci --ignore-scripts/)
  assert.match(read('../../../docs/features/orch-lib-layers/design.md'), /core\/config-schema.ts.*zod/)
})

test('업무 도구 설정은 두 문서 표에 있다', () => {
  for (const file of ['../references/overlay.md', '../../../docs/data-schema.md']) assert.ok(read(file).includes('| `board` | `task` |'))
})
