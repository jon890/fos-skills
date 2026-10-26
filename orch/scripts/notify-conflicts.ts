// 머지 직후 열린 내 PR 가운데 base 와 충돌하는 것을 찾고, 그 PR 을 만든 worker 에게 base 를 합치라고 한 번만 알린다.
//
// 앞 PR 이 머지되면 같은 파일을 고친 뒤 PR 이 충돌한다. GitHub 의 CONFLICTING 표시는 아무도 보지 않으면
// 그 PR 의 worker 는 모른 채 끝나고, 머지 큐에 넣은 뒤에야 STOP 으로 드러난다.
// 충돌은 그 PR 을 만든 worker 가 이어 받는다(orch/references/replying.md 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」).
// 새 worker 는 어느 경우에도 띄우지 않는다. 로컬 자원을 아끼기 위해서다.
//
// 사용법:
//     notify-conflicts.ts [--repo DIR] [--base BRANCH] [--run RUN] [--state FILE] [--dry-run]
//
//     --repo     대상 저장소 체크아웃. 기본은 현재 디렉터리
//     --base     열린 PR 의 base. 기본은 origin/HEAD 가 가리키는 브랜치, 없으면 main
//     --run      worker 를 찾을 Orca Run. 없으면 코디네이터에 묶인 Run 이다. send-to-worker 와 이벤트의 run 에도 준다
//     --state    이미 알린 (PR, base SHA) 를 적는 파일. 기본 <orch 작업 폴더>/state/notify-conflicts.json
//     --dry-run  알리지 않고 충돌과 할 일만 낸다. 후속 지시서를 쓰지 않고, 보내지 않고, 이벤트를 내지 않고, 기록하지 않는다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// 충돌 찾기, PR 하나의 처리(resolveConflict, concludeConflict), 알린 기록은 lib/conflicts.ts 가, 브랜치의 워크트리와 worker 행 찾기는
// lib/workers.ts 가 맡는다. 상주 루프(orch-loop.ts)도 같은 함수와 같은 기록, 아래 종료 코드 분류를 쓴다. 충돌 여부와 파일은 merge-tree 로 origin/<base> 와 PR HEAD 를 합쳐 본다.
// 다른 사람 PR 은 줄도 내지 않고 종료 코드에도 세지 않는다. 작성자 목록은 config.json 의 pipeline.authors,
// 없으면 PR URL 호스트의 gh 현재 사용자다(lib/gh.ts 의 ownAuthors). 그 목록을 정하지 못하면 조회 실패다.
//
// 충돌한 내 PR 마다 `#<PR> CONFLICTING <브랜치>: 파일...` 을 낸다. (PR, base SHA) 가 기록에 있으면 `이미 알렸다(<값>)` 로 넘어간다.
// base 가 움직이면 새 충돌일 수 있어 다시 알린다. 처음 보면:
//     1. 그 브랜치의 워크트리(git worktree list)와 그 워크트리의 dispatch(worker-list, 살아 있는 것을 먼저)를 찾는다
//     2. dispatch 가 살아 있으면 본문을 `send-to-worker --dispatch <id> --body <본문>` 으로 보낸다
//     3. dispatch 가 끝났으면 후속 지시서 <지시서 폴더>/spec-conflict-<PR>.md 를 쓰고(base 가 움직이면 덮어쓴다)
//        `send-to-worker --dispatch <id> --spec <지시서>` 로 보낸다. --body 는 주지 않는다. 끝난 dispatch 에는 가지 않는다
//        지시서 이름을 spec- 으로 시작하게 둔 것은 정리 경로(cleanup-sweep, handoff-cleanup, finish-pr)가 이 이름만 보기 때문이다
//     4. 아래 표로 기록하고 pr-conflict 이벤트를 낸다. 기록하지 않은 경우에는 이벤트도 내지 않는다. 다음 실행이 다시 본다
//
//     send-to-worker 종료 코드   살아 있는 dispatch     끝난 dispatch          기록과 출력
//     0                          notified               resumed                기록. `<dispatch> 에 알렸다`
//     4                          notified(깨우지 못함)  resumed                기록. 알림 줄 끝에 `(깨우지 못했다, 종료 코드 4)`
//     1                          notified(reply 는 남음) 아래 참고              살아 있는 경로는 기록한다. 기록하지 않으면 다음 실행이 같은 reply 를 또 보낸다
//     3                          orphan                 orphan                 기록. `CONFLICT-ORPHAN <PR> <이유>`. 같은 (PR, base SHA) 로 다시 알리지 않는다
//     5 와 그 밖                  보내지 못함            보내지 못함            기록하지 않는다. `보내지 못했다(… 종료 코드 N)` 와 stderr 의 이유
//     2                          사용법 오류            사용법 오류            그 자리에서 멈추고 명령 종료 코드 2
//     끝난 dispatch 의 1: send-to-worker 의 1 은 다시 띄우기의 실패지만, launch-worker 가 worker-start 를 이미 성공한 뒤에
//     dispatch id 를 읽지 못했거나 다시 띄운 뒤 단계가 멈춰도 1 이다. 그 실행의 stdout 에 `LAUNCHED <id>` 줄이 있으면
//     worker-start 가 성공해 worker 가 떴으므로 resumed 로 기록한다. 다시 보내면 같은 워크트리에 Task 가 하나 더 생긴다.
//     `restart: ` 줄은 근거로 보지 않는다. 다시 띄우겠다는 예고일 뿐이라 그 뒤 worker-start 가 실패해도 남는다.
//     LAUNCHED 줄이 없으면 보내지 못한 것으로 두고 기록하지 않는다. 그래서 worker-start 가 성공한 뒤 LAUNCHED 를 내기 전에
//     멈춘 경우(dispatch id 를 읽지 못함, 다시 띄운 뒤 watch 가 멈춤)도 다음 실행이 다시 보내고, 같은 워크트리에 Task 가 겹칠 수 있다
//     agent_unconfigured 로 send-to-worker 가 같은 워크트리에 다시 띄운 것도 resumed 다. 워크트리와 터미널 수가 늘지 않는다
//     워크트리나 dispatch 를 찾지 못한 경우도 orphan 이고 기록한다. worker-list 를 읽지 못하면 알리지도 기록하지도 않는다
//
// 후속 지시서: 첫 줄은 공통 지시서 <지시서 폴더>/spec-common.md 의 절대경로를 먼저 읽으라는 줄이다. 그 파일이 없으면 이 줄 없이 쓰고
//     stderr 에 경고를 낸다. 브랜치 줄, `중간 과정: PR #<PR>` 줄, 허락 줄(push 는 허락, PR 은 새로 열지 않는다), 할 일과 충돌 파일 목록을 둔다.
//     중간 과정 줄이 있어 보드에 새 항목이 생기지 않는다. 그 PR 의 마무리(finish-pr.ts)가 머지 뒤 이 지시서를 지운다.
//
// pr-conflict 입력(lib/events.ts 머리 주석의 「이벤트별 필드」): pr, base_head, files, worker, action.
//     worker 는 찾은 dispatch 의 worker-list 행에서 채우고(spec 은 후속 지시서 경로, 없으면 null) 워크트리나 dispatch 가 없으면 null 이다.
//     핸들러의 실패는 HOOK-FAIL 줄만 남긴다. 이 이벤트는 충돌한 PR 이 있을 때만 나서 종료 코드가 이미 1 이다.
//
// GH, ORCA, SEND_TO_WORKER 환경 변수로 실행 파일과 스크립트 경로를 바꾼다. 스크립트는 확장자로 인터프리터를 고른다(lib/proc.ts 의 scriptCommand).
//
// 종료 코드: 0 충돌한 내 PR 이 없다, 1 충돌한 내 PR 이 있다(알렸든 못 알렸든), 2 사용법 오류(설정 파일 오류 포함)나 조회 실패

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError, loadConfig, PIPELINE_KEYS, section } from './lib/config.ts'
import { concludeConflict, findConflicts, loadNotified, notifiedFile, notifiedKey, resolveConflict } from './lib/conflicts.ts'
import type { OpenPr, WorkerFound } from './lib/conflicts.ts'
import type { FireContext } from './lib/events.ts'
import { apiTarget, isOwnPr, ownAuthors } from './lib/gh.ts'
import { defaultBase } from './lib/git.ts'
import { warnLegacy } from './lib/paths.ts'
import { workerFor, workerRows, worktreePaths } from './lib/workers.ts'

