// 배포 뒤 할 일 목록의 파일과 보드 반영, 루프 알림. 값을 정하는 규칙은 core/followups.ts 가 소유한다.
//
// 파일: <orch 루트>/state/followups.json. 값은 { items: Followup[] } 이다. 저장소마다 하나고 워크트리끼리 함께 쓴다.
//     마무리 여럿과 루프, 코디네이터 명령이 함께 쓰므로 쓰기는 옆 잠금(work-board 의 withFileLock) 안에서 읽고 고쳐 rename 한다.
//
// 보드 반영(mirrorBoard): 보드 파일이 있을 때만 항목 `followup-<PR>` 을 보드 명령으로 만든다. 끝나지 않은 항목은 wait 상태,
//     제목 「배포 뒤 확인 #<PR> <PR 제목>」, 하위 줄 하나(후속 검증 글)다. 끝낸 항목은 done 으로 바꾼다. 보드가 없으면 건너뛴다.
//     보드에는 항목을 새로 만드는 orch 명령이 없어(orch board set 은 있는 항목만 받는다) 이 경로가 만든다.
//     보드 반영이 실패해도 목록은 그대로 쓴다. 목록이 원본이고 보드는 보여 주는 자리다.
//
// 루프 확인(followupTick): 상주 루프가 틱마다 부른다(loop/steps/followups.ts).
//     1. 배포를 확인하지 못한 항목(failure, timeout)은 배포 설정(finish.deploy_workflow 와 deploy_branch)이 있으면 그 머지 커밋이
//        배포됐는지 다시 본다(lib/deploy.ts 의 deployVerdict, 배포 실행 목록은 틱마다 한 번). 성공이면 success 로 적는다.
//        배포 설정이 없으면 다시 보지 않는다. 마무리가 none 으로 적어 머지 즉시 확인한 것으로 보기 때문이다
//     2. 배포를 확인했고 알리지 않은 항목을 모두 묶어 Run 에 FOLLOWUP-READY 한 번을 보낸다(core/followups.ts 의 noticeText).
//        보낸 뒤에만 notified_at 을 적는다. 보내지 못하면 다음 틱이 다시 보낸다. 알린 항목은 다시 알리지 않는다
//     목록 파일이 없으면 gh 와 Orca 를 부르지 않는다.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock } from '../../../../extensions/work-board/bin/file-lock.ts'
import {
  boardItemId, boardTitle, dueFollowups, markDeployed, markNotified, noticeText, parseFollowups, pruneFollowups, undeployedFollowups,
} from '../core/followups.ts'
import type { Followup } from '../core/followups.ts'
import { boardPath } from './board-file.ts'
import { deployVerdict, parseRuns } from './deploy.ts'
import type { RunRow } from './deploy.ts'
import { gh } from './gh.ts'
import { git } from './git.ts'
import { makeParent, pathOf } from './paths.ts'
import { run, scriptCommand } from './proc.ts'

export type { Followup } from '../core/followups.ts'

// lib/board.ts 의 BOARD_BIN 과 같은 경로다. 그 모듈은 무거워 마무리와 정리가 함께 읽는 이 모듈에서 import 하지 않는다
const BOARD_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../extensions/work-board/bin/board.ts')

export function followupsFile(repo: string): string {
  return join(pathOf('state', repo), 'followups.json')
}

export function loadFollowups(repo: string): Followup[] {
  const file = followupsFile(repo)
  if (!existsSync(file)) return []
  return parseFollowups(JSON.parse(readFileSync(file, 'utf8')))
}

