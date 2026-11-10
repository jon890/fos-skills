// 임시 설치 기록과 캐시 사본으로 직접 호출 경고를 검증한다. 실제 플러그인 기록은 건드리지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '../scripts/lib/commands.ts'
import { staleBundleWarning } from '../scripts/lib/bundle.ts'

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))
let root: string, config: string, old: string, current: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-bundle-')))
  config = join(root, 'profile with space')
  old = join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', 'old')
  current = join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', 'new')
  mkdirSync(join(current, 'skills', 'orch', 'scripts'), { recursive: true })
  mkdirSync(dirname(join(config, 'plugins', 'installed_plugins.json')), { recursive: true })
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fos-skills@fos-skills': [
    { scope: 'project', installPath: '/missing' }, { scope: 'user', installPath: current },
  ] } }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function record(entries: { scope: string; installPath: string }[]): void {
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fos-skills@fos-skills': entries } }))
}

test('user 범위 항목이 있으면 같은 번들의 project 범위 항목이 있어도 user 와 다르면 경고한다', () => {
  mkdirSync(join(old, 'skills', 'orch', 'scripts'), { recursive: true })
  record([{ scope: 'project', installPath: old }, { scope: 'user', installPath: current }])
  assert.match(staleBundleWarning(old, config)!, /new\/skills\/orch\/bin\/orch\.ts/)
})

test('user 범위 설치본이 3.x 배치(orch/scripts)면 현재 설치본을 고르지 못해 경고하지 않는다', () => {
  const legacy = join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', 'legacy')
  mkdirSync(join(legacy, 'orch', 'scripts'), { recursive: true })
  record([{ scope: 'user', installPath: legacy }, { scope: 'project', installPath: current }])
  assert.equal(staleBundleWarning(old, config), null)
})
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
  assert.match(run.stderr, /new\/skills\/orch\/bin\/orch\.ts/)
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
  // 일부러 닿지 않는 스크립트와 이유
  const exempt: Record<string, string> = {
    'worker/resume-exec.ts': '새 터미널에서 lib/resume.ts 만으로 뜨는 실행기다. 경고 모듈과 orca 조회 없이 세션을 찾고 끝난다',
  }
  // 직접 실행 스크립트는 묶음 폴더 아래에 있다(lib, handlers 는 진입 스크립트가 아니다)
  const groups = readdirSync(SCRIPTS, { withFileTypes: true }).filter((d) => d.isDirectory() && !['lib', 'handlers'].includes(d.name)).map((d) => d.name)
  const names = groups.flatMap((group) => readdirSync(join(SCRIPTS, group)).filter((name) => name.endsWith('.ts')).map((name) => `${group}/${name}`))
  assert.ok(names.length > 0)
  for (const name of Object.keys(exempt)) assert.ok(names.includes(name), `예외 목록의 ${name} 이 없다`)
  // 폐기 안내 껍데기는 RETIRED 한 줄만 내야 하므로 설치 경고를 더하지 않는다. retired.spec.ts 가 무조회를 확인한다.
  const retired = new Set(COMMANDS.filter(c => c.retired && !COMMANDS.some(other => other.script === c.script && !other.retired)).map(c => c.script))
  for (const name of names.filter((name) => !(name in exempt) && !retired.has(name))) assert.ok(reaches(join(SCRIPTS, name)), name)
})

test('새 skills 배치의 직접 호출도 플러그인 루트와 현재 진입점을 대조한다', () => {
  cpSync(SCRIPTS, join(old, 'skills', 'orch', 'scripts'), { recursive: true })
  const probe = join(old, 'skills', 'orch', 'scripts', 'probe.ts')
  writeFileSync(probe, "import './lib/args.ts'\nconsole.log('ready')\n")
  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stderr, /new\/skills\/orch\/bin\/orch\.ts/)
  assert.equal(staleBundleWarning(current, config), null)
})

test('ORCH_CONTEXT 는 스크립트가 읽고 지워 자식에 물려주지 않는다', () => {
  const probe = join(root, 'probe.ts')
  writeFileSync(
    probe,
    `import { orchContext } from ${JSON.stringify(join(SCRIPTS, 'lib', 'bundle.ts'))}\n` +
      "import { spawnSync } from 'node:child_process'\n" +
      'console.log(JSON.stringify(orchContext()))\n' +
      "console.log(spawnSync(process.execPath, ['-e', 'console.log(process.env.ORCH_CONTEXT ?? \"none\")'], { encoding: 'utf8' }).stdout.trim())\n",
  )
  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, ORCH_CONTEXT: 'run=run-current loop-repo=registered' } })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, '{"run":"run-current","loop-repo":"registered"}\nnone\n')
})

