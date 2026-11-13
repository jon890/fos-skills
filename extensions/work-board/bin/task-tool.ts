// 창이 저장소의 업무 도구 이름을 읽는다. stdout: { name: string|null, error: string|null } 한 줄.
import { parseArgs } from 'node:util'
import { taskAdapter } from '../../../skills/orch/scripts/lib/task-adapters.ts'
import { ConfigError } from '../../../skills/orch/scripts/core/config.ts'
function main(): number {
  let repo: string | undefined
  try { const parsed = parseArgs({ options: { repo: { type: 'string' } } }); repo = parsed.values.repo; if (!repo) throw Error('repo') }
  catch { process.stderr.write('사용법: task-tool.ts --repo <폴더>\n'); return 2 }
  try { console.log(JSON.stringify({ name: taskAdapter(repo)?.name ?? null, error: null })); return 0 }
  catch (e) { if (!(e instanceof ConfigError)) throw e; console.log(JSON.stringify({ name: null, error: e.message })); return 0 }
}
process.exitCode = main()
