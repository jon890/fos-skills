// colima_trim 의 명령 경계 테스트. colima 와 du 는 가짜 실행 파일이라 실제 VM 과 디스크를 건드리지 않는다.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox } from './helpers.ts'

const GIB = 1024 ** 3

// colima 가짜. 상태는 FAKE_CFG 가 가리키는 JSON 이고, df 호출 순서대로 used 를 돌려준다
const COLIMA = `const fs = require('node:fs')
const cfg = process.env.FAKE_CFG
const state = JSON.parse(fs.readFileSync(cfg, 'utf8'))
const argv = process.argv.slice(2)
fs.appendFileSync(cfg + '.calls', JSON.stringify(argv) + '\\n')
const next = (key) => {
  let n = 0
  try { n = Number(fs.readFileSync(cfg + '.' + key, 'utf8')) } catch {}
  fs.writeFileSync(cfg + '.' + key, String(n + 1))
  return n
}
const out = (text) => fs.writeSync(1, text)
if (argv[0] === 'status') process.exit(state.running ? 0 : 1)
if (argv.includes('df')) {
  const n = next('df')
  const used = state.used[Math.min(n, state.used.length - 1)]
  if (used === null) { fs.writeSync(2, 'df: no mount\\n'); process.exit(0) }
  out('       Used\\n' + used + '\\n')
  process.exit(0)
}
if (argv.includes('sh')) {
  next('trim')
  if (state.trimFail) { fs.writeSync(2, 'sudo: a password is required\\n'); process.exit(1) }
  out('/mnt/lima-colima: ' + state.trimmed + ' bytes trimmed\\n'.replace(' bytes', ' GiB (' + state.trimmed + ' bytes)'))
  process.exit(0)
}
`

type State = { running?: boolean; used?: (number | null)[]; trimFail?: boolean; trimmed?: number; duKb?: number }

