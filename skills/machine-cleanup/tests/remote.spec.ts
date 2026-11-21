// remote.ts 가 스크립트와 입력을 묶어 보내고, 잠금 실패와 접속 실패를 스크립트 실패와 나누는지 본다(스펙 REQ5, REQ7, REQ12).
// 가짜 ssh 는 받은 명령을 이 맥의 sh 로 돌린다. 가짜 flock 은 FAKE_FLOCK_BUSY=1 이면 75 로 끝나고 아니면 명령을 돈다.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'
import { okClearance } from './hs-helpers.ts'
import { importClosure, remoteScript } from '../scripts/remote.ts'

const SSH = `
const { spawnSync } = require('node:child_process')
if (process.env.FAKE_SSH_CODE) process.exit(Number(process.env.FAKE_SSH_CODE))
const done = spawnSync('sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'inherit' })
process.exit(done.status ?? 1)
`
const FLOCK = `
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
if (process.env.FAKE_FLOCK_LOG) fs.appendFileSync(process.env.FAKE_FLOCK_LOG, process.argv.slice(2, 7).join(' ') + '\\n')
if (process.env.FAKE_FLOCK_BUSY === '1') process.exit(75)
const args = process.argv.slice(2)
const done = spawnSync(args[5], args.slice(6), { stdio: 'inherit' })
process.exit(done.status ?? 1)
`

const TOOLS = ['git', 'du', 'node', 'tar', 'mktemp', 'sh', 'rm', 'env']

function box(): Sandbox {
  const b = new Sandbox('hsr-', TOOLS)
  b.script('ssh', SSH)
  b.script('flock', FLOCK)
  return b
}

describe('remote 내부 함수', () => {
  test('import 를 따라가 홈서버에 보낼 파일을 모은다', () => {
    const files = importClosure(join(import.meta.dirname, '..', 'scripts', 'hs_survey.ts'))
    for (const f of ['scripts/hs_survey.ts', 'scripts/io.ts', 'scripts/lib/git_survey.ts', 'scripts/lib/session_survey.ts', 'scripts/kit/py.ts']) assert.ok(files.includes(f), f)
    assert.ok(!files.some((f) => f.includes('container_runtimes')), files.join(','))
  })

  test('잠금이 있으면 실행 전체를 flock 으로 감싸고 홈 경로는 홈서버에서 푼다', () => {
    const body = remoteScript('hs_delete.ts', ['images', "a'b"], '~/ops.lock')
    assert.match(body, /flock -E 75 -w 300 "\$HOME"\/'ops\.lock' env FOS_INFRA_LOCK_HELD=1 node 'scripts\/hs_delete\.ts' 'images' 'a'\\''b'/)
    assert.match(body, /trap 'rm -rf "\$d"' EXIT/)
  })
})

describe('remote 명령', () => {
  test('입력 파일을 사본 경로로 바꿔 보내고 표준 출력을 파일로 받는다', () => {
    const b = box()
    const cfg = write(join(b.root, 'cfg.json'), JSON.stringify({ backup: { root: join(b.root, 'srv/backup') } }))
    const out = join(b.root, 'out.txt')
    // hs_delete 의 사용법 오류는 입력 없이 2 로 끝난다. 보낸 스크립트가 실제로 도는지만 본다
    const r = b.run('remote', ['--host', 'example-host', '--input', cfg, '--json-out', out, 'hs_delete.ts', 'backup', '--config', cfg, 'nope!'])
    assert.equal(r.code, 1, r.stderr)
    assert.match(r.stderr, /거부 nope!/)
    assert.equal(readFileSync(out, 'utf8'), '')
  })

  test('잠금을 얻지 못하면 75 로 끝나고 스크립트는 돌지 않는다', () => {
    const b = box()
    const target = write(join(b.root, 'srv/backup/old/x'), 'x')
    const cfg = write(join(b.root, 'cfg.json'), JSON.stringify({ backup: { root: join(b.root, 'srv/backup') } }))
    const r = b.run('remote', ['--host', 'example-host', '--lock', join(b.root, 'ops.lock'), '--input', cfg, '--input', okClearance(b.root), 'hs_delete.ts', 'backup', '--config', cfg, '--clearance', okClearance(b.root), '--apply', 'old'], { env: b.env({ FAKE_FLOCK_BUSY: '1' }) })
    assert.equal(r.code, 75)
    assert.match(r.stderr, /잠금을 300초 안에 얻지 못함/)
    assert.ok(existsSync(target))
  })

  test('잠금 아래에서는 지우고, 잠금 없이 --apply 하면 지우지 않는다', () => {
    const b = box()
    const target = write(join(b.root, 'srv/backup/old/x'), 'x')
    const cfg = write(join(b.root, 'cfg.json'), JSON.stringify({ backup: { root: join(b.root, 'srv/backup') } }))
    const bare = b.run('remote', ['--host', 'example-host', '--input', cfg, '--input', okClearance(b.root), 'hs_delete.ts', 'backup', '--config', cfg, '--clearance', okClearance(b.root), '--apply', 'old'])
    assert.equal(bare.code, 4)
    assert.ok(existsSync(target))
    const locked = b.run('remote', ['--host', 'example-host', '--lock', join(b.root, 'ops.lock'), '--input', cfg, '--input', okClearance(b.root), 'hs_delete.ts', 'backup', '--config', cfg, '--clearance', okClearance(b.root), '--apply', 'old'])
    assert.equal(locked.code, 0, locked.stderr)
    assert.ok(!existsSync(target))
  })

  test('접속에 실패하면 255 와 원인 줄을 내고 아무것도 돌지 않는다', () => {
    const b = box()
    const target = write(join(b.root, 'srv/backup/old/x'), 'x')
    const cfg = write(join(b.root, 'cfg.json'), JSON.stringify({ backup: { root: join(b.root, 'srv/backup') } }))
    const r = b.run('remote', ['--host', 'example-host', '--lock', join(b.root, 'ops.lock'), '--input', cfg, '--input', okClearance(b.root), 'hs_delete.ts', 'backup', '--config', cfg, '--clearance', okClearance(b.root), '--apply', 'old'], { env: b.env({ FAKE_SSH_CODE: '255' }) })
    assert.equal(r.code, 255)
    assert.match(r.stderr, /홈서버에 접속하지 못함/)
    assert.ok(existsSync(target))
  })

  test('스크립트 이름이 아니면 사용법 오류다', () => {
    const b = box()
    assert.equal(b.run('remote', ['--host', 'h', '../x.ts']).code, 2)
    assert.equal(b.run('remote', ['hs_survey.ts']).code, 2)
  })
})