// 잠금 안에서 읽고 고쳐 쓴다. change 가 같은 배열을 돌려주면 쓰지 않는다
export function updateFollowups<T>(repo: string, change: (items: Followup[]) => { items: Followup[]; value: T }): T {
  const file = followupsFile(repo)
  makeParent(file, repo)
  return withFileLock(file, () => {
    const before = existsSync(file) ? parseFollowups(JSON.parse(readFileSync(file, 'utf8'))) : []
    const got = change(before)
    if (got.items !== before) {
      const items = pruneFollowups(got.items, Date.now())
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ items }, null, 2)}\n`)
      renameSync(`${file}.tmp`, file)
    }
    return got.value
  })
}

// 후속 검증을 코디네이터가 끝낸 PR 인가. 목록을 읽지 못하면 끝나지 않은 것으로 본다
export function followupDone(repo: string, pr: number | string): boolean {
  try {
    return loadFollowups(repo).some((item) => item.pr === Number(pr) && item.done_at !== null)
  } catch {
    return false
  }
}

export type BoardOptions = { file?: string | null; bin?: string | null }

// 머리 주석의 「보드 반영」. 반영한 줄이나 건너뛴 이유를 돌려준다. 실패는 `실패:` 로 시작한다
export function mirrorBoard(repo: string, item: Followup, options: BoardOptions = {}): string {
  let file: string
  try {
    file = boardPath(repo, options.file ?? null)
  } catch (e) {
    return `실패: 보드 경로를 정하지 못했다: ${(e as Error).message}`
  }
  if (!existsSync(file)) return '보드 없음'
  const id = boardItemId(item.pr)
  const argv = item.done_at
    ? ['set', id, 'done']
    : ['set', id, 'wait', '--title', boardTitle(item), '--detail', item.text.replace(/\s+/g, ' ').trim()]
  const bin = options.bin || process.env.BOARD_BIN || BOARD_BIN
  const done = run(scriptCommand(bin, [...argv, '--file', file]), { cwd: repo, timeoutMs: 60_000 })
  if (done.code !== 0) return `실패: 보드 ${id}: ${done.stderr.replace(/\s+/g, ' ').trim()}`
  return `보드 ${id} ${item.done_at ? 'done' : 'wait'}`
}

export type DeploySettings = { workflow: string; branch: string }

// 머지 커밋이 배포됐는지 본다. 배포 실행 목록은 cache 에 한 번만 읽는다
export function deployedNow(repo: string, merge: string, deploy: DeploySettings, cache: { runs: RunRow[] | null }): boolean {
  if (!/^[0-9a-f]{7,64}$/i.test(merge)) return false
  if (cache.runs === null) {
    git(repo, ['fetch', '-q', 'origin', deploy.branch])
    const runs = gh(['run', 'list', '--branch', deploy.branch, '--workflow', deploy.workflow, '--limit', '15', '--json', 'headSha,status,conclusion'], { cwd: repo })
    cache.runs = runs.code === 0 ? parseRuns(runs.stdout) : []
  }
  const tip = git(repo, ['rev-parse', `refs/remotes/origin/${deploy.branch}`])
  const isAncestor = (ancestor: string, sha: string) => git(repo, ['merge-base', '--is-ancestor', ancestor, sha]).code === 0
  return deployVerdict(cache.runs, merge, isAncestor, tip.code === 0 ? tip.stdout.trim() : '').verdict === 'success'
}

export type TickDeps = {
  // 배포 설정. 없으면 배포를 다시 보지 않는다
  deploy: DeploySettings | null
  // 알림을 보낼 Run. 없으면 알리지 않는다
  run: string | null
  notify: (run: string, text: string) => { ok: true } | { ok: false; error: string }
  deployed?: (merge: string) => boolean
  now?: () => string
}

export type TickResult = { deployed: number[]; notified: number[]; error: string | null }

// 머리 주석의 「루프 확인」
export function followupTick(repo: string, deps: TickDeps): TickResult {
  const result: TickResult = { deployed: [], notified: [], error: null }
  if (!existsSync(followupsFile(repo))) return result
  const now = deps.now ?? (() => new Date().toISOString())
  const cache = { runs: null as RunRow[] | null }
  const deployed = deps.deployed ?? ((merge: string) => deps.deploy !== null && deployedNow(repo, merge, deps.deploy, cache))
  const pending = deps.deploy ? undeployedFollowups(loadFollowups(repo)) : []
  const confirmed = pending.filter((item) => deployed(item.merge_commit)).map((item) => item.pr)
  if (confirmed.length > 0) {
    updateFollowups(repo, (items) => ({ items: markDeployed(items, confirmed), value: null }))
    result.deployed = confirmed
  }
  if (!deps.run) return result
  const due = dueFollowups(loadFollowups(repo))
  if (due.length === 0) return result
  const sent = deps.notify(deps.run, noticeText(due))
  if (!sent.ok) {
    result.error = sent.error
    return result
  }
  const prs = due.map((item) => item.pr)
  updateFollowups(repo, (items) => ({ items: markNotified(items, prs, now()), value: null }))
  result.notified = prs
  return result
}
