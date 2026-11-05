// mod 는 TypeScript 를 import 하지 못한다. 표시용 gh 읽기를 orch 와 같은 캐시·잠금으로 실행한다.
// 사용법: node github.ts prs|url
// cwd 는 현재 세션의 저장소다. stdout 과 종료 코드는 gh 결과 그대로이고 쓰는 명령은 받지 않는다.
import { gh } from '../../../skills/orch/scripts/lib/gh.ts'
import { mainCheckout } from '../../../skills/orch/scripts/lib/git.ts'
import { orchDir } from '../../../skills/orch/scripts/lib/paths.ts'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const PR_ARGS = ['pr', 'list', '--state', 'open', '--limit', '30', '--json',
  'number,title,isDraft,mergeStateStatus,headRefName,statusCheckRollup,author']
export const URL_ARGS = ['repo', 'view', '--json', 'url', '--jq', '.url']

const args = process.argv.slice(2)
const queries: Record<string, string[]> = { prs: PR_ARGS, url: URL_ARGS }
const query = args.length === 1 && Object.hasOwn(queries, args[0]) ? queries[args[0]] : undefined
if (!query) {
  process.stderr.write('사용법: github.ts prs|url\n')
  process.exitCode = 2
} else {
  // orch 를 쓰는 저장소와 명시한 ORCH_DIR 는 기존 캐시를 공유한다.
  // 그 밖에는 PR 응답이 git add -A 에 들어가지 않도록 저장소 밖에 둔다.
  const repo = process.cwd()
  if (!process.env.ORCH_DIR && !existsSync(orchDir(repo))) {
    const configured = process.env.XDG_CACHE_HOME
    const cache = configured && isAbsolute(configured) ? configured : join(homedir(), '.cache')
    const key = createHash('sha256').update(mainCheckout(repo)).digest('hex')
    process.env.ORCH_DIR = join(cache, 'fos-skills', 'work-board', key)
  }
  const done = gh(query, { timeoutMs: 20_000, ttlSeconds: () => 300 })
  process.stdout.write(done.stdout)
  process.stderr.write(done.stderr)
  process.exitCode = done.code
}
