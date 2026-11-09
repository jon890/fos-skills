// 공통 지시서의 표지 항목을 설치된 틀에 맞춘다. 기본은 항목별 diff, --apply 만 파일을 쓴다.
// 사용법: orch spec sync-common [--repo DIR] [--specs-dir DIR] [--apply]
// 표지 없는 항목과 keep 표지는 보존한다. 자리표시자 값이 있는 낡은 항목은 추측하지 않고 수동 확인으로 남긴다.
// 출력: SYNC-ADD/UPDATE 뒤 항목 diff, SYNC-KEEP, SYNC-MANUAL, SYNC-PREVIEW/APPLIED/UNCHANGED.
// 종료 코드: 0 성공(미리보기 포함), 1 수동 확인 필요(안전한 항목은 적용), 2 인자 또는 파일 오류.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expandArgs } from '../lib/args.ts'
import { bundleRoot } from '../lib/bundle.ts'
import { CONDITIONAL_RULES, ruleBodies, sameBody } from '../lib/common-rules.ts'
import { pathOf, requireMigrated } from '../lib/paths.ts'

export function syncCommon(copy: string, template: string, repo: string): { text: string; output: string[]; manual: boolean } {
  for (const text of [copy, template]) {
    const names = [...text.matchAll(/<!--\s*orch-rule:\s*([A-Za-z0-9_-]+)(?:\s+keep)?\s*-->/g)].map((match) => match[1])
    if (new Set(names).size !== names.length) throw new Error('같은 표지가 둘 이상 있다. 중복을 없앤 뒤 다시 실행한다')
  }
  const wanted = ruleBodies(template)
  const existing = ruleBodies(copy)
  // 한 항목에 표지가 여럿이면 keep 항목까지 함께 교체할 수 있어 쓰기 전에 거부한다.
  for (const rules of [wanted, existing]) {
    const spans = [...rules.values()].sort((a, b) => a.head - b.head)
    if (spans.some((span, i) => i > 0 && span.head < spans[i - 1].end)) throw new Error('표지 항목의 범위가 겹친다')
  }
  const lines = copy.split(/\r\n|[\n\r\u2028\u2029]/)
  const eol = copy.includes('\r\n') ? '\r\n' : '\n'
  const edits: { head: number; end: number; lines: string[] }[] = []
  const output: string[] = []
  let manual = false
  for (const [name, want] of wanted) {
    const mine = existing.get(name)
    if (!mine && Object.hasOwn(CONDITIONAL_RULES, name) && !CONDITIONAL_RULES[name](repo)) continue
    if (mine?.keep) {
      output.push(`SYNC-KEEP ${name}`)
      continue
    }
    if (mine && sameBody(want.body, mine.body)) continue
    // 현재 틀만으로 바뀐 본문 안의 저장소 값을 확정할 수 없다. 원문을 남기고 직접 맞추게 한다.
    if (/\{\{[^}]*\}\}/.test(want.raw)) {
      output.push(`SYNC-MANUAL ${name}: 자리표시자 값을 확인해 직접 맞춘다`)
      manual = true
      continue
    }
    let head = mine?.head ?? lines.length
    let end = mine?.end ?? head
    if (!mine) {
      const next = [...wanted.entries()].find(([key, rule]) => rule.head > want.head && existing.has(key))
      if (next) head = end = existing.get(next[0])!.head
    }
    // 기존 목록 번호와 기호는 저장소의 문맥이다.
    const prefix = mine?.raw.match(/^(?:[-*]|\d+\.)\s+/)?.[0]
    const raw = prefix ? want.raw.replace(/^(?:[-*]|\d+\.)\s+/, prefix) : want.raw
    const replacement = raw.replace(/\n+$/, '').split('\n')
    if (mine) {
      const trailing = lines.slice(mine.head, mine.end).reverse().findIndex((line) => line.trim() !== '')
      replacement.push(...Array(Math.max(0, trailing)).fill(''))
    } else replacement.push('')
    edits.push({ head, end, lines: replacement })
    output.push(`SYNC-${mine ? 'UPDATE' : 'ADD'} ${name}`, `@@ -${head + 1},${end - head} +${head + 1},${replacement.length} @@`)
    if (mine) output.push(...lines.slice(head, end).map((line) => `-${line}`))
    output.push(...replacement.map((line) => `+${line}`))
  }
  // 같은 위치에 빠진 항목을 넣을 때 틀의 순서를 보존한다.
  for (const edit of edits.toReversed().sort((a, b) => b.head - a.head)) lines.splice(edit.head, edit.end - edit.head, ...edit.lines)
  return { text: edits.length ? lines.join(eol) : copy, output, manual }
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
    if (values.apply && changed) writeFileSync(file, result.text)
    console.log(`SYNC-${changed ? values.apply ? 'APPLIED' : 'PREVIEW' : 'UNCHANGED'} ${file}`)
    return result.manual ? 1 : 0
  } catch (error) {
    console.error(`sync-common: ${(error as Error).message}`)
    return 2
  }
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2))
