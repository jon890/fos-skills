// mod 는 TypeScript 를 import 하지 못한다. 표시용 gh 읽기를 orch 와 같은 캐시·잠금으로 실행한다.
// 사용법: node github.ts prs|url
// cwd 는 현재 세션의 저장소다. stdout 과 종료 코드는 gh 결과 그대로이고 쓰는 명령은 받지 않는다.
import { gh } from '../../../skills/orch/scripts/lib/gh.ts'

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
  const done = gh(query, { timeoutMs: 20_000, ttlSeconds: () => 300 })
  process.stdout.write(done.stdout)
  process.stderr.write(done.stderr)
  process.exitCode = done.code
}
