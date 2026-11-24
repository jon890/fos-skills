// hs_delete.ts 가 승인한 것만, 지우기 직전에 다시 확인한 뒤 지우는지 본다(스펙 REQ7, REQ9, REQ10).

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Repo, Sandbox, write } from './helpers.ts'
import { applyArgs, DAY, fakeProc, hermesDb, nowSec, sampleConfig } from './hs-helpers.ts'
import { keptReason, parseImageItem } from '../scripts/hs_delete.ts'

const LOCKED = { FOS_INFRA_LOCK_HELD: '1' }
const RULES = '## 백업\n\n| 용도 | 무엇 | 누가 | 보관 |\n| --- | --- | --- | --- |\n' +
  '| `ops/` | 운영 작업 | ops.sh | 결과 검토 뒤 명시적 정리로 최신 2개 |\n| `db/` | 덤프 | s | 최신 7개 |\n| `mixed/` | 구성 | d.sh | 명시적 정리로 서비스별 최신 1개 |\n'

// 상태를 가진 가짜 docker. FAKE_DOCKER_STATE 파일의 { psFails, inspectFails, used: [이미지ID], images: { 이름: [ID, 태그...] }, onRm: { 이름: 쓰게 될 ID } }
// 를 읽고, image rm 을 기록한다. onRm 은 그 이미지를 지운 뒤 다른 이미지를 컨테이너가 쓰게 되는 경우를 흉내 낸다
const DOCKER = `
const fs = require('node:fs')
const file = process.env.FAKE_DOCKER_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const a = process.argv.slice(2)
const save = () => fs.writeFileSync(file, JSON.stringify(st))
if (a[0] === 'ps') { if (st.psFails) process.exit(1); console.log(st.used.length ? 'c1' : ''); process.exit(0) }
if (a[0] === 'inspect') { if (st.inspectFails) process.exit(1); console.log(st.used.join('\\n')); process.exit(0) }
if (a[0] === 'image' && a[1] === 'inspect') {
  const img = st.images[a[a.length - 1]]
  if (!img) { process.stderr.write('No such image'); process.exit(1) }
  console.log(img.join(' ')); process.exit(0)
}
if (a[0] === 'image' && a[1] === 'rm') {
  st.removed = [...(st.removed || []), a[2]]
  if (st.onRm && st.onRm[a[2]]) st.used.push(st.onRm[a[2]])
  delete st.images[a[2]]; save(); process.exit(0)
}
if (a.includes('prune')) { st.pruned = true; save() }
`

const ID = (c: string) => `sha256:${c.repeat(64)}`

