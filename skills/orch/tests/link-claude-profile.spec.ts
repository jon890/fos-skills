// link-claude-profile.ts 와 lib/claude-profile.ts 를 임시 프로필 폴더로 본다. 실제 Orca 프로필에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { missingItems, pickSource, selectedProfile, selectedReadiness, stamp } from '../scripts/lib/claude-profile.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/link-claude-profile.ts', import.meta.url))

let tmp: string
let root: string
let config: string

// 설정 폴더(config)를 가리키는 링크와 설정 파일을 갖춘 기준 프로필 src, 빈 plugins 폴더만 있는 대상 프로필 dst 를 만든다
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'link-claude-profile-')))
  root = join(tmp, 'profiles')
  config = join(tmp, 'config')
  for (const name of ['plugins', 'skills', 'projects']) mkdirSync(join(config, name), { recursive: true })
  mkdirSync(join(tmp, 'elsewhere'))
  const src = join(root, 'src', 'home')
  mkdirSync(src, { recursive: true })
  for (const name of ['plugins', 'skills', 'projects']) symlinkSync(join(config, name), join(src, name))
  symlinkSync(join(tmp, 'elsewhere'), join(src, 'outside'))
  writeFileSync(join(src, 'settings.json'), '{"a":1}')
  writeFileSync(join(src, 'CLAUDE.md'), '# 지침\n')
  writeFileSync(join(src, '.claude.json'), '{"login":"src"}')
  const dst = join(root, 'dst', 'home')
  mkdirSync(join(dst, 'plugins'), { recursive: true })
  mkdirSync(join(dst, 'projects'))
  writeFileSync(join(root, 'selected-host'), `${dst}\n`)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function home(id: string): string {
  return join(root, id, 'home')
}

function link(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
    env: { ...process.env, ORCA_CLAUDE_PROFILES: root },
    encoding: 'utf8',
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

describe('판정', () => {
  test('plugins 링크와 settings.json 이 있으면 준비됐고, 없으면 빠진 것을 낸다', () => {
    assert.deepEqual(missingItems(home('src')), [])
    assert.deepEqual(missingItems(home('dst')), ['plugins 링크', 'settings.json'])
  })

  test('selected-host 의 home 경로나 id 로 선택된 프로필을 찾는다', () => {
    assert.equal(selectedProfile(root), 'dst')
    assert.deepEqual(selectedReadiness(root), { id: 'dst', missing: ['plugins 링크', 'settings.json'] })
    writeFileSync(join(root, 'selected-host'), 'src')
    assert.deepEqual(selectedReadiness(root), { id: 'src', missing: [] })
  })

  test('Orca 가 없거나 선택된 home 이 프로필 폴더 밖이면 판정하지 않는다', () => {
    assert.equal(selectedReadiness(join(tmp, 'none')), null)
    writeFileSync(join(root, 'selected-host'), join(tmp, 'config'))
    assert.equal(selectedReadiness(root), null)
  })

  test('기준 프로필은 갖춰진 프로필 가운데 settings.json 을 가장 최근에 고친 것이다', () => {
    const newer = join(root, 'newer', 'home')
    mkdirSync(newer, { recursive: true })
    symlinkSync(join(config, 'plugins'), join(newer, 'plugins'))
    writeFileSync(join(newer, 'settings.json'), '{}')
    utimesSync(join(home('src'), 'settings.json'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    assert.equal(pickSource(root, 'dst'), 'newer')
    assert.equal(pickSource(root, 'newer'), 'src')
  })
})

describe('연결', () => {
  test('dry-run 은 목록만 내고 바꾸지 않는다. 세션 상태와 설정 폴더 밖 링크, 로그인 정보는 옮기지 않는다', () => {
    const r = link([])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^기준 src → 대상 dst: 4건$/m)
    assert.match(r.stdout, /링크 plugins ← .*\/config\/plugins \(있던 것은 백업\)/)
    assert.match(r.stdout, /링크 skills ← /)
    assert.match(r.stdout, /복사 settings\.json ← /)
    assert.match(r.stdout, /복사 CLAUDE\.md ← /)
    assert.match(r.stdout, /건너뜀 projects: 세션 상태가 있다/)
    assert.doesNotMatch(r.stdout, /outside|\.claude\.json/)
    assert.match(r.stdout, /dry-run 이다/)
    assert.equal(lstatSync(join(home('dst'), 'plugins')).isSymbolicLink(), false)
    assert.equal(existsSync(join(home('dst'), 'settings.json')), false)
  })

  test('--apply 는 있던 것을 백업 이름으로 옮기고 맞춘다. 다시 돌리면 바꿀 것이 없다', () => {
    const r = link(['dst', '--apply'])
    assert.equal(r.code, 0, r.stderr)
    const dst = home('dst')
    assert.equal(readlinkSync(join(dst, 'plugins')), join(config, 'plugins'))
    assert.equal(readlinkSync(join(dst, 'skills')), join(config, 'skills'))
    assert.equal(readFileSync(join(dst, 'settings.json'), 'utf8'), '{"a":1}')
    assert.equal(lstatSync(join(dst, 'projects')).isDirectory(), true)
    assert.equal(existsSync(join(dst, '.claude.json')), false)
    const backups = readdirSync(dst).filter((name) => name.includes('.bak-'))
    assert.equal(backups.length, 1)
    assert.match(backups[0], /^plugins\.bak-\d{14}$/)
    assert.deepEqual(missingItems(dst), [])

    const again = link(['dst', '--apply'])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /^기준 src → 대상 dst: 0건$/m)
    assert.equal(readdirSync(dst).filter((name) => name.includes('.bak-')).length, 1)
  })

  test('--include-state 면 세션 상태도 백업하고 링크한다', () => {
    const r = link(['--from', 'src', '--include-state', '--apply'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readlinkSync(join(home('dst'), 'projects')), join(config, 'projects'))
    assert.ok(readdirSync(home('dst')).some((name) => /^projects\.bak-\d{14}$/.test(name)))
  })

  test('기준으로 쓸 프로필이 없거나 대상이 없으면 1 이다', () => {
    rmSync(join(root, 'src'), { recursive: true })
    assert.equal(link([]).code, 1)
    assert.equal(link(['nope']).code, 1)
  })

  test('백업 이름의 시각은 YYYYMMDDHHMMSS 다', () => {
    assert.equal(stamp(new Date(2026, 9, 30, 7, 5, 9)), '20261030070509')
  })
})
