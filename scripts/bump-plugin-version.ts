#!/usr/bin/env node
// main 에 들어온 변경으로 플러그인 version 을 올리고 플러그인 CHANGELOG 에 한 줄을 더한다.
//
// 사용: node scripts/bump-plugin-version.ts --base <push 전 커밋> --head <push 뒤 커밋> [--date YYYY-MM-DD]
// `.github/workflows/plugin-version.yml` 이 main push 마다 부른다. 규칙의 근거는 docs/adr/019-plugin-version-auto-bump.md 다.
// 저장소는 이 파일의 상위 폴더다. 긴 옵션은 고유 접두로 줄여 쓸 수 있고 `--이름=값` 도 받는다.
//
// 옵션
//   --base   push 전 main 커밋. 비었거나 0 40개면 head 의 부모 (기본 빈 값)
//   --head   push 뒤 커밋 (기본 HEAD)
//   --date   절 날짜 (기본 한국 시간 오늘)
//
// 등급은 base..head 에서 바뀐 스킬 CHANGELOG 의 더한 줄로 정한다.
// - `- 호환성:` 으로 시작하는 줄이 있으면 major
// - 새 버전 절(`## X.Y.Z (날짜)`)이 있으면 minor
// - 그 밖의 변경은 patch
//
// 먼저 main 트리의 변경 이력 조각(`<단위>/changes/*.patch.md`, `*.minor.md`)으로 스킬 버전을 올린다(scripts/skill_changes.ts,
// docs/adr/023-version-at-merge.md). 조각이 있었으면 플러그인 등급은 minor 이상이고 요약 줄에 그 새 스킬 버전이 든다.
// 조각 검사에 걸려 건너뛴 것은 stderr 에 `경고: ` 줄로 낸다.
//
// 올리지 않고 끝내는 경우(종료 코드 0, stdout 첫 줄이 `skip:`):
// - base..head 가 plugin.json 의 version 을 이미 바꿨다(사람이 직접 올림). 조각은 그래도 적용한다
// - 바뀐 파일이 plugin.json, 플러그인 CHANGELOG, 조각뿐이고 이번에 적용한 조각이 없다
// 올렸으면 stdout 첫 줄이 새 version 이다.
//
// 종료 코드
//   0  올렸거나 건너뛰었다
//   1  plugin.json 의 version 이 X.Y.Z 가 아니거나 version 칸이 없다, git 명령이 실패했다
//   2  사용법 오류

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from '../modules/kit/args.ts'
import { normalizeNewlines, PY_SPACE, pyReadText, pySplitLines } from '../modules/kit/py.ts'
import { applyFragments, type Applied, CHANGES_DIR, todaySeoul, UNIT_ROOTS } from './skill_changes.ts'

const ROOT = join(import.meta.dirname, '..')
const MANIFEST = '.claude-plugin/plugin.json'
const CHANGELOG = '.claude-plugin/CHANGELOG.md'
const OWN_FILES = new Set([MANIFEST, CHANGELOG])
const FRAGMENT_PATH = new RegExp(`^(?:${UNIT_ROOTS.join('|')})/[^/]+/${CHANGES_DIR}/`)
const RANK: Record<string, number> = { patch: 0, minor: 1, major: 2 }
export const ZERO = '0'.repeat(40)

const SEMVER = /^(\p{Nd}+)\.(\p{Nd}+)\.(\p{Nd}+)(?=\n?$)/u
const VERSION_HEADING = /^## (\p{Nd}+\.\p{Nd}+\.\p{Nd}+) \(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}\)/u
const COMPAT = /^- 호환성:/
const VERSION_FIELD = new RegExp(`("version"${PY_SPACE}*:${PY_SPACE}*")[^"]*(")`)
const PR_NUMBER = /Merge pull request #(\p{Nd}+)|\(#(\p{Nd}+)\)(?=\n?$)/u

// 옛 명령의 SystemExit(문구) 자리다. main 이 stderr 에 문구를 내고 1 로 끝낸다
class Fatal extends Error {}

function git(args: string[], root: string): string {
  const done = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (done.error || done.status !== 0) throw new Error(`git ${args.join(' ')} 실패 (종료 ${done.status}): ${done.stderr ?? done.error}`)
  return normalizeNewlines(done.stdout)
}

function manifestVersion(text: string): string {
  try {
    const version = JSON.parse(text)?.version
    return version ? String(version) : ''
  } catch {
    return ''
  }
}

function fileAt(ref: string, path: string, root: string): string {
  try {
    return git(['show', `${ref}:${path}`], root)
  } catch {
    return ''
  }
}