describe('이미지(REQ7)', () => {
  function setup(state: Record<string, unknown>) {
    const box = new Sandbox('hsd-')
    box.script('docker', DOCKER)
    const file = write(join(box.root, 'docker.json'), JSON.stringify({ used: [ID('a')], images: { 'app:1': [ID('a'), 'app:1'], 'app:0': [ID('b'), 'app:0'], 'app:2': [ID('c'), 'app:2'] }, ...state }))
    const env = (extra: Record<string, string> = {}) => box.env({ FAKE_DOCKER_STATE: file, ...extra })
    const state_ = () => JSON.parse(readFileSync(file, 'utf8'))
    return { box, env, state: state_ }
  }

  test('dry-run 은 지울 목록만 보이고 아무것도 지우지 않는다', () => {
    const { box, env, state } = setup({})
    const r = box.run('hs_delete', ['images', `app:0=${ID('b')}`, `app:1=${ID('a')}`], { env: env() })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /지울 것 app:0/)
    assert.match(r.stdout, /남김 app:1: 컨테이너가 쓰는 중/)
    assert.equal(state().removed, undefined)
  })

  test('쓰는 중인 이미지는 남기고, 없는 이름은 실패로 세며, prune 은 부르지 않는다', () => {
    const { box, env, state } = setup({})
    const r = box.run('hs_delete', ['images', ...applyArgs(box), `app:0=${ID('b')}`, `app:1=${ID('a')}`, `gone:1=${ID('d')}`], { env: env(LOCKED) })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /지움 1개, 남김 1개, 실패 0개, 없음 1개/)
    assert.deepEqual(state().removed, ['app:0'])
    assert.equal(state().pruned, undefined)
  })

  test('컨테이너 조회(ps 나 inspect)가 실패하면 그 이미지는 건너뛴다', () => {
    for (const fail of [{ psFails: true }, { inspectFails: true }]) {
      const { box, env, state } = setup(fail)
      const r = box.run('hs_delete', ['images', ...applyArgs(box), `app:0=${ID('b')}`], { env: env(LOCKED) })
      assert.match(r.stdout, /건너뜀 app:0: 컨테이너가 쓰는 이미지를 읽지 못함/)
      assert.equal(state().removed, undefined)
    }
  })

  test('조사 뒤 태그가 다른 이미지를 가리키면 건너뛰고, ID 없이 태그만 넘기면 거부한다', () => {
    const { box, env, state } = setup({})
    const r = box.run('hs_delete', ['images', ...applyArgs(box), `app:0=${ID('e')}`, 'app:2'], { env: env(LOCKED) })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /건너뜀 app:0: 조사 뒤 다른 이미지를 가리킨다/)
    assert.match(r.stderr, /거부 app:2/)
    assert.equal(state().removed, undefined)
  })

  test('앞 이미지를 지우는 동안 뒤 이미지를 컨테이너가 쓰게 되면 남긴다', () => {
    const { box, env, state } = setup({ onRm: { 'app:0': ID('c') } })
    const r = box.run('hs_delete', ['images', ...applyArgs(box), `app:0=${ID('b')}`, `app:2=${ID('c')}`], { env: env(LOCKED) })
    assert.match(r.stdout, /남김 app:2: 컨테이너가 쓰는 중/)
    assert.deepEqual(state().removed, ['app:0'])
  })

  test('지금 이미지 ID 조회가 성공 코드와 빈 값을 내면 건너뛴다(리뷰 P2)', () => {
    const { box, env, state } = setup({ images: { 'app:0': [] } })
    const r = box.run('hs_delete', ['images', ...applyArgs(box), `app:0=${ID('b')}`], { env: env(LOCKED) })
    assert.match(r.stdout, /건너뜀 app:0: 지금 이미지 ID 를 읽지 못함/)
    assert.equal(state().removed, undefined)
  })

  test('잠금 없이 --apply 하면 지우지 않고 4 로 끝난다', () => {
    const { box, env, state } = setup({})
    assert.equal(box.run('hs_delete', ['images', ...applyArgs(box), `app:0=${ID('b')}`], { env: env() }).code, 4)
    assert.equal(state().removed, undefined)
  })

  test('승인 항목 꼴을 읽는다', () => {
    assert.deepEqual(parseImageItem(`a:1=${ID('b')}`), ['a:1', ID('b')])
    assert.deepEqual(parseImageItem(`localhost:5000/a:1=${ID('b')}`), ['localhost:5000/a:1', ID('b')])
    assert.deepEqual(parseImageItem(ID('b')), [ID('b'), ID('b')])
    assert.equal(parseImageItem('a:1'), null)
  })

  test('다른 이름이 가리키거나 컨테이너가 쓰는 거절은 남김으로 본다', () => {
    assert.ok(keptReason('conflict: unable to delete abc (must be forced) - image is referenced in multiple repositories'))
    assert.ok(keptReason('conflict: unable to delete 2e (must be forced) - image is being used by stopped container 1f'))
    assert.equal(keptReason('Error response from daemon: no such image'), null)
  })
})

