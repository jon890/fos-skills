#!/usr/bin/env node
// 스킬 README 와 CHANGELOG 가 저장소 README 의 「스킬 README」, 「버전과 변경 이력」 형식을 따르는지 검사한다.
//
// 사용: node scripts/check-skill-docs.ts [스킬 이름 ...]
// 저장소는 이 파일의 상위 폴더다. 인자가 없으면 SKILL.md 가 있는 모든 디렉터리(옛 배치의 저장소 루트 포함)와
// 모든 변경 이력 조각(`<단위>/changes/`, scripts/skill_changes.ts)을 본다. 이름을 주면 그 스킬과 그 스킬의 조각만 본다.
//
// 출력: 위반마다 한 줄. 스킬 문서는 `<이름>/README.md: <이유>`, `<이름>/CHANGELOG.md: <이유>`,
//       조각은 `<저장소 상대 경로>: <이유>` 다.
// 종료 코드: 0 위반 없음, 1 위반이 있거나 스킬·README·CHANGELOG 를 읽지 못했다

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PY_SPACE, pyHead, pyLen, pyReadText, pySplitLines, pyStrCompare, pyStrip } from '../modules/kit/py.ts'
import { checkChanges } from './skill_changes.ts'
import { skillDirs, sourcePath } from './skill_paths.ts'

const ROOT = join(import.meta.dirname, '..')
export const README_SECTIONS = ['이럴 때 쓴다', '사용 예시', '받는 것', '함께 쓰는 스킬']
const README_FORBIDDEN = ['구성']
export const MAX_VERSION_BULLETS = 5
export const MAX_SUMMARY_BULLETS = 8
export const MAX_BULLET_CHARS = 160

// fullmatch 로 쓴다
const VERSION_HEADING = /^(\p{Nd}+)\.(\p{Nd}+)\.(\p{Nd}+) \(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}\)$/u
const SUMMARY_HEADING = /^(\p{Nd}+)\.x$/u
// re.M 의 ^ 와 $
const SKILL_VERSION = new RegExp(`(?<![^\\n])${PY_SPACE}+version:${PY_SPACE}*"?([0-9][0-9.]*)"?${PY_SPACE}*(?![^\\n])`)

type Section = [heading: string, body: string[]]

// 첫 `## ` 앞의 줄과 [(제목, 본문 줄)] 을 돌려준다. 코드 블록 안의 `## ` 은 제목으로 보지 않는다
export function splitSections(text: string): { intro: string[]; sections: Section[] } {
  const intro: string[] = []
  const sections: Section[] = []
  let fenced = false
  for (const line of pySplitLines(text).slice(1)) {
    if (line.startsWith('```')) fenced = !fenced
    if (!fenced && line.startsWith('## ')) sections.push([pyStrip(line.slice(3)), []])
    else if (sections.length > 0) sections[sections.length - 1][1].push(line)
    else intro.push(line)
  }
  return { intro, sections }
}

function firstLineIs(text: string, expected: string): boolean {
  const first = pySplitLines(text).slice(0, 1)
  return first.length === 1 && first[0] === expected
}

export function checkReadme(name: string, text: string): string[] {
  const problems: string[] = []
  if (!firstLineIs(text, `# ${name}`)) problems.push(`첫 줄이 \`# ${name}\` 이 아니다`)
  const { intro, sections } = splitSections(text)
  if (!intro.some((line) => pyStrip(line))) problems.push('제목 밑에 이 스킬이 덜어 주는 수고를 적은 첫 문단이 없다')
  const headings = sections.map(([heading]) => heading)
  for (const heading of README_FORBIDDEN) {
    if (headings.includes(heading)) problems.push(`\`## ${heading}\` 절을 두지 않는다. 파일 구성은 SKILL.md 와 docstring 이 소유한다`)
  }
  const missing = README_SECTIONS.filter((heading) => !headings.includes(heading))
  if (missing.length > 0) problems.push('빠진 절: ' + missing.map((heading) => `\`## ${heading}\``).join(', '))
  const present = headings.filter((heading) => README_SECTIONS.includes(heading))
  if (missing.length === 0 && present.join('\n') !== README_SECTIONS.join('\n')) problems.push('절 순서가 다르다: ' + README_SECTIONS.join(' > '))
  return problems
}