export function bump(version: string, level: string): string {
  const match = SEMVER.exec(version || '')
  if (!match) throw new Fatal(`bump-plugin-version: ${MANIFEST} 의 version 이 X.Y.Z 가 아니에요: '${version}'`)
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function addedLines(base: string, head: string, path: string, root: string): string[] {
  const names = pySplitLines(git(['diff', '--name-status', '--find-renames', base, head], root))
  let old: string | undefined
  for (const line of names) {
    const parts = line.split('\t')
    if (parts[0].startsWith('R') && parts.length === 3 && parts[2] === path) {
      old = parts[1]
      break
    }
  }
  const diff = git(['diff', '--find-renames', '-U0', base, head, '--', ...(old ? [old, path] : [path])], root)
  return pySplitLines(diff)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
}

// 등급과 [(스킬, 새 버전)] 을 돌려준다. 스킬은 CHANGELOG 가 든 폴더 이름이다
function classify(base: string, head: string, changed: string[], root: string): { level: string; entries: Applied[] } {
  let level = 'patch'
  const entries: Applied[] = []
  for (const path of changed) {
    if (!path.endsWith('/CHANGELOG.md') || OWN_FILES.has(path)) continue
    const skill = basename(dirname(path))
    for (const line of addedLines(base, head, path, root)) {
      const heading = VERSION_HEADING.exec(line)
      if (heading) {
        entries.push([skill, heading[1]])
        if (level === 'patch') level = 'minor'
      } else if (COMPAT.test(line)) {
        level = 'major'
      }
    }
  }
  return { level, entries }
}

function prNumbers(base: string, head: string, root: string): string[] {
  const numbers: string[] = []
  for (const subject of pySplitLines(git(['log', '--format=%s', `${base}..${head}`], root))) {
    const match = PR_NUMBER.exec(subject)
    const number = match && (match[1] || match[2])
    if (number && !numbers.includes(number)) numbers.push(number)
  }
  return numbers
}

function summary(entries: Applied[], changed: string[], prs: string[]): string {
  let body: string
  if (entries.length > 0) body = entries.map(([skill, version]) => `${skill} ${version}`).join(', ')
  else body = '바뀐 곳: ' + [...new Set(changed.map((path) => path.split('/')[0]))].sort().join(', ')
  const refs = prs.map((number) => `#${number}`).join(' ')
  return `- ${body}` + (refs ? ` (${refs})` : '')
}

function prepend(changelog: string, version: string, day: string, line: string): string {
  const heading = `## ${version} (${day})\n\n${line}\n`
  const lines = pySplitLines(changelog, true)
  const index = lines.findIndex((text) => text.startsWith('## '))
  if (index >= 0) return lines.slice(0, index).join('') + heading + '\n' + lines.slice(index).join('')
  return changelog.replace(/\n+$/, '') + '\n\n' + heading
}

export function run(base: string, head: string, day: string, root: string = ROOT): string {
  if (!base || base === ZERO) base = git(['rev-parse', `${head}~1`], root).trim()
  const { applied, warnings } = applyFragments(root, day)
  for (const warning of warnings) process.stderr.write(`경고: ${warning}\n`)
  let changed = pySplitLines(git(['diff', '--name-only', base, head], root)).filter((path) => path && !FRAGMENT_PATH.test(path))
  if (manifestVersion(fileAt(base, MANIFEST, root)) !== manifestVersion(fileAt(head, MANIFEST, root))) {
    return 'skip: 이번 변경이 version 을 이미 바꿨어요'
  }
  changed = changed.filter((path) => !OWN_FILES.has(path))
  if (changed.length === 0 && applied.length === 0) return 'skip: 플러그인 버전 파일 말고 바뀐 것이 없어요'
  let { level, entries } = classify(base, head, changed, root)
  if (applied.length > 0) {
    if (RANK[level] < RANK.minor) level = 'minor'
    entries = [...applied, ...entries]
  }
  const manifestPath = join(root, MANIFEST)
  const manifestText = pyReadText(manifestPath)
  const version = bump(manifestVersion(manifestText), level)
  // 키 순서와 들여쓰기를 지키려고 version 줄만 바꾼다
  if (!VERSION_FIELD.test(manifestText)) throw new Fatal(`bump-plugin-version: ${MANIFEST} 에 version 칸이 없어요`)
  writeFileSync(manifestPath, manifestText.replace(VERSION_FIELD, (_all, before: string, after: string) => before + version + after))
  const changelogPath = join(root, CHANGELOG)
  writeFileSync(changelogPath, prepend(pyReadText(changelogPath), version, day, summary(entries, changed, prNumbers(base, head, root))))
  return version
}

const USAGE = 'usage: bump-plugin-version.ts [-h] [--base BASE] [--head HEAD] [--date DATE]'
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  base: { type: 'string', default: '' },
  head: { type: 'string', default: 'HEAD' },
  date: { type: 'string' },
} as const

export function main(argv: string[]): number {
  let values: { help?: boolean; base: string; head: string; date?: string }
  try {
    values = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, strict: true, allowPositionals: false }).values as typeof values
  } catch (error) {
    process.stderr.write(`${USAGE}\nbump-plugin-version.ts: error: ${(error as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n\nmain 에 들어온 변경으로 플러그인 version 을 올리고 플러그인 CHANGELOG 에 한 줄을 더한다.\n자세한 것은 이 파일의 머리 주석에 있다.\n`)
    return 0
  }
  try {
    process.stdout.write(`${run(values.base, values.head, values.date ?? todaySeoul())}\n`)
  } catch (error) {
    if (!(error instanceof Fatal)) throw error
    process.stderr.write(`${error.message}\n`)
    return 1
  }
  return 0
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
const isMain = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