describe('백업과 휴지통(REQ7)', () => {
  test('용도 이름 꼴이 아니거나 링크면 거부하고, 승인한 용도만 지운다', () => {
    const box = new Sandbox('hsd-')
    const cfg = sampleConfig(box.root)
    const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
    write(join(cfg.checkout, cfg.backup.rules), RULES)
    write(join(cfg.backup.root, 'oneoff/x'), 'x')
    write(join(cfg.backup.root, 'keep/x'), 'x')
    const r = box.run('hs_delete', ['backup', '--config', cfgFile, ...applyArgs(box), 'oneoff', '../keep', ''], { env: box.env(LOCKED) })
    assert.equal(r.code, 1)
    assert.ok(!existsSync(join(cfg.backup.root, 'oneoff')))
    assert.ok(existsSync(join(cfg.backup.root, 'keep/x')))
  })

  // 가상 백업 루트. ops 는 명시적 정리로 최신 2개, db 는 매일 정리가 소유, mixed 는 한 폴더에 서비스가 섞인 명시적 정리다
  function backups() {
    const box = new Sandbox('hsd-')
    const cfg = sampleConfig(box.root)
    const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
    write(join(cfg.checkout, cfg.backup.rules), RULES)
    const base = nowSec() - 10 * DAY
    for (const [i, name] of ['d1', 'd2', 'd3', 'd4'].entries()) {
      const dir = join(cfg.backup.root, 'ops', name)
      write(join(dir, 'x'), name)
      utimesSync(dir, base + i * DAY, base + i * DAY)
    }
    write(join(cfg.backup.root, 'db/a/x'), 'a')
    write(join(cfg.backup.root, 'mixed/a/x'), 'a')
    const run = (args: string[]) => box.run('hs_delete', ['backup', '--config', cfgFile, ...args], { env: box.env(LOCKED) })
    return { box, cfg, run, ops: (name: string) => join(cfg.backup.root, 'ops', name) }
  }

  test('--keep N 이면 최신 N개를 남기고 오래된 항목만 지운다(묶음 8)', () => {
    const b = backups()
    const dry = b.run(['--keep', '2', 'ops'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /남김 ops: 최신 2개, 지울 것 2개/)
    assert.match(dry.stdout, /지울 것 .*ops\/d1\n지울 것 .*ops\/d2\n/)
    assert.ok(existsSync(b.ops('d1')))
    const done = b.run(['--keep', '2', ...applyArgs(b.box), 'ops'])
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(['d1', 'd2', 'd3', 'd4'].map((n) => existsSync(b.ops(n))), [false, false, true, true])
    assert.ok(existsSync(join(b.cfg.backup.root, 'ops')))
  })

  test('명시적 정리 용도는 --keep 이 없거나 규칙보다 적으면 폴더째 지우지 않는다(묶음 8)', () => {
    const b = backups()
    const bare = b.run([...applyArgs(b.box), 'ops'])
    assert.equal(bare.code, 1)
    assert.match(bare.stderr, /거부 ops: 보관 규칙이 남길 개수를 정한다\(결과 검토 뒤 명시적 정리로 최신 2개\)\. --keep 2 으로 넘긴다/)
    const few = b.run(['--keep', '1', ...applyArgs(b.box), 'ops'])
    assert.equal(few.code, 1)
    assert.match(few.stderr, /--keep 1 이 보관 규칙의 2개보다 적다/)
    assert.ok(['d1', 'd2', 'd3', 'd4'].every((n) => existsSync(b.ops(n))))
  })

  test('자동 정리가 소유한 용도와 서비스가 섞인 용도는 거부한다', () => {
    const b = backups()
    const r = b.run(['--keep', '5', ...applyArgs(b.box), 'db', 'mixed'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /거부 db: 자동 정리가 소유한다\(최신 7개\)/)
    assert.match(r.stderr, /거부 mixed: 한 폴더에 여러 대상이 섞여 개수로 지우지 않는다/)
    assert.ok(existsSync(join(b.cfg.backup.root, 'db/a/x')) && existsSync(join(b.cfg.backup.root, 'mixed/a/x')))
  })

  test('보관 규칙 표를 읽지 못하면 --keep 없이 폴더째 지우지 않는다', () => {
    const b = backups()
    rmSync(join(b.cfg.checkout, b.cfg.backup.rules))
    const r = b.run([...applyArgs(b.box), 'ops'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /거부 ops: 보관 규칙 표를 읽지 못해 폴더째 지우지 않는다/)
    assert.ok(existsSync(b.ops('d1')))
  })

  test('--keep 은 backup 에만, 1 이상의 정수로 받는다', () => {
    const b = backups()
    assert.equal(b.run(['--keep', '0', 'ops']).code, 2)
    assert.equal(b.run(['--keep', 'x', 'ops']).code, 2)
    assert.equal(b.box.run('hs_delete', ['trash', '--keep', '1', 'f']).code, 2)
  })

  test('휴지통 항목은 files 와 info 를 함께 지운다', () => {
    const box = new Sandbox('hsd-')
    const info = write(join(box.home, '.local/share/Trash/info/f.trashinfo'), '[Trash Info]\n')
    const file = write(join(box.home, '.local/share/Trash/files/f'), 'x')
    assert.match(box.run('hs_delete', ['trash', 'f']).stdout, /지울 것 f/)
    assert.ok(existsSync(file))
    assert.equal(box.run('hs_delete', ['trash', ...applyArgs(box), 'f']).code, 0)
    assert.ok(!existsSync(file) && !existsSync(info))
  })
})

describe('워크트리(REQ9)', () => {
  function setup(busy: boolean) {
    const box = new Sandbox('hsd-')
    const repo = new Repo(join(box.root, 'ops'))
    const tip = repo.commit('init', 1_700_000_000)
    repo.git('branch', 'done')
    const wt = join(box.root, 'wt')
    repo.git('worktree', 'add', '-q', wt, 'done')
    const real = repo.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))[1].slice(9)
    fakeProc(box.root, [{ pid: 20, uid: process.getuid!(), cwd: busy ? join(real, 'x') : box.home }])
    const survey = write(join(box.root, 'git.json'), JSON.stringify([{ repo: repo.dir, base: 'origin/main', worktrees: [{ path: real, class: '제거 후보', tip }], branches: [] }]))
    return { box, survey, real }
  }

  test('안에서 도는 프로세스가 있으면 남긴다', () => {
    const { box, survey, real } = setup(true)
    const r = box.run('hs_delete', ['worktrees', '--survey', survey, ...applyArgs(box), real], { env: box.env({ ...LOCKED, HS_ROOT: box.root }) })
    assert.match(r.stdout, /남김 .*: 안에서 도는 프로세스가 있다/)
    assert.ok(existsSync(real))
  })

  test('쓰는 프로세스가 없으면 지운다. 조사 파일에 없는 경로는 거부한다', () => {
    const { box, survey, real } = setup(false)
    const r = box.run('hs_delete', ['worktrees', '--survey', survey, ...applyArgs(box), real, join(box.root, 'other')], { env: box.env({ ...LOCKED, HS_ROOT: box.root }) })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /지움 /)
    assert.match(r.stderr, /거부 .*other: 조사 파일의 제거 후보가 아니다/)
    assert.ok(!existsSync(real))
  })
})

