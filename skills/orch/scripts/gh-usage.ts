// 로컬 호출 기록만 읽는다. GitHub 에는 접속하지 않는다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { orchDir } from './lib/paths.ts'

const repoAt = process.argv.indexOf('--repo')
const repo = repoAt >= 0 ? process.argv[repoAt + 1] : process.cwd()
if (!repo) {
  process.stderr.write('usage: gh-usage.ts [--repo DIR]\n')
  process.exitCode = 2
} else {
  const now = Date.now()
  let calls = 0
  let hits = 0
  for (const date of new Set([now, now - 3600_000].map((time) => new Date(time).toISOString().slice(0, 10)))) {
    let lines: string[] = []
    try { lines = readFileSync(join(orchDir(repo), 'state/gh/logs', `${date}.jsonl`), 'utf8').split('\n') } catch { /* 첫 호출 전 */ }
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        const time = Date.parse(row.time)
        if (time >= now - 3600_000 && time <= now) {
          if (row.cacheHit === true) hits++
          else calls++
        }
      } catch { /* 쓰는 중인 마지막 줄은 다음 실행에서 읽는다. */ }
    }
  }
  process.stdout.write(`GH-USAGE last-hour calls=${calls} cache-hits=${hits}\n`)
}
