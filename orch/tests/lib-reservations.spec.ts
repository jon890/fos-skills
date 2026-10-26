// lib/reservations.ts 의 예약 판정을 본다. 판정 함수는 입력만 받으므로 가짜 프로세스 없이 함수만 부른다.
// 파일 읽기와 쓰기는 git 밖의 임시 폴더를 ORCH_DIR 로 두고 본다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { addedPaths, choose, nextVersion, prune, readReservations, reservationsFile, slug, writeReservations } from '../scripts/lib/reservations.ts'
import type { Migration } from '../scripts/lib/auto-merge.ts'
import type { Reservation } from '../scripts/lib/reservations.ts'

const AT = '2026-10-27T00:00:00.000Z'
const NOW = '2026-10-27T01:00:00.000Z'

function mig(module: string, label: string): Migration {
  return { module, version: label.slice(1).split(/[._]/).map(Number), label, path: `db/${module}/${label}__x.sql` }
}

function res(branch: string, label: string, name = 'x', module = 'api'): Reservation {
  return { module, version: label.slice(1).split(/[._]/).map(Number), label, branch, name, path: `db/${module}/${label}__${name}.sql`, at: AT }
}

// base 최고 V12, 다른 브랜치 feat-b 의 열린 PR V13, 다른 브랜치 feat-c 의 예약 V14
function input(extra: Partial<Parameters<typeof choose>[0]> = {}): Parameters<typeof choose>[0] {
  return {
    module: 'api',
    name: 'add index',
    branch: 'feat-a',
    again: false,
    dir: 'db/api',
    at: NOW,
    baseMax: mig('api', 'V12'),
    open: [{ branch: 'feat-b', migrations: [mig('api', 'V13')] }],
    reservations: [res('feat-c', 'V14')],
    ...extra,
  }
}

describe('slug', () => {
  test('공백은 _ 로, 대문자는 소문자로 바꾼다', () => {
    assert.equal(slug('Add user index'), 'add_user_index')
  })

  test('- 는 _ 로 바꾸고 그 밖의 글자는 지운다', () => {
    assert.equal(slug('drop-old (table)!'), 'drop_old_table')
  })

  test('한글만 있으면 비어 Error 다', () => {
    assert.throws(() => slug('한글만'), /빈다/)
  })
})

describe('nextVersion', () => {
  test('그 모듈의 첫 자리 최대값에 1 을 더한다. 다른 모듈은 세지 않는다', () => {
    assert.deepEqual(nextVersion('api', [mig('api', 'V12'), mig('api', 'V3'), mig('web', 'V40')]), { version: [13], label: 'V13' })
  })

  test('그 모듈 것이 없으면 V1 이다', () => {
    assert.deepEqual(nextVersion('api', [mig('web', 'V40')]), { version: [1], label: 'V1' })
  })

  test('V1_2 만 있으면 V2 다', () => {
    assert.deepEqual(nextVersion('api', [mig('api', 'V1_2')]), { version: [2], label: 'V2' })
  })
})

describe('choose', () => {
  test('base 최고, 다른 브랜치의 열린 PR, 다른 브랜치의 예약을 모두 넘는다', () => {
    const got = choose(input())
    assert.deepEqual(got.reservation, {
      module: 'api',
      version: [15],
      label: 'V15',
      branch: 'feat-a',
      name: 'add_index',
      path: 'db/api/V15__add_index.sql',
      at: NOW,
    })
    assert.equal(got.reused, false)
    assert.equal(got.renewed, false)
    assert.deepEqual(got.list, [res('feat-c', 'V14'), got.reservation])
  })

  test('같은 브랜치, 모듈, 설명이면 그 예약을 그대로 준다', () => {
    const mine = res('feat-a', 'V15', 'add_index')
    const reservations = [res('feat-c', 'V14'), mine]
    const got = choose(input({ reservations }))
    assert.equal(got.reused, true)
    assert.equal(got.renewed, false)
    assert.deepEqual(got.reservation, mine)
    assert.equal(got.list, reservations)
  })

  test('again 이면 그 예약을 빼고 다시 정한다. 다른 것이 그대로면 같은 번호가 나온다', () => {
    const mine = res('feat-a', 'V15', 'add_index')
    const got = choose(input({ again: true, reservations: [res('feat-c', 'V14'), mine] }))
    assert.equal(got.reused, false)
    assert.equal(got.renewed, false)
    assert.equal(got.reservation.label, 'V15')
    assert.equal(got.reservation.at, NOW)
    assert.deepEqual(got.list, [res('feat-c', 'V14'), got.reservation])
  })

  test('again 에서 같은 브랜치 PR 이 그 예약으로 만든 파일 하나는 세지 않는다', () => {
    const mine = res('feat-a', 'V15', 'add_index')
    const open = [...input().open, { branch: 'feat-a', migrations: [mig('api', 'V15')] }]
    const got = choose(input({ again: true, open, reservations: [res('feat-c', 'V14'), mine] }))
    assert.equal(got.reservation.label, 'V15')
  })

  test('같은 브랜치 PR 이 예약 없이 만든 파일은 센다', () => {
    const mine = res('feat-a', 'V15', 'add_index')
    const open = [...input().open, { branch: 'feat-a', migrations: [mig('api', 'V15'), mig('api', 'V16')] }]
    const got = choose(input({ again: true, open, reservations: [res('feat-c', 'V14'), mine] }))
    assert.equal(got.reservation.label, 'V17')
  })

  test('같은 브랜치의 다른 설명 예약도 세어 다음 번호를 받는다', () => {
    const other = res('feat-a', 'V15', 'other')
    const got = choose(input({ reservations: [res('feat-c', 'V14'), other] }))
    assert.equal(got.reservation.label, 'V16')
    assert.deepEqual(got.list, [res('feat-c', 'V14'), other, got.reservation])
  })

  test('다시 줄 예약이 base 최고 이하가 됐으면 새로 정하고 renewed 다', () => {
    const mine = res('feat-a', 'V13', 'add_index')
    const got = choose(input({ baseMax: mig('api', 'V13'), open: [], reservations: [mine] }))
    assert.equal(got.reused, false)
    assert.equal(got.renewed, true)
    assert.equal(got.reservation.label, 'V14')
    assert.deepEqual(got.list, [got.reservation])
  })

  test('다시 줄 예약이 다른 브랜치의 열린 PR 과 같은 번호면 renewed 다', () => {
    const mine = res('feat-a', 'V13', 'add_index')
    const got = choose(input({ reservations: [mine] }))
    assert.equal(got.renewed, true)
    assert.equal(got.reservation.label, 'V14')
  })

  test('다시 줄 예약이 다른 예약과 같은 번호면 renewed 다', () => {
    const mine = res('feat-a', 'V14', 'add_index')
    const got = choose(input({ reservations: [res('feat-c', 'V14'), mine] }))
    assert.equal(got.renewed, true)
    assert.equal(got.reservation.label, 'V15')
  })

  test('같은 브랜치의 열린 PR 에 같은 번호가 있는 것은 그 예약의 파일이라 다시 준다', () => {
    const mine = res('feat-a', 'V15', 'add_index')
    const open = [...input().open, { branch: 'feat-a', migrations: [mig('api', 'V15')] }]
    const got = choose(input({ open, reservations: [res('feat-c', 'V14'), mine] }))
    assert.equal(got.reused, true)
    assert.deepEqual(got.reservation, mine)
  })

  test('다른 모듈의 번호는 세지 않는다', () => {
    const got = choose(input({ baseMax: null, open: [{ branch: 'feat-b', migrations: [mig('web', 'V40')] }], reservations: [res('feat-c', 'V9', 'x', 'web')] }))
    assert.equal(got.reservation.label, 'V1')
  })
})