// 가짜 Hermes 삭제: 그 profile DB 에서 세션과 자식을 지운다
const HERMES_DELETE = `
const { DatabaseSync } = require('node:sqlite')
const [profile, session] = process.argv.slice(2)
const data = process.env.FAKE_HERMES_DATA
const db = new DatabaseSync(profile === 'default' ? data + '/state.db' : data + '/profiles/' + profile + '/state.db')
db.prepare('DELETE FROM sessions WHERE id = ? OR parent_session_id = ?').run(session, session)
db.close()
`

describe('Hermes 세션(REQ10)', () => {
  function setup() {
    const box = new Sandbox('hsd-')
    const cfg = sampleConfig(box.root)
    const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
    const old = nowSec() - 40 * DAY
    const db = join(cfg.hermes.data, 'state.db')
    hermesDb(db, [['a', null, 'cron', old], ['a1', 'a', 'cron', old], ['b', null, 'api', old], ['linked-1', null, 'api', old]])
    box.script('hermes-delete', HERMES_DELETE)
    const linked = box.fake('linked-sessions', [{ stdout: 'linked-1\n' }])
    const env = box.env({ FAKE_HERMES_DATA: cfg.hermes.data })
    const ids = () => {
      const d = new DatabaseSync(db, { readOnly: true })
      const out = (d.prepare('SELECT id FROM sessions ORDER BY id').all() as any[]).map((r) => r.id)
      d.close()
      return out
    }
    return { box, cfgFile, db, env, linked, ids }
  }

  test('후보 트리를 지우고 연결된 세션이 남았는지 확인한다', () => {
    const h = setup()
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, ...applyArgs(h.box), 'default:a'], { env: h.env })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /연결된 세션 1개가 모두 남음/)
    assert.match(r.stdout, /세션 DB 크기 default: [\d.]+M\. 공간 회수는 Hermes 를 멈춘 점검 시간에 사용자가 한다/)
    assert.deepEqual(h.ids(), ['b', 'linked-1'])
  })

  test('조사 뒤 트리 안의 세션이 연결되면 그 루트를 지우지 않는다', () => {
    const h = setup()
    h.linked.setRules([{ stdout: 'linked-1\na1\n' }])
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, ...applyArgs(h.box), 'default:a'], { env: h.env })
    assert.match(r.stdout, /건너뜀 default:a/)
    assert.deepEqual(h.ids(), ['a', 'a1', 'b', 'linked-1'])
  })

  test('조사 뒤 트리 안의 세션이 최근에 활동하면 지우지 않는다', () => {
    const h = setup()
    const d = new DatabaseSync(h.db)
    d.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(nowSec(), 'a1')
    d.close()
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, ...applyArgs(h.box), 'default:a'], { env: h.env })
    assert.match(r.stdout, /건너뜀 default:a/)
    assert.ok(h.ids().includes('a'))
  })

  test('연결 목록을 다시 읽지 못하면 아무것도 지우지 않는다', () => {
    const h = setup()
    h.linked.setRules([{ code: 1, stderr: 'db down' }])
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, ...applyArgs(h.box), 'default:a', 'default:b'], { env: h.env })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /다시 읽기 실패로 남은 2개를 지우지 않는다/)
    assert.equal(h.ids().length, 4)
  })
})

