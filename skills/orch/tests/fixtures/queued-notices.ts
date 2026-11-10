import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 모아 보내려고 쌓아 둔 알림(state/notice-digest). run 을 주면 그 Run 의 것만 읽는다. 아직 DIGEST 로 보내기 전이다
export function queuedNotices(orchDir: string, run?: string): Record<string, unknown>[] {
  const dir = join(orchDir, 'state', 'notice-digest')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('__') && (!run || name === `${run}.json`))
    .flatMap((name) => (JSON.parse(readFileSync(join(dir, name), 'utf8')).items as Record<string, unknown>[]).map((item) => ({ source: 'orch-loop', kind: item.kind, text: item.text, queued: true })))
}
