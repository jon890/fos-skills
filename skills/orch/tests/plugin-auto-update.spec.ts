import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireUpdateLock, comparePluginVersion, configDirs, readUpdateReport, updatePlugins, UPDATE_MS } from '../scripts/loop/plugin-auto-update.ts'

const SHA = 'a'.repeat(40)
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-auto-update-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'claude')
  const profiles = join(root, 'profiles')
  const stateDir = join(root, 'state')
  const profile = join(profiles, 'one', 'home')
  for (const dir of [home, profile, stateDir]) mkdirSync(join(dir, 'plugins'), { recursive: true })
  const add = (configDir: string, scope: string, version: string, projectPath?: string) => {
    const installPath = join(configDir, 'plugins', 'cache', 'fos-skills', 'fos-skills', version)
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true })
    writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
    const row = { scope, version, installPath, ...(projectPath ? { projectPath } : {}) }
    const file = join(configDir, 'plugins', 'installed_plugins.json')
    const old = (() => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { plugins: {} } } })()
    old.plugins['fos-skills@fos-skills'] = [...(old.plugins['fos-skills@fos-skills'] || []), row]
    writeFileSync(file, JSON.stringify(old))
    return file
  }
  return { root, home, profiles, stateDir, profile, add }
}

test('버전은 숫자 순서로 비교하고 알 수 없는 꼴은 갱신하지 않는다', () => {
  assert.equal(comparePluginVersion('1.9.0', '1.10.0'), -1)
  assert.equal(comparePluginVersion('2.0.0', '1.10.0'), 1)
  assert.equal(comparePluginVersion('1.0.0', '1.0.0'), 0)
  assert.equal(comparePluginVersion('sha', '1.0.0'), null)
})

