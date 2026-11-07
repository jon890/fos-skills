// 하네스 감사 대상 파일 선택을 한곳에서 관리한다.
// 감사 대상 확장자 목록(SCRIPT_SUFFIXES)과 판정은 옛 Python 구현 그대로다. 다른 저장소의 .py, .sh 를 감사하는 판정을 바꾸지 않는다.

import { realpathSync } from 'node:fs'
import { exists, isDir, isFile, isRelativeTo, pathName, pathParents, pathParent, pathParts, pathSuffix, pjoin, pyPath, pyResolve, relativeTo, walk } from './pylike.ts'
import { pyStrCompare } from './kit/py.ts'

export const SKIP_PARTS = new Set(['.git', '.omx', '.venv', 'node_modules', 'applications', 'cache', 'data', 'logs', 'private', 'reports', 'sources', 'tasks', 'worktrees'])

export class ValueError extends Error {}

function isSkipped(path: string, root: string): boolean {
  return pathParts(relativeTo(path, root)).some((part) => SKIP_PARTS.has(part))
}

// Path.parts 안에서 parts 가 이어진 구간을 찾는다
function inside(path: string, ...parts: string[]): boolean {
  const values = pathParts(path)
  const width = parts.length
  for (let index = 0; index <= values.length - width; index++) {
    if (parts.every((part, offset) => values[index + offset] === part)) return true
  }
  return false
}

const GUIDE_PREFIXES: string[][] = [
  ['.claude', 'agents'],
  ['.claude', 'references'],
  ['.claude', 'rules'],
  ['.agents', 'roles'],
  ['.claude', 'skills', '_shared'],
]

export function isTarget(path: string, root: string, includeReadme = false): boolean {
  if (isSkipped(path, root)) return false
  const name = pathName(path)
  const parts = pathParts(path)
  if (name === 'AGENTS.md' || name === 'CLAUDE.md') return true
  if (includeReadme && name === 'README.md' && pathParent(path) === root) return true
  if (name.endsWith('-overlay.md') && parts.includes('.claude')) return true
  if (name === 'overlay.md' && parts.includes('.orch')) return true
  if (name === 'SKILL.md') return true
  const suffix = pathSuffix(path)
  if (suffix === '.toml' && inside(path, '.codex', 'agents')) return true
  if (suffix !== '.md') return false
  if (GUIDE_PREFIXES.some((prefix) => inside(path, ...prefix))) return true
  for (const parent of pathParents(path)) {
    if (parent === root) break
    if (isFile(pjoin(parent, 'SKILL.md')) && pathParts(relativeTo(path, parent)).includes('references')) return true
  }
  return false
}

// `--scope` 값을 저장소 안의 절대 경로로 바꾼다. 범위 밖이거나 없는 경로면 ValueError 를 낸다
export function resolveScope(root: string, scope: string | null): string | null {
  if (scope === null) return null
  let path = pyPath(scope)
  if (!path.startsWith('/')) path = pjoin(root, path)
  path = pyResolve(path)
  if (!exists(path)) throw new ValueError(`범위 경로가 없다: ${scope}`)
  if (path !== root && !isRelativeTo(path, root)) throw new ValueError(`범위가 저장소 밖을 가리킨다: ${scope}`)
  return path
}

// argv 에서 `--scope` 를 떼어내고 나머지를 그대로 돌려준다. 위치 인자의 자리를 바꾸지 않는다
export function takeScope(argv: string[]): [string[], string | null] {
  const rest: string[] = []
  let scope: string | null = null
  let index = 0
  while (index < argv.length) {
    const item = argv[index]
    if (item === '--scope') {
      if (index + 1 >= argv.length) throw new ValueError('--scope 에 경로가 없다')
      scope = argv[index + 1]
      index += 2
      continue
    }
    if (item.startsWith('--scope=')) {
      scope = item.slice(item.indexOf('=') + 1)
      index += 1
      continue
    }
    rest.push(item)
    index += 1
  }
  return [rest, scope]
}

const SCRIPT_SUFFIXES = new Set(['.py', '.sh', '.bash', '.zsh'])

// start 아래(또는 파일 하나)의 실행 파일 수를 센다. 건너뛰는 디렉터리는 대상과 같다
export function countScripts(start: string): number {
  if (isFile(start)) return SCRIPT_SUFFIXES.has(pathSuffix(start)) ? 1 : 0
  let total = 0
  for (const step of walk(start)) {
    step.directories.splice(0, step.directories.length, ...step.directories.filter((d) => !SKIP_PARTS.has(d)))
    total += step.filenames.filter((name) => SCRIPT_SUFFIXES.has(pathSuffix(name))).length
  }
  return total
}

// 감사 대상 파일을 낸다. scope 를 주면 그 디렉터리 아래나 그 파일 하나만 본다.
// 대상 판정은 언제나 root 기준이므로, 범위를 좁혀도 같은 파일이 같은 판정을 받는다
export function iterTargets(root: string, includeReadme = false, scope: string | null = null): string[] {
  const start = scope ?? root
  const out: string[] = []
  if (isFile(start)) {
    if (isTarget(start, root, includeReadme)) out.push(start)
    return out
  }
  const seen = new Set<string>()
  for (const step of walk(start)) {
    const kept = step.directories.filter((d) => !SKIP_PARTS.has(d)).sort(pyStrCompare)
    step.directories.splice(0, step.directories.length, ...kept)
    for (const filename of [...step.filenames].sort(pyStrCompare)) {
      const path = pjoin(step.current, filename)
      if (!isTarget(path, root, includeReadme)) continue
      let resolved: string
      try {
        resolved = realpathSync(path)
      } catch {
        resolved = path
      }
      if (!isRelativeTo(resolved, root)) {
        out.push(path)
        continue
      }
      if (seen.has(resolved)) continue
      seen.add(resolved)
      out.push(path)
    }
  }
  return out
}

export { isDir }
