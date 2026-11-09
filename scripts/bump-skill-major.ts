#!/usr/bin/env node
// 스킬의 major 버전을 올린다. 버전 줄을 올리고, CHANGELOG 의 현재 major 절들을 `## N.x` 한 절로 접고, 새 major 절 머리를 만든다.
//
// 왜 필요한가:
//   저장소 README 「버전과 변경 이력」 은 호환성이 깨지는 변경(major)을 조각으로 받지 않고, PR 이 버전과 CHANGELOG 를 직접 올리며
//   이전 major 를 한 절로 줄이라고 한다. 절이 수십 개인 CHANGELOG 를 손으로 접으면 항목 수와 길이 한도를 놓치기 쉬워 명령으로 둔다.
//
// 사용 (cwd 는 어디든 된다. 저장소는 이 파일의 상위 폴더다)
//   node scripts/bump-skill-major.ts <스킬> --note "<호환성 항목>" [--note ...] [--summary "<접은 절 항목>" ...] [--date YYYY-MM-DD] [--apply]
//
// 옵션
//   --note     새 major 절의 항목. 1~5개. `호환성:` 으로 시작하지 않으면 붙인다. 무엇이 깨지는지 적는다
//   --summary  접은 `## N.x` 절의 항목. 1~8개, 항목마다 160자 이하. 주지 않으면 접는 절들의 항목을 그대로 쓰되,
//              8개를 넘거나 160자를 넘는 것이 있으면 멈추고 항목 목록을 보여 준다. 그때 요약을 직접 써서 준다
//   --date     새 절 날짜 (기본 한국 시간 오늘)
//   --apply    파일에 쓴다. 없으면 미리보기만 보이고 아무것도 쓰지 않는다
//
// 동작
//   - SKILL.md 의 metadata.version 을 `<major+1>.0.0` 으로 올린다
//   - CHANGELOG 에서 현재 major 의 `## X.Y.Z (날짜)` 절을 모두 `## <major>.x` 한 절로 접는다. 이미 접힌 옛 `N.x` 절은 그대로 둔다
//   - 접은 결과가 scripts/check-skill-docs.ts 의 한도를 지키는지 검사한다. 어기면 쓰지 않고 멈춘다
//   - `changes/` 에 조각이 남아 있으면 경고한다. 머지 뒤 workflow 가 그 조각으로 새 major 위에 patch 나 minor 를 더 올린다
//   - 이 명령으로 올린 스킬은 workflow 가 major 를 다시 올리지 않는다. 플러그인 major 는 `호환성:` 항목을 보고 workflow 가 올린다
//
// 종료 코드
//   0  미리보기를 냈거나 적용했다
//   1  접은 결과가 한도를 어기거나 SKILL.md, CHANGELOG 를 읽을 수 없다, 접을 절이 없다
//   2  사용법 오류

import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { pyReadText, pyStrip } from '../modules/kit/py.ts'
import { checkChangelog, MAX_BULLET_CHARS, MAX_SUMMARY_BULLETS, MAX_VERSION_BULLETS, splitSections } from './check-skill-docs.ts'
import { isMainModule } from './is-main.ts'
import { CHANGES_DIR, SKILL_VERSION_LINE, todaySeoul } from './skill_changes.ts'
import { isDir, sourcePath } from './skill_paths.ts'

const ROOT = join(import.meta.dirname, '..')
const VERSION = /^(\d+)\.(\d+)\.(\d+) \(\d{4}-\d{2}-\d{2}\)$/
const SUMMARY = /^(\d+)\.x$/

export type BumpOptions = { notes: string[]; summary?: string[]; date?: string }
export type BumpPlan = { from: string; to: string; skillMd: string; changelog: string; folded: string[]; pending: string[]; problems: string[] }

function bullet(text: string): string {
  return `- ${pyStrip(text.startsWith('- ') ? text.slice(2) : text)}`
}

