// 배포 뒤 할 일 목록의 파일과 보드 반영, 루프 알림. 값을 정하는 규칙은 core/followups.ts 가 소유한다.
//
// 파일: <orch 루트>/state/followups.json. 값은 { items: Followup[] } 이다. 저장소마다 하나고 워크트리끼리 함께 쓴다.
//     마무리 여럿과 루프, 코디네이터 명령이 함께 쓰므로 쓰기는 옆 잠금(followups.json.lock, lib/owner-lock.ts) 안에서 읽고 고쳐 rename 한다.
//     잠금은 쥔 프로세스가 살아 있으면 넘겨받지 않는다. 보드 명령(60초까지)이 잠금 안에서 돌기 때문이다. 잡지 못하면 던진다.
//     파일이 JSON 이 아니면 `followups.json.broken-<시각>` 으로 옮기고 빈 목록으로 다시 시작하며 stderr 에 경고 한 줄을 낸다.
//     그대로 두면 그 저장소의 기능 PR 마무리가 모두 FINISH-FAIL 로 멈추고 고칠 명령이 없었다(PR 558 리뷰). 옮긴 파일에서 항목을 직접 되살린다
//
// 보드 반영(updateWithBoard): 연결된 보드 항목에는 대기 단계를 붙이고, 없으면 별도 followup-<PR> 항목을 만든다.
//     완료하면 해당 단계나 별도 항목을 끝낸다. 보드가 없으면 건너뛴다.
//     보드 반영이 실패해도 목록은 그대로 쓴다. 목록이 원본이고 보드는 보여 주는 자리다.
//     보드는 목록을 쓴 같은 잠금 안에서, 방금 쓴 목록의 그 항목 값으로만 쓴다. 받아 둔 값으로 보드를 쓰는 경로는 없다.
//     따로 쓰면 늦게 끝난 대기 쓰기가 followup done 의 끝남을 덮어 보드가 대기로 돌아갔다(PR 558 리뷰)
//
// 루프 확인(followupTick): 상주 루프가 틱마다 부른다(loop/steps/followups.ts).
//     1. 배포를 확인하지 못한 항목(failure, timeout)은 배포 설정(finish.deploy_workflow 와 deploy_branch)이 있으면 그 머지 커밋이
//        배포됐는지 다시 본다(lib/deploy.ts 의 deployVerdict, 배포 실행 목록은 틱마다 한 번). 성공이면 success 로 적는다.
//        배포 설정이 없으면 다시 보지 않는다. 마무리가 none 으로 적어 머지 즉시 확인한 것으로 보기 때문이다
//     2. 배포를 확인했고 알리지 않은 항목을 모두 묶어 Run 에 FOLLOWUP-READY 한 번을 보낸다(core/followups.ts 의 noticeText).
//        보낸 뒤에만 notified_at 을 적는다. 보내지 못하면 다음 틱이 다시 보낸다. 알린 항목은 다시 알리지 않는다
//     목록 파일이 없으면 gh 와 Orca 를 부르지 않는다.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withOwnerLock } from './owner-lock.ts'
import {
  boardItemId, boardTitle, dueFollowups, markDeployed, markNotified, noticeText, parseFollowups, pruneFollowups, undeployedFollowups,
} from '../core/followups.ts'
import type { Followup } from '../core/followups.ts'
import { BOARD_BIN, boardPath, staleBoardWrite } from './board-file.ts'
import { parseStepMark } from '../../../../extensions/work-board/hooks/step-marks.js'
import { deployVerdict, parseRuns } from './deploy.ts'
import type { RunRow } from './deploy.ts'
import { gh } from './gh.ts'
import { git } from './git.ts'
import { makeParent, pathOf } from './paths.ts'
import { run, scriptCommand } from './proc.ts'

export type { Followup } from '../core/followups.ts'

export function followupsFile(repo: string): string {
  return join(pathOf('state', repo), 'followups.json')
}

export function loadFollowups(repo: string): Followup[] {
  const file = followupsFile(repo)
  if (!existsSync(file)) return []
  try {
    return parseFollowups(JSON.parse(readFileSync(file, 'utf8')))
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return withOwnerLock(`${file}.lock`, () => readItems(file))
  }
}

// 잠금 안에서 부른다. 머리 주석의 「파일」 대로 깨진 파일은 옮기고 빈 목록이다
function readItems(file: string): Followup[] {
  if (!existsSync(file)) return []
  try {
    return parseFollowups(JSON.parse(readFileSync(file, 'utf8')))
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    const moved = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
    renameSync(file, moved)
    process.stderr.write(`배포 뒤 할 일 목록이 JSON 이 아니라 ${moved} 로 옮기고 빈 목록으로 다시 시작한다: ${e.message}\n`)
    return []
  }
}

type Change<T> = (items: Followup[]) => { items: Followup[]; value: T }

