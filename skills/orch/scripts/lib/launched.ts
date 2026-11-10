// launch-worker.ts 가 띄운 worker 의 기록. cleanup-sweep.ts 가 「코디네이터가 띄운 터미널」 을 가리는 근거다.
//
// Orca 는 worker 가 끝난 터미널에 입력이 들어가면 `user_owned` 로 기록한다. 사람이 넘겨받은 것과 이 자동 기록을 필드로 구분할 수 없어,
// 코디네이터가 띄운 터미널도 사람 터미널로 보고 워크트리를 남겼다. 띄운 쪽이 기록을 남기면 sweep 이 그 기록으로 구분한다.
//
// 위치: <orch 루트>/state/launched-workers/<dispatch>.json. dispatch 마다 파일 하나라 병렬로 띄워도 서로 덮지 않는다.
// 내용: { dispatch, task, terminal, worktree, branch, run, spec, lint_ack, agent, model, effort, effective, experiment }. worktree 밖은 모르면 null 이거나 없다. spec 은 그 dispatch 에 준 지시서의 절대경로다.
// agent, model, effort 는 launch-worker 와 worker resume 이 공통으로 적는다. Orca 가 그 dispatch 의 실행 설정을 모르므로
// 다음 resume 이 이 값으로 같은 에이전트를 다시 띄운다.
// branch 는 워크트리와 지시서가 정리된 뒤에도 질문의 PR 종료를 확인할 때 쓴다. 옛 기록에는 없을 수 있다.
// lint_ack 은 spec-lint 가 막을 발견을 냈는데 `--lint-ack` 으로 넘기고 띄운 이유다.
// 다시 띄우기(--retry-of)와 `--terminal` 이어 쓰기는 새 dispatch 를 만들어 새 파일이 생긴다. send-to-worker 의 후속 일도 Orca send 의 새 dispatch 로 기록한다.
// 그래서 한 워크트리에 쓴 지시서(첫 지시서, 이어받기, 충돌 해소, 후속)는 그 워크트리를 가리키는 기록들의 spec 이다.
//
// 내보내는 것:
//     recordLaunch   기록을 쓴다. 실패하면 던진다
//     readLaunch     기록을 읽는다. 없거나 형식이 다르면 null
//     forgetLaunch   기록을 지운다. 없어도 통과한다
//     launchesAt     그 워크트리를 가리키는 기록 전부. 폴더가 없으면 빈 목록
//     latestTaskLaunch  같은 Task 의 가장 최근 기록. 영구 이력 도입 전 ready Task 의 호환에 쓴다

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realPath } from './fs.ts'
import { ensure, pathOf } from './paths.ts'

export type Effective = { agent?: string | null; model?: string | null; effort?: string | null }

export type Launch = {
  completion?: "none" | null
  branch?: string | null; dispatch: string; task?: string | null; terminal: string | null; worktree: string; run: string | null; spec?: string | null; lint_ack?: string | null
  agent?: string | null; model?: string | null; effort?: string | null
  effective?: Effective | null; experiment?: string | null
}

const DIR = 'launched-workers'

// 읽기와 지우기는 폴더를 만들지 않는다. create 일 때만 state 폴더를 만들고 git 이 무시하게 한다
function fileOf(repo: string, dispatch: string, create = false): string | null {
  // dispatch id 가 경로 조각이 되므로 한 단계 이름일 때만 쓴다
  if (!/^[\w.-]+$/.test(dispatch) || dispatch.startsWith('.')) return null
  return join(create ? ensure('state', repo) : pathOf('state', repo), DIR, `${dispatch}.json`)
}

export function recordLaunch(repo: string, launch: Launch): void {
  const file = fileOf(repo, launch.dispatch, true)
  if (!file) throw new Error(`dispatch id 를 파일 이름으로 쓸 수 없다: ${launch.dispatch}`)
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ ...launch, worktree: realPath(launch.worktree) })}\n`, 'utf8')
  renameSync(tmp, file)
}

export function readLaunch(repo: string, dispatch: string): Launch | null {
  const file = fileOf(repo, dispatch)
  if (!file) return null
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof data !== 'object' || data === null) return null
    const v = data as Record<string, unknown>
    if (v.dispatch !== dispatch || typeof v.worktree !== 'string') return null
    const text = (x: unknown) => (typeof x === 'string' && x ? x : null)
    return { ...(v.completion === "none" ? { completion: "none" as const } : {}), dispatch, branch: text(v.branch), task: text(v.task), terminal: text(v.terminal), worktree: v.worktree, run: text(v.run), spec: text(v.spec), lint_ack: text(v.lint_ack), agent: text(v.agent), model: text(v.model), effort: text(v.effort), effective: typeof v.effective === 'object' && v.effective !== null ? { agent: text((v.effective as Effective).agent), model: text((v.effective as Effective).model), effort: text((v.effective as Effective).effort) } : null, experiment: text(v.experiment) }
  } catch {
    return null
  }
}

export function forgetLaunch(repo: string, dispatch: string): void {
  const file = fileOf(repo, dispatch)
  if (file) rmSync(file, { force: true })
}

export function launchesAt(repo: string, worktree: string): Launch[] {
  const target = realPath(worktree)
  let names: string[]
  try {
    names = readdirSync(join(pathOf('state', repo), DIR))
  } catch {
    return []
  }
  const found: Launch[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const launch = readLaunch(repo, name.slice(0, -'.json'.length))
    if (launch && (launch.worktree === target || launch.worktree === worktree)) found.push(launch)
  }
  return found
}

// 이력 도입 전 ready Task 도 이어 띄울 수 있게 정리용 기록에서 가장 최근 dispatch 를 찾는다.
export function latestTaskLaunch(repo: string, task: string): Launch | null {
  const dir = join(pathOf('state', repo), DIR)
  try {
    return readdirSync(dir).filter(name => name.endsWith('.json'))
      .map(name => ({ launch: readLaunch(repo, name.slice(0, -5)), at: statSync(join(dir, name)).mtimeMs }))
      .filter(row => row.launch?.task === task).sort((a, b) => b.at - a.at)[0]?.launch ?? null
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
