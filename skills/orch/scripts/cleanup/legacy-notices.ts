// 없어진 대기 상태를 휴지통으로 옮긴다. 읽지 않은 루프 알림은 성공적으로 전송한 뒤에만 옮긴다.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathOf } from '../lib/paths.ts'
import { readLoop, registeredRuns } from '../lib/loop.ts'
import { queueDigest } from '../lib/notice-digest.ts'

export function migrateLegacyNotices(repo: string, trash: string, apply: boolean, log: (line: string) => void): void {
  const state = pathOf('state', repo)
  const move = (file: string) => {
    if (!existsSync(file)) return
    log(`LEGACY-STATE ${file}`)
    if (!apply) return
    mkdirSync(trash, { recursive: true })
    renameSync(file, join(trash, `${basename(file)}.${Date.now()}.${process.pid}`))
  }
  const dir = join(state, 'loop-events')
  const files = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.jsonl')).map(n => join(dir, n)) : []
  if (existsSync(join(state, 'loop-events.jsonl'))) files.push(join(state, 'loop-events.jsonl'))
  for (const file of files) {
    const cursor = file.replace(/\.jsonl$/, '.cursor')
    let at = 0
    if (existsSync(cursor)) { const raw = readFileSync(cursor, 'utf8').trim(); if (/^\d+$/.test(raw)) at = Number(raw) }
    let rows: { seq: number; kind: string; text: string }[]
    try { rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.seq > at) }
    catch (e) { log(`LEGACY-STATE-KEEP ${file}: ${String(e)}`); continue }
    if (rows.length) {
      const entries = registeredRuns(repo)
      const key = basename(file, '.jsonl')
      const old = readLoop(repo)
      const known = [...new Set([...entries.map(entry => entry.run), ...(old?.runs ?? []), ...(old?.run ? [old.run] : [])])]
      // 단일 옛 파일은 앞 loop.json 의 Run 에만 속한다. 변환한 파일명에서 실제 Run 을 추측하지 않는다.
      const matches = known.filter(run => run.replace(/[^A-Za-z0-9_.-]/g, '_') === key)
      const target = key === 'loop-events' ? old?.run : matches.length === 1 ? matches[0] : null
      if (!target) { log(`LEGACY-STATE-KEEP ${file}: Run 을 알 수 없다`); continue }
      if (!apply) { log(`LEGACY-NOTICE ${target}: ${rows.length}`); continue }
      // 안내성 알림이라 바로 깨우지 않고 DIGEST 로 모아 보낸다(lib/notice-digest.ts)
      try { queueDigest(repo, target, 'LEGACY-NOTICE', rows.map(row => `${row.kind} ${row.text}`).join('; ')) }
      catch (e) { log(`NOTICE-FAIL LEGACY-NOTICE ${String(e)}`); continue }
    }
    move(file); move(cursor)
  }
  if (existsSync(dir)) for (const name of readdirSync(dir).filter(n => n.endsWith('.cursor'))) {
    if (!existsSync(join(dir, name.replace(/\.cursor$/, '.jsonl')))) move(join(dir, name))
  }
  for (const name of ['wait', 'no-wait']) move(join(state, name))
}