// 연결 목록을 파일에서 읽는 가짜 조회와, 지우는 동안 다른 트리를 연결시키는 가짜 삭제
const LINKED_FROM_FILE = `
const fs = require('node:fs')
process.stdout.write(fs.readFileSync(process.env.FAKE_LINKED, 'utf8'))
`
const DELETE_AND_LINK = `
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const [profile, session] = process.argv.slice(2)
const db = new DatabaseSync(process.env.FAKE_HERMES_DATA + '/state.db')
db.prepare('DELETE FROM sessions WHERE id = ? OR parent_session_id = ?').run(session, session)
db.close()
if (session === 'a') fs.appendFileSync(process.env.FAKE_LINKED, 'b\\n')
`

describe('Hermes 세션을 루트마다 다시 확인한다(REQ10, 리뷰 P1)', () => {
  test('앞 트리를 지우는 동안 뒤 트리가 연결되면 뒤 트리는 건너뛰고 연결 세션이 남는다', () => {
    const box = new Sandbox('hsd-')
    const cfg = sampleConfig(box.root)
    const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
    const old = nowSec() - 40 * DAY
    hermesDb(join(cfg.hermes.data, 'state.db'), [['a', null, 'cron', old], ['b', null, 'cron', old]])
    const linked = write(join(box.root, 'linked.txt'), '')
    box.script('linked-sessions', LINKED_FROM_FILE)
    box.script('hermes-delete', DELETE_AND_LINK)
    const r = box.run('hs_delete', ['hermes', '--config', cfgFile, ...applyArgs(box), 'default:a', 'default:b'], { env: box.env({ FAKE_HERMES_DATA: cfg.hermes.data, FAKE_LINKED: linked }) })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /지움 default:a/)
    assert.match(r.stdout, /건너뜀 default:b/)
    assert.match(r.stdout, /연결된 세션 1개가 모두 남음/)
    const d = new DatabaseSync(join(cfg.hermes.data, 'state.db'), { readOnly: true })
    assert.deepEqual((d.prepare('SELECT id FROM sessions').all() as any[]).map((x) => x.id), ['b'])
    d.close()
  })
})

// 진짜 git 을 부르고, 첫 워크트리를 지울 때 둘째 워크트리 안에서 프로세스가 시작된 것처럼 가짜 /proc 을 고친다
const GIT_STARTS_PROC = `
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const a = process.argv.slice(2)
const done = spawnSync(process.env.REAL_GIT, a, { stdio: 'inherit' })
if (a.includes('remove') && a[a.length - 1] === process.env.FIRST_WT) {
  const dir = process.env.HS_ROOT + '/proc/77'
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(dir + '/status', 'Name:\\tnew\\nUid:\\t' + process.getuid() + '\\t0\\t0\\t0\\n')
  fs.symlinkSync(process.env.SECOND_WT, dir + '/cwd')
}
process.exit(done.status ?? 1)
`

