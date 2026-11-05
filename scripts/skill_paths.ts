// 스킬 원본의 위치. 설치 대상(skills/)과 내보내기 전용 원본(export-only-skills/)을 나누고 이름은 그대로 둔다.
// 옛 커밋과 팀 배치는 저장소 루트에 스킬을 두었으므로, legacy 와 sourcePath 는 루트도 본다.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pyStrCompare } from '../modules/kit/py.ts'

export const SKILL_ROOTS = ['skills', 'export-only-skills'] as const

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// 이름순 자식. Python 의 sorted(Path.iterdir()) 와 같은 순서다(같은 부모 아래에서는 이름 비교)
export function sortedChildren(dir: string): string[] {
  return readdirSync(dir).sort(pyStrCompare).map((name) => join(dir, name))
}

// 이름 → 스킬 폴더. SKILL.md 가 있는 폴더만 고른다. 같은 이름이 두 곳에 있으면 던진다
export function skillDirs(root: string, legacy = false): Map<string, string> {
  const parents = SKILL_ROOTS.map((name) => join(root, name))
  if (legacy) parents.push(root)
  const found = new Map<string, string>()
  for (const parent of parents) {
    if (!isDir(parent)) continue
    for (const child of sortedChildren(parent)) {
      if (!isFile(join(child, 'SKILL.md'))) continue
      const name = child.slice(parent.length + 1)
      if (found.has(name)) throw new Error(`스킬 원본이 둘이다: ${name}`)
      found.set(name, child)
    }
  }
  return found
}

// 내보내기의 옛 커밋과 팀 배치도 읽는다. 새 원본은 SKILL_ROOTS 아래에 둔다
export function sourcePath(root: string, name: string): string {
  for (const parent of [...SKILL_ROOTS, '']) {
    const path = join(root, parent, name)
    if (isDir(path)) return path
  }
  throw new Error(`스킬 원본이 없다: ${name}`)
}
