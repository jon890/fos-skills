// 릴리스에 든 PR 의 보드 항목에서 [release] 단계를 끝낸다(lib/milestones.ts, ADR-018).
//
// 코어는 릴리스가 무엇인지 정하지 않는다. 언제 이 명령을 부를지는 저장소가 정한다(오버레이의 절차나 after-deploy 같은 이벤트 핸들러).
//
// 사용법:
//     board-release.ts (--release PR | --pr N [--pr N ...]) [--repo DIR] [--board PATH] [--board-bin PATH] [--dry-run]
//
//     --release     릴리스 PR 번호. 그 PR 의 머지 커밋(머지 전이면 head 커밋)이 기준 커밋이다.
//                   항목의 pr 칸의 PR 이 MERGED 이고 그 머지 커밋이 기준 커밋의 조상이면 그 항목은 릴리스에 들었다.
//                   기준 커밋이 로컬에 없으면 origin 을 받아 오고, 그래도 없으면 refs/pull/<PR>/head 를 받아 온다
//     --pr          릴리스에 든 PR 번호를 직접 준다. 여러 번 준다. pr 칸이나 merged-pr 칸에 그 번호가 든 항목이 대상이다
//     --repo        gh 와 git 을 돌릴 저장소. 기본은 현재 디렉터리
//     --board       board.json. 기본은 work-board 의 board.ts 가 정한 위치
//     --board-bin   항목을 고치는 명령. 기본은 BOARD_BIN 환경 변수, 없으면 이 저장소의 work-board/bin/board.ts
//     --dry-run     보드를 고치지 않고 바뀔 항목과 부를 보드 명령만 낸다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// 줄 끝 사건 꼬리표가 있는 항목은 goal 도 포함해 릴리스에 든 PR 의 release 줄만 끝낸다.
//     다른 줄과 항목 상태는 그대로 둔다. 꼬리표가 없으면 아래 마일스톤 규칙을 쓴다.
// 대상 항목: done, goal 이 아니고, stages 칸에 release 가 있고, 그 단계가 끝나지 않은 항목이다.
//     --release 로 찾을 때는 pr 칸의 PR 만 본다. 마일스톤 항목은 업무의 마지막 PR 을 pr 칸에 남긴다(board-sync.ts).
//     pr 칸이 비었거나 그 PR 이 머지되지 않았으면 건너뛴다. 업무의 뒤 PR 이 아직 남은 항목이다
// 끝내기: lib/milestones.ts 의 mergedCommands 를 마지막 PR 로 부른다. [release] 와 그 앞 사건 단계를 끝내고 남은 일 줄을 지우고,
//     done 지점(board.done_after, 기본 merge)에 닿았으면 그 번호까지의 남은 단계를 끝내고 done 으로 바꾼다
// GH 환경 변수로 gh 실행 파일을 바꾼다.
//
// 종료 코드: 0 반영했다(또는 --dry-run, 대상 없음), 1 보드나 gh 를 읽지 못했거나 보드 명령이 실패했다, 2 사용법 오류(설정 파일 오류 포함)

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { taggedBoardSteps, boardSteps, prNumbers } from './lib/board.ts'
import { ConfigError } from './lib/config.ts'
import { git } from './lib/git.ts'
import { ghJson } from './lib/gh.ts'
import { boardSettings, mergedCommands, stagesOf } from './lib/milestones.ts'
import { boardPath } from './lib/paths.ts'
import { run, scriptCommand } from './lib/proc.ts'
import { parseEventTag } from '../../work-board/hooks/event-tags.js'

const USAGE = '사용법: board-release.ts (--release PR | --pr N [--pr N ...]) [--repo DIR] [--board PATH] [--board-bin PATH] [--dry-run]'
const HERE = dirname(fileURLToPath(import.meta.url))
const SKIP_STATUS = new Set(['done', 'goal'])

