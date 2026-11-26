// 창이 읽을 보드 파일 경로를 orch 와 같은 규칙(skills/orch/scripts/lib/board-file.ts 의 boardPath)으로 정한다.
// stdout: { path: string|null, error: string|null } 한 줄. 설정이 잘못되면 path 는 null, error 에 이유다.
import { parseArgs } from 'node:util'
import { boardPath } from '../../../skills/orch/scripts/lib/board-file.ts'
import { ConfigError } from '../../../skills/orch/scripts/core/config.ts'
function main(): number {
  let repo: string | undefined
  try { const parsed = parseArgs({ options: { repo: { type: 'string' } } }); repo = parsed.values.repo; if (!repo) throw Error('repo') }
  catch { process.stderr.write('사용법: board-file.ts --repo <폴더>\n'); return 2 }
  try { console.log(JSON.stringify({ path: boardPath(repo), error: null })); return 0 }
  catch (e) { if (!(e instanceof ConfigError)) throw e; console.log(JSON.stringify({ path: null, error: e.message })); return 0 }
}
process.exitCode = main()
