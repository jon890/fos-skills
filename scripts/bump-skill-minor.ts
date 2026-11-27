#!/usr/bin/env node
// 호환성 변경으로 스킬의 minor 버전을 직접 올린다. 일반 PR 은 .minor.md 조각을 쓴다.
// --apply 를 주면 SKILL.md 와 CHANGELOG 를 고친다. 기본은 미리보기다.

import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { pyReadText } from '../modules/kit/py.ts'
import { checkChangelog } from './check-skill-docs.ts'
import { isMainModule } from './is-main.ts'
import { CHANGES_DIR, currentVersion, nextVersion, prependSection, SKILL_VERSION_LINE, todaySeoul } from './skill_changes.ts'
import { isDir, sourcePath } from './skill_paths.ts'

const ROOT = join(import.meta.dirname, '..')

export type BumpOptions = { notes: string[]; date?: string }
export type BumpPlan = { from: string; to: string; skillMd: string; changelog: string; pending: string[]; problems: string[] }

// 파일을 바꾸지 않고 바꿀 내용을 계산한다. problems 가 비어 있지 않으면 적용하지 않는다
export function planBump(root: string, name: string, options: BumpOptions): BumpPlan {
  const dir = sourcePath(root, name)
  const skillText = pyReadText(join(dir, 'SKILL.md'))
  const match = SKILL_VERSION_LINE.exec(skillText)
  if (!match) throw new Error(`${name}/SKILL.md: metadata.version 줄을 찾지 못했다`)
  const from = match[2]
  const to = nextVersion(from, 'minor')
  const changelogText = pyReadText(join(dir, 'CHANGELOG.md'))
  if (currentVersion(changelogText) !== from) throw new Error(`${name}/CHANGELOG.md: 첫 버전이 metadata.version 과 다르다`)
  const notes = options.notes.map(note => {
    const text = note.trim().replace(/^- /, '')
    return `- ${text.startsWith('호환성:') ? text : `호환성: ${text}`}`
  })
  const problems: string[] = []
  if (notes.length === 0 || notes.some(note => note.trim() === '- 호환성:')) {
    problems.push('--note 에서 무엇이 깨지는지 한 줄 이상 적는다')
  }
  const changelog = prependSection(changelogText, to, options.date ?? todaySeoul(), notes.join('\n'))

  const changesDir = join(dir, CHANGES_DIR)
  const pending = isDir(changesDir) ? readdirSync(changesDir).sort() : []
  const skillMd = skillText.replace(SKILL_VERSION_LINE, (_all, before: string, _old: string, after: string) => before + to + after)
  for (const problem of checkChangelog(name, changelog, to)) problems.push(`${name}/CHANGELOG.md: ${problem}`)
  return { from, to, skillMd, changelog, pending, problems }
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
      date: { type: 'string' },
      apply: { type: 'boolean' },
    },
  } as const
  let parsed: ReturnType<typeof parseArgs<typeof config>>
  try {
    parsed = parseArgs(config)
  } catch (error) {
    process.stderr.write(`bump-skill-minor: ${(error as Error).message}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (positionals.length !== 1) {
    process.stderr.write('사용: node scripts/bump-skill-minor.ts <스킬> --note "<호환성 항목>" [--date YYYY-MM-DD] [--apply]\n')
    return 2
  }
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    process.stderr.write(`bump-skill-minor: --date 는 YYYY-MM-DD 여야 한다: ${values.date}\n`)
    return 2
  }
  const name = positionals[0]
  let plan: BumpPlan
  try {
    plan = planBump(root, name, { notes: values.note ?? [], date: values.date })
  } catch (error) {
    process.stderr.write(`bump-skill-minor: ${(error as Error).message}\n`)
    return 1
  }
  const out = process.stdout
  out.write(`${name}: ${plan.from} -> ${plan.to}\n`)
  out.write(`새 CHANGELOG 앞부분:\n${plan.changelog.split('\n').slice(0, 14).join('\n')}\n`)
  for (const file of plan.pending) out.write(`경고: ${CHANGES_DIR}/${file} 조각이 남아 있다. 머지 뒤 새 minor 위에 버전이 더 올라간다\n`)
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
