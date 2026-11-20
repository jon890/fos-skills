// Orca worker-start 는 Claude 실행 인자(--add-dir)를 받지 않는다. 지시서와 명시적으로 가리킨
// 로컬 파일을 worker 워크트리의 git 무시 폴더에 복사해 외부 읽기 확인 창을 피한다.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.ts', '.tsx', '.js', '.py', '.sh'])

function inside(file: string, directory: string): boolean {
  const rel = relative(directory, file)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function fileAt(file: string): boolean {
  try { return statSync(file).isFile() } catch { return false }
}

export function copyWorkerSpec(spec: string, repo: string, worktree: string): string {
  const source = realpathSync(spec)
  const sourceDir = dirname(source)
  const root = realpathSync(repo)
  const targetDir = join(worktree, '.orch', 'worker-specs', createHash('sha256').update(source).digest('hex').slice(0, 12))
  mkdirSync(targetDir, { recursive: true })
  const copied = new Map<string, string>()
  const copy = (file: string): string => {
    const real = realpathSync(file)
    const existing = copied.get(real)
    if (existing) return existing
    const name = real === join(sourceDir, 'spec-common.md')
      ? 'spec-common.md'
      : createHash('sha256').update(real).digest('hex').slice(0, 12) + '-' + basename(real)
    const destination = join(targetDir, name)
    copied.set(real, destination)
    if (!TEXT_EXTENSIONS.has(extname(real).toLowerCase())) {
      copyFileSync(real, destination)
      return destination
    }
    let contents = readFileSync(real, 'utf8')
    // 절대경로로 가리킨 커밋 전 자료만 복사한다. 저장소 밖 임의 경로는 읽지 않는다.
    for (const match of contents.matchAll(/\/[^\s`'"<>()[\]]+/g)) {
      const candidate = match[0].replace(/[.,;:]$/, '').replace(/(?:#.*|:\d+(?::\d+)?)$/, '')
      if (!candidate || candidate === real || !fileAt(candidate)) continue
      const resolved = realpathSync(candidate)
      if (!inside(resolved, root) && !inside(resolved, sourceDir)) continue
      const inWorktree = inside(resolved, root) ? join(worktree, relative(root, resolved)) : ''
      const replacement = inside(resolved, worktree) ? resolved : inWorktree && fileAt(inWorktree) ? inWorktree : copy(resolved)
      contents = contents.replaceAll(candidate, replacement)
    }
    writeFileSync(destination, contents)
    return destination
  }
  const common = join(sourceDir, 'spec-common.md')
  if (common !== source && fileAt(common)) copy(common)
  return copy(source)
}
