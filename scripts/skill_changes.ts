// 스킬 변경 이력 조각의 규칙. 검사기(check-skill-docs.ts)와 머지 workflow 의 버전 상향(bump-plugin-version.ts)이 이 한 곳을 쓴다.
//
// PR 은 `<단위>/changes/<슬러그>.<등급>.md` 조각만 더하고, main 에 머지될 때 workflow 가 조각마다 버전을 올려
// CHANGELOG 절을 만든다. 근거는 docs/adr/023-version-at-merge.md 다.
//
// 단위는 `skills/<이름>`, `export-only-skills/<이름>`, `extensions/<이름>` 가운데 CHANGELOG.md 가 있는 폴더다.
// 조각은 `- ` 항목 1~5개이고 등급은 파일 이름 접미(`.patch.md`, `.minor.md`)다. major 는 조각으로 받지 않는다.

import { spawnSync } from 'node:child_process'
import { readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { normalizeNewlines, pyHead, pyInt, pyLen, pyReadText, pySplitLines, pyStrCompare, pyStrip, PY_SPACE } from '../modules/kit/py.ts'
import { isDir, isFile, SKILL_ROOTS, sortedChildren } from './skill_paths.ts'

export const UNIT_ROOTS = [...SKILL_ROOTS, 'extensions'] as const
export const CHANGES_DIR = 'changes'
export const MAX_BULLETS = 5
export const MAX_BULLET_CHARS = 160
export const LEVELS = ['patch', 'minor'] as const

const FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]*\.(patch|minor)\.md(?=\n?$)/
const VERSION_HEADING = /^## (\p{Nd}+)\.(\p{Nd}+)\.(\p{Nd}+) \(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}\)/u
// re.M 의 ^ 와 $. 뒤의 공백은 줄바꿈까지 먹을 수 있어 옛 정규식과 같은 꼴로 둔다
export const SKILL_VERSION_LINE = new RegExp(`(?<![^\\n])(${PY_SPACE}+version:${PY_SPACE}*")(\\p{Nd}+\\.\\p{Nd}+\\.\\p{Nd}+)(")${PY_SPACE}*(?![^\\n])`, 'u')

export type Applied = [unit: string, version: string]

function posix(path: string): string {
  return path.split(sep).join('/')
}

// CHANGELOG.md 가 있는 단위 폴더를 이름순으로 돌려준다
export function unitDirs(root: string): string[] {
  const found: string[] = []
  for (const parent of UNIT_ROOTS) {
    const base = join(root, parent)
    if (isDir(base)) found.push(...sortedChildren(base).filter((child) => isFile(join(child, 'CHANGELOG.md'))))
  }
  return found
}

// 조각 하나의 문제 목록. 이름은 파일 이름, 내용은 파일 본문이다
export function checkFragment(name: string, text: string): string[] {
  const problems: string[] = []
  if (!FRAGMENT_NAME.test(name)) {
    problems.push('이름이 `<슬러그>.patch.md` 나 `<슬러그>.minor.md` 꼴이 아니다(슬러그는 영문 소문자, 숫자, 하이픈)')
  }
  const lines = pySplitLines(text).filter((line) => pyStrip(line))
  const bullets = lines.filter((line) => line.startsWith('- '))
  if (bullets.length !== lines.length) problems.push('목록 항목(`- `)이 아닌 줄이 있다')
  if (lines.length === 0) problems.push('항목이 없다')
  if (bullets.length > MAX_BULLETS) problems.push(`항목이 ${bullets.length}개로 상한 ${MAX_BULLETS}개를 넘는다`)
  // 적용 때 절 끝 공백을 지우면 `-` 만 남아 CHANGELOG 검사에서 실패한다
  if (bullets.some((bullet) => !pyStrip(bullet.slice(2)))) problems.push('내용이 빈 항목(`- `)이 있다')
  for (const bullet of bullets) {
    if (pyLen(bullet) - 2 > MAX_BULLET_CHARS) problems.push(`${MAX_BULLET_CHARS}자를 넘는 항목이 있다: ${pyHead(bullet, 40)}…`)
    if (bullet.startsWith('- 호환성:')) problems.push('`호환성:` 항목은 조각으로 받지 않는다. major 는 PR 이 버전과 CHANGELOG 를 직접 올린다')
  }
  return problems
}

// 저장소의 모든 조각을 검사해 `<경로>: <이유>` 줄을 돌려준다
export function checkChanges(root: string): string[] {
  const problems: string[] = []
  for (const unit of unitDirs(root)) {
    const folder = join(unit, CHANGES_DIR)
    if (!isDir(folder)) continue
    for (const path of sortedChildren(folder)) {
      const rel = posix(relative(root, path))
      if (!isFile(path)) {
        problems.push(`${rel}: 파일이 아니다`)
        continue
      }
      problems.push(...checkFragment(basename(path), pyReadText(path)).map((problem) => `${rel}: ${problem}`))
    }
  }
  return problems
}