describe('워크트리 다시 확인(REQ9, 리뷰 P2)', () => {
  function setup() {
    const box = new Sandbox('hsd-')
    const repo = new Repo(join(box.root, 'ops'))
    const tip = repo.commit('init', 1_700_000_000)
    for (const b of ['w1', 'w2', 'gone1', 'gone2']) repo.git('branch', b)
    for (const b of ['w1', 'w2', 'gone1', 'gone2']) repo.git('worktree', 'add', '-q', join(box.root, b), b)
    const list = repo.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
    const pick = (name: string) => list.find((l) => l.endsWith(`/${name}`))!
    const [w1, w2, gone1, gone2] = ['w1', 'w2', 'gone1', 'gone2'].map(pick)
    rmSync(gone1, { recursive: true })
    rmSync(gone2, { recursive: true })
    fakeProc(box.root, [{ pid: 20, uid: process.getuid!(), cwd: box.home }])
    const wts = [w1, w2].map((p) => ({ path: p, class: '제거 후보', tip })).concat([gone1, gone2].map((p) => ({ path: p, class: '기록만 남음', tip })))
    const survey = write(join(box.root, 'git.json'), JSON.stringify([{ repo: repo.dir, base: 'origin/main', worktrees: wts, branches: [] }]))
    return { box, repo, survey, w1, w2, gone1, gone2 }
  }

  test('앞 워크트리를 지우는 동안 뒤 워크트리에서 프로세스가 시작되면 뒤 것은 남긴다', () => {
    const { box, survey, w1, w2 } = setup()
    box.script('git', GIT_STARTS_PROC)
    const env = box.env({ ...LOCKED, HS_ROOT: box.root, REAL_GIT: join(box.tools, 'git'), FIRST_WT: w1, SECOND_WT: w2 })
    const r = box.run('hs_delete', ['worktrees', '--survey', survey, ...applyArgs(box), w1, w2], { env })
    assert.match(r.stdout, /지움 .*w1/)
    assert.match(r.stdout, /남김 .*w2: 안에서 도는 프로세스가 있다/)
    assert.ok(existsSync(w2))
  })

  test('/proc 목록을 읽지 못하면 남긴다', () => {
    const { box, survey, w1 } = setup()
    rmSync(join(box.root, 'proc'), { recursive: true })
    const r = box.run('hs_delete', ['worktrees', '--survey', survey, ...applyArgs(box), w1], { env: box.env({ ...LOCKED, HS_ROOT: box.root }) })
    assert.match(r.stdout, /남김 .*w1: 사용 여부를 확인하지 못함/)
    assert.ok(existsSync(w1))
  })

  test('기록만 남은 워크트리는 남은 기록이 모두 승인됐을 때만 prune 한다', () => {
    const { box, repo, survey, gone1, gone2 } = setup()
    const env = box.env({ ...LOCKED, HS_ROOT: box.root })
    const one = box.run('hs_delete', ['worktrees', '--survey', survey, ...applyArgs(box), gone1], { env })
    assert.match(one.stdout, /건너뜀 .*gone1: prune 하면 승인하지 않은 기록 1개/)
    assert.match(repo.git('worktree', 'list', '--porcelain'), /prunable/)
    const both = box.run('hs_delete', ['worktrees', '--survey', survey, ...applyArgs(box), gone1, gone2], { env })
    assert.equal(both.code, 0, both.stderr)
    assert.doesNotMatch(repo.git('worktree', 'list', '--porcelain'), /prunable/)
  })
})

