import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { iterTextLinesReplace, readTextReplace } from '../scripts/io.ts'
import { iterMessages } from '../scripts/session_log.ts'

test('줄 읽기는 작은 청크에서도 UTF-8 대체와 줄 끝을 유지한다', () => {
  const file = join(tempDir('hc-lines-'), 'session.jsonl')
  const samples = [
    Buffer.from(''), Buffer.from('\n'), Buffer.from('\r\n\r\n'),
    Buffer.from('\uFEFF한글😀\r\n둘째\r셋째\n끝'),
    Buffer.from('a\rb\r\nc\n'), Buffer.from('a\u0085b\u2028c\u2029d'),
    Buffer.from([0xe1, 0x80, 0x0d, 0x0a, 0xff, 0x0a, 0xf0, 0x9f]),
    Buffer.from('긴 줄'.repeat(1000)),
  ]
  for (const bytes of samples) {
    writeFileSync(file, bytes)
    const text = readTextReplace(file)
    const expected = text ? text.replace(/\n$/, '').split('\n') : []
    for (const chunkSize of [1, 2, 3, 7, 64, 65536]) {
      assert.deepEqual([...iterTextLinesReplace(file, chunkSize)], expected, `chunkSize=${chunkSize}`)
    }
  }
})

test('메시지는 필요한 시점에 읽고 깨진 줄과 중복 blob 을 건너뛴다', () => {
  const file = join(tempDir('hc-messages-'), 'session.jsonl')
  const first = { type: 'user', message: { content: '한글😀' } }
  const last = { type: 'assistant', message: { content: '끝' } }
  const messages = iterMessages(file)
  // 반복을 시작하기 전에는 파일을 열거나 내용을 쌓지 않는다.
  writeFileSync(file, `${JSON.stringify(first)}\r\n{깨진 줄\r${JSON.stringify({ type: 'api-request-blob', message: first })}\n`)
  appendFileSync(file, Buffer.from('{"type":"user","message":{"content":"'))
  appendFileSync(file, Buffer.from([0xff]))
  appendFileSync(file, `"}}\r${JSON.stringify(last)}`)
  assert.deepEqual([...messages], [first, { type: 'user', message: { content: '\uFFFD' } }, last])
})