describe('prune', () => {
  test('gone 이 true 인 항목만 지우고 false 와 null 은 남긴다', () => {
    const list = [res('gone', 'V1'), res('live', 'V2'), res('unknown', 'V3')]
    const verdict: Record<string, boolean | null> = { gone: true, live: false, unknown: null }
    const got = prune(list, (r) => verdict[r.branch])
    assert.deepEqual(got.removed, [res('gone', 'V1')])
    assert.deepEqual(got.kept, [res('live', 'V2'), res('unknown', 'V3')])
  })
})

describe('addedPaths', () => {
  test('MODIFIED 와 DELETED 는 빠지고 changeType 이 없는 행은 든다', () => {
    const files = [
      { path: 'a.sql', changeType: 'ADDED' },
      { path: 'b.sql', changeType: 'MODIFIED' },
      { path: 'c.sql' },
      { path: 'd.sql', changeType: 'RENAMED' },
      { path: 'e.sql', changeType: 'COPIED' },
      { path: 'f.sql', changeType: 'DELETED' },
      { changeType: 'ADDED' },
    ]
    assert.deepEqual(addedPaths(files), ['a.sql', 'c.sql', 'd.sql', 'e.sql'])
  })

  test('목록이 아니면 빈 목록이다', () => {
    assert.deepEqual(addedPaths(null), [])
  })
})

describe('readReservations 와 writeReservations', () => {
  let tmp: string
  let saved: string | undefined
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-reservations-')))
    saved = process.env.ORCH_DIR
    process.env.ORCH_DIR = join(tmp, 'orch')
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.ORCH_DIR
    else process.env.ORCH_DIR = saved
    rmSync(tmp, { recursive: true, force: true })
  })

  function put(text: string): void {
    mkdirSync(dirname(reservationsFile(tmp)), { recursive: true })
    writeFileSync(reservationsFile(tmp), text)
  }

  test('파일이 없으면 빈 목록이다', () => {
    assert.deepEqual(readReservations(tmp), { list: [], skipped: 0 })
  })

  test('쓴 목록을 그대로 읽고 옆 파일을 남기지 않는다', () => {
    const list = [res('feat-a', 'V3'), res('feat-b', 'V1_2')]
    writeReservations(tmp, list)
    assert.deepEqual(readReservations(tmp), { list, skipped: 0 })
    assert.deepEqual(JSON.parse(readFileSync(reservationsFile(tmp), 'utf8')), { reservations: list })
    assert.equal(existsSync(`${reservationsFile(tmp)}.${process.pid}.tmp`), false)
  })

  test('rename 이 실패하면 옆 파일을 지우고 오류를 던진다', () => {
    // 예약 파일 자리에 비지 않은 폴더가 있으면 rename 이 실패한다
    mkdirSync(join(reservationsFile(tmp), 'x'), { recursive: true })
    assert.throws(() => writeReservations(tmp, [res('feat-a', 'V3')]), (e: NodeJS.ErrnoException) => typeof e.code === 'string')
    assert.equal(existsSync(`${reservationsFile(tmp)}.${process.pid}.tmp`), false, '옆 파일이 남았다')
  })

  test('형식이 틀린 항목은 건너뛰고 센다', () => {
    put(JSON.stringify({ reservations: [res('feat-a', 'V3'), { module: 'api' }, { ...res('feat-b', 'V4'), version: [] }] }))
    assert.deepEqual(readReservations(tmp), { list: [res('feat-a', 'V3')], skipped: 2 })
  })

  test('JSON 이 아니거나 최상위가 틀리면 Error 다', () => {
    put('{')
    assert.throws(() => readReservations(tmp), /JSON 이 아니다/)
    put('[]')
    assert.throws(() => readReservations(tmp), /최상위/)
  })
})
