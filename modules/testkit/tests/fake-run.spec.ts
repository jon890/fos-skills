import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fakeRun } from '../fake-run.ts'

describe('fakeRun', () => {
  it('명령 이름으로 묶음을 고른다', () => {
    const f = fakeRun({ gh: [{ stdout: 'g' }], git: [{ stdout: 'i', code: 2 }] })
    assert.deepEqual(f.run(['/usr/bin/gh', 'pr']), { code: 0, stdout: 'g', stderr: '', timedOut: false })
    assert.equal(f.run(['git']).code, 2)
  })

  it('맞는 규칙이 없으면 code 0 과 빈 출력이다', () => {
    const f = fakeRun({ gh: [{ args: ['pr'], stdout: 'x' }] })
    assert.deepEqual(f.run(['gh', 'issue']), { code: 0, stdout: '', stderr: '', timedOut: false })
    assert.deepEqual(f.run(['other']), { code: 0, stdout: '', stderr: '', timedOut: false })
  })

  it('calls 가 argv 와 opts 를 기록하고 setRules 가 묶음을 바꾼다', () => {
    const f = fakeRun({})
    f.run(['gh', 'a'], { cwd: '/x' })
    assert.deepEqual(f.calls(), [{ argv: ['gh', 'a'], opts: { cwd: '/x' } }])
    f.setRules('gh', [{ stdout: 'new' }])
    assert.equal(f.run(['gh']).stdout, 'new')
  })
})
