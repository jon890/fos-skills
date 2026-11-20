// PR 산출물은 <orch 루트>/handoff/pr-<번호>/ 에 둔다. MERGED 확인 뒤 이 폴더만 휴지통으로 옮긴다.
// 규칙 밖의 옛 파일과 다른 PR 폴더는 건드리지 않는다. 다시 실행해도 이미 옮긴 폴더를 덮어쓰지 않는다.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { orchDir } from './paths.ts'

export type PrHandoffResult = { moved: boolean; legacy: number; trash: string | null }

function taken(target: string): boolean {
  try { lstatSync(target); return true }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

export function cleanupPrHandoff(repo: string, pr: string, trashRoot?: string): PrHandoffResult {
  if (!/^[1-9]\d*$/.test(pr)) throw new Error(`PR 번호가 아니다: ${pr}`)
  const handoff = join(orchDir(repo), 'handoff')
  if (!existsSync(handoff)) return { moved: false, legacy: 0, trash: null }
  const entries = readdirSync(handoff)
  const legacy = entries.filter((name) => {
    if (name === 'pending' || /^pr-[1-9]\d*$/.test(name)) return false
    return !lstatSync(join(handoff, name)).isDirectory()
  }).length
  const source = join(handoff, `pr-${pr}`)
  if (!existsSync(source) || !lstatSync(source).isDirectory()) return { moved: false, legacy, trash: null }
  const day = new Date()
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
  const root = trashRoot ?? join(homedir(), '.Trash', `orch-cleanup-${stamp}`)
  const base = join(root, 'handoff', `pr-${pr}`)
  let target = base
  for (let suffix = 2; taken(target); suffix += 1) target = `${base}.${suffix}`
  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(source, target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    rmSync(source, { recursive: true })
  }
  return { moved: true, legacy, trash: target }
}
