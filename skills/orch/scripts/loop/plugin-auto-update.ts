// 루프 부모가 30분마다 머신의 fos-skills 캐시 설치본을 확인한다. 테스트는 설정 폴더와 명령 실행기를 임시 폴더로 주입한다.
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reclaim } from '../lib/events.ts'
import { alive } from '../lib/process.ts'
import { run, runAsync, stopping } from '../lib/proc.ts'
import type { RunOptions, RunResult } from '../lib/proc.ts'
import { profilesRoot } from '../lib/claude-profile.ts'
import { PLUGIN } from '../lib/install-record.ts'

export const UPDATE_MS = 30 * 60 * 1000
const COMMAND_MS = 180_000
type Entry = { scope?: unknown; projectPath?: unknown; installPath?: unknown; version?: unknown }
export type UpdateResult = { configDir: string; scope: string; projectPath?: string; oldVersion: string; result: 'success' | 'failed' | 'skipped'; reason?: string }
export type UpdateReport = { version: string; checkedAt: number; results: UpdateResult[]; failureNotified?: string; notifyFailure?: boolean }
type Exec = (argv: string[], options?: RunOptions) => Promise<RunResult>
type Options = { home?: string; profiles?: string; stateDir?: string; repository?: string; now?: number; exec?: Exec }

