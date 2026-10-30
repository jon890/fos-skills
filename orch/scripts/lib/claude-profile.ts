// Orca 의 Claude 계정 프로필이 플러그인과 설정을 갖췄는지 판정하고, 기준 프로필과 같은 모양으로 맞출 목록을 만든다.
//
// Orca 는 계정마다 <profiles>/<id>/home 을 따로 만들어 CLAUDE_CONFIG_DIR 로 넘긴다. 새 프로필에는 빈 plugins, skills 만 있고
// settings.json, CLAUDE.md 가 없어, 그 계정으로 뜬 worker 에게 플러그인과 스킬, 지침이 하나도 보이지 않는다.
//
// 프로필 폴더: ORCA_CLAUDE_PROFILES, 없으면 ~/Library/Application Support/orca/claude-profiles.
//     그 폴더의 selected-host 파일이 지금 선택된 계정의 home 경로를 담는다. 프로필 id 만 적힌 꼴도 받는다.
// 준비됨: home 의 plugins 가 링크이고 settings.json 이 파일이다.
// 기준 프로필: 준비된 프로필 가운데 settings.json 을 가장 최근에 고친 것. 링크 대상은 기준 프로필의 링크를 그대로 따른다.
//     plugins 링크가 가리키는 폴더의 부모(설정 폴더) 안을 가리키는 링크만 옮긴다. 그 밖을 가리키는 링크는 계정마다 다를 수 있어 두지 않는다.
// 옮기지 않는 것: 로그인 정보(.claude.json)는 COPY_FILES 에 없어 복사하지 않는다. 세션 상태(STATE_ITEMS)가 대상에 실체로 있으면
//     건너뛴다. 옮기면 실행 중인 세션의 셸 스냅숏과 이어 열기가 깨진다. 그 계정의 세션을 모두 끈 뒤 includeState 로 다시 돌린다.
// 바꿀 때: 이미 있는 것은 지우지 않고 `<이름>.bak-<YYYYMMDDHHMMSS>` 로 옮긴 뒤 링크하거나 복사한다.

import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { inside, isFile } from './fs.ts'

// 계정마다 같아도 되는 설정 파일. 로그인 정보와 세션 상태는 넣지 않는다
export const COPY_FILES = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'CLAUDE-omc.md', 'keybindings.json', 'browser.config.json', 'mac-cleanup-overlay.md']
export const STATE_ITEMS = ['projects', 'history.jsonl', 'session-env', 'shell-snapshots', 'file-history']

export type Step = { kind: 'link' | 'copy'; name: string; origin: string; replaces: boolean }
export type Plan = { steps: Step[]; skipped: string[] }

export function profilesRoot(): string {
  return process.env.ORCA_CLAUDE_PROFILES || join(homedir(), 'Library/Application Support/orca/claude-profiles')
}

export function homeOf(root: string, id: string): string {
  return join(root, id, 'home')
}

function isLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function present(target: string): boolean {
  return existsSync(target) || isLink(target)
}

function linkTarget(link: string): string {
  return resolve(dirname(link), readlinkSync(link))
}

// 준비되지 않은 이유. 비었으면 준비됐다
export function missingItems(home: string): string[] {
  const missing: string[] = []
  if (!isLink(join(home, 'plugins'))) missing.push('plugins 링크')
  if (!isFile(join(home, 'settings.json'))) missing.push('settings.json')
  return missing
}

// 지금 선택된 프로필의 id. Orca 를 쓰지 않으면(프로필 폴더나 selected-host 가 없으면) null,
// 선택된 home 이 프로필 폴더 밖이면(Orca 가 기본 설정 폴더를 쓰면) 'outside' 다
export function selectedProfile(root: string): string | null | 'outside' {
  let text: string
  try {
    text = readFileSync(join(root, 'selected-host'), 'utf8').trim()
  } catch {
    return null
  }
  if (!text) return null
  if (!isAbsolute(text)) return text
  const home = resolve(text)
  if (!inside(home, resolve(root)) || basename(home) !== 'home') return 'outside'
  return basename(dirname(home))
}

// 띄우기 전 판정. Orca 를 쓰지 않거나 선택된 home 이 프로필 폴더 밖이면 판정할 것이 없어 null 이다
export function selectedReadiness(root: string): { id: string; missing: string[] } | null {
  const id = selectedProfile(root)
  if (id === null || id === 'outside') return null
  return { id, missing: missingItems(homeOf(root, id)) }
}

export function pickSource(root: string, target: string): string | null {
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return null
  }
  const ready = ids.filter((id) => id !== target && missingItems(homeOf(root, id)).length === 0)
  if (ready.length === 0) return null
  const mtime = (id: string) => statSync(join(homeOf(root, id), 'settings.json')).mtimeMs
  return ready.reduce((best, id) => (mtime(id) > mtime(best) ? id : best))
}

export function plan(source: string, target: string, includeState: boolean): Plan {
  const steps: Step[] = []
  const skipped: string[] = []
  const configHome = dirname(linkTarget(join(source, 'plugins')))
  for (const name of readdirSync(source).sort()) {
    const entry = join(source, name)
    const dest = join(target, name)
    if (isLink(entry)) {
      const to = linkTarget(entry)
      if (!inside(to, configHome)) continue
      if (isLink(dest) && linkTarget(dest) === to) continue
      if (STATE_ITEMS.includes(name) && present(dest) && !isLink(dest) && !includeState) {
        skipped.push(name)
        continue
      }
      steps.push({ kind: 'link', name, origin: to, replaces: present(dest) })
    } else if (COPY_FILES.includes(name) && isFile(entry)) {
      if (isFile(dest) && !isLink(dest) && readFileSync(dest).equals(readFileSync(entry))) continue
      steps.push({ kind: 'copy', name, origin: entry, replaces: present(dest) })
    }
  }
  return { steps, skipped }
}

export function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
}

// 계획대로 바꾼다. 옮긴 백업 경로를 낸다
export function apply(target: string, steps: Step[], when: string): string[] {
  const backups: string[] = []
  for (const step of steps) {
    const dest = join(target, step.name)
    if (present(dest)) {
      const backup = `${dest}.bak-${when}`
      renameSync(dest, backup)
      backups.push(backup)
    }
    if (step.kind === 'link') symlinkSync(step.origin, dest)
    else copyFileSync(step.origin, dest)
  }
  return backups
}