// 파일을 바꾸지 않고 바꿀 내용을 계산한다. problems 가 비어 있지 않으면 적용하지 않는다
export function planBump(root: string, name: string, options: BumpOptions): BumpPlan {
  const dir = sourcePath(root, name)
  const skillText = pyReadText(join(dir, 'SKILL.md'))
  const match = SKILL_VERSION_LINE.exec(skillText)
  if (!match) throw new Error(`${name}/SKILL.md: metadata.version 줄을 찾지 못했다`)
  const from = match[2]
  const major = Number(from.split('.')[0])
  const to = `${major + 1}.0.0`
  const changelogText = pyReadText(join(dir, 'CHANGELOG.md'))
  const { intro, sections } = splitSections(changelogText)
  const title = changelogText.split('\n')[0]

  const folded: string[] = []
  const kept: [string, string[]][] = []
  let foldedCount = 0
  for (const [heading, body] of sections) {
    const version = VERSION.exec(heading)
    const summary = SUMMARY.exec(heading)
    if (version && Number(version[1]) === major) {
      foldedCount++
      folded.push(...body.filter((line) => pyStrip(line)))
    } else if (summary && Number(summary[1]) === major) {
      throw new Error(`${name}/CHANGELOG.md: \`## ${major}.x\` 절이 이미 있다`)
    } else kept.push([heading, body.filter((line) => pyStrip(line))])
  }
  if (foldedCount === 0) throw new Error(`${name}/CHANGELOG.md: 접을 ${major}.Y.Z 절이 없다`)

  const problems: string[] = []
  const notes = options.notes.map((note) => bullet(note.startsWith('호환성:') ? note : `호환성: ${note}`))
  if (notes.length === 0) problems.push('--note 가 필요하다. 무엇이 깨지는지 한 줄 이상 적는다')
  if (notes.length > MAX_VERSION_BULLETS) problems.push(`--note 가 ${notes.length}개로 상한 ${MAX_VERSION_BULLETS}개를 넘는다`)

  const given = options.summary && options.summary.length > 0
  const summary = given ? options.summary!.map(bullet) : folded
  if (!given) {
    const tooLong = summary.filter((line) => [...line].length - 2 > MAX_BULLET_CHARS).length
    if (summary.length > MAX_SUMMARY_BULLETS || tooLong > 0) {
      problems.push(
        `접을 항목이 ${summary.length}개${tooLong > 0 ? `(${MAX_BULLET_CHARS}자를 넘는 항목 ${tooLong}개)` : ''}라 그대로 쓸 수 없다. ` +
          `${MAX_SUMMARY_BULLETS}개 이하, ${MAX_BULLET_CHARS}자 이하로 직접 요약해 --summary 로 준다`,
      )
    }
  }

  const date = options.date ?? todaySeoul()
  const block = (heading: string, lines: string[]) => `## ${heading}\n\n${lines.join('\n')}\n`
  const head = [title, ...intro.filter((line) => pyStrip(line))].join('\n')
  const changelog = [head + '\n', block(`${to} (${date})`, notes), block(`${major}.x`, summary), ...kept.map(([heading, body]) => block(heading, body))].join('\n')

  const changesDir = join(dir, CHANGES_DIR)
  const pending = isDir(changesDir) ? readdirSync(changesDir).sort() : []
  const skillMd = skillText.replace(SKILL_VERSION_LINE, (_all, before: string, _old: string, after: string) => before + to + after)
  // 접은 결과가 검사기의 한도를 지키는지 본다. 항목 수 문제는 위에서 이미 말했으니 겹치는 줄은 거른다
  for (const problem of checkChangelog(name, changelog, to)) problems.push(`${name}/CHANGELOG.md: ${problem}`)
  return { from, to, skillMd, changelog, folded, pending, problems }
}

export function applyBump(root: string, name: string, plan: BumpPlan): void {
  const dir = sourcePath(root, name)
  writeFileSync(join(dir, 'SKILL.md'), plan.skillMd)
  writeFileSync(join(dir, 'CHANGELOG.md'), plan.changelog)
}

export function main(argv: string[], root: string = ROOT): number {
  const config = {
    args: argv,
    allowPositionals: true,
    options: {
      note: { type: 'string', multiple: true },
      summary: { type: 'string', multiple: true },
      date: { type: 'string' },
      apply: { type: 'boolean' },
    },
  } as const
  let parsed: ReturnType<typeof parseArgs<typeof config>>
  try {
    parsed = parseArgs(config)
  } catch (error) {
    process.stderr.write(`bump-skill-major: ${(error as Error).message}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (positionals.length !== 1) {
    process.stderr.write('사용: node scripts/bump-skill-major.ts <스킬> --note "<호환성 항목>" [--summary "<항목>" ...] [--date YYYY-MM-DD] [--apply]\n')
    return 2
  }
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    process.stderr.write(`bump-skill-major: --date 는 YYYY-MM-DD 여야 한다: ${values.date}\n`)
    return 2
  }
  const name = positionals[0]
  let plan: BumpPlan
  try {
    plan = planBump(root, name, { notes: values.note ?? [], summary: values.summary, date: values.date })
  } catch (error) {
    process.stderr.write(`bump-skill-major: ${(error as Error).message}\n`)
    return 1
  }
  const out = process.stdout
  out.write(`${name}: ${plan.from} -> ${plan.to}\n`)
  out.write(`접는 항목 ${plan.folded.length}개:\n${plan.folded.join('\n')}\n\n`)
  out.write(`새 CHANGELOG 앞부분:\n${plan.changelog.split('\n').slice(0, 14).join('\n')}\n`)
  for (const file of plan.pending) out.write(`경고: ${CHANGES_DIR}/${file} 조각이 남아 있다. 머지 뒤 새 major 위에 버전이 더 올라간다\n`)
  if (plan.problems.length > 0) {
    for (const problem of plan.problems) process.stderr.write(`${problem}\n`)
    return 1
  }
  if (!values.apply) {
    out.write('미리보기만 했다. 파일에 쓰려면 --apply 를 준다\n')
    return 0
  }
  applyBump(root, name, plan)
  out.write(`적용했다: ${name}/SKILL.md, ${name}/CHANGELOG.md\n`)
  return 0
}

if (isMainModule(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
