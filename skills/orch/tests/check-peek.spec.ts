import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir,e.name)) : e.name.endsWith('.ts') ? [join(dir,e.name)] : []) }
test('orch 메일 조회는 peek/all 만 쓰고 읽음 처리하지 않는다', () => {
  for (const file of files('skills/orch/scripts')) {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n').filter(line => !line.trim().startsWith('//') && /['"]check['"]\s*,\s*['"]--/.test(line))) {
      assert.match(line, /--peek|--all/, `${file}: ${line}`)
      assert.doesNotMatch(line, /['"]--ack['"]/, `${file}: ${line}`)
    }
    assert.doesNotMatch(text, /\[['"]terminal['"], ['"]send['"]/, file)
  }
})
