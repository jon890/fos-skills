// 임시 설치 기록과 캐시 사본으로 직접 호출 경고를 검증한다. 실제 플러그인 기록은 건드리지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { staleBundleWarning } from '../scripts/lib/bundle.ts'

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url))
let root: string, config: string, old: string, current: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-bundle-')))
  config = join(root, 'profile with space')
  old = join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', 'old')
  current = join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', 'new')
  mkdirSync(join(current, 'orch', 'scripts'), { recursive: true })
  mkdirSync(dirname(join(config, 'plugins', 'installed_plugins.json')), { recursive: true })
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fos-skills@fos-skills': [
    { scope: 'project', installPath: '/missing' }, { scope: 'user', installPath: current },
  ] } }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
test('다른 캐시이면 한 줄 경고하고 현재 설치본과 체크아웃은 조용하다', () => {
  const warning = staleBundleWarning(old, config)
  assert.match(warning!, /^STALE-BUNDLE orch: .*현재 진입점:/)
  assert.equal(warning!.split('\n').length, 1)
  assert.equal(staleBundleWarning(current, config), null)
  assert.equal(staleBundleWarning(join(root, 'checkout'), config), null)
  assert.equal(staleBundleWarning(old, '/missing'), null)
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), '{broken')
  assert.equal(staleBundleWarning(old, config), null)
})
test('진입점을 거치지 않은 스크립트 호출도 stderr 에 한 번만 경고한다', () => {
  cpSync(SCRIPTS, join(old, 'orch', 'scripts'), { recursive: true })
  // args 와 proc 양쪽에서 import 해도 ESM 이 한 번만 실행한다.
  writeFileSync(join(old, 'orch', 'scripts', 'probe.ts'), "import './lib/args.ts'\nimport './lib/proc.ts'\nconsole.log('ready')\n")
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(old, 'orch', 'scripts', 'probe.ts')], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, 'ready\n')
  assert.equal(run.stderr.split('\n').filter((line) => line.startsWith('STALE-BUNDLE')).length, 1)
  assert.match(run.stderr, /new\/orch\/bin\/orch\.ts/)
})
test('모든 직접 실행 스크립트가 공용 경고 모듈에 닿는다', () => {
  function reaches(file: string, visited = new Set<string>()): boolean {
    if (file.endsWith('/lib/bundle.ts')) return true
    if (visited.has(file)) return false
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(/^import\s+(?!type\b)(?:[^'"\n]*from\s*)?['"](\.[^'"]+)['"]/gm)]
      .some((m) => reaches(resolve(dirname(file), m[1]), visited))
  }
  for (const name of readdirSync(SCRIPTS).filter((name) => name.endsWith('.ts'))) assert.ok(reaches(join(SCRIPTS, name)), name)
})
