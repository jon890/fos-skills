// 설정 파일과 업무 도구 호출. DOORAY_BIN 과 timeoutMs 는 가짜 CLI 를 쓰는 테스트에서도 사용한다.
// 실제 사내 CLI 의 응답 맨 위 id 와 한글 프로젝트 코드 조회는 코디네이터 환경에서 별도로 확인한다.
import { taskAdapterOf, templateUrl, doorayParts } from '../core/task-adapters.ts'
import type { TaskAdapter } from '../core/task-adapters.ts'
import { loadConfig } from './config.ts'
import { runAsync } from './proc.ts'
export function taskAdapter(repo: string): TaskAdapter | null { return taskAdapterOf(loadConfig(repo)) }
export async function resolveTaskUrl(adapter: TaskAdapter, ref: string, opts?: { dooray?: string; timeoutMs?: number }): Promise<string> {
  if (adapter.kind === 'url-template') return templateUrl(adapter, ref)
  const parts = doorayParts(ref)
  if (!parts) throw new Error(`업무 번호를 프로젝트와 번호로 나누지 못했다: ${ref}`)
  const result = await runAsync([opts?.dooray ?? process.env.DOORAY_BIN ?? 'dooray', '--json', 'post', 'get', parts.project, parts.number], { timeoutMs: opts?.timeoutMs ?? 15000 })
  if (result.code === 127) throw new Error('dooray 명령을 찾지 못했다')
  if (result.code !== 0) throw new Error(`dooray post get: ${(result.stderr || result.stdout).trim().split(/\r?\n/)[0] || '조회 실패'}`)
  let id: unknown
  try { id = JSON.parse(result.stdout)?.id } catch {}
  if (!((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id)))) throw new Error('dooray post get: 응답에 id 가 없다')
  return `${adapter.webUrl}/project/tasks/${id}`
}