const USAGE = '사용법: notify-conflicts.ts [--repo DIR] [--base BRANCH] [--run RUN] [--state FILE] [--dry-run]'

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

type Args = { repo: string; base: string; run: string; state: string; dryRun: boolean }

function parse(argv: string[]): Args | 'help' | null {
  const options = {
    repo: { type: 'string', default: '.' },
    base: { type: 'string', default: '' },
    run: { type: 'string', default: '' },
    state: { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv, options), options }).values
  } catch (e) {
    err(`${USAGE}\nnotify-conflicts: ${(e as Error).message}`)
    return null
  }
  if (values.help) return 'help'
  return { repo: values.repo, base: values.base, run: values.run, state: values.state, dryRun: values['dry-run'] }
}

async function main(argv: string[]): Promise<number> {
  const a = parse(argv)
  if (a === null) return 2
  if (a === 'help') {
    out(USAGE)
    return 0
  }
  const repo = resolve(a.repo)
  if (!a.state) warnLegacy(repo, 'notify-conflicts')
  // 작성자 목록을 읽기 전에 설정 파일의 오류를 먼저 사용법 오류로 알린다
  section(loadConfig(repo), 'pipeline', PIPELINE_KEYS)
  const base = (a.base || defaultBase(repo) || 'main').replace(/^origin\//, '')
  const statePath = a.state ? resolve(a.state) : notifiedFile(repo)

  const found = findConflicts(repo, base)
  if (!found.ok) {
    err(`notify-conflicts: ${found.error}`)
    return 2
  }
  const { baseSha } = found
  const authors = new Map<string, string[]>()
  const mine: { pr: OpenPr; files: string[] }[] = []
  for (const item of found.found) {
    const host = apiTarget(item.pr.url)?.host
    if (!host) {
      err(`notify-conflicts: #${item.pr.number} 의 PR URL 을 읽지 못했다: ${JSON.stringify(item.pr.url ?? null)}`)
      return 2
    }
    if (!authors.has(host)) {
      const own = ownAuthors(repo, host)
      if (!own) {
        err(`notify-conflicts: 내 PR 의 작성자를 정하지 못했다(${host} 의 gh api user 실패). config.json 의 pipeline.authors 로 준다`)
        return 2
      }
      authors.set(host, own)
    }
    if (isOwnPr({ author: { login: item.pr.author?.login ?? '' } }, authors.get(host) ?? [])) mine.push(item)
  }
  if (mine.length === 0) {
    out(`충돌한 열린 PR 이 없다(base ${base} ${baseSha.slice(0, 8)})`)
    return 0
  }

  const state = loadNotified(statePath)
  const paths = worktreePaths(repo)
  const ctx: FireContext = { repo, base, run: a.run || null }
  let workers: ReturnType<typeof workerRows> | null = null

  for (const { pr, files } of mine) {
    const number = pr.number
    out(`#${number} CONFLICTING ${pr.headRefName}: ${files.join(' ')}`)
    const key = notifiedKey(number, baseSha)
    if (Object.hasOwn(state, key)) {
      out(`  이미 알렸다(${state[key]})`)
      continue
    }
    let target: WorkerFound
    const path = paths.get(pr.headRefName)
    if (!path) {
      target = { orphan: '워크트리 없음. 새 worker 는 띄우지 않는다' }
    } else {
      workers ??= workerRows(a.run)
      if (!workers.ok) {
        out(`  worker 목록을 읽지 못해 알리지 않았다: ${workers.error}`)
        err(`notify-conflicts: #${number} 는 기록하지 않는다. 다음 실행이 다시 본다`)
        continue
      }
      const row = workerFor(workers.rows, path)
      target = row ? { path, row } : { orphan: '그 워크트리의 dispatch 없음. 새 worker 는 띄우지 않는다' }
    }
    const outcome = await resolveConflict({ repo, base, baseSha, pr, files, found: target, run: a.run || null, dryRun: a.dryRun, out })
    if (outcome.kind === 'usage') return 2
    if (outcome.kind === 'record') await concludeConflict(statePath, repo, ctx, pr, files, baseSha, outcome)
  }
  return 1
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    if (e instanceof ConfigError) {
      err(`notify-conflicts: ${e.message}`)
      process.exitCode = 2
    } else {
      err(`notify-conflicts: ${(e as Error)?.stack ?? String(e)}`)
      process.exitCode = 1
    }
  },
)
