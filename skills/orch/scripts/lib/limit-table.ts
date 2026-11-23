// agent-selection.md 의 한도 표를 시작 전 검사, 실행, 모델 알림에서 함께 읽는다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRoot } from './bundle.ts'
import { sameFamily } from './model-generation.ts'

type Entry = { agent: string; model: string; effort: string | null }

// 「사용 한도에 걸렸을 때」 표의 칸 하나. `gpt-6.1-sol` `medium` 이나 Claude Opus 5.5 `medium` 꼴이다
function entryOf(text: string): Entry | null {
  const claude = /^Claude ([A-Za-z]+) (\d+(?:\.\d+)*)(?:\s+`([a-z]+)`)?$/.exec(text.trim())
  if (claude) return { agent: 'claude', model: `claude-${claude[1].toLowerCase()}-${claude[2].replaceAll('.', '-')}`, effort: claude[3] ?? null }
  const codex = /^`([^`]+)`(?:\s+`([a-z]+)`)?$/.exec(text.trim())
  if (codex) return { agent: 'codex', model: codex[1], effort: codex[2] ?? null }
  return null
}

export type LimitRow = { from: Entry; same: Entry[]; cell: string; grade?: string }

// 「사용 한도에 걸렸을 때」 표의 줄. 제목이나 칸 꼴이 바뀌면 빈 목록이다
export function limitRows(table: string): LimitRow[] {
  const lines = table.split('\n')
  const start = lines.indexOf('### 사용 한도에 걸렸을 때')
  if (start === -1) return []
  const rows: LimitRow[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 3 && cells.length !== 4) continue
    const from = entryOf(cells[0])
    if (!from) continue
    const grade = cells[3]?.match(/^`([a-z][a-z0-9-]*)`$/)?.[1]
    rows.push({ from, same: cells[1].split(/,\s*/).map(entryOf).filter((e): e is Entry => e !== null), cell: cells[1], ...(grade ? { grade } : {}) })
  }
  return rows
}

// 등급의 두 제공자는 등급을 표시한 한도 표의 행과 첫 반대 제공자에서 읽는다.
export function gradeCandidates(table: string): Map<string, Entry[]> {
  const candidates = new Map<string, Entry[]>()
  for (const row of limitRows(table)) {
    if (!row.grade) continue
    const other = row.same.find(entry => entry.agent !== row.from.agent)
    const source = { ...row.from, effort: null }
    candidates.set(row.grade, other ? [source, other] : [source])
  }
  return candidates
}

// 걸린 모델의 줄. effort 까지 맞는 줄이 먼저이고, 없으면 effort 없는 줄이다. 모델은 같은 계열이면 세대가 달라도 맞는 것으로 본다(model-generation.ts)
export function limitRowOf(table: string, worker: { model: string | null; effort: string | null }): LimitRow | null {
  const rows = limitRows(table)
  const exact = (r: LimitRow) => r.from.model === worker.model
  const family = (r: LimitRow) => sameFamily(r.from.model, worker.model)
  for (const match of [exact, family]) {
    const found = rows.find(r => match(r) && r.from.effort === worker.effort) ?? rows.find(r => match(r) && r.from.effort === null)
    if (found) return found
  }
  return null
}

export function readSelectionTable(file = join(bundleRoot(), 'references', 'agent-selection.md')): string {
  return readFileSync(file, 'utf8')
}
