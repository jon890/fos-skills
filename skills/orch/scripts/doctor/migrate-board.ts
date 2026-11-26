import { linkSync, lstatSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { withFileLock } from '../../../../modules/file-lock.ts'
import { BOARD_PATHS, boardRoot } from '../../../../modules/work-board/path.ts'
import { isObject } from '../core/json.ts'
import { legacyBoardRoot, resolveBoardSetting } from '../lib/board-file.ts'
import { readConfigFile, updateConfig } from '../lib/config.ts'
import { inside, realPath } from '../lib/fs.ts'
import { mainCheckout } from '../lib/git.ts'
import { orcaJson } from '../lib/orca.ts'
import { ensureIgnored } from '../lib/paths.ts'

type ConfigRef = { repo: string; file: string; value: string }
export type BoardMove = {
  from: string
  to: string
  owner: string
  repos: string[]
  configs: ConfigRef[]
  blocked: string[]
  conflict: boolean
}

function boardValue(raw: unknown): string {
  return isObject(raw) && isObject(raw.finish) && typeof raw.finish.board === 'string' ? raw.finish.board : ''
}

function readSetting(repo: string) {
  const current = readConfigFile(repo)
  return current.exists ? current : readConfigFile(repo, join(repo, '.claude/orch-finish.json'))
}

// 파일 이름은 그대로 두고 부모 폴더의 별칭만 해석한다. 링크 자체도 충돌로 알아볼 수 있다.
function filePath(file: string): string {
  return join(realPath(dirname(file)), basename(file))
}

function probe(file: string) {
  try { return lstatSync(file, { bigint: true }) }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

function sameFile(left: ReturnType<typeof probe>, right: ReturnType<typeof probe>): boolean {
  return !!left?.isFile() && !!right?.isFile() && left.dev === right.dev && left.ino === right.ino
}

function sourceFor(repo: string, value: string): string | undefined {
  if (value) {
    const configured = resolveBoardSetting(repo, value)
    if (legacyBoardRoot(configured)) return filePath(configured)
    // 이미 새 경로로 고친 설정에서 다시 실행해도 남은 설정을 이어서 고친다.
    const to = filePath(configured)
    const owner = dirname(dirname(to))
    if (join(owner, BOARD_PATHS[0]) !== to) return
    const fresh = probe(to)
    return BOARD_PATHS.slice(1).map(path => filePath(join(owner, path))).find(path => sameFile(probe(path), fresh))
  }
  const owner = boardRoot(repo)
  return BOARD_PATHS.slice(1).map(path => filePath(join(owner, path))).find(path => probe(path) !== null)
}

export function planBoardMove(repo: string): BoardMove | null {
  const current = readSetting(repo)
  // 깨진 설정은 기존 폴더 이전 명령이 보고한다. 그 상태에서는 어떤 보드를 쓰는지 알 수 없다.
  if (current.error) return null
  const from = sourceFor(repo, boardValue(current.value))
  if (!from) return null
  const source = probe(from)
  if (!source) return null
  const owner = legacyBoardRoot(from)
  if (!owner) throw new Error(`옛 보드의 기준 폴더를 찾지 못했다: ${from}`)
  const to = join(owner, BOARD_PATHS[0])
  const target = probe(to)
  const repos = new Set([repo, owner])
  const blocked: string[] = []
  const configs = new Map<string, ConfigRef>()
  const listed = orcaJson<{ repos?: unknown }>(['repo', 'list'], { cwd: repo, timeoutMs: 5_000 })
  if (!listed.ok) blocked.push(`공유 보드 설정을 찾을 저장소 목록을 읽지 못했다: ${listed.error}`)
  else if (!Array.isArray(listed.data?.repos)) blocked.push('공유 보드 설정을 찾을 저장소 목록이 올바르지 않다')
  else for (const row of listed.data.repos) {
    if (isObject(row) && typeof row.path === 'string' && isAbsolute(row.path)) repos.add(mainCheckout(row.path))
  }
  const affected = new Set([repo, owner])
  const otherRefs = new Set<string>()
  for (const candidate of repos) {
    const read = candidate === repo ? current : readSetting(candidate)
    if (read.error) {
      if (candidate === owner) blocked.push(`보드가 있는 저장소의 설정을 읽지 못했다: ${read.file}: ${read.error}`)
      continue
    }
    const value = boardValue(read.value)
    if (!value) continue
    const config = realPath(read.file)
    const path = resolveBoardSetting(candidate, value)
    if (filePath(path) !== from && realPath(path) !== from) {
      otherRefs.add(config)
      continue
    }
    affected.add(candidate)
    configs.set(config, { repo: candidate, file: config, value: nextValue(candidate, value, to) })
  }
  for (const file of configs.keys()) {
    if (otherRefs.has(file)) blocked.push(`저장소마다 다른 보드를 가리키는 공용 설정이다: ${file}`)
  }
  if (!source.isFile()) blocked.push(`옛 보드가 일반 파일이어야 한다: ${from}`)
  return { from, to, owner, repos: [...affected], configs: [...configs.values()], blocked, conflict: !!target && !sameFile(source, target) }
}

function nextValue(repo: string, old: string, to: string): string {
  if (old.startsWith('~/')) {
    const home = resolveBoardSetting(repo, '~')
    return inside(to, home) ? `~/${relative(home, to)}` : to
  }
  return isAbsolute(old) ? to : relative(mainCheckout(repo), to)
}

export function applyBoardMove(move: BoardMove, configPath: (file: string) => string, configured: (file: string, value: string) => void): void {
  withFileLock(move.from, oldLock => withFileLock(move.to, newLock => {
    const old = probe(move.from)
    if (!old?.isFile()) throw new Error(`옛 보드 파일이 바뀌었다: ${move.from}`)
    const target = probe(move.to)
    if (target && !sameFile(old, target)) throw new Error(`새 위치에 이미 다른 보드가 있다: ${move.to}`)
    if (!target) linkSync(move.from, move.to)
    for (const { repo, file } of move.configs) {
      const destination = configPath(file)
      let updated: string | undefined
      updateConfig(repo, raw => {
        const setting = boardValue(raw)
        if (!setting) return
        const path = resolveBoardSetting(repo, setting)
        if (filePath(path) !== move.from && realPath(path) !== move.from) return
        if (!isObject(raw) || !isObject(raw.finish)) return
        updated = nextValue(repo, setting, move.to)
        return { ...raw, finish: { ...raw.finish, board: updated } }
      }, { file: destination })
      if (updated !== undefined) configured(destination, updated)
    }
    if (!oldLock.held() || !newLock.held()) throw new Error('보드 잠금을 잃었다. 보드를 쓰는 세션을 멈춘 뒤 다시 이전한다')
    ensureIgnored(move.owner, '.orch')
    unlinkSync(move.from)
  }))
}
