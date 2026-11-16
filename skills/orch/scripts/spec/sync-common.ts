// 공통 지시서의 표지 항목을 설치된 틀에 맞춘다. 기본은 항목별 diff, --apply 만 파일을 쓴다.
// 사용법: orch spec sync-common [--repo DIR] [--specs-dir DIR] [--apply]
// 틀과 첫 줄이 같은 표지 없는 항목은 갱신하고, 나머지 항목과 keep 표지는 보존한다. 자리표시자 값이 있는 낡은 항목은 추측하지 않고 수동 확인으로 남긴다.
// 출력: SYNC-ADD/UPDATE 뒤 항목 diff, SYNC-KEEP, SYNC-MANUAL, SYNC-PREVIEW/APPLIED/UNCHANGED.
// 종료 코드: 0 성공(미리보기 포함), 1 수동 확인 필요(안전한 항목은 적용), 2 인자 또는 파일 오류.
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expandArgs } from '../lib/args.ts'
import { bundleRoot } from '../lib/bundle.ts'
import { CONDITIONAL_RULES, outsideFences, ruleBodies, ruleIssues, sameBody } from '../lib/common-rules.ts'
import { pathOf, requireMigrated } from '../lib/paths.ts'

// 목록 기호와 표지를 제외한 첫 줄로 옛 항목과 중복을 찾는다. 코드 예시는 제외한다.
function ruleHead(line: string): string {
  return line.replace(/^(?:[-*]|\d+\.)\s+/, '').replace(/<!--\s*orch-rule:[^>]*-->/g, '').trimEnd()
}

export function duplicateRuleHeads(text: string): { no: number; message: string }[] {
  const heads = new Map<string, number[]>()
  outsideFences(text.split(/\r\n|[\n\r\u2028\u2029]/)).forEach((line, index) => {
    if (!/^(?:[-*]|\d+\.)\s+/.test(line)) return
    const head = ruleHead(line)
    heads.set(head, [...(heads.get(head) ?? []), index + 1])
  })
  return [...heads.entries()].filter(([, rows]) => rows.length > 1)
    .map(([head, rows]) => ({ no: rows[0], message: `같은 머리 줄의 항목이 둘 이상 있다: ${rows.join(', ')}줄 (${head})` }))
}

