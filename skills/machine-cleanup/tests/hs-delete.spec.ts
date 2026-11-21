// hs_delete.ts 가 승인한 것만, 지우기 직전에 다시 확인한 뒤 지우는지 본다(스펙 REQ7, REQ9, REQ10).

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Repo, Sandbox, write } from './helpers.ts'
import { DAY, fakeProc, hermesDb, nowSec, sampleConfig } from './hs-helpers.ts'
import { keptReason } from '../scripts/hs_delete.ts'

const LOCKED = { FOS_INFRA_LOCK_HELD: '1' }

describe('이미지(REQ7)', () => {
  const DOCKER: FakeRule[] = [
    { args: ['ps', '-aq'], stdout: 'c1\n' },
    { args: ['inspect', '{{.Image}}'], stdout: 'sha256:used\n' },
    { args: ['image', 'inspect', 'app:1'], stdout: 'sha256:used app:1\n' },
    { args: ['image', 'inspect', 'app:0'], stdout: 'sha256:old app:0\n' },
    { args: ['image', 'inspect', 'gone:1'], code: 1, stderr: 'No such image' },
    { args: ['image', 'rm', 'app:0'], stdout: 'Deleted\n' },
  ]

  test('dry-run 은 지울 목록만 보이고 아무것도 지우지 않는다', () => {
    const box = new Sandbox('hsd-')
    const docker = box.fake('docker', DOCKER)
    const r = box.run('hs_delete', ['images', 'app:0', 'app:1'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /지울 것 app:0/)
    assert.match(r.stdout, /남김 app:1: 컨테이너가 쓰는 중/)
    assert.ok(!docker.calls().some((c) => c.argv.includes('rm')))
  })

  test('쓰는 중인 이미지는 남기고, 없는 이름은 실패로 세며, prune 은 부르지 않는다', () => {
    const box = new Sandbox('hsd-')
    const docker = box.fake('docker', DOCKER)
    const r = box.run('hs_delete', ['images', '--apply', 'app:0', 'app:1', 'gone:1'], { env: box.env(LOCKED) })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /지움 1개, 남김 1개, 실패 0개, 없음 1개/)
    const rm = docker.calls().filter((c) => c.argv.includes('rm'))
    assert.deepEqual(rm.map((c) => c.argv), [['image', 'rm', 'app:0']])
    assert.ok(!docker.calls().some((c) => c.argv.includes('prune')))
  })

  test('잠금 없이 --apply 하면 지우지 않고 4 로 끝난다', () => {
    const box = new Sandbox('hsd-')
    const docker = box.fake('docker', DOCKER)
    assert.equal(box.run('hs_delete', ['images', '--apply', 'app:0']).code, 4)
    assert.equal(docker.calls().length, 0)
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
    write(join(cfg.backup.root, 'oneoff/x'), 'x')
    write(join(cfg.backup.root, 'keep/x'), 'x')
    const r = box.run('hs_delete', ['backup', '--config', cfgFile, '--apply', 'oneoff', '../keep', ''], { env: box.env(LOCKED) })
    assert.equal(r.code, 1)
    assert.ok(!existsSync(join(cfg.backup.root, 'oneoff')))
    assert.ok(existsSync(join(cfg.backup.root, 'keep/x')))
  })

  test('휴지통 항목은 files 와 info 를 함께 지운다', () => {
    const box = new Sandbox('hsd-')
    const info = write(join(box.home, '.local/share/Trash/info/f.trashinfo'), '[Trash Info]\n')
    const file = write(join(box.home, '.local/share/Trash/files/f'), 'x')
    assert.match(box.run('hs_delete', ['trash', 'f']).stdout, /지울 것 f/)
    assert.ok(existsSync(file))
    assert.equal(box.run('hs_delete', ['trash', '--apply', 'f']).code, 0)
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
    const r = box.run('hs_delete', ['worktrees', '--survey', survey, '--apply', real], { env: box.env({ ...LOCKED, HS_ROOT: box.root }) })
    assert.match(r.stdout, /남김 .*: 안에서 도는 프로세스가 있다/)
    assert.ok(existsSync(real))
  })

  test('쓰는 프로세스가 없으면 지운다. 조사 파일에 없는 경로는 거부한다', () => {
    const { box, survey, real } = setup(false)
    const r = box.run('hs_delete', ['worktrees', '--survey', survey, '--apply', real, join(box.root, 'other')], { env: box.env({ ...LOCKED, HS_ROOT: box.root }) })
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
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, '--apply', 'default:a'], { env: h.env })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /연결된 세션 1개가 모두 남음/)
    assert.deepEqual(h.ids(), ['b', 'linked-1'])
  })

  test('조사 뒤 트리 안의 세션이 연결되면 그 루트를 지우지 않는다', () => {
    const h = setup()
    h.linked.setRules([{ stdout: 'linked-1\na1\n' }])
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, '--apply', 'default:a'], { env: h.env })
    assert.match(r.stdout, /건너뜀 default:a/)
    assert.deepEqual(h.ids(), ['a', 'a1', 'b', 'linked-1'])
  })

  test('조사 뒤 트리 안의 세션이 최근에 활동하면 지우지 않는다', () => {
    const h = setup()
    const d = new DatabaseSync(h.db)
    d.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(nowSec(), 'a1')
    d.close()
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, '--apply', 'default:a'], { env: h.env })
    assert.match(r.stdout, /건너뜀 default:a/)
    assert.ok(h.ids().includes('a'))
  })

  test('연결 목록을 다시 읽지 못하면 아무것도 지우지 않는다', () => {
    const h = setup()
    h.linked.setRules([{ code: 1, stderr: 'db down' }])
    const r = h.box.run('hs_delete', ['hermes', '--config', h.cfgFile, '--apply', 'default:a', 'default:b'], { env: h.env })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /다시 읽기 실패로 아무것도 지우지 않는다/)
    assert.equal(h.ids().length, 4)
  })
})

