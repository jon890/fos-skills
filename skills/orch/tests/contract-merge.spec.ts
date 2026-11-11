// lib/contract-merge.ts 의 설정 판정과 lib/spec-reserve.ts 의 줄 읽기를 본다. git 을 쓰는 합치기 절차는
// notify-conflicts.spec.ts 와 merge-queue-overlap.spec.ts 의 「계약 머리 자동 합치기」 가 본다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ConfigError } from '../scripts/lib/config.ts'
import { contractSettings, onlyContracts } from '../scripts/lib/contract-merge.ts'
import { BLOCK_END, BLOCK_START, reservedLine, reserveRequestsOf, withReservedBlock } from '../scripts/lib/spec-reserve.ts'

describe('contractSettings', () => {
  test('절이 없으면 null 이고 두 키가 있으면 명령과 정규식을 낸다', () => {
    assert.equal(contractSettings({}), null)
    const got = contractSettings({ contracts: { merge_command: 'python3 x.py', paths: ['^contracts/a\\.yaml$', '^contracts/b\\.yaml$'] } })
    assert.equal(got?.command, 'python3 x.py')
    assert.equal(got?.paths.test('contracts/b.yaml'), true)
    assert.equal(got?.paths.test('contracts/c.yaml'), false)
  })

  test('하나만 있거나 타입이 틀리거나 모르는 키가 있으면 설정 오류다', () => {
    assert.throws(() => contractSettings({ contracts: { merge_command: 'x' } }), ConfigError)
    assert.throws(() => contractSettings({ contracts: { paths: '^c/' } }), ConfigError)
    assert.throws(() => contractSettings({ contracts: { merge_command: ' ', paths: '^c/' } }), ConfigError)
    assert.throws(() => contractSettings({ contracts: { merge_command: 'x', paths: '(' } }), ConfigError)
    assert.throws(() => contractSettings({ contracts: { merge_command: 'x', paths: '^c/', extra: 1 } }), ConfigError)
  })

  test('충돌 파일이 하나 이상이고 모두 계약 파일일 때만 합친다', () => {
    const settings = { command: 'x', paths: /^contracts\// }
    assert.equal(onlyContracts(['contracts/a.yaml', 'contracts/b.yaml'], settings), true)
    assert.equal(onlyContracts(['contracts/a.yaml', 'docs/a.md'], settings), false)
    assert.equal(onlyContracts([], settings), false)
  })
})

describe('번호 예약 줄과 블록', () => {
  test('목록 기호와 굵은 글씨를 받고 이름은 띄어 써도 된다. 틀린 줄은 problems 에 든다', () => {
    const text = ['번호 예약: sql api care profile', '- **번호 예약:** `adr api tools`', '번호 예약: version api x', '번호 예약: java api'].join('\n')
    const got = reserveRequestsOf(text)
    assert.deepEqual(got.requests, [
      { kind: 'sql', module: 'api', name: 'care profile' },
      { kind: 'adr', module: 'api', name: 'tools' },
    ])
    assert.equal(got.problems.length, 2)
  })

  test('RESERVED 줄을 읽고 reused, renewed 꼬리는 뗀다', () => {
    assert.deepEqual(reservedLine('PRUNED a V1 b\nRESERVED api V7 db/V7__x.sql renewed\n'), { label: 'V7', path: 'db/V7__x.sql' })
    assert.equal(reservedLine('LOOKUP-FAIL x\n'), null)
  })

  test('블록은 마지막 요청 줄 뒤에 하나만 두고 다시 쓰면 바꾼다. 받은 번호가 없으면 옛 블록만 지운다', () => {
    const text = '# 일\n번호 예약: sql api a\n번호 예약: adr api b\n## 할 일\n'
    const once = withReservedBlock(text, [{ kind: 'sql', module: 'api', name: 'a', label: 'V1', path: 'p1' }])
    assert.equal(once, `# 일\n번호 예약: sql api a\n번호 예약: adr api b\n${BLOCK_START}\n잡아 준 번호(이 경로로 만들고 스스로 고르지 않는다):\n- sql api a: V1 \`p1\`\n${BLOCK_END}\n## 할 일\n`)
    assert.equal(reserveRequestsOf(once).requests.length, 2)
    const twice = withReservedBlock(once, [{ kind: 'sql', module: 'api', name: 'a', label: 'V2', path: 'p2' }])
    assert.equal(twice.split(BLOCK_START).length, 2)
    assert.ok(twice.includes('V2 `p2`') && !twice.includes('V1 `p1`'))
    assert.equal(withReservedBlock(once, []), text)
    assert.equal(withReservedBlock('# 요청 없음\n', [{ kind: 'sql', module: 'api', name: 'a', label: 'V1', path: 'p' }]), '# 요청 없음\n')
  })
})
