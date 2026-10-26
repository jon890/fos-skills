// launch-worker.ts 가 띄운 worker 의 기록. cleanup-sweep.ts 가 「코디네이터가 띄운 터미널」 을 가리는 근거다.
//
// Orca 는 worker 가 끝난 터미널에 입력이 들어가면 `user_owned` 로 기록한다. 사람이 넘겨받은 것과 이 자동 기록을 필드로 가를 수 없어,
// 코디네이터가 띄운 터미널도 사람 터미널로 보고 워크트리를 남겼다. 띄운 쪽이 기록을 남기면 sweep 이 그 기록으로 가른다.
//
// 위치: <orch 루트>/state/launched-workers/<dispatch>.json. dispatch 마다 파일 하나라 병렬로 띄워도 서로 덮지 않는다.
// 내용: { dispatch, terminal, worktree, run }. terminal 과 run 은 모르면 null 이다.
// 다시 띄우기(--retry-of)와 `--terminal` 이어 쓰기는 새 dispatch 를 만들어 새 파일이 생긴다.
//
// 내보내는 것:
//     recordLaunch   기록을 쓴다. 실패하면 던진다
//     readLaunch     기록을 읽는다. 없거나 형식이 다르면 null
//     forgetLaunch   기록을 지운다. 없어도 통과한다

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realPath } from './fs.ts'
import { ensure, pathOf } from './paths.ts'

export type Launch = { dispatch: string; terminal: string | null; worktree: string; run: string | null }

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
    return { dispatch, terminal: text(v.terminal), worktree: v.worktree, run: text(v.run) }
  } catch {
    return null
  }
}

export function forgetLaunch(repo: string, dispatch: string): void {
  const file = fileOf(repo, dispatch)
  if (file) rmSync(file, { force: true })
}