function setup(state: State = {}) {
  const box = new Sandbox('mc-', [])
  const cfg = join(box.root, 'colima.json')
  const write = (next: State) =>
    writeFileSync(cfg, JSON.stringify({ running: true, used: [38 * GIB], trimFail: false, trimmed: 47028871168, ...next }))
  write(state)
  box.script('colima', COLIMA)
  const du = box.fake('du', [{ stdout: `${(state.duKb ?? 40 * 1024 * 1024)}\t/disk\n` }])
  const env = box.env({ FAKE_CFG: cfg })
  const run = (args: string[] = []) => box.run('colima_trim', ['--interval', '0', ...args], { env })
  const calls = () => {
    try {
      return readFileSync(`${cfg}.calls`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
    } catch {
      return []
    }
  }
  return { box, du, run, calls, write }
}

const sizeLine = (label: string, disk: string, used: string, gap: string) => new RegExp(`^${label}: 디스크 파일 ${disk}GiB, VM 사용량 ${used}GiB, 차이 ${gap}GiB, 호스트 여유 \\d+\\.\\dGiB$`)

describe('성공 경로', () => {
  test('차이가 기준값 이하이면 한 번 trim 하고 0 으로 끝난다', () => {
    const { run, calls } = setup({ used: [38 * GIB] })
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    const out = done.stdout.split('\n')
    assert.match(out[0], sizeLine('전', '40\\.0', '38\\.0', '2\\.0'))
    assert.equal(out[1], '시도 1: trim 43.8GiB')
    assert.match(out[2], /^ {2}측정: 디스크 파일 40\.0GiB, VM 사용량 38\.0GiB, 차이 2\.0GiB, 호스트 여유 \d+\.\dGiB$/)
    assert.match(out[3], sizeLine('후', '40\\.0', '38\\.0', '2\\.0'))
    assert.match(out[4], /^디스크 파일 40\.0GiB -> 40\.0GiB, 호스트 확보 -?\d+\.\dGiB$/)
    assert.equal(out.length, 6)
    assert.deepEqual(calls().map((c) => c.slice(0, 3).join(' ')), ['status -p default', 'ssh -p default', 'ssh -p default', 'ssh -p default'])
  })

  test('trim 은 sync 뒤에 fstrim -v 를 sh -c 로 돌리고 측정은 df -B1 --output=used 다', () => {
    const { run, calls } = setup()
    run()
    const [status, df1, trim, df2] = calls()
    assert.deepEqual(status, ['status', '-p', 'default'])
    assert.deepEqual(df1, ['ssh', '-p', 'default', '--', 'df', '-B1', '--output=used', '/mnt/lima-colima'])
    assert.deepEqual(trim, ['ssh', '-p', 'default', '--', 'sh', '-c', 'sync && sudo fstrim -v /mnt/lima-colima'])
    assert.deepEqual(df2, df1)
  })

  test('차이가 크면 기다렸다 다시 돌고 닫히면 0 이다', () => {
    const { run, calls } = setup({ used: [24 * GIB, 24 * GIB, 38 * GIB] })
    const done = run()
    assert.equal(done.code, 0, done.stderr)
    assert.ok(done.stdout.includes('시도 1: trim 43.8GiB\n'))
    assert.ok(done.stdout.includes('  차이가 기준값 4.0GiB 보다 커 0초 뒤 다시 돈다\n'))
    assert.ok(done.stdout.includes('시도 2: trim 43.8GiB\n'))
    assert.equal(calls().filter((c) => c.includes('sh')).length, 2)
  })

  test('trim 한 바이트 수의 합과 알아볼 수 없는 출력은 0GiB 다', () => {
    const { run, write } = setup()
    write({ trimmed: 0 })
    const done = run()
    assert.ok(done.stdout.includes('시도 1: trim 0.0GiB\n'))
  })
})

describe('종료 코드 2', () => {
  test('횟수 상한까지 차이가 남으면 2 이고 남은 차이를 stderr 로 알린다', () => {
    const { run } = setup({ used: [24 * GIB] })
    const done = run(['--max-attempts', '1'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('시도 1회 뒤에도 차이 16.0GiB 가 남았다(기준값 4.0GiB, 횟수 상한 1, 시간 상한 100초)\n'), done.stderr)
    assert.ok(done.stdout.includes('후: 디스크 파일 40.0GiB'))
  })

  test('시간 상한이 다음 시도를 막으면 횟수가 남아도 2 다', () => {
    const { run, calls } = setup({ used: [24 * GIB] })
    const done = run(['--max-seconds', '0', '--max-attempts', '4'])
    assert.equal(done.code, 2)
    assert.equal(calls().filter((c) => c.includes('sh')).length, 1)
    assert.ok(done.stderr.includes('시간 상한 0초'))
  })

  test('기준값은 소수 GiB 를 바이트로 내림해 쓴다', () => {
    const { run } = setup({ used: [24 * GIB] })
    const done = run(['--max-attempts', '1', '--threshold-gib', '0.5'])
    assert.ok(done.stderr.includes('기준값 0.5GiB'))
    const wide = setup({ used: [24 * GIB] }).run(['--threshold-gib=20'])
    assert.equal(wide.code, 0)
  })

  test('호스트 파일이 VM 사용량보다 작아 차이가 음수여도 다시 돌지 않는다', () => {
    const { run, calls } = setup({ used: [60 * GIB] })
    const done = run()
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('차이 -20.0GiB'))
    assert.equal(calls().filter((c) => c.includes('sh')).length, 1)
  })
})

describe('종료 코드 1', () => {
  test('Colima 가 꺼져 있으면 아무것도 하지 않고 1 이다', () => {
    const { run, calls } = setup({ running: false })
    const done = run()
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '')
    assert.equal(done.stderr, 'Colima 프로필 default 가 떠 있지 않다. 아무것도 하지 않았다.\n')
    assert.deepEqual(calls(), [['status', '-p', 'default']])
  })

  test('colima 가 PATH 에 없어도 꺼진 것으로 본다', () => {
    const box = new Sandbox('mc-', [])
    const done = box.run('colima_trim', [])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('Colima 프로필 default 가 떠 있지 않다'))
  })

  test('fstrim 이 실패하면 1 이다', () => {
    const { run } = setup({ trimFail: true })
    const done = run()
    assert.equal(done.code, 1)
    assert.equal(done.stderr, 'fstrim 실패: sudo: a password is required\n')
    assert.ok(done.stdout.startsWith('전: '))
  })

  test('df 출력에서 사용량을 읽지 못하면 측정 실패로 1 이다', () => {
    const { run } = setup({ used: [null] })
    const done = run()
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '')
    assert.equal(done.stderr, `측정 실패: du=${40 * GIB} df=df: no mount\n`)
  })

  test('du 출력을 읽지 못해도 측정 실패다', () => {
    const { run, du } = setup()
    du.setRules([{ stdout: 'du: cannot access\n' }])
    const done = run()
    assert.equal(done.code, 1)
    assert.ok(done.stderr.startsWith('측정 실패: du=None df='))
  })
})

