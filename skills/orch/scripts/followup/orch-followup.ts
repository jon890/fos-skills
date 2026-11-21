// 배포 뒤 할 일 목록을 보고 끝낸다. 목록에 옮기는 것은 마무리(queue/finish-pr.ts 머리 주석의 「배포 뒤 할 일」)이고,
// 배포 확인과 묶은 알림은 상주 루프(lib/followups.ts 머리 주석의 「루프 확인」)다. 값의 규칙은 core/followups.ts 가 소유한다.
//
// 사용법:
//     orch followup list [--all] [--repo DIR]
//         끝나지 않은 항목을 한 줄씩 낸다(core/followups.ts 의 followupLine). --all 은 끝난 항목도 낸다. 없으면 FOLLOWUP-NONE 이다
//     orch followup done <PR> [--note 글] [--no-finish] [--run RUN] [--repo DIR]
//         코디네이터가 배포된 환경에서 확인을 마친 뒤 부른다. 항목을 끝냄으로 적고 `FOLLOWUP-DONE #<PR>` 를 낸다.
//         이미 끝났으면 `FOLLOWUP-ALREADY #<PR>`, 목록에 없으면 `FOLLOWUP-MISSING #<PR>` 과 종료 코드 1 이다.
//         보드 파일이 있으면 항목 followup-<PR> 을 done 으로 바꾼다. 실패해도 목록은 끝낸 채 둔다.
//         이어서 그 PR 의 마무리(finish-pr.ts)를 백그라운드로 다시 띄워 지시서 정리, 업무 완료, 보드 done 까지 가게 한다.
//         pid 파일은 처음 마무리가 쓴 것(항목의 pid_file)이고, 없으면 <orch 루트>/queue/finish-<PR>.pid 다. 출력은 그 옆 finish-<PR>.out 이다.
//         `FINISH-STARTED <PR> <로그>` 를 낸다. 같은 PR 의 마무리가 이미 돌면
//         다시 돌기 표시(state/finish-rerun/<PR>)를 남기고 `FINISH-RUNNING <PR> <pid 파일>` 이다.
//         도는 마무리가 끝날 때 그 요청을 보고 끝난 후속 검증으로 한 번 더 돈다. --no-finish 면 다시 띄우지 않는다. 띄우지 못하면 FINISH-START-FAIL 과 종료 코드 1 이다.
//         다시 띄우는 마무리에는 처음 마무리의 옵션(항목의 finish_args: 보드, --complete 같은 마지막 PR 표시, 지시서 폴더, 배포 설정)을 그대로 준다.
//         보드 항목도 그 보드에서 done 으로 바꾼다. --run 을 주면 처음 값 대신 그 값을 넘긴다. 둘 다 없으면 마무리가 설정의 finish.run 을 읽는다
//
// 종료 코드: 0 성공, 1 없는 항목이나 마무리를 띄우지 못함, 2 사용법이나 설정 오류
// FINISH_PR 환경 변수로 마무리 스크립트 경로를 바꾼다.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { followupLine, markDone, openFollowups } from '../core/followups.ts'
import type { Followup } from '../core/followups.ts'
import { expandArgs } from '../lib/args.ts'
import { scriptPath } from '../lib/commands.ts'
import { loadFollowups, updateWithBoard } from '../lib/followups.ts'
import { real } from '../lib/fs.ts'
import { mainCheckout, repoArgProblem } from '../lib/git.ts'
import { guardWrite, MAIN_GUARD_OPTIONS } from '../lib/main-guard.ts'
import { makeParent, pathOf } from '../lib/paths.ts'
import { scriptCommand } from '../lib/proc.ts'
import { askRerun } from '../lib/finish-claim.ts'
import { pidFileAlive } from '../lib/process.ts'

const USAGE = `사용법:
  orch followup list [--all] [--repo DIR]
  orch followup done <PR> [--note 글] [--no-finish] [--run RUN] [--repo DIR]`
const OPTIONS = {
  ...MAIN_GUARD_OPTIONS,
  repo: { type: 'string' }, run: { type: 'string' }, note: { type: 'string' },
  all: { type: 'boolean' }, 'no-finish': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const

function list(repo: string, all: boolean): number {
  const items = loadFollowups(repo)
  const shown = all ? items : openFollowups(items)
  if (shown.length === 0) console.log('FOLLOWUP-NONE')
  for (const item of shown) console.log(followupLine(item))
  return 0
}

// 띄운 마무리가 실제로 시작했는지 기다린다. 띄운 뒤 이 명령이 끝나도 마무리는 이어 돈다
function started(child: ChildProcess, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    child.once('error', (e) => resolve(`${name} 를 실행하지 못했다: ${e.message}`))
    child.once('spawn', () => {
      child.unref()
      resolve(null)
    })
  })
}