export function nextVersion(version: string, level: string): string {
  const [major, minor, patch] = version.split('.').map(pyInt)
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function todaySeoul(): string {
  // en-CA 의 날짜 꼴이 YYYY-MM-DD 다
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

// main 첫째 부모 기준으로 파일이 마지막에 더해진 순서. 머지 커밋은 PR 이 더한 파일을 머지 순서로 낸다
function addedOrder(root: string): Map<string, number> {
  const done = spawnSync(
    'git',
    ['log', '--reverse', '--first-parent', '-m', '--diff-filter=A', '--name-only', '--format=', '--', ...UNIT_ROOTS],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  if (done.error || done.status !== 0) return new Map()
  // 같은 경로를 지웠다 다시 더한 경우(슬러그 재사용)는 마지막에 더한 자리를 쓴다
  const order = new Map<string, number>()
  pySplitLines(normalizeNewlines(done.stdout)).forEach((line, index) => {
    if (line) order.set(line, index)
  })
  return order
}

// 단위의 조각 파일을 머지 순서로 돌려준다. 순서를 모르는 것은 뒤에서 이름순이다
export function fragments(root: string, unit: string): string[] {
  const folder = join(unit, CHANGES_DIR)
  if (!isDir(folder)) return []
  const order = addedOrder(root)
  const rank = (path: string) => order.get(posix(relative(root, path))) ?? order.size
  const files = readdirSync(folder)
    .map((name) => join(folder, name))
    .filter(isFile)
  return files.sort((a, b) => rank(a) - rank(b) || pyStrCompare(basename(a), basename(b)))
}

export function currentVersion(changelog: string): string | null {
  for (const line of pySplitLines(changelog)) {
    const match = VERSION_HEADING.exec(line)
    if (match) return match.slice(1, 4).join('.')
  }
  return null
}

export function prependSection(changelog: string, version: string, day: string, body: string): string {
  const heading = `## ${version} (${day})\n\n${pyStrip(body)}\n`
  const lines = pySplitLines(changelog, true)
  const index = lines.findIndex((line) => line.startsWith('## '))
  if (index >= 0) return lines.slice(0, index).join('') + heading + '\n' + lines.slice(index).join('')
  return changelog.replace(/\n+$/, '') + '\n\n' + heading
}

// 조각마다 버전 하나를 올리고 조각을 지운다. 틀린 조각과 읽을 수 없는 단위는 경고만 내고 건너뛴다.
// 조각이 없는 단위는 건드리지 않는다
export function applyFragments(root: string, day: string = todaySeoul()): { applied: Applied[]; warnings: string[] } {
  const applied: Applied[] = []
  const warnings: string[] = []
  for (const unit of unitDirs(root)) {
    const pending = fragments(root, unit)
    if (pending.length === 0) continue
    const unitRel = posix(relative(root, unit))
    const changelogPath = join(unit, 'CHANGELOG.md')
    let text = pyReadText(changelogPath)
    let version = currentVersion(text)
    if (!version) {
      warnings.push(`${unitRel}/CHANGELOG.md: 첫 버전 절을 읽을 수 없어 조각을 건너뛴다`)
      continue
    }
    const skillMd = join(unit, 'SKILL.md')
    let skillText = isFile(skillMd) ? pyReadText(skillMd) : null
    if (skillText !== null && !SKILL_VERSION_LINE.test(skillText)) {
      warnings.push(`${unitRel}/SKILL.md: metadata.version 줄을 찾지 못해 조각을 건너뛴다`)
      continue
    }
    for (const path of pending) {
      const body = pyReadText(path)
      const problems = checkFragment(basename(path), body)
      if (problems.length > 0) {
        warnings.push(`${posix(relative(root, path))}: ${problems[0]}. 건너뛴다`)
        continue
      }
      const name = basename(path).split('.')
      version = nextVersion(version, name[name.length - 2])
      text = prependSection(text, version, day, body)
      if (skillText !== null) {
        const next = version
        skillText = skillText.replace(SKILL_VERSION_LINE, (_all, before: string, _old: string, after: string) => before + next + after)
      }
      unlinkSync(path)
      applied.push([basename(unit), version])
    }
    writeFileSync(changelogPath, text)
    const folder = join(unit, CHANGES_DIR)
    if (readdirSync(folder).length === 0) rmdirSync(folder)
    if (skillText !== null) writeFileSync(skillMd, skillText)
  }
  return { applied, warnings }
}
