import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { alive, cwdHolders } from '../scripts/lib/process.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

let tmp: string

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lib-process-'))
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('alive', () => {
  test('자기 pid 는 살아 있다', () => {
    assert.equal(alive(process.pid), true)
  })

  test('끝난 자식 pid 는 죽었다', () => {
    const done = spawnSync(process.execPath, ['-e', ''])
    assert.equal(typeof done.pid, 'number')
    assert.equal(alive(done.pid as number), false)
  })

  test('process.kill 이 EPERM 을 내면 살아 있고 ESRCH 면 죽었다', (t) => {
    const kill = t.mock.method(process, 'kill', () => {
      throw errno('EPERM')
    })
    assert.equal(alive(4242), true)
    kill.mock.mockImplementation(() => {
      throw errno('ESRCH')
    })
    assert.equal(alive(4242), false)
  })

  test('정수가 아니거나 1 미만인 pid 는 process.kill 이 성공하더라도 false 다', (t) => {
    // process.kill(0, 0) 은 자기 프로세스 그룹에 보내져 늘 성공한다. 그 성공에 기대지 않는지 본다.
    t.mock.method(process, 'kill', () => true)
    for (const pid of [0, -1, 1.5, Number.NaN]) assert.equal(alive(pid), false, `pid ${pid} 가 살아 있다고 나왔다`)
  })
})

function withPath<T>(dir: string, action: () => T): T {
  const saved = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${saved ?? ''}`
  try {
    return action()
  } finally {
    process.env.PATH = saved
  }
}

describe('cwdHolders', () => {
  test('dir 과 그 하위를 쥔 프로세스만 pid 와 cwd 로 낸다. dir 은 실경로로 비교한다', () => {
    const target = join(tmp, 'wt')
    mkdirSync(target)
    const real = realpathSync(target)
    const bin = join(tmp, 'bin-ok')
    mkdirSync(bin)
    const listing = [
      'p100', 'fcwd', `n${real}`,
      'p200', 'fcwd', `n${real}/sub`,
      'p300', 'fcwd', `n${real}x`,
      'p400', 'fcwd', 'n/elsewhere',
    ].join('\n') + '\n'
    fakeBin(bin, 'lsof', [{ stdout: listing }])
    const r = withPath(bin, () => cwdHolders(target))
    assert.deepEqual(r, { ok: true, holders: [{ pid: 100, cwd: real }, { pid: 200, cwd: `${real}/sub` }] })
  })

  test('lsof 가 1 로 끝나면 맞는 프로세스가 없는 것이라 빈 목록이다', () => {
    const bin = join(tmp, 'bin-none')
    mkdirSync(bin)
    fakeBin(bin, 'lsof', [{ code: 1 }])
    assert.deepEqual(withPath(bin, () => cwdHolders(tmp)), { ok: true, holders: [] })
  })

  test('lsof 가 2 로 끝나면 ok: false 다', () => {
    const bin = join(tmp, 'bin-fail')
    mkdirSync(bin)
    fakeBin(bin, 'lsof', [{ code: 2, stderr: 'lsof: 실패' }])
    const r = withPath(bin, () => cwdHolders(tmp))
    assert.equal(r.ok, false)
  })

  test('lsof 를 실행하지 못하면 ok: false 다', () => {
    const empty = join(tmp, 'bin-empty')
    mkdirSync(empty)
    const saved = process.env.PATH
    process.env.PATH = empty
    try {
      assert.equal(cwdHolders(tmp).ok, false)
    } finally {
      process.env.PATH = saved
    }
  })

  // 건너뛰지 않는다. lsof 가 없는 환경에서 이 사례가 빠지면 실제 출력 형식을 읽는지 아무도 확인하지 않게 된다.
  // CI 의 ubuntu 이미지와 macOS 에는 lsof 가 있다.
  test('실제 lsof 로 임시 폴더를 작업 디렉터리로 띄운 자식을 찾는다', async () => {
    const lsof = spawnSync('lsof', ['-v'])
    assert.equal(lsof.error, undefined, `lsof 가 PATH 에 없다(PATH=${process.env.PATH}). 이 테스트는 실제 lsof 가 있어야 한다: ${lsof.error?.message}`)
    const dir = join(tmp, 'real')
    mkdirSync(dir)
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { cwd: dir })
    try {
      await new Promise((resolve) => child.stdout.once('data', resolve))
      const r = cwdHolders(dir)
      assert.equal(r.ok, true, !r.ok ? r.error : '')
      const found = r.ok ? r.holders.filter((h) => h.pid === child.pid) : []
      assert.deepEqual(found, [{ pid: child.pid, cwd: realpathSync(dir) }])
    } finally {
      child.kill('SIGKILL')
    }
  })
})