// 잠금 안에서 읽고 고쳐 쓴 뒤 after 에 지금 목록을 준다. change 가 같은 배열을 돌려주면 쓰지 않는다
function locked<T, R>(repo: string, change: Change<T>, after: (items: Followup[], value: T) => R): R {
  const file = followupsFile(repo)
  makeParent(file, repo)
  return withOwnerLock(`${file}.lock`, () => {
    const before = readItems(file)
    const got = change(before)
    let items = before
    if (got.items !== before) {
      items = pruneFollowups(got.items, Date.now())
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ items }, null, 2)}\n`)
      renameSync(`${file}.tmp`, file)
    }
    return after(items, got.value)
  }, { waitMs: 90_000 })
}

export function updateFollowups<T>(repo: string, change: Change<T>): T {
  return locked(repo, change, (_items, value) => value)
}

// 목록을 고치고, 같은 잠금 안에서 그 PR 의 보드 항목을 방금 쓴 목록의 값으로 쓴다(머리 주석의 「보드 반영」).
// board 는 반영한 줄이나 건너뛴 이유다. 실패는 `실패:` 로 시작한다. 목록에 그 PR 이 없으면 `항목 없음` 이다.
// options 를 주지 않으면 그 항목의 finish_args(처음 마무리의 옵션)에 든 --board 와 --board-bin 을 쓴다
export function updateWithBoard<T>(repo: string, pr: number, change: Change<T>, options?: BoardOptions): { value: T; board: string } {
  return locked(repo, change, (items, value) => {
    const item = items.find((one) => one.pr === pr)
    return { value, board: item ? mirrorBoard(repo, item, options ?? boardOptionsOf(item.finish_args)) : '항목 없음' }
  })
}

// 옵션 목록의 --board, --board-bin 값. `--board x` 와 `--board=x` 를 받는다
export function boardOptionsOf(args: string[]): BoardOptions {
  const value = (name: string): string | null => {
    for (let i = args.length - 1; i >= 0; i--) {
      if (args[i] === name && i + 1 < args.length) return args[i + 1]
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
    }
    return null
  }
  return { file: value('--board'), bin: value('--board-bin') }
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

// 머리 주석의 「보드 반영」. 목록의 잠금 안에서만 부른다(updateWithBoard)
function mirrorBoard(repo: string, item: Followup, options: BoardOptions): string {
  let file: string
  try {
    file = boardPath(repo, options.file ?? null)
  } catch (e) {
    return `실패: 보드 경로를 정하지 못했다: ${(e as Error).message}`
  }
  if (!existsSync(file)) return '보드 없음'
  const bin = options.bin || process.env.BOARD_BIN || BOARD_BIN
  const call = (argv: string[]) => run(scriptCommand(bin, [...argv, '--file', file]), { cwd: repo, timeoutMs: 60_000 })
  if (item.board_item) return mirrorStep(call, item, item.board_item)

  const id = boardItemId(item.pr)
  const argv = item.done_at
    ? ['set', id, 'done']
    : ['set', id, 'wait', '--title', boardTitle(item), '--detail', item.text.replace(/\s+/g, ' ').trim()]
  const done = call(argv)
  if (done.code !== 0) return `실패: 보드 ${id}: ${done.stderr.replace(/\s+/g, ' ').trim()}`
  return `보드 ${id} ${item.done_at ? 'done' : 'wait'}`
}

type BoardView = {
  status: string
  rev: string
  lines: { number: number | null; done: boolean; text: string; in: 'details' | 'next' }[]
}

function mirrorStep(call: (argv: string[]) => ReturnType<typeof run>, item: Followup, id: string): string {
  // 번호 앞에 #을 쓰면 기존 PR 머지 단계로 인식해 배포 뒤 확인까지 자동으로 끝낸다.
  const label = `배포 뒤 확인 (PR ${item.pr})`
  const body = `${label} · ${item.text.replace(/(?:PR\s+)?#(?=\d)/gi, 'PR ').replace(/\s+/g, ' ').trim()}`
  const done = item.done_at !== null
  const status = `보드 ${id} 배포 뒤 확인 ${done ? 'done' : 'wait'}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = call(['view', id])
    if (got.code !== 0) return `실패: 보드 ${id}: ${got.stderr.trim()}`
    let view: BoardView
    try { view = JSON.parse(got.stdout) } catch { return `실패: 보드 ${id} 의 단계 목록을 읽지 못했다` }
    if (!Array.isArray(view?.lines) || typeof view.rev !== 'string') return `실패: 보드 ${id} 의 단계 목록을 읽지 못했다`
    const steps = view.lines.filter((line) => line.number !== null)
    const current = steps.find((line) => parseStepMark(line.text)?.body.startsWith(`${label} · `))
    if (done && !current) return '단계 없음'
    const number = current?.number ?? Math.max(0, ...steps.map((line) => line.number ?? 0)) + 1
    const text = done && current ? current.text : `${number}. [wait] ${body}`
    if (current?.text === text && current.done === done && (done || view.status !== 'done')) return status

    const source = current?.in ?? steps[0]?.in ?? 'details'
    const lines = view.lines.filter((line) => line.in === source)
    const fresh = { text, done }
    const next = current ? lines.map((line) => line === current ? fresh : line) : [...lines, fresh]
    const argv = ['set', id, ...(!done && view.status === 'done' ? ['wait'] : []), '--if-rev', view.rev]
    for (const line of next) argv.push(source === 'details' ? '--detail' : '--next', `${line.done ? '✓ ' : '[ ] '}${line.text}`)
    const written = call(argv)
    if (written.code === 0) return status
    if (!staleBoardWrite(argv, written)) return `실패: 보드 ${id}: ${written.stderr.trim()}`
  }
  return `실패: 보드 ${id} 의 단계가 계속 바뀌었다`
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
  // 보낸 뒤 이 기록이 실패하면 다음 틱이 같은 알림을 다시 보낸다. 알림을 잃는 것보다 한 번 더 받는 쪽을 택했다
  updateFollowups(repo, (items) => ({ items: markNotified(items, prs, now()), value: null }))
  result.notified = prs
  return result
}