const OPTIONS = {
  release: { type: 'string' },
  pr: { type: 'string', multiple: true },
  repo: { type: 'string' },
  board: { type: 'string' },
  'board-bin': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Pr = { state?: unknown; mergeCommit?: { oid?: unknown } | null; headRefOid?: unknown }

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function number(value: string): string | null {
  const m = /^\s*#?(\d+)\s*$/.exec(value)
  return m ? m[1] : null
}

function view(repo: string, pr: string): Pr | null {
  const got = ghJson<Pr>(['pr', 'view', pr, '--json', 'state,mergeCommit,headRefOid'], { cwd: repo, killSignal: 'SIGKILL' })
  return got.ok && isRecord(got.data) ? got.data : null
}

function oidOf(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/.test(value) ? value : ''
}

// 커밋이 로컬에 있는지. 없으면 origin 을, 그래도 없으면 그 PR 의 head 를 받아 온다
function ensureCommit(repo: string, oid: string, pr: string): boolean {
  const has = () => git(repo, ['cat-file', '-e', `${oid}^{commit}`], { killSignal: 'SIGKILL' }).code === 0
  if (has()) return true
  git(repo, ['fetch', '-q', 'origin'], { killSignal: 'SIGKILL' })
  if (has()) return true
  git(repo, ['fetch', '-q', 'origin', `refs/pull/${pr}/head`], { killSignal: 'SIGKILL' })
  return has()
}

function main(argv: string[]): number {
  let values
  try {
    values = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, allowPositionals: false }).values
  } catch (e) {
    err(`${USAGE}\nboard-release: ${(e as Error).message}`)
    return 2
  }
  if (values.help) {
    out(USAGE)
    return 0
  }
  const given = values.pr ?? []
  if (Boolean(values.release) === given.length > 0) {
    err(`${USAGE}\nboard-release: --release 와 --pr 중 하나만 준다`)
    return 2
  }
  const release = values.release ? number(values.release) : null
  const prs = given.map(number)
  if ((values.release && !release) || prs.some((pr) => pr === null)) {
    err(`board-release: PR 번호가 아니다: ${[values.release, ...given].filter(Boolean).join(' ')}`)
    return 2
  }
  const repo = resolve(values.repo ?? '.')
  const board = values.board ? resolve(values.board) : boardPath(repo)
  const boardBin = values['board-bin'] || process.env.BOARD_BIN || resolve(HERE, '../../work-board/bin/board.ts')
  const dryRun = values['dry-run'] === true
  let doneAfter
  try {
    doneAfter = boardSettings(repo).doneAfter
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    err(`board-release: ${e.message}`)
    return 2
  }
  let items: Record<string, unknown>[]
  try {
    const raw = (JSON.parse(readFileSync(board, 'utf8')) as { items?: unknown }).items
    items = (Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : []).filter(isRecord)
  } catch (e) {
    err(`board-release: 보드를 읽지 못했다: ${board}: ${(e as Error).message}`)
    return 1
  }

  // 기준 커밋. --pr 로 줬으면 쓰지 않는다
  let target = ''
  const views = new Map<string, Pr | null>()
  if (release) {
    err(`board-release: 릴리스 PR ${release} 확인 중`)
    const got = view(repo, release)
    views.set(release, got)
    if (!got) {
      err(`board-release: 릴리스 PR ${release} 를 읽지 못했다`)
      return 1
    }
    target = oidOf(got.mergeCommit?.oid) || oidOf(got.headRefOid)
    if (!target || !ensureCommit(repo, target, release)) {
      err(`board-release: 릴리스 PR ${release} 의 커밋을 찾지 못했다: ${target || '없음'}`)
      return 1
    }
  }

  const changed: string[] = []
  const ancestors = new Map<string, boolean>()
  function included(pr: string): boolean | null {
    if (!views.has(pr)) views.set(pr, view(repo, pr))
    const got = views.get(pr)
    if (!got) return null
    const merge = oidOf(got.mergeCommit?.oid)
    if (got.state !== 'MERGED' || !merge) return false
    if (!ancestors.has(merge)) ancestors.set(merge, git(repo, ['merge-base', '--is-ancestor', merge, target], { killSignal: 'SIGKILL' }).code === 0)
    return ancestors.get(merge)!
  }
  for (const item of items) {
    if (item.status === 'done') continue
    err(`board-release: ${item.id} 확인 중`)
    const tagged = taggedBoardSteps(boardBin, String(item.id), board, item)
    if (tagged === null) {
      err(`board-release: 단계 목록을 읽지 못했다: ${item.id}`)
      return 1
    }
    if (tagged.length > 0) {
      for (const step of tagged.filter((step) => !step.done)) {
        const tag = parseEventTag(step.text)!
        if (tag.event !== 'release') continue
        if (release) {
          const found = included(tag.pr)
          if (found === null) {
            err(`board-release: ${item.id} 의 PR ${tag.pr} 를 읽지 못했다`)
            return 1
          }
          if (!found) continue
        } else if (!prs.includes(tag.pr)) continue
        const cmd = ['step', String(item.id), String(step.number)]
        if (dryRun) out(`${item.id} (PR #${tag.pr})\n  ${cmd.join(' ')}`)
        else {
          const done = run(scriptCommand(boardBin, [...cmd, '--file', board]), { killSignal: 'SIGKILL' })
          if (done.code !== 0) {
            err(`board-release: 보드 명령이 실패했다: ${item.id}: ${done.stderr}`)
            return 1
          }
        }
        if (!changed.includes(String(item.id))) changed.push(String(item.id))
      }
      continue
    }
    if (SKIP_STATUS.has(String(item.status))) continue
    const stages = stagesOf(item)
    if (!stages || stages.release === undefined) continue
    const id = String(item.id)
    const own = [...prNumbers(item.pr)]
    let pr: string | undefined
    if (release) {
      pr = own[0]
      if (!pr) continue
      const found = included(pr)
      if (found === null) {
        err(`board-release: ${id} 의 PR ${pr} 를 읽지 못했다`)
        return 1
      }
      if (!found) continue
    } else {
      pr = [...own, ...prNumbers(item['merged-pr'])].find((n) => prs.includes(n))
      if (!pr) continue
    }
    const steps = boardSteps(boardBin, id, board)
    if (steps === null) {
      err(`board-release: 단계 목록을 읽지 못했다: ${id}`)
      return 1
    }
    if (steps.some((step) => step.number === stages.release && step.done)) continue
    const made = mergedCommands(item, steps, stages, pr, 'release', { last: true, doneAfter, note: null })
    changed.push(id)
    if (dryRun) {
      out([`${id}${made.done ? ' -> done' : ''} (PR #${pr})`, ...made.cmds.map((c) => c.join(' '))].join('\n  '))
      continue
    }
    for (const cmd of made.cmds) {
      const done = run(scriptCommand(boardBin, [...cmd, '--file', board]), { killSignal: 'SIGKILL' })
      if (done.code !== 0) {
        if (done.stderr) process.stderr.write(done.stderr)
        err(`board-release: 보드 명령이 실패했다: ${id}`)
        return 1
      }
    }
    out(`board-release: ${id} 의 [release] 단계를 끝냈다 (PR #${pr})${made.done ? ', done' : ''}`)
  }
  out(`board-release: ${changed.join(', ') || '바뀐 항목 없음'}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
