// 하네스 감사 대상 파일 선택을 한곳에서 관리한다.
// 감사 대상 확장자 목록(SCRIPT_SUFFIXES)과 판정은 옛 Python 구현 그대로다. 다른 저장소의 .py, .sh 를 감사하는 판정을 바꾸지 않는다.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { readTextReplace } from './io.ts'
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
  ['.claude', 'overlays'],
  ['.claude', 'references'],
  ['.claude', 'rules'],
  ['.agents', 'roles'],
  ['.claude', 'skills', '_shared'],
]

function isInstruction(path: string): boolean {
  const name = pathName(path)
  return name === 'AGENTS.md' || name === 'CLAUDE.md'
}

export function isTarget(path: string, root: string, includeReadme = false): boolean {
  if (isSkipped(path, root)) return false
  const name = pathName(path)
  const parts = pathParts(path)
  if (isInstruction(path)) return true
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

function* importedGuides(guide: string, root: string): Generator<string> {
  let text: string
  try {
    text = readTextReplace(guide)
  } catch {
    return
  }
  let fence = ''
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (marker && !fence) {
      fence = marker
      continue
    }
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = ''
      continue
    }
    if (/^( {4}|\t)/.test(line)) continue
    const prose = line.replace(/(`+).*?\1/g, '')
    for (const [, reference] of prose.matchAll(/(?:^|\s)@([^\s`<>]+?\.md)(?=[.,;:!?)]?(?:\s|$))/g)) {
      const candidate = reference.startsWith('~/')
        ? pjoin(homedir(), reference.slice(2))
        : pjoin(pathParent(guide), reference)
      const resolved = existingPath(candidate)
      if (resolved && isRelativeTo(resolved, root) && !isSkipped(resolved, root) && isFile(resolved)) yield resolved
    }
  }
}

function existingPath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
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
  const out: string[] = []
  const seen = new Set<string>()
  const guides = new Set<string>()
  const inScope = (path: string) => scope === null || isRelativeTo(path, scope)
  function addTarget(path: string, resolved: string): void {
    if (!inScope(path) || seen.has(resolved)) return
    if (isRelativeTo(resolved, root)) seen.add(resolved)
    out.push(path)
  }

  // 범위 밖 지침이 범위 안 파일을 불러올 수 있어 지침은 루트부터 찾는다.
  for (const step of walk(root)) {
    const kept = step.directories.filter((d) => !SKIP_PARTS.has(d)).sort(pyStrCompare)
    step.directories.splice(0, step.directories.length, ...kept)
    for (const filename of [...step.filenames].sort(pyStrCompare)) {
      const path = pjoin(step.current, filename)
      const instruction = isInstruction(path)
      if (!instruction && (!inScope(path) || !isTarget(path, root, includeReadme))) continue
      const resolved = existingPath(path) ?? path
      if (instruction && isRelativeTo(resolved, root) && !isSkipped(resolved, root) && isFile(resolved)) guides.add(path)
      addTarget(path, resolved)
    }
  }
  // 파일 범위는 링크의 실제 경로로 들어온다. 디렉터리 링크는 일반 순회에서 건너뛴다.
  if (scope && isFile(scope) && isTarget(scope, root, includeReadme)) addTarget(scope, scope)

  for (const guide of guides) {
    for (const imported of importedGuides(guide, root)) {
      guides.add(imported)
      addTarget(imported, imported)
    }
  }
  return out
}

export { isDir }
