// Claude Code 훅은 Node 내장 모듈을 불러올 수 없다. 최초 경로 확인만 별도 프로세스에서 하고
// 이후 파일은 훅이 건넨 파일 API 로 매번 읽는다. 경로를 보관하고 열린 대기를 고르는 것은 이 모듈이 맡는다.
import type { Approval } from '../../core/approvals.ts'

type BoardApproval = Pick<Approval, 'id' | 'version' | 'kind' | 'title' | 'createdAt' |
  'terminal' | 'item' | 'step' | 'then' | 'real' | 'command'> & { preview: { path: string } | null }
type ApprovalView = { open: BoardApproval[]; error?: never } | { open?: never; error: string }

function openApprovals(source: string): ApprovalView {
  if (!String(source || '').trim()) return { open: [] }
  let data
  try {
    data = JSON.parse(source)
  } catch (error) {
    return { error: (error as Error).message }
  }
  if (!data || !Array.isArray(data.entries)) return { error: '승인 파일 꼴이 틀려요' }
  // 창은 저장 파일 전체가 유효한지 검사하는 대신 그릴 수 있는 열린 항목만 골라 왔다.
  const open = data.entries
    .filter((e): e is Approval => e && e.state === 'open' && typeof e.id === 'string' && Number.isInteger(e.version) && typeof e.title === 'string')
    .sort((a, b) => a.version - b.version)
    .map(({ id, version, kind, title, createdAt, terminal, item, step, then, real, command, preview }) => ({
      id, version, kind, title, createdAt, terminal, item, step, then, real, command,
      preview: preview && { path: preview.path },
    }))
  return { open }
}

type BoardFiles = {
  exists: (file: string) => Promise<boolean>
  read: (file: string) => Promise<string>
}

// 주 checkout 을 바꾸거나 창을 열 때 만든다. 파일을 읽는 동안에는 같은 경로를 쓴다.
export async function boardApprovalReader(
  repo: string,
  pluginRoot: string,
  run: (argv: string[]) => Promise<string>,
  files: BoardFiles,
): Promise<() => Promise<ApprovalView>> {
  const file = (await run(['node', '--disable-warning=ExperimentalWarning',
    pluginRoot + '/skills/orch/scripts/lib/board-queries/board-approvals.ts', repo])).trim()
  if (!file.startsWith('/')) throw new Error('승인 파일 경로를 찾지 못했어요')
  return async () => await files.exists(file) ? openApprovals(await files.read(file)) : { open: [] }
}