// 처음 마무리의 옵션(finish_args)에서 --run 을 뺀다. --run 을 주면 그 값이 앞선다
function withoutRun(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') { i += 1; continue }
    if (args[i].startsWith('--run=')) continue
    out.push(args[i])
  }
  return out
}

async function restartFinish(repo: string, pr: number, run: string | undefined, notMain: string | undefined, item: Followup | null): Promise<number> {
  // 처음 마무리가 --finish-log-dir 로 다른 pid 파일을 썼으면 그 파일을 봐야 도는 마무리를 알아본다(PR 558 리뷰)
  const pidFile = item?.pid_file ?? join(pathOf('queue', repo), `finish-${pr}.pid`)
  const dir = dirname(pidFile)
  makeParent(join(dir, 'x'), repo)
  // 도는 마무리가 이미 대기 경로를 지났을 수 있어, 끝날 때 한 번 더 돌게 표시를 남긴다(규칙은 lib/finish-claim.ts 머리 주석).
  // 표시를 먼저 쓰고 pid 를 본다. 살아 있으면 그 마무리가 끝내기 전에 표시를 본다. 아니면 표시를 둔 채 새 마무리를 띄운다.
  // 새 마무리는 실행권을 잡으면 표시를 지우고, 끝나던 마무리가 아직 쥐고 있어 잡지 못하면 그 마무리가 놓은 뒤 표시를 보고 한 번 더 돈다
  askRerun(repo, pr)
  if (pidFileAlive(pidFile)) {
    console.log(`FINISH-RUNNING ${pr} ${pidFile}`)
    return 0
  }
  const outFile = join(dir, `finish-${pr}.out`)
  const finishArgs = item?.finish_args ?? []
  const replay = run ? withoutRun(finishArgs) : finishArgs
  const args = [String(pr), '--repo', repo, '--pid-file', pidFile, ...replay, ...(run ? ['--run', run] : []), ...(notMain !== undefined ? ['--not-main', notMain] : [])]
  const cmd = scriptCommand(process.env.FINISH_PR || scriptPath('finish-pr'), args)
  const fd = openSync(outFile, 'w')
  let child: ChildProcess
  try {
    child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', fd, fd], detached: true })
  } finally {
    closeSync(fd)
  }
  const error = await started(child, cmd[0])
  if (error) {
    console.log(`FINISH-START-FAIL ${pr} ${error.replace(/\s+/g, ' ')}`)
    return 1
  }
  console.log(`FINISH-STARTED ${pr} ${outFile}`)
  return 0
}

async function done(repo: string, pr: number, values: { note?: string; run?: string; 'no-finish'?: boolean; 'not-main'?: string }): Promise<number> {
  const guard = guardWrite(repo, 'followup done', values['not-main'], { prs: [String(pr)] })
  if (guard.code !== 0) return guard.code
  // 목록을 끝내고 같은 잠금 안에서 보드를 목록의 값(done)으로 쓴다(lib/followups.ts 의 「보드 반영」). 보드는 처음 마무리가 쓴 곳이다
  const { value: { result, item }, board } = updateWithBoard(repo, pr, (items) => {
    const made = markDone(items, pr, new Date().toISOString(), values.note?.trim() || null)
    return { items: made.items, value: { result: made.result, item: made.items.find((one) => one.pr === pr) ?? null } }
  })
  if (result === 'missing') {
    console.log(`FOLLOWUP-MISSING #${pr}`)
    return 1
  }
  console.log(result === 'done' ? `FOLLOWUP-DONE #${pr}` : `FOLLOWUP-ALREADY #${pr}`)
  if (board.startsWith('실패:')) console.log(`FOLLOWUP-BOARD-FAIL #${pr} ${board.slice('실패:'.length).trim()}`)
  if (values['no-finish']) return 0
  return restartFinish(repo, pr, values.run, values['not-main'], item)
}

async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, OPTIONS, ['note']), options: OPTIONS, allowPositionals: true })
  } catch (e) {
    process.stderr.write(`orch-followup: ${(e as Error).message}\n${USAGE}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const repoArg = values.repo ?? '.'
  const problem = repoArgProblem(repoArg)
  if (problem) {
    process.stderr.write(`orch-followup: ${problem}\n`)
    return 2
  }
  const repo = mainCheckout(real(repoArg))
  const [verb, number, ...rest] = positionals
  try {
    if (verb === 'list' && number === undefined) return list(repo, values.all ?? false)
    if (verb === 'done' && /^\d+$/.test(number ?? '') && rest.length === 0) return await done(repo, Number(number), values)
  } catch (e) {
    process.stderr.write(`orch-followup: ${(e as Error).message.replace(/\s+/g, ' ')}\n`)
    return 2
  }
  process.stderr.write(`${USAGE}\n`)
  return 2
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (e) => {
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  },
)