describe('실행 차단(REQ12, 리뷰 P2)', () => {
  test('clearance 가 없거나 차단 범주가 있으면 어떤 하위 명령도 지우지 않고 5 로 끝난다', () => {
    const box = new Sandbox('hsd-')
    const file = write(join(box.home, '.local/share/Trash/files/f'), 'x')
    write(join(box.home, '.local/share/Trash/info/f.trashinfo'), '[Trash Info]\n')
    const none = box.run('hs_delete', ['trash', '--apply', 'f'])
    assert.equal(none.code, 5)
    assert.match(none.stderr, /--clearance 가 없다/)
    const blocked = write(join(box.root, 'blocked.json'), JSON.stringify({ blocked: [{ category: 'Docker 이미지', reason: 'docker ps 가 실패했다' }] }))
    const r = box.run('hs_delete', ['trash', '--clearance', blocked, '--apply', 'f'])
    assert.equal(r.code, 5)
    assert.match(r.stderr, /실행 차단: 필수 조사가 실패했다\(Docker 이미지\)\. 홈서버는 아무것도 지우지 않는다/)
    assert.ok(existsSync(file))
  })
})

// 연결 조회가 도는 동안 대상 세션이 활동한 것처럼 세션 DB 를 고치는 가짜 조회
const LINKED_TOUCHES = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.env.FAKE_HERMES_DATA + '/state.db')
db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(Date.now() / 1000, 'a')
db.close()
`

describe('Hermes 확인 순서(리뷰 P1)', () => {
  test('연결 목록을 읽는 동안 활동한 세션은 지우지 않는다', () => {
    const box = new Sandbox('hsd-')
    const cfg = sampleConfig(box.root)
    const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
    hermesDb(join(cfg.hermes.data, 'state.db'), [['a', null, 'cron', nowSec() - 40 * DAY]])
    box.script('linked-sessions', LINKED_TOUCHES)
    box.script('hermes-delete', HERMES_DELETE)
    const r = box.run('hs_delete', ['hermes', '--config', cfgFile, ...applyArgs(box), 'default:a'], { env: box.env({ FAKE_HERMES_DATA: cfg.hermes.data }) })
    assert.match(r.stdout, /건너뜀 default:a/)
    const d = new DatabaseSync(join(cfg.hermes.data, 'state.db'), { readOnly: true })
    assert.equal((d.prepare('SELECT count(*) n FROM sessions').get() as any).n, 1)
    d.close()
  })
})

// git status 가 도는 동안 그 워크트리 안에서 프로세스가 시작된 것처럼 가짜 /proc 을 고친다
const GIT_STATUS_STARTS_PROC = `
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a.includes('status') && !fs.existsSync(process.env.HS_ROOT + '/proc/88')) {
  const dir = process.env.HS_ROOT + '/proc/88'
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(dir + '/status', 'Name:\\tnew\\nUid:\\t' + process.getuid() + '\\t0\\t0\\t0\\n')
  fs.symlinkSync(a.includes('-C') ? a[a.indexOf('-C') + 1] : process.cwd(), dir + '/cwd')
}
const done = spawnSync(process.env.REAL_GIT, a, { stdio: 'inherit' })
process.exit(done.status ?? 1)
`

describe('워크트리 확인 순서(리뷰 P2)', () => {
  test('git 상태를 읽는 동안 시작한 프로세스도 잡아 남긴다', () => {
    const box = new Sandbox('hsd-')
    const repo = new Repo(join(box.root, 'ops'))
    const tip = repo.commit('init', 1_700_000_000)
    repo.git('branch', 'w1')
    repo.git('worktree', 'add', '-q', join(box.root, 'w1'), 'w1')
    const w1 = repo.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((l) => l.endsWith('/w1'))!
    fakeProc(box.root, [{ pid: 20, uid: process.getuid!(), cwd: box.home }])
    const survey = write(join(box.root, 'git.json'), JSON.stringify([{ repo: repo.dir, base: 'origin/main', worktrees: [{ path: w1, class: '제거 후보', tip }], branches: [] }]))
    box.script('git', GIT_STATUS_STARTS_PROC)
    const r = box.run('hs_delete', ['worktrees', '--survey', survey, ...applyArgs(box), w1], { env: box.env({ ...LOCKED, HS_ROOT: box.root, REAL_GIT: join(box.tools, 'git') }) })
    assert.match(r.stdout, /남김 .*w1: 안에서 도는 프로세스가 있다/)
    assert.ok(existsSync(w1))
  })
})