describe('프로필과 디스크 경로', () => {
  test('프로필 이름은 colima 의 -p 로 가고 디스크 폴더 이름이 바뀐다', () => {
    const { run, calls, du, box } = setup()
    run(['--profile', 'dev'])
    assert.deepEqual(calls()[0], ['status', '-p', 'dev'])
    assert.deepEqual(du.calls()[0].argv, ['-sk', join(box.home, '.colima/_lima/_disks/colima-dev/datadisk')])
    assert.ok(calls().every((c) => c.includes('dev')))
  })

  test('기본 프로필의 디스크는 colima 폴더다', () => {
    const { run, du, box } = setup()
    run()
    assert.deepEqual(du.calls()[0].argv, ['-sk', join(box.home, '.colima/_lima/_disks/colima/datadisk')])
  })

  test('--disk 는 ~ 를 홈으로 풀고 프로필보다 앞선다', () => {
    const { run, du, box } = setup()
    run(['--profile', 'dev', '--disk', '~/d/disk'])
    assert.deepEqual(du.calls()[0].argv, ['-sk', join(box.home, 'd/disk')])
  })

  test('--disk 가 빈 문자열이면 프로필의 기본 경로를 쓴다', () => {
    const { run, du, box } = setup()
    run(['--disk', ''])
    assert.deepEqual(du.calls()[0].argv, ['-sk', join(box.home, '.colima/_lima/_disks/colima/datadisk')])
  })
})

describe('옵션 읽기', () => {
  test('옵션은 접두로 줄이고 =로 값을 준다', () => {
    const { run, calls } = setup()
    const done = run(['--prof=dev', '--max-a', '2', '--thr', '3'])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(calls()[0], ['status', '-p', 'dev'])
  })

  test('모호한 접두와 모르는 옵션과 잘못된 값은 사용법 오류 2 다', () => {
    const { run } = setup()
    for (const args of [['--max'], ['--nope'], ['--max-attempts', '2.5'], ['--interval=abc'], ['--threshold-gib', 'x'], ['--max-seconds'], ['extra']]) {
      const done = run(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.equal(done.stdout, '')
    }
    const ambiguous = run(['--max'])
    assert.ok(ambiguous.stderr.includes('ambiguous option: --max could match --max-attempts, --max-seconds'), ambiguous.stderr)
  })

  test('거듭 준 값 옵션은 마지막 값이다', () => {
    const { run, calls } = setup()
    run(['--profile', 'a', '--profile', 'b'])
    assert.deepEqual(calls()[0], ['status', '-p', 'b'])
  })

  test('-h 와 --help 는 도움말을 내고 0 으로 끝난다', () => {
    const { run, calls } = setup()
    const done = run(['--help'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('usage: '))
    assert.deepEqual(calls(), [])
  })
})