export function checkChangelog(name: string, text: string, skillVersion: string): string[] {
  const problems: string[] = []
  if (!firstLineIs(text, `# CHANGELOG: ${name}`)) problems.push(`첫 줄이 \`# CHANGELOG: ${name}\` 이 아니다`)
  const { sections } = splitSections(text)
  if (sections.length === 0) return [...problems, '버전 절이 없다']
  const first = VERSION_HEADING.exec(sections[0][0])
  if (!first) return [...problems, `첫 절 \`## ${sections[0][0]}\` 이 \`## X.Y.Z (YYYY-MM-DD)\` 꼴이 아니다`]
  if (sections[0][0].split(new RegExp(`${PY_SPACE}+`))[0] !== skillVersion) problems.push(`첫 절의 버전이 SKILL.md 의 ${skillVersion} 과 다르다`)
  const current = Number(first[1])
  for (const [heading, body] of sections) {
    const version = VERSION_HEADING.exec(heading)
    const summary = SUMMARY_HEADING.exec(heading)
    let limit: number
    if (version) {
      limit = MAX_VERSION_BULLETS
      if (Number(version[1]) !== current) problems.push(`\`## ${heading}\`: 이전 major 는 \`## ${version[1]}.x\` 한 절로 줄인다`)
    } else if (summary) {
      limit = MAX_SUMMARY_BULLETS
      if (Number(summary[1]) >= current) problems.push(`\`## ${heading}\`: 현재 major 는 버전마다 절을 둔다`)
    } else {
      problems.push(`\`## ${heading}\`: \`X.Y.Z (YYYY-MM-DD)\` 나 \`N.x\` 꼴이 아니다`)
      continue
    }
    const lines = body.filter((line) => pyStrip(line))
    const bullets = lines.filter((line) => line.startsWith('- '))
    if (bullets.length !== lines.length) problems.push(`\`## ${heading}\`: 목록 항목이 아닌 줄이 있다`)
    if (bullets.length === 0) problems.push(`\`## ${heading}\`: 항목이 없다`)
    if (bullets.length > limit) problems.push(`\`## ${heading}\`: 항목이 ${bullets.length}개로 상한 ${limit}개를 넘는다`)
    for (const bullet of bullets) {
      if (pyLen(bullet) - 2 > MAX_BULLET_CHARS) problems.push(`\`## ${heading}\`: ${MAX_BULLET_CHARS}자를 넘는 항목이 있다: ${pyHead(bullet, 40)}…`)
    }
  }
  return problems
}

export function checkSkill(name: string, root: string = ROOT): string[] {
  const skillDir = sourcePath(root, name)
  const match = SKILL_VERSION.exec(pyReadText(join(skillDir, 'SKILL.md')))
  const readme = pyReadText(join(skillDir, 'README.md'))
  const changelog = pyReadText(join(skillDir, 'CHANGELOG.md'))
  return [
    ...checkReadme(name, readme).map((problem) => `${name}/README.md: ${problem}`),
    ...checkChangelog(name, changelog, match ? match[1] : '').map((problem) => `${name}/CHANGELOG.md: ${problem}`),
  ]
}

export function skillNames(root: string = ROOT): string[] {
  return [...skillDirs(root, true).keys()].sort(pyStrCompare)
}

export function main(argv: string[], root: string = ROOT): number {
  let problems: string[]
  try {
    problems = (argv.length > 0 ? argv : skillNames(root)).flatMap((name) => checkSkill(name, root))
  } catch (error) {
    process.stderr.write(`check-skill-docs: ${(error as Error).message}\n`)
    return 1
  }
  problems.push(...checkChanges(root).filter((problem) => argv.length === 0 || argv.some((name) => problem.includes(`/${name}/changes/`))))
  for (const problem of problems) process.stdout.write(`${problem}\n`)
  return problems.length > 0 ? 1 : 0
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
const isMain = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
