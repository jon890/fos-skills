// 가짜 실행 파일과 가짜 run() 이 같은 규칙에 같은 답을 내는지 사례 표로 본다
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCommand } from '../command.ts'
import { fakeBin, type FakeRule } from '../fake-bin.ts'
import { fakeRun } from '../fake-run.ts'
import { tempDir } from '../temp.ts'

const cases: { name: string; rules: FakeRule[]; args: string[]; expect: { stdout: string; stderr: string; code: number } }[] = [
  { name: '규칙 없음', rules: [], args: ['a'], expect: { stdout: '', stderr: '', code: 0 } },
  {
    name: '첫 규칙 우선',
    rules: [{ args: ['a'], stdout: 'first' }, { args: ['a'], stdout: 'second' }],
    args: ['a'],
    expect: { stdout: 'first', stderr: '', code: 0 },
  },
  { name: 'args 없는 규칙은 늘 맞는다', rules: [{ stdout: 'any', stderr: 'e', code: 3 }], args: ['z'], expect: { stdout: 'any', stderr: 'e', code: 3 } },
  { name: '일부만 맞는 규칙은 건너뛴다', rules: [{ args: ['a', 'b'], stdout: 'ab' }, { stdout: 'fallback' }], args: ['a'], expect: { stdout: 'fallback', stderr: '', code: 0 } },
  { name: '일부만 맞고 다른 규칙도 없다', rules: [{ args: ['a', 'b'], stdout: 'ab' }], args: ['a'], expect: { stdout: '', stderr: '', code: 0 } },
  { name: '모두 맞는 규칙', rules: [{ args: ['a', 'b'], stdout: 'ab', code: 1 }], args: ['b', 'x', 'a'], expect: { stdout: 'ab', stderr: '', code: 1 } },
]

describe('가짜 실행 파일과 가짜 run() 의 규칙', () => {
  for (const c of cases) {
    it(c.name, () => {
      const bin = fakeBin(tempDir(), 'tool', c.rules)
      const real = runCommand([bin.path, ...c.args])
      const fake = fakeRun({ tool: c.rules }).run(['tool', ...c.args])
      assert.deepEqual({ stdout: real.stdout, stderr: real.stderr, code: real.code }, c.expect)
      assert.deepEqual({ stdout: fake.stdout, stderr: fake.stderr, code: fake.code }, c.expect)
    })
  }
})
