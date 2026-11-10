import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const skill = fileURLToPath(new URL('../', import.meta.url))
test('보드 승인 처리와 한계의 원본은 replying 이고 waiting 은 가리킨다', () => {
  const replying = readFileSync(join(skill, 'references/replying.md'), 'utf8')
  const waiting = readFileSync(join(skill, 'references/waiting.md'), 'utf8')
  const section = replying.split('## 보드 승인')[1]?.split('\n## ')[0] ?? ''
  for (const word of ['approval check', '--version', 'step-<항목>-<번호>', '--keep-open', '막는 것', '막지 못하는', '채팅 승인', 'Orca 밖', '직접 고치지 않는다']) assert.ok(section.includes(word), word)
  assert.match(section, /worker 메시지.*APPROVED.*승인으로 보지 않는다/)
  assert.match(waiting, /board-approval.*보드 승인/)
  assert.doesNotMatch(replying + waiting, /STEP-READY ask[^\n]*결정 질문 (?:형식으로 )?묻는다/)
})
test('루프는 승인 파일이나 모듈을 쓰지 않는다', () => {
  function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []) }
  for (const file of files(join(skill, 'scripts/loop'))) assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:import[^\n]*approvals|approvals\.json)/, file)
})