export function syncCommon(copy: string, template: string, repo: string): { text: string; output: string[]; manual: boolean } {
  for (const text of [copy, template]) {
    const issues = [...ruleIssues(text), ...duplicateRuleHeads(text)]
    if (issues.length) throw new Error(issues.map((issue) => issue.message).join('; '))
  }
  const wanted = ruleBodies(template)
  const existing = ruleBodies(copy)
  // 한 항목에 표지가 여럿이면 keep 항목까지 함께 교체할 수 있어 쓰기 전에 거부한다.
  for (const rules of [wanted, existing]) {
    const spans = [...rules.values()].sort((a, b) => a.head - b.head)
    if (spans.some((span, i) => i > 0 && span.head < spans[i - 1].end)) throw new Error('표지 항목의 범위가 겹친다')
  }
  const lines = copy.split(/\r\n|[\n\r\u2028\u2029]/)
  const separators = [...copy.matchAll(/\r\n|[\n\r\u2028\u2029]/g)].map((match) => match[0])
  const starts: number[] = []
  let offset = 0
  for (const [index, line] of lines.entries()) {
    starts.push(offset)
    offset += line.length + (separators[index]?.length ?? 0)
  }
  const edits: { head: number; end: number; lines: string[] }[] = []
  const output: string[] = []
  let manual = false
  const addedSections = new Set<string>()
  for (const [name, want] of wanted) {
    let mine = existing.get(name)
    let legacy = false
    if (!mine) {
      const head = outsideFences(lines).findIndex((line) => /^(?:[-*]|\d+\.)\s+/.test(line)
        && !/<!--\s*orch-rule:/.test(line) && ruleHead(line) === ruleHead(want.raw.split('\n')[0]))
      if (head >= 0) {
        // 범위와 하위 목록의 안전 검사는 기존 표지 항목 파서를 그대로 쓴다.
        const marked = [...lines]
        marked[head] += ` <!-- orch-rule: ${name} -->`
        mine = ruleBodies(marked.join('\n')).get(name)!
        // 옛 틀은 설명과 명령 블록을 바로 다음 목록 항목으로 나누기도 했다.
        // 틀의 첫 설명 줄과 같은 표지 없는 항목만 함께 교체한다.
        const next = mine.end
        const continuation = want.raw.split('\n').slice(1).find((line) => line.trim())
        if (continuation && /^(?:[-*]|\d+\.)\s+/.test(lines[next] ?? '')
          && !/<!--\s*orch-rule:/.test(lines[next]) && ruleHead(lines[next]) === continuation.trim()) {
          const tail = [...lines]
          tail[next] += ` <!-- orch-rule: ${name} -->`
          const span = ruleBodies(tail.join('\n')).get(name)!
          mine.end = span.end
          mine.unsafe ||= span.unsafe
        }
        mine.raw = lines.slice(mine.head, mine.end).join('\n')
        legacy = true
      }
    }
    if (!mine && Object.hasOwn(CONDITIONAL_RULES, name) && !CONDITIONAL_RULES[name](repo)) continue
    if (mine?.keep) {
      output.push(`SYNC-KEEP ${name}`)
      continue
    }
    if (mine && !legacy && sameBody(want.body, mine.body)) continue
    if (mine?.unsafe || want.unsafe) {
      output.push(`SYNC-MANUAL ${name}: 표지 없는 부모나 하위 목록이 교체 범위에 있다`)
      manual = true
      continue
    }
    // 현재 틀만으로 바뀐 본문 안의 저장소 값을 확정할 수 없다. 원문을 남기고 직접 맞추게 한다.
    if (/\{\{[^}]*\}\}/.test(want.raw)) {
      output.push(`SYNC-MANUAL ${name}: 자리표시자 값을 확인해 직접 맞춘다`)
      manual = true
      continue
    }
    let head = mine?.head ?? lines.length
    let end = mine?.end ?? head
    let sectionPrefix: string[] = []
    if (!mine) {
      const headings = outsideFences(lines).flatMap((line, index) => /^#{1,6}\s+/.test(line) ? [{ title: line.trim(), head: index }] : [])
      const sections = headings.filter((heading) => heading.title === want.section)
      if (sections.length > 1) {
        output.push(`SYNC-MANUAL ${name}: 같은 절 제목이 둘 이상이다: ${want.section}`)
        manual = true
        continue
      }
      const section = sections[0]
      const sectionEnd = section ? headings.find((heading) => heading.head > section.head)?.head ?? lines.length : lines.length
      const next = [...wanted.entries()].find(([key, rule]) => rule.head > want.head && rule.section === want.section && existing.has(key) &&
        (!want.section || (section && existing.get(key)!.head > section.head && existing.get(key)!.head < sectionEnd)))
      head = end = next ? existing.get(next[0])!.head : sectionEnd
      if (want.section && !section && !addedSections.has(want.section)) {
        sectionPrefix = ['', want.section, '']
        addedSections.add(want.section)
      }
      output.push(`SYNC-LOCATION ${name}: ${want.section ?? '절 제목 없음'}, ${head + 1}줄 앞${next ? `, 표지 ${next[0]} 앞` : ''}`)
    }
    // 기존 목록 번호와 기호는 저장소의 문맥이다.
    const prefix = mine?.raw.match(/^(?:[-*]|\d+\.)\s+/)?.[0]
    const raw = prefix ? want.raw.replace(/^(?:[-*]|\d+\.)\s+/, prefix) : want.raw
    const replacement = [...sectionPrefix, ...raw.replace(/\n+$/, '').split('\n')]
    if (mine) {
      const trailing = lines.slice(mine.head, mine.end).reverse().findIndex((line) => line.trim() !== '')
      replacement.push(...Array(Math.max(0, trailing)).fill(''))
    } else replacement.push('')
    edits.push({ head, end, lines: replacement })
    output.push(`SYNC-${mine ? 'UPDATE' : 'ADD'} ${name}`, `@@ -${head === end ? head : head + 1},${end - head} +${head + 1},${replacement.length} @@`)
    if (mine) output.push(...lines.slice(head, end).map((line) => `-${line}`))
    output.push(...replacement.map((line) => `+${line}`))
  }
  // 원문의 문자 오프셋으로 잘라 붙여 교체 범위 밖의 줄바꿈은 그대로 둔다.
  let text = copy
  for (const edit of edits.toReversed().sort((a, b) => b.head - a.head)) {
    const start = starts[edit.head] ?? copy.length
    const end = starts[edit.end] ?? copy.length
    const eol = separators[edit.head] ?? separators[edit.head - 1] ?? separators[0] ?? '\n'
    let replacement = edit.lines.join(eol)
    if (edit.end < lines.length) replacement += eol
    if (edit.head === edit.end && start === copy.length && copy.length && !/[\r\n\u2028\u2029]$/.test(copy)) replacement = eol + replacement
    text = text.slice(0, start) + replacement + text.slice(end)
  }
  const issues = [...ruleIssues(text), ...duplicateRuleHeads(text)]
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join('; '))
  return { text, output, manual }
}

// 같은 폴더에서 완성한 파일을 rename 한다. 실패하면 원본과 권한을 지키고 임시 파일만 치운다.
export function atomicWrite(file: string, text: string, rename: typeof renameSync = renameSync): void {
  const target = realpathSync(file)
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: statSync(target).mode })
    chmodSync(temporary, statSync(target).mode & 0o7777)
    rename(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function main(argv: string[]): number {
  try {
    const options = { repo: { type: 'string' }, 'specs-dir': { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } as const
    const { values } = parseArgs({ args: expandArgs(argv, options), options })
    if (values.help) {
      console.log('사용법: orch spec sync-common [--repo DIR] [--specs-dir DIR] [--apply]')
      return 0
    }
    const repo = resolve(values.repo ?? process.cwd())
    if (!requireMigrated(repo, 'sync-common', null)) return 2
    const file = join(resolve(values['specs-dir'] ?? pathOf('specs', repo)), 'spec-common.md')
    const original = readFileSync(file, 'utf8')
    const template = readFileSync(process.env.SPEC_TEMPLATE || join(bundleRoot(), 'templates', 'spec-common.md'), 'utf8')
    const result = syncCommon(original, template, repo)
    for (const line of result.output) console.log(line)
    const changed = result.text !== original
    if (values.apply && changed) atomicWrite(file, result.text)
    console.log(`SYNC-${changed ? values.apply ? 'APPLIED' : 'PREVIEW' : 'UNCHANGED'} ${file}`)
    return result.manual ? 1 : 0
  } catch (error) {
    console.error(`sync-common: ${(error as Error).message}`)
    return 2
  }
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2))