test('설정 폴더와 scope 별 갱신, 설치 기록 검증, 30분 대기를 임시 폴더에서 확인한다', async t => {
  const f = fixture(t)
  const project = join(f.root, 'project')
  mkdirSync(project)
  f.add(f.home, 'user', '1.0.0')
  f.add(f.profile, 'project', '1.1.0', project)
  const calls: { argv: string[]; cwd?: string; config?: string }[] = []
  const exec = async (argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
    calls.push({ argv, cwd: opts.cwd, config: opts.env?.CLAUDE_CONFIG_DIR })
    if (argv[0] === 'git') return { code: 0, stdout: `${SHA}\trefs/heads/main\n`, stderr: '', timedOut: false }
    if (argv[0] === 'curl') return { code: 0, stdout: JSON.stringify({ version: '1.2.0' }), stderr: '', timedOut: false }
    const file = join(opts.env!.CLAUDE_CONFIG_DIR!, 'plugins', 'installed_plugins.json')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    value.plugins['fos-skills@fos-skills'][0].version = '1.2.0'
    writeFileSync(file, JSON.stringify(value))
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  assert.deepEqual(configDirs(f.home, f.profiles), [f.home, f.profile])
  const options = { home: f.home, profiles: f.profiles, stateDir: f.stateDir, repository: 'https://github.com/jon890/fos-skills', exec }
  const report = await updatePlugins({ ...options, now: 1000 })
  assert.equal(report?.results.length, 2)
  assert.ok(report?.results.every(result => result.result === 'success'))
  assert.deepEqual(calls.filter(call => call.argv[0] === 'claude').map(call => [call.cwd, call.config]), [[f.home, f.home], [project, f.profile]])
  assert.equal((await updatePlugins({ ...options, now: 1000 + UPDATE_MS - 1 })), null)
  assert.equal(calls.filter(call => call.argv[0] === 'claude').length, 2)
  assert.deepEqual((await updatePlugins({ ...options, now: 1000 + UPDATE_MS }))?.results.map(row => row.result), ['success', 'success'])
  assert.equal(readUpdateReport(f.stateDir)?.version, '1.2.0')
})

test('갱신 명령이 성공해도 설치 기록이 그대로면 실패하며 다음 확인에 재시도한다', async t => {
  const f = fixture(t)
  f.add(f.home, 'user', '1.0.0')
  let updates = 0
  const exec = async (argv: string[]) => {
    if (argv[0] === 'git') return { code: 0, stdout: `${SHA}\trefs/heads/main\n`, stderr: '', timedOut: false }
    if (argv[0] === 'curl') return { code: 0, stdout: '{"version":"1.2.0"}', stderr: '', timedOut: false }
    updates++
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const options = { home: f.home, profiles: f.profiles, stateDir: f.stateDir, repository: 'https://github.com/jon890/fos-skills', exec }
  assert.equal((await updatePlugins({ ...options, now: 1000 }))?.results[0].reason, '설치 기록의 version 이 main 과 다르다')
  assert.equal(readUpdateReport(f.stateDir)?.failureNotified, '1.2.0')
  assert.equal((await updatePlugins({ ...options, now: 1000 }))?.results[0], undefined)
  assert.equal((await updatePlugins({ ...options, now: 1000 + UPDATE_MS }))?.notifyFailure, undefined)
  assert.equal(updates, 2)
})

test('개발용 폴더는 건드리지 않고 잠금 중에는 확인하지 않는다', async t => {
  const f = fixture(t)
  const file = join(f.home, 'plugins', 'installed_plugins.json')
  writeFileSync(file, JSON.stringify({ plugins: { 'fos-skills@fos-skills': [{ scope: 'user', version: '1.0.0', installPath: join(f.root, 'checkout') }] } }))
  const lock = join(f.stateDir, 'plugin-auto-update.lock')
  const token = acquireUpdateLock(lock)
  assert.ok(token)
  assert.equal(acquireUpdateLock(lock), null)
  assert.equal(await updatePlugins({ home: f.home, profiles: f.profiles, stateDir: f.stateDir, repository: 'https://github.com/jon890/fos-skills', exec: async () => { throw new Error('명령 호출 금지') } }), null)
})

test('main 보다 높은 설치본을 낮추지 않고 local scope 는 기록된 프로젝트에서 갱신한다', async t => {
  const f = fixture(t)
  const project = join(f.root, 'local-project')
  mkdirSync(project)
  f.add(f.home, 'user', '2.0.0')
  f.add(f.profile, 'local', '1.0.0', project)
  const updates: { cwd?: string; scope: string; config?: string }[] = []
  const exec = async (argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
    if (argv[0] === 'git') return { code: 0, stdout: `${SHA}\trefs/heads/main\n`, stderr: '', timedOut: false }
    if (argv[0] === 'curl') return { code: 0, stdout: '{"version":"1.2.0"}', stderr: '', timedOut: false }
    updates.push({ cwd: opts.cwd, scope: argv.at(-2)!, config: opts.env?.CLAUDE_CONFIG_DIR })
    const file = join(f.profile, 'plugins', 'installed_plugins.json')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    value.plugins['fos-skills@fos-skills'][0].version = '1.2.0'
    writeFileSync(file, JSON.stringify(value))
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const report = await updatePlugins({ home: f.home, profiles: f.profiles, stateDir: f.stateDir, repository: 'https://github.com/jon890/fos-skills', exec, now: 1000 })
  assert.deepEqual(report?.results.map(row => row.result), ['skipped', 'success'])
  assert.deepEqual(updates, [{ cwd: project, scope: 'local', config: f.profile }])
})

test('Orca 프로필 기록이 다른 설정 폴더의 캐시를 가리켜도 해당 프로필을 갱신한다', async t => {
  const f = fixture(t)
  f.add(f.home, 'user', '1.0.0')
  const profileFile = f.add(f.profile, 'user', '1.0.0')
  const record = JSON.parse(readFileSync(profileFile, 'utf8'))
  record.plugins['fos-skills@fos-skills'][0].installPath = join(f.home, 'plugins', 'cache', 'fos-skills', 'fos-skills', '1.0.0')
  writeFileSync(profileFile, JSON.stringify(record))
  const updatedDirs: string[] = []
  const exec = async (argv: string[], opts: { env?: Record<string, string | undefined> } = {}) => {
    if (argv[0] === 'git') return { code: 0, stdout: `${SHA}\trefs/heads/main\n`, stderr: '', timedOut: false }
    if (argv[0] === 'curl') return { code: 0, stdout: '{"version":"1.2.0"}', stderr: '', timedOut: false }
    const dir = opts.env!.CLAUDE_CONFIG_DIR!
    updatedDirs.push(dir)
    const file = join(dir, 'plugins', 'installed_plugins.json')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    value.plugins['fos-skills@fos-skills'][0].version = '1.2.0'
    writeFileSync(file, JSON.stringify(value))
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const report = await updatePlugins({ home: f.home, profiles: f.profiles, stateDir: f.stateDir, repository: 'https://github.com/jon890/fos-skills', exec, now: 1000 })
  assert.deepEqual(report?.results.map(row => row.result), ['success', 'success'])
  assert.deepEqual(updatedDirs, [f.home, f.profile])
})

test('같은 scope 의 프로젝트 설치본은 각각의 갱신 결과를 유지한다', async t => {
  const f = fixture(t)
  const projects = [join(f.root, 'a'), join(f.root, 'b')]
  for (const project of projects) { mkdirSync(project); f.add(f.home, 'project', '1.0.0', project) }
  const exec = async (argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
    if (argv[0] === 'git') return { code: 0, stdout: `${SHA}\trefs/heads/main\n`, stderr: '', timedOut: false }
    if (argv[0] === 'curl') return { code: 0, stdout: '{"version":"1.2.0"}', stderr: '', timedOut: false }
    const file = join(opts.env!.CLAUDE_CONFIG_DIR!, 'plugins', 'installed_plugins.json')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    value.plugins['fos-skills@fos-skills'].find(row => row.projectPath === opts.cwd).version = '1.2.0'
    writeFileSync(file, JSON.stringify(value))
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const options = { home: f.home, profiles: f.profiles, stateDir: f.stateDir, repository: 'https://github.com/jon890/fos-skills', exec }
  const first = await updatePlugins({ ...options, now: 1000 })
  const second = await updatePlugins({ ...options, now: 1000 + UPDATE_MS })
  assert.deepEqual(first?.results.map(row => row.projectPath), projects)
  assert.deepEqual(second?.results.map(row => row.projectPath), projects)
  assert.deepEqual(second?.results.map(row => row.result), ['success', 'success'])
})