export function comparePluginVersion(left: string, right: string): number | null {
  const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null
  const a = parse(left), b = parse(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

export function configDirs(home: string, profiles: string): string[] {
  let ids: string[] = []
  try { ids = readdirSync(profiles) } catch { /* Orca 미설치 */ }
  return [...new Set([home, ...ids.map(id => join(profiles, id, 'home'))].map(dir => resolve(dir)))]
}

function records(dir: string): Entry[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.[PLUGIN]
    return Array.isArray(rows) ? rows.filter((row): row is Entry => row !== null && typeof row === 'object') : []
  } catch { return [] }
}

function cacheEntry(entry: Entry, configDirs: string[]): entry is Entry & { installPath: string; scope: 'user' | 'project' | 'local' } {
  const installPath = entry.installPath
  if (typeof installPath !== 'string' || !configDirs.some(dir => installPath.startsWith(join(dir, 'plugins', 'cache', 'fos-skills', 'fos-skills') + '/'))) return false
  if (!['user', 'project', 'local'].includes(String(entry.scope))) return false
  return entry.scope === 'user' || (typeof entry.projectPath === 'string' && entry.projectPath.length > 0)
}

function installedVersion(entry: Entry): string {
  if (typeof entry.version === 'string' && comparePluginVersion(entry.version, entry.version) !== null) return entry.version
  try {
    const manifest = JSON.parse(readFileSync(join(String(entry.installPath), '.claude-plugin', 'plugin.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch { return '' }
}

function stateFile(dir: string): string { return join(dir, 'plugin-auto-update.json') }
export function updateStateDir(): string { return process.env.ORCH_PLUGIN_UPDATE_STATE_DIR ?? join(homedir(), '.cache', 'fos-skills') }
export function readUpdateReport(dir: string): UpdateReport | null {
  try {
    const value = JSON.parse(readFileSync(stateFile(dir), 'utf8'))
    return typeof value.version === 'string' && typeof value.checkedAt === 'number' && Array.isArray(value.results) ? value : null
  } catch { return null }
}

function saveReport(dir: string, report: UpdateReport): void {
  const temporary = stateFile(dir) + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(report) + '\n')
  renameSync(temporary, stateFile(dir))
}

// pid 재사용을 구분하기 위해 ps 의 시작 시각과 명령줄을 함께 저장한다.
function identity(pid: number): string | null {
  if (!alive(pid)) return null
  const found = run([process.env.PS || 'ps', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { env: { LC_ALL: 'C' } })
  if (found.code !== 0 || !found.stdout.trim()) {
    if (!alive(pid)) return null
    throw new Error(`pid ${pid} 의 시작 시각과 명령줄을 읽지 못했다`)
  }
  return found.stdout.trim()
}

function lockContent(file: string): string | null {
  try { return readFileSync(file, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}

export function acquireUpdateLock(file: string): string | null {
  const own = identity(process.pid)
  if (!own) throw new Error('현재 프로세스 식별 정보를 읽지 못했다')
  const token = JSON.stringify({ pid: process.pid, identity: own, nonce: randomUUID() })
  for (;;) {
    let fd: number
    try { fd = openSync(file, 'wx') }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const seen = lockContent(file)
      if (seen === null) continue
      if (!seen.trim() && Date.now() - statSync(file).mtimeMs < 1000) return null
      let holder: { pid?: unknown; identity?: unknown } = {}
      try { holder = JSON.parse(seen) } catch { /* 깨진 잠금은 회수한다 */ }
      if (Number.isInteger(holder.pid) && identity(Number(holder.pid)) === holder.identity) return null
      if (reclaim(file, seen) === 'retry') continue
      return null
    }
    try { writeSync(fd, token) } finally { closeSync(fd) }
    return token
  }
}

function releaseUpdateLock(file: string, token: string): void {
  if (lockContent(file) === token) unlinkSync(file)
}

async function mainVersion(repository: string, exec: Exec): Promise<string> {
  const head = await exec(['git', 'ls-remote', repository, 'refs/heads/main'], { timeoutMs: 10_000 })
  const sha = /^([0-9a-f]{40})\s+refs\/heads\/main$/m.exec(head.stdout)?.[1]
  if (head.code !== 0 || !sha) throw new Error('main 커밋을 읽지 못했다')
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(repository)
  if (!match) throw new Error('GitHub 저장소 주소를 읽지 못했다')
  const url = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${sha}/.claude-plugin/plugin.json`
  const manifest = await exec(['curl', '-fsSL', '--max-time', '10', url], { timeoutMs: 12_000 })
  if (manifest.code !== 0) throw new Error('main 플러그인 버전을 읽지 못했다')
  const version = JSON.parse(manifest.stdout).version
  if (typeof version !== 'string' || comparePluginVersion(version, version) === null) throw new Error('main 플러그인 버전이 올바르지 않다')
  return version
}

export async function updatePlugins(options: Options = {}): Promise<UpdateReport | null> {
  const home = options.home ?? process.env.ORCH_PLUGIN_UPDATE_HOME ?? join(homedir(), '.claude')
  const profiles = options.profiles ?? profilesRoot()
  const stateDir = options.stateDir ?? updateStateDir()
  const exec = options.exec ?? runAsync
  const now = options.now ?? Date.now()
  mkdirSync(stateDir, { recursive: true })
  const lock = join(stateDir, 'plugin-auto-update.lock')
  const token = acquireUpdateLock(lock)
  if (!token) return null
  try {
    const previous = readUpdateReport(stateDir)
    if (previous && now - previous.checkedAt < UPDATE_MS) return null
    const dirs = configDirs(home, profiles)
    const targets = dirs.flatMap(configDir => records(configDir).filter(entry => cacheEntry(entry, dirs)).map(entry => ({ configDir, entry })))
    if (targets.length === 0) return null
    const manifestFile = fileURLToPath(new URL('../../../../.claude-plugin/plugin.json', import.meta.url))
    const repository = options.repository ?? JSON.parse(readFileSync(manifestFile, 'utf8')).repository
    let version: string
    try { version = await mainVersion(repository, exec) }
    catch (e) {
      saveReport(stateDir, { version: previous?.version ?? '', checkedAt: now, results: previous?.results ?? [], failureNotified: previous?.failureNotified })
      throw e
    }
    const results: UpdateResult[] = []
    for (const { configDir, entry } of targets) {
      const projectPath = typeof entry.projectPath === 'string' ? entry.projectPath : undefined
      const oldVersion = installedVersion(entry)
      const comparison = comparePluginVersion(oldVersion, version)
      if (comparison === null) {
        results.push({ configDir, scope: entry.scope, projectPath, oldVersion: oldVersion || '-', result: 'failed', reason: '설치본 버전을 읽지 못했다' })
        continue
      }
      if (comparison >= 0) {
        const earlier = comparison === 0 && previous?.version === version
          ? previous.results.find(row => row.configDir === configDir && row.scope === entry.scope && row.projectPath === projectPath && row.result === 'success')
          : undefined
        results.push(earlier ?? { configDir, scope: entry.scope, projectPath, oldVersion, result: 'skipped', reason: comparison === 0 ? '이미 최신' : 'main 보다 높음' })
        continue
      }
      if (stopping()) break
      const cwd = entry.scope === 'user' ? configDir : String(entry.projectPath)
      const command = await exec(['claude', 'plugin', 'update', PLUGIN, '--scope', entry.scope, '--yes'], {
        cwd, env: { CLAUDE_CONFIG_DIR: configDir }, timeoutMs: COMMAND_MS, group: true,
      })
      const updated = records(configDir).find(row => row.scope === entry.scope && row.projectPath === entry.projectPath)
      if (command.code === 0 && updated?.version === version) results.push({ configDir, scope: entry.scope, projectPath, oldVersion, result: 'success' })
      else results.push({ configDir, scope: entry.scope, projectPath, oldVersion, result: 'failed', reason: command.code !== 0 ? (command.stderr || command.stdout || `종료 코드 ${command.code}`).trim().split('\n').at(-1) : '설치 기록의 version 이 main 과 다르다' })
    }
    const notifyFailure = results.some(row => row.result === 'failed') && previous?.failureNotified !== version
    const report: UpdateReport = { version, checkedAt: now, results,
      failureNotified: notifyFailure ? version : previous?.failureNotified,
      ...(notifyFailure ? { notifyFailure: true } : {}),
    }
    saveReport(stateDir, report)
    return report
  } finally { releaseUpdateLock(lock, token) }
}

export function updateSummary(report: UpdateReport): string {
  const lines = report.results.map(row => `${row.configDir} ${row.scope}${row.projectPath ? ' ' + row.projectPath : ''}: ${row.oldVersion} → ${row.result === 'success' ? report.version + ' 성공' : row.result === 'skipped' ? row.reason : '실패: ' + row.reason}`)
  const headline = report.results.some(row => row.result === 'success')
    ? `fos-skills ${report.version} 설치됨, 세션은 쉴 때 다시 읽는다`
    : report.results.some(row => row.result === 'failed') ? `fos-skills ${report.version} 설치 실패` : `fos-skills ${report.version} 변경 없음`
  return [headline, ...lines].join('\n')
}
