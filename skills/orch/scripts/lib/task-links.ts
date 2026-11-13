// 열린 항목 중 task-ref 만 있는 항목의 업무 주소를 채운다. 실패 뒤 30분 간격, 틱 예산 60초, CLI 호출 15초.
// state/task-links.json: { items: { [id]: { ref, at(ISO), reason } }, config?: string }. 깨진 기록은 비운다.
// 성공 TASK-LINK <id> <번호>, 첫 실패 TASK-LINK-FAIL <id> <번호> <이유>, 설정 오류 TASK-LINK-CONFIG <이유>.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { taskAdapter, resolveTaskUrl } from './task-adapters.ts'
import { boardPath } from './board-file.ts'
import { BOARD_BIN, readBoard } from './board.ts'
import { makeParent, pathOf } from './paths.ts'
import { run, scriptCommand } from './proc.ts'

type Failure = { ref: string; at: string; reason: string }
type RecordFile = { items: Record<string, Failure>; config?: string }
const oneLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
export async function fillTaskUrls(repo: string, opts: { now?: () => number; budgetMs?: number; log: (line: string) => void; resolve?: typeof resolveTaskUrl }): Promise<{ filled: string[]; failed: string[] }> {
  const result = { filled: [] as string[], failed: [] as string[] }
  const board = boardPath(repo)
  if (!existsSync(board)) return result
  const file = join(pathOf('state', repo), 'task-links.json')
  let record: RecordFile = { items: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
      const items = Object.fromEntries(Object.entries(raw.items).filter(([, v]) => {
        const row = v as Failure | null
        return row && typeof row.ref === 'string' && typeof row.reason === 'string' && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
      })) as Record<string, Failure>
      record = { items, ...(typeof raw.config === 'string' ? { config: raw.config } : {}) }
    }
  } catch {}
  const save = () => { makeParent(file, repo); writeFileSync(`${file}.tmp`, JSON.stringify(record)); renameSync(`${file}.tmp`, file) }
  let adapter
  try { adapter = taskAdapter(repo) }
  catch (e) { const reason = oneLine(e); if (record.config !== reason) opts.log(`TASK-LINK-CONFIG ${reason}`); record.config = reason; save(); return result }
  delete record.config
  const clean = () => {
    const rows = new Map(readBoard(board).map(row => [String(row.id), row]))
    for (const [id, old] of Object.entries(record.items)) {
      const row = rows.get(id)
      if (!row || row.status === 'done' || row['task-ref'] !== old.ref || row.task) delete record.items[id]
    }
  }
  clean()
  if (!adapter) { if (existsSync(file)) save(); return result }
  const now = opts.now ?? Date.now, start = now()
  for (const row of readBoard(board)) {
    const id = String(row.id), ref = row['task-ref']
    if (row.status === 'done' || typeof ref !== 'string' || !ref || row.task) continue
    const old = record.items[id]
    if (old?.ref === ref && now() - Date.parse(old.at) < 30 * 60 * 1000) continue
    if (now() - start >= (opts.budgetMs ?? 60000)) break
    try {
      const url = await (opts.resolve ?? resolveTaskUrl)(adapter, ref)
      const done = run(scriptCommand(process.env.BOARD_BIN || BOARD_BIN, ['set', id, '--exact', '--fill', '--if-task-ref', ref, '--task', url, '--file', board]))
      if (done.code === 1 && /^(?:board.ts: )?(?:업무 번호가 바뀌어 저장하지 않았다|항목이 없다)/.test(done.stderr.trim())) continue
      if (done.code !== 0) throw new Error(done.stderr.trim() || `보드 명령 종료 코드 ${done.code}`)
      delete record.items[id]; result.filled.push(id); opts.log(`TASK-LINK ${id} ${ref}`)
    } catch (e) {
      const reason = oneLine(e)
      if (old?.ref !== ref) opts.log(`TASK-LINK-FAIL ${id} ${ref} ${reason}`)
      record.items[id] = { ref, at: new Date(now()).toISOString(), reason: old?.ref === ref ? old.reason : reason }
      result.failed.push(id)
    }
  }
  clean(); save()
  return result
}