// 가짜 공간 회수: 그 profile DB 를 VACUUM 한다
const HERMES_OPTIMIZE = `
const { DatabaseSync } = require('node:sqlite')
const [profile] = process.argv.slice(2)
const data = process.env.FAKE_HERMES_DATA
const db = new DatabaseSync(profile === 'default' ? data + '/state.db' : data + '/profiles/' + profile + '/state.db')
db.exec('VACUUM')
db.close()
`

describe('Hermes 공간 회수(REQ10)', () => {
  test('dry-run 은 크기만 보이고, 잠금 없이 --apply 하면 돌지 않으며, 잠금 아래에서는 전후 크기를 낸다', () => {
    const box = new Sandbox('hsd-')
    const cfg = sampleConfig(box.root)
    const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
    const db = join(cfg.hermes.data, 'state.db')
    hermesDb(db, Array.from({ length: 300 }, (_, i) => [`s${i}`, null, 'cron', nowSec()] as [string, null, string, number]))
    const d = new DatabaseSync(db)
    d.exec("UPDATE sessions SET source = hex(randomblob(500)); DELETE FROM sessions WHERE id != 's0'")
    d.close()
    box.script('hermes-optimize', HERMES_OPTIMIZE)
    const env = { FAKE_HERMES_DATA: cfg.hermes.data }
    assert.match(box.run('hs_delete', ['hermes-optimize', '--config', cfgFile, 'default'], { env: box.env(env) }).stdout, /회수할 것 default: 지금 /)
    assert.equal(box.run('hs_delete', ['hermes-optimize', '--config', cfgFile, '--apply', 'default'], { env: box.env(env) }).code, 4)
    const r = box.run('hs_delete', ['hermes-optimize', '--config', cfgFile, '--apply', 'default', 'none'], { env: box.env({ ...env, ...LOCKED }) })
    assert.equal(r.code, 1)
    const m = /회수 default: ([\d.]+)M -> ([\d.]+)M/.exec(r.stdout)
    assert.ok(m, r.stdout)
    assert.ok(Number(m[2]) < Number(m[1]), r.stdout)
    assert.match(r.stderr, /없음 none/)
  })
})
