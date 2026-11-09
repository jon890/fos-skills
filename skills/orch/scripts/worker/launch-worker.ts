// 워크트리를 만들거나 확인한 뒤 허락 줄이 있는 지시서로 Orca worker 를 띄운다.
//
// 사용법:
//     launch-worker.ts --spec FILE (--repo DIR --name NAME | --worktree DIR | --repo DIR --task ID)
//         [--task ID [--retry-of DISPATCH]] [--base BRANCH] [--resume-remote] [--run ID] [--watch SEC] [--lint-ack REASON] [--dirty-ack REASON] -- WORKER_ARGS...
//
//     --spec           지시서. spec-line 으로 첫 지시 줄을 만든다. `허락:` 줄이 없으면 거부한다.
//                      `worker 선택:` 줄(형식은 lib/spec.ts 의 selectionsOf)이 없거나 빠진 요소가 있거나, 그 줄의 에이전트, 모델, effort 가
//                      WORKER_ARGS 의 --agent, --model, --effort 와 다르면 거부한다. effort `기본` 은 옵션을 주지 않는다.
//                      --terminal 도 선택 정책은 검사한다. --lint-ack 으로 넘길 수 없다
//     --lint-ack       spec-lint 가 막을 발견을 냈지만 의도한 것이라 넘기는 이유. 이유 없이 넘기는 옵션은 없다(빈 값은 사용법 오류).
//                      이유는 `lint-ack: <이유>` 줄로 출력하고 띄운 worker 의 기록(lib/launched.ts 의 lint_ack)에 남긴다
//     --task           같은 Task 다시 띄우기. failed/blocked 는 --retry-of 를 함께 주고 ready 는 생략한다.
//                      워크트리는 이전 이력에서 읽는다. 이력 도입 전 기록은 launched-workers 에서 읽는다
//     --repo, --name   새 워크트리를 make-worktree 로 만든다. --base, --resume-remote 는 make-worktree 에 넘긴다
//     --worktree       기존 워크트리(`path:` 접두를 받는다). 그 경로에 터미널이 남아 있으면 목록을 보이고 거부한다.
//                      같은 워크트리에 이어 띄우면 앞 세션이 닫히지 않고 쌓인다. --terminal 로 이어 쓰는 터미널은 세지 않는다.
//                      커밋 안 된 변경(`git status --porcelain --untracked-files=all`)이 있어도 목록을 보이고 거부한다.
//                      재사용한 워크트리에 다른 PR 의 변경이 남아 있으면 worker 가 그것을 자기 일로 알고 커밋한다.
//                      make-worktree 가 복사한 .claude/settings.local.json 과 git 저장소가 아닌 폴더는 보지 않는다.
//                      --terminal 로 이어 쓰면 그 에이전트가 하던 변경이라 보지 않는다. 리뷰 worker(`리뷰 PR:` 줄)는 차례 2-1 이 따로 본다
//     --dirty-ack      커밋 안 된 변경이 이어 할 일의 것이라 그대로 띄우는 이유. 빈 값은 사용법 오류다.
//                      이유는 `dirty-ack: <이유>` 줄로 출력한다. 끊긴 worker 를 이어 띄울 때 쓴다(references/launch.md 「끊긴 worker 다시 띄우기」)
//     --run            worker-start 와 다시 띄우기에 줄 Run. 없으면 코디네이터에 묶인 Run 이다
//     --watch          띄운 뒤 worker-show 의 단계를 볼 초. 기본 90. 0 이면 보지 않는다
//     WORKER_ARGS      worker-start 에 그대로 넘긴다(--agent, --model, --effort, --terminal 같은 것).
//                      --terminal 은 --agent, --model, --effort 와 함께 쓰지 못한다
//
// 차례:
//     0. selectionVerdict 로 지시서의 행, 근거, 실험을 검사한다. 새 실행은 agent/model/effort 도 대조한다. 어긋나면 1 이다
//     0-1. --agent codex 면 `codex debug models` 로 --model, --effort 를 검사한다(lib/model-check.ts). 조회하지 못하거나 claude 면 경고만 낸다
//     0-2. --agent claude 면 지금 선택된 Orca 의 Claude 프로필에 plugins 링크와 settings.json 이 있는지 본다(lib/claude-profile.ts).
//        없으면 link-claude-profile.ts 로 맞추는 명령 한 줄을 내고 1 이다. 고치지는 않는다. 프로필 폴더나 selected-host 가 없으면 건너뛴다
//     1. spec-line --require-permission 으로 첫 지시 줄을 만든다
//     1-1. spec-lint 로 이 지시서를 검사한다. 함께 넘기는 활성 지시서는 살아 있는 dispatch(pending, dispatched, running)가 쓰는 지시서
//        가운데 이 지시서와 같은 폴더에 있는 것이다(lib/spec.ts 의 liveSpecPaths. 이 지시서 자신과 spec-common.md 는 뺀다).
//        활성 지시서는 --active 로 넘겨 선택 검사를 하지 않는다. 활성 지시서끼리의 겹침은 경고만 낸다.
//        띄울 지시서끼리 겹치는 것은 먼저 띄운 쪽이 활성이 된 뒤 나중 지시서를 띄울 때 잡힌다. 아직 안 띄운 지시서는 보지 않는다.
//        spec-lint 가 1 로 끝나면(막을 발견) 워크트리를 만들기 전에 발견 줄을 내고 5 로 멈춘다. --lint-ack 이 있으면 이유와 함께 넘긴다.
//        활성 지시서를 읽지 못하면 경고하고 이 지시서 하나만 검사한다. spec-lint 가 1 이 아닌 코드로 끝나도(저장소를 읽지 못함 같은 것) 경고만 하고 진행한다
//        --base(없으면 origin/HEAD 의 브랜치)를 spec-lint 의 --base 로 넘긴다. 「할 일」 첫 줄의 상대경로 스펙은 worker 가 시작할 곳에서 읽는다.
//        새 워크트리면 origin/<base>, --resume-remote 면 --spec-ref origin/<지시서 브랜치>, --worktree 면 --spec-root <그 워크트리> 다.
//        첫 줄 검사(spec-lint 의 「루프」)에 걸려도 같은 5 다. 확인받은 스펙 없이 기능 worker 를 띄우지 않게 한다
//        SPEC_LINT 로 spec-lint 를 바꾼다
//     2. 워크트리를 만들거나 확인한다
//     2-0. --agent codex 이고 코디네이터 환경에 SSH_AUTH_SOCK 이 있으면 그 워크트리에만 걸리는 git 설정 core.sshCommand 에
//        `ssh -o IdentityAgent=<소켓>` 을 둔다(lib/ssh-agent.ts). Codex 의 `inherit = "core"` 가 SSH_AUTH_SOCK 을 빼 git 의 SSH 인증이
//        막히는 것을 막는다. worker-start 에는 Codex 인자(-c)를 넘길 옵션이 없다. 이미 정한 core.sshCommand 는 덮지 않고, 설정이 실패해도 띄운다.
//        Claude worker 에는 하지 않는다. 소켓이 바뀌어도 환경 변수는 따라가지만 설정에 박은 경로는 낡는다
//     2-1. 리뷰 worker 준비. 지시서에 `리뷰 PR: #<N>` 줄(lib/review.ts 의 reviewPrOfSpec)이 있을 때만 한다. 새 워크트리도 --worktree 도 같다.
//        PR head 는 이 프로세스가 주 checkout 에서 `git fetch origin +refs/pull/<N>/head:refs/orch/review/pr-<N>` 로 받는다.
//        worker 가 직접 fetch 하지 않게 하려는 것이다. 원격이 SSH 별칭이면 worker 세션에서는 인증이 막혔다(10-31 실측).
//        받은 커밋을 읽은 뒤 그 임시 ref 는 지운다. 받지 못하면 `리뷰 PR head 를 받지 못했다` 를 내고 1 이다.
//        워크트리 HEAD 가 이미 그 커밋이면 `REVIEW-CHECKOUT #<N> <SHA> 이미 준비됨` 을 내고 아래 준비 명령을 다시 돌리지 않는다.
//        아니면 커밋 안 된 변경이 없는지 보고(있으면 1) `git checkout --detach <SHA>` 로 그 커밋에 둔 뒤 `REVIEW-CHECKOUT #<N> <SHA>` 를 낸다.
//        PR head 를 받지 못해 멈춘 워크트리를 --worktree 로 다시 띄우면 여기서 다시 꺼낸다. 기준 브랜치 커밋으로 worker 가 뜨지 않는다.
//        공유 저장소에 로컬 브랜치(`pr-<N>`)를 만들지 않는다. 워크트리를 만든 브랜치는 remove-worktree --delete-branch 가 reflog 로 찾아 지운다.
//        config.json 의 review.prepare(bash 명령 문자열)가 있으면 꺼낸 뒤 그 워크트리에서 한 번 돌린다. 저장소가 정한 생성물 준비 명령이다.
//        환경에 ORCH_REVIEW_PR(<N>)과 ORCH_REPO(주 checkout)를 둔다. 시간 제한은 PREPARE_MS(30분)이고 그룹 전체를 끝낸다.
//        끝나면 `REVIEW-PREPARE <종료 코드>` 를 낸다. 0 이 아니면 출력 끝 20줄과 경고를 stderr 에 내고 그대로 띄운다.
//        생성물이 없어도 코드 읽기 리뷰는 할 수 있어서다. review.prepare 가 문자열이 아니면 설정 오류(2)다
//     3. before-launch 이벤트를 낸다. 결과가 pass 나 none 이 아니면(거부, 실패, 시간 초과, 잠금 실패) 띄우지 않고 1 이다.
//        거부만 보고 실패를 지나치면 죽은 핸들러가 막으려던 띄우기를 하게 된다(docs/flow.md 「갈래」 의 「거부처럼 멈춘다」)
//     4. `orca worktree list` 에 그 경로가 보일 때까지 기다린다
//     5. worker-start 로 띄우고 --watch 초 동안 단계를 본다
//        실패하면 출력의 error 를 `worker-start 오류: <code>: <message>` 한 줄로 낸다
//        단계는 `worker-show --full` 의 worker.stage 다. --full 없이 읽은 줄인 보기는 이 키가 없어 늘 「단계 없음」 으로 보였고,
//        살아 일하는 worker 를 abandon 하고 같은 워크트리에 하나 더 띄웠다(2026-11-02 세 번)
//        --watch 초가 지나도 worktree_creating 이거나 단계가 없으면 일하는 흔적을 본다(아래 「일하는 흔적」).
//        흔적이 있으면 `<dispatch> 단계는 <단계> 지만 일하는 흔적이 있어(<근거>) 다시 띄우지 않는다` 를 내고 그대로 LAUNCHED 다
//        흔적을 확인하지 못하면 `STALLED-START <dispatch> <단계 또는 -> watch=<초>s,no-signs-of-life` 와 종료 코드 1 로 멈춘다.
//        시간 초과나 흔적 부재는 종료 증거가 아니다. abandon 과 재시도는 하지 않고 코디네이터가 화면을 보고 판단한다
//        멈춤도 재개·정리용 launched-workers 기록, 보드와 worker-launched 이벤트는 남긴다. 배정 통계의 성공 이력은 남기지 않는다
//     일하는 흔적(하나라도 있으면): dispatch 의 lastHeartbeatAt, dispatch.status 가 running, worker-start 직전과 비교해
//        워크트리의 HEAD 나 `git status --porcelain` 이 바뀜, worker 터미널 화면이 작업 중이거나 권한 확인 창(lib/screen.ts)
//     6. `LAUNCHED <dispatch id> <워크트리>` 를 낸 뒤 worker-launched 이벤트를 낸다. 그 실패는 종료 코드를 바꾸지 않는다.
//        짧은 출력(진입점의 orch worker launch, lib/output.ts)은 `LAUNCHED <dispatch id> <터미널 또는 -> <워크트리>` 이고, worker-start 가 성공할 때마다
//        `LAUNCH-EFFECTIVE <launch.effective 의 JSON 한 줄 또는 ->` 를, 실패하면 receipt 전체를 `START-FAIL <receipt 한 줄>` 로 낸다. 거부는 `REFUSED <이유 첫 줄>`,
//        ack 줄과 REVIEW-*, SSH-AGENT 판정 줄 밖의 진행 줄과 worker-start JSON 은 내지 않는다
//        그에 앞서 띄운 worker 의 터미널 handle, dispatch id, 워크트리와 브랜치를 orch 상태 폴더에 기록한다(lib/launched.ts).
//        cleanup-sweep 이 그 터미널을 코디네이터의 것으로 알아보는 근거다. 다시 띄우기와 `--terminal` 이어 쓰기도 새 dispatch 로 기록한다.
//        기록 실패는 stderr 로만 알리고 LAUNCHED 와 종료 코드는 유지한다.
//        보드가 있으면 지시서의 항목 id, 제목과 마일스톤 단계(lib/milestones.ts)로 doing 항목을 갱신한다. 실패는 stderr 로 알리고 LAUNCHED 는 유지한다.
//        설정이 보드를 가리키는데 파일이 없으면 그 사실을 알린다.
//        핸들러의 실패와 이벤트 실행기의 예외(설정 파일 오류, state 폴더를 쓰지 못함 같은 것)가 모두 그렇다.
//        stderr 에 `worker-launched 를 내지 못했다: <이유>` 를 남긴다. worker 가 이미 떠 있어 코디네이터는 LAUNCHED 를 믿고 다음 단계로 가야 한다
//     새로 만든 워크트리는 띄우지 못하고 멈춰도 남긴다. 지시서의 브랜치 이름을 다시 쓸 때 사람이 판단할 근거라서다.
//     그때 stderr 에 `--worktree` 로 이어 띄우는 명령(`node --disable-warning=ExperimentalWarning <이 파일의 절대경로> ...`)을 낸다.
//     worker-start 가 이미 성공했으면 내지 않는다(같은 일의 Task 가 하나 더 생긴다)
//
// 이벤트 입력(lib/events.ts 머리 주석의 「이벤트별 필드」):
//     repo     --repo, --worktree 로 불렀으면 그 경로의 주 checkout
//     base     --base, 없으면 origin/HEAD 의 브랜치, 그것도 없으면 빈 문자열. 앞의 `origin/` 은 뗀다(--base origin/main 도 main)
//     run      --run, 없으면 null
//     worker   task, dispatch, terminal, worktree(절대경로), spec(절대경로). before-launch 의 task 는 --task, terminal 은 WORKER_ARGS 의
//              --terminal 이고 dispatch 는 null 이다. worker-launched 의 task 는 worker-start 결과, dispatch 는 LAUNCHED 의 id,
//              terminal 은 마지막 worker-show 의 worker.agentTerminalHandle, dispatch.assigneeHandle, WORKER_ARGS 의 --terminal 순이다
//     branch   워크트리의 현재 브랜치. 없으면 null
//     agent, model, effort   WORKER_ARGS 의 값. 없으면 null
//
// 종료 코드: 0 LAUNCHED, 1 STALLED-START, 거부, 실행 실패, before-launch 가 막음, 리뷰 PR head 를 받거나 꺼내지 못함, 2 사용법 오류, orch 폴더 미이전, 설정 파일 오류,
//            3 --terminal 의 터미널이 에이전트를 인식하지 못함(agent_unconfigured),
//            4 --agent 에 없는 --model, 그 모델이 지원하지 않는 --effort(worktree 를 만들기 전에 멈춘다),
//            5 spec-lint 가 막을 발견을 냈고 --lint-ack 이 없다(worktree 를 만들기 전에 멈춘다)
//
// 환경 변수: ORCA, SPEC_LINE, MAKE_WORKTREE 로 실행 도구를 바꾼다. ORCA_CLAUDE_PROFILES 로 0-2 의 프로필 폴더를 바꾼다. 도구는 확장자로 인터프리터를 고른다(lib/proc.ts 의 scriptCommand).
//            확인 간격(초)은 LAUNCH_POLL=5, LAUNCH_WT_WAIT=30, LAUNCH_WT_POLL=2 가 기본값이다. 소수도 받는다.
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts). WORKER_ARGS 는 펼치지 않는다.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { registerBoard } from '../lib/board.ts'
import { expandArgs } from '../lib/args.ts'
import { ConfigError, loadConfig, REVIEW_KEYS, section } from '../lib/config.ts'
import { fire } from '../lib/events.ts'
import type { FireContext } from '../lib/events.ts'
import { isFile, realPath } from '../lib/fs.ts'
import { profilesRoot, selectedReadiness } from '../lib/claude-profile.ts'
import { checkLaunchSettings } from '../lib/model-check.ts'
import { defaultBase, git, mainCheckout } from '../lib/git.ts'
import { launchesAt, latestTaskLaunch, readLaunch, recordLaunch } from '../lib/launched.ts'
import { orca, orcaBin, repoVisibility, repoVisibilityActions, withFull } from '../lib/orca.ts'
import { requireMigrated } from '../lib/paths.ts'
import { readScreen, screenLines } from '../lib/screen.ts'
import { runAsync, scriptCommand, withRun } from '../lib/proc.ts'
import type { Runner } from '../lib/proc.ts'
import type { RunResult } from '../lib/proc.ts'
import { orchWord, scriptPath } from '../lib/commands.ts'
import { shQuote } from '../lib/py.ts'
import { emit, oneLine, short } from '../lib/output.ts'
import type { Rule } from '../lib/output.ts'
import { configureSshAgent } from '../lib/ssh-agent.ts'
import { reviewPrOfSpec } from '../lib/review.ts'
import { latestTerminal, launchHistory, recordHistory } from '../lib/launch-history.ts'
import { selectionVerdict } from '../lib/selection.ts'
import { branchesOf, experimentOf, liveSpecPaths, SELECTION_FORMAT, selectionsOf } from '../lib/spec.ts'

const USAGE = [
  '사용법: launch-worker.ts --spec FILE (--repo DIR --name NAME | --worktree DIR | --repo DIR --task ID)',
  '            [--task ID [--retry-of DISPATCH]] [--base BRANCH] [--resume-remote] [--run ID] [--watch SEC] [--lint-ack REASON] [--dirty-ack REASON] -- WORKER_ARGS...',
].join('\n')
// worker-start 는 에이전트가 뜰 때까지, make-worktree 는 fetch 와 worktree add 가 끝날 때까지 기다린다. 기본 60초로는 모자랄 수 있다
const LONG_MS = 600_000
// 리뷰 생성물 준비(review.prepare)의 시간 제한. 저장소의 생성기를 모두 돌리는 명령이라 띄우기보다 길게 준다
const PREPARE_MS = 1_800_000
const PREPARE_TAIL = 20

class Stop extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

// 짧은 출력(진입점의 orch worker launch)의 줄 규칙. 거부 이유는 첫 줄만 판정 줄로 남긴다. ack 줄은 띄운 근거라 그대로다
const SHORT_RULES: Rule[] = [
  [/^거부: ([^\n]*)/, (m) => `REFUSED ${m[1]}`],
  [/^((?:lint|dirty)-ack: .*)$/, (m) => m[1]],
]

function out(line: string): void {
  // 여러 줄 거부(남은 터미널 목록, 변경 목록)는 첫 줄의 규칙만 탄다. 나머지 줄은 판정 줄이 아니라 빠진다
  if (short() && line.startsWith('거부: ')) emit(line.split('\n')[0], SHORT_RULES)
  else emit(line, SHORT_RULES)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function seconds(name: string, fallback: string): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < 0) throw new Stop(`${name} 는 0 이상의 초여야 한다: ${process.env[name]}`, 2)
  return value
}

// Python 의 `{초:g}` 와 같은 꼴. 유효 숫자 여섯 자리이고 끝의 0 을 지운다. 0.1 을 세 번 더한 값이 0.30000000000000004 가 아니라 0.3 이다
function secondsText(value: number): string {
  const [mantissa, exponent] = value.toExponential(5).split('e')
  const power = Number(exponent)
  if (power < -4 || power >= 6) {
    const digits = mantissa.replace(/\.?0+$/, '')
    return `${digits}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`
  }
  const fixed = value.toFixed(Math.max(0, 5 - power))
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

// 결과 JSON 의 result 에서 key 후보를 | 로 나눠 차례로 읽는다. 처음 나온 빈 값 아닌 것을 문자열로 낸다. 없으면 빈 문자열.
// 후보를 여럿 보는 것은 Orca 버전에 따라 같은 값이 다른 자리에 오기 때문이다(dispatch.id 와 dispatchId 같은 것).
// 한 자리만 보다 놓치면 이미 뜬 worker 의 dispatch id 를 읽지 못해 실패로 알리게 된다.
// worker-start 실패 출력의 receipt 한 줄. JSON 이면 줄바꿈 없이 다시 쓰고, 아니면 stdout 과 stderr 를 한 줄로 잇는다
function receiptLine(result: RunResult): string {
  try {
    return JSON.stringify(JSON.parse(result.stdout))
  } catch {
    return oneLine(`${result.stdout} ${result.stderr}`) || '-'
  }
}

function jget(text: string, keys: string): string {
  let result: unknown
  try {
    result = (JSON.parse(text) as { result?: unknown }).result
  } catch {
    return ''
  }
  for (const key of keys.split('|')) {
    let value: unknown = result
    for (const part of key.split('.')) {
      value = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[part] : undefined
    }
    if (value !== undefined && value !== null && value !== '') return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return ''
}

// 워크트리의 HEAD 와 `git status --porcelain`. 읽지 못하면 빈 문자열이다
function worktreeSnapshot(worktree: string): string {
  const head = git(worktree, ['rev-parse', 'HEAD'])
  const status = git(worktree, ['status', '--porcelain'])
  if (head.code !== 0 || status.code !== 0) return ''
  return `${head.stdout.trim()}\n${status.stdout}`
}

// 머리 주석의 「일하는 흔적」. 근거 한 마디를 내고, 없으면 빈 문자열이다
async function signsOfLife(
  show: string,
  worktree: string,
  snapshot: string,
  call: (args: string[], timeoutMs?: number) => Promise<RunResult>,
): Promise<string> {
  if (jget(show, 'dispatch.lastHeartbeatAt')) return `heartbeat ${jget(show, 'dispatch.lastHeartbeatAt')}`
  if (jget(show, 'dispatch.status') === 'running') return 'dispatch running'
  const now = worktreeSnapshot(worktree)
  if (snapshot && now && now !== snapshot) return '워크트리 변경'
  const handle = jget(show, 'worker.agentTerminalHandle|dispatch.assigneeHandle|terminal')
  if (handle) {
    const read = await call(['terminal', 'read', '--terminal', handle, '--screen', '--json'])
    let result: Record<string, unknown> = {}
    try {
      result = ((JSON.parse(read.stdout) as { result?: Record<string, unknown> }).result ?? {}) as Record<string, unknown>
    } catch {
      result = {}
    }
    const state = read.code === 0 ? readScreen(screenLines(result)).state : 'unknown'
    if (state === 'working' || state === 'permission') return `터미널 화면 ${state}`
  }
  return ''
}

// worker-start 출력에서 오류를 `code: message` 한 줄로 뽑는다. 못 찾으면 빈 문자열이다
function startError(text: string): string {
  let parsed: { error?: unknown; result?: { error?: unknown } }
  try {
    parsed = JSON.parse(text)
  } catch {
    return ''
  }
  const found = parsed?.error ?? parsed?.result?.error
  if (typeof found === 'string') return found
  if (typeof found !== 'object' || found === null) return ''
  const { code, message } = found as { code?: unknown; message?: unknown }
  return [code, message].filter((part) => typeof part === 'string' && part).join(': ')
}

// WORKER_ARGS 에서 옵션의 값. 없거나 값이 빠졌으면 null.
function passValue(passthru: string[], name: string): string | null {
  const at = passthru.indexOf(name)
  return at >= 0 && at + 1 < passthru.length ? passthru[at + 1] : null
}

// 그 워크트리에 붙은 터미널(handle 과 제목). reuse 는 이어 쓸 터미널이라 뺀다. 읽지 못하면 Stop(1).
function leftTerminals(worktree: string, reuse = ''): string {
  const done = orca(['terminal', 'list', '--json'])
  if (done.code !== 0) throw new Stop('거부: orca terminal list 를 읽지 못해 남은 터미널을 확인할 수 없다', 1)
  let rows: Record<string, unknown>[]
  try {
    const list = (JSON.parse(done.stdout) as { result: { terminals?: unknown } }).result.terminals ?? []
    if (!Array.isArray(list)) throw new Error('terminals 가 목록이 아니다')
    rows = list as Record<string, unknown>[]
  } catch {
    throw new Stop('거부: 터미널 목록을 해석하지 못했다', 1)
  }
  return rows
    .filter((t) => t?.worktreePath === worktree && t?.handle !== reuse)
    .map((t) => `${t.handle} ${Array.from(String(t.title ?? '')).slice(0, 60).join('')}`)
    .join('\n')
}

// Orca 가 워크트리를 알아보지 못했을 때 원인을 짐작할 근거와 사용자 조치. 설정은 바꾸지 않는다.
function unrecognizedHelp(worktree: string, waited: number): string {
  const common = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const commonDir = common.stdout.trim()
  const repo = common.code === 0 && commonDir ? dirname(commonDir) : null
  const value = repo ? repoVisibility(repo) : ''
  const lines = [
    `Orca 가 워크트리를 알아보지 못했다. \`orca worktree list\` 로 확인한다: ${worktree} (${secondsText(waited)}초 기다림)`,
    `  만든 경로: ${worktree}`,
    `  저장소의 externalWorktreeVisibility: ${value || '(읽지 못함)'}`,
  ]
  if (value === 'hide' && repo) {
    lines.push('  hide 면 git worktree add 로 만든 워크트리를 Orca 가 외부 워크트리로 보고 숨긴다. 사용자가 아래 중 하나를 한다(스크립트는 설정을 바꾸지 않는다)')
    lines.push(repoVisibilityActions(repo))
  } else if (repo) {
    lines.push('  hide 가 아니면 Orca 가 아직 알아보지 못한 것일 수 있다. 잠시 뒤 `orca worktree list` 를 다시 보고, 계속 안 보이면 Orca 화면에서 등록한다')
  }
  return lines.join('\n')
}

function listed(worktree: string): boolean {
  const done = orca(['worktree', 'list', '--limit', '1000', '--json'])
  if (done.code !== 0) return false
  let rows: unknown
  try {
    rows = (JSON.parse(done.stdout) as { result: { worktrees?: unknown } }).result.worktrees
  } catch {
    return false
  }
  if (!Array.isArray(rows)) return false
  const target = realPath(worktree)
  return rows.some((row) => realPath(String((row as { path?: unknown })?.path || '/nonexistent')) === target)
}

// 루프 검사가 상대경로 스펙을 읽을 곳. --worktree 면 그 워크트리, --resume-remote 면 origin/<지시서 브랜치>, 아니면 spec-lint 의 기본(origin/<base>)이다
function loopSource(a: Args, specPath: string): string[] {
  if (a.worktree) return ['--spec-root', realPath(a.worktree.replace(/^path:/, ''))]
  if (!a.resumeRemote) return []
  let branch: string | undefined
  try {
    branch = branchesOf(readFileSync(specPath, 'utf8'))[0]
  } catch {
    branch = undefined
  }
  return branch ? ['--spec-ref', `origin/${branch}`] : []
}

// spec-lint 로 이 지시서를 검사한다. 머리 주석의 「1-1」. 막으면 종료 코드, 통과하거나 넘기면 null 이다.
// acked 는 --lint-ack 으로 넘긴 발견의 이유다. 넘길 발견이 없으면 null 이라 기록에 남지 않는다.
async function lintGate(a: Args, continuation: boolean, execute: typeof runAsync): Promise<{ stop: number | null; acked: string | null }> {
  const specPath = resolve(a.spec)
  const repo = a.repo || mainCheckout(realPath(a.worktree.replace(/^path:/, '')))
  const live = liveSpecPaths(a.run || null)
  if (live === null) err('경고: 활성 지시서를 읽지 못해 이 지시서 하나만 검사한다(다른 지시서와의 겹침은 보지 못한다)')
  const specsDir = realPath(dirname(specPath))
  const others = [...(live ?? [])].filter((file) => file !== realPath(specPath) && dirname(file) === specsDir && basename(file) !== 'spec-common.md' && isFile(file))
  // 루프 검사가 상대경로 스펙을 worker 가 시작할 곳에서 읽게 한다. 머리 주석의 「1-1」
  const base = (a.base || defaultBase(repo) || '').replace(/^origin\//, '')
  const source = loopSource(a, specPath)
  const args = ['--repo', repo, ...(base ? ['--base', base] : []), ...source, ...others.flatMap((file) => ['--active', file]), ...(continuation ? ['--active', specPath] : []), specPath]
  const done = await execute(scriptCommand(process.env.SPEC_LINT || scriptPath('spec-lint'), args))
  if (done.code !== 1) {
    if (done.code === 0 && done.stdout.trim()) err(done.stdout.trim())
    if (done.code !== 0) err(`경고: spec-lint 가 종료 코드 ${done.code} 로 끝나 검사하지 못했다: ${done.stderr.trim().split('\n').pop() ?? ''}`)
    return { stop: null, acked: null }
  }
  err(done.stdout.trimEnd())
  if (a.lintAck === null) {
    err(`거부: spec-lint 가 막을 발견을 냈다. 지시서를 고치거나, 의도한 발견(겹침 같은 것)이면 --lint-ack "<이유>" 로 이유를 적어 넘긴다${others.length > 0 ? `\n함께 본 활성 지시서: ${others.join(', ')}` : ''}`)
    return { stop: 5, acked: null }
  }
  out(`lint-ack: ${a.lintAck}`)
  return { stop: null, acked: a.lintAck }
}

// 지시서의 worker 선택 줄과 WORKER_ARGS 를 대조한다. 머리 주석의 「0」. 어긋나면 거부 문구, 맞으면 null 이다.
// 지시서를 읽지 못하면 null 이다. 그 실패는 다음 단계의 spec-line 이 사용법 오류로 알린다.
function selectionReject(specPath: string, passthru: string[], repo: string, retry: boolean, continuation: boolean): string | null {
  let text: string
  try {
    text = readFileSync(specPath, 'utf8')
  } catch {
    return null
  }
  const verdict = selectionVerdict(text, repo, { launch: true, retry, continuation })
  if (verdict.length) return `${verdict.join('; ')}. 형식: ${SELECTION_FORMAT}`
  const [selection] = selectionsOf(text)
  const mismatched: string[] = []
  for (const [name, want] of [['--agent', selection.agent], ['--model', selection.model], ['--effort', selection.effort === '기본' ? null : selection.effort]] as const) {
    const given = passValue(passthru, name)
    if (given !== want) mismatched.push(`${name} ${given ?? '(없음)'}, 지시서 ${want}`)
  }
  if (mismatched.length === 0) return null
  return `지시서 ${selection.no}번 줄의 \`worker 선택:\` 과 띄우는 값이 다르다: ${mismatched.join('; ')}. 지시서를 고치거나 그 값으로 띄운다`
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

// make-worktree 가 워크트리에 복사하는 파일이라 커밋 안 된 변경으로 세지 않는다
const MADE_BY_LAUNCH = new Set(['.claude/settings.local.json'])
const DIRTY_SHOWN = 50

// --worktree 의 커밋 안 된 변경(porcelain 줄). git 저장소가 아니거나 읽지 못하면 빈 목록이다
function uncommitted(worktree: string): string[] {
  const done = git(worktree, ['status', '--porcelain', '--untracked-files=all'])
  if (done.code !== 0) return []
  return done.stdout.split('\n').filter((line) => line.trim() && !MADE_BY_LAUNCH.has(line.slice(3)))
}

type Args = {
  spec: string
  task: string
  retryOf: string
  repo: string
  name: string
  base: string
  worktree: string
  run: string
  watch: number
  lintAck: string | null
  dirtyAck: string | null
  resumeRemote: boolean
  passthru: string[]
}

function parse(argv: string[]): Args | 'help' {
  const split = argv.includes('--') ? argv.indexOf('--') : argv.length
  const passthru = argv.slice(split + 1)
  const options = {
    spec: { type: 'string' },
    task: { type: 'string', default: '' },
    'retry-of': { type: 'string', default: '' },
    repo: { type: 'string', default: '' },
    name: { type: 'string', default: '' },
    base: { type: 'string', default: '' },
    worktree: { type: 'string', default: '' },
    run: { type: 'string', default: '' },
    watch: { type: 'string', default: '90' },
    'lint-ack': { type: 'string' },
    'dirty-ack': { type: 'string' },
    'resume-remote': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    values = parseArgs({ args: expandArgs(argv.slice(0, split), options, ['lint-ack', 'dirty-ack']), options }).values
  } catch (e) {
    throw new Stop(`${USAGE}\nlaunch-worker: ${(e as Error).message}`, 2)
  }
  if (values.help) return 'help'
  const usage = (message: string) => new Stop(`${USAGE}\nlaunch-worker: ${message}`, 2)
  if (!values.spec) throw usage('--spec 이 필요하다')
  const watch = values.watch as string
  if (!/^\d+$/.test(watch)) throw usage('--watch 는 초 단위 정수다')
  const lintAck = values['lint-ack'] === undefined ? null : (values['lint-ack'] as string).trim()
  if (lintAck === '') throw usage('--lint-ack 에는 넘기는 이유를 적는다')
  const dirtyAck = values['dirty-ack'] === undefined ? null : (values['dirty-ack'] as string).trim()
  if (dirtyAck === '') throw usage('--dirty-ack 에는 그대로 띄우는 이유를 적는다')
  const resumeRemote = values['resume-remote'] as boolean
  if (!values.task && values['retry-of']) throw usage('--task 와 --retry-of 를 함께 준다')
  if (values.task && (values.worktree || values.name)) throw usage('다시 띄우기의 워크트리는 이력에서 읽는다')
  if (!values.task && values.worktree && (values.repo || values.name || resumeRemote)) throw usage('--worktree 와 --repo/--name/--resume-remote 은 함께 쓰지 않는다')
  if (!values.task && !values.worktree && !(values.repo && values.name)) throw usage('새 워크트리는 --repo 와 --name, 기존 워크트리는 --worktree 를 준다')
  return {
    spec: values.spec,
    task: values.task as string,
    retryOf: values['retry-of'] as string,
    repo: values.repo as string,
    name: values.name as string,
    base: values.base as string,
    worktree: values.worktree as string,
    run: values.run as string,
    watch: Number(watch),
    lintAck,
    dirtyAck,
    resumeRemote,
    passthru,
  }
}

// 차례 2-1(머리 주석). 리뷰 PR head 를 받아 워크트리를 그 커밋에 두고 저장소의 생성물 준비 명령을 한 번 돌린다. 멈춰야 하면 종료 코드, 아니면 null 이다
async function prepareReview(worktree: string, repo: string, pr: number, execute: typeof runAsync): Promise<number | null> {
  const ref = `refs/orch/review/pr-${pr}`
  const fetched = git(repo, ['fetch', '-q', 'origin', `+refs/pull/${pr}/head:${ref}`], { timeoutMs: LONG_MS })
  const sha = fetched.code === 0 ? git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).stdout.trim() : ''
  git(repo, ['update-ref', '-d', ref])
  if (!sha) {
    err(`리뷰 PR head 를 받지 못했다(#${pr}): ${fetched.stderr.trim()}`)
    return 1
  }
  if (git(worktree, ['rev-parse', 'HEAD']).stdout.trim() === sha) {
    out(`REVIEW-CHECKOUT #${pr} ${sha} 이미 준비됨`)
    return null
  }
  const status = git(worktree, ['status', '--porcelain'])
  if (status.code !== 0 || status.stdout.trim()) {
    err(`리뷰 워크트리에 커밋 안 된 변경이 있어 PR head 로 옮기지 않는다: ${worktree}`)
    return 1
  }
  const checked = git(worktree, ['checkout', '-q', '--detach', sha])
  if (checked.code !== 0) {
    err(`리뷰 PR head 를 꺼내지 못했다(#${pr}): ${checked.stderr.trim()}`)
    return 1
  }
  out(`REVIEW-CHECKOUT #${pr} ${sha}`)
  const command = section<{ prepare?: unknown }>(loadConfig(repo), 'review', REVIEW_KEYS).prepare
  if (command === undefined) return null
  if (typeof command !== 'string') throw new ConfigError('설정 파일의 review.prepare 는 bash 명령 문자열이어야 한다')
  const done = await execute(['bash', '-c', command], {
    cwd: worktree,
    timeoutMs: PREPARE_MS,
    group: true,
    env: { ORCH_REVIEW_PR: String(pr), ORCH_REPO: repo },
  })
  out(`REVIEW-PREPARE ${done.code}`)
  if (done.code !== 0) {
    const tail = (done.stdout + done.stderr).trimEnd().split('\n').slice(-PREPARE_TAIL).join('\n')
    if (tail) err(tail)
    err(`경고: 리뷰 생성물 준비가 ${done.timedOut ? '시간 제한을 넘겨' : `종료 코드 ${done.code} 로`} 끝났다. worker 는 생성물 없이 리뷰한다`)
  }
  return null
}

export function main(argv: string[], runner?: Runner, asyncRunner: typeof runAsync = runAsync): Promise<number> {
  return runner ? withRun(runner, () => executeMain(argv, asyncRunner)) : executeMain(argv, asyncRunner)
}

async function executeMain(argv: string[], execute: typeof runAsync): Promise<number> {
  const a = parse(argv)
  if (a === 'help') {
    out(USAGE)
    return 0
  }
  const { passthru } = a
  if (passValue(passthru, '--task') || passValue(passthru, '--retry-of')) throw new Stop('--task 와 --retry-of 는 -- 앞에 준다', 2)
  let retryRepo = a.repo || process.cwd()
  let retryDispatch: string | null = null
  let retryLaunch: ReturnType<typeof readLaunch> = null
  if (a.task) {
    const prior = a.retryOf ? launchHistory(retryRepo).find(row => row.dispatch === a.retryOf) ?? readLaunch(retryRepo, a.retryOf) : launchHistory(retryRepo).filter(row => row.task === a.task).at(-1) ?? latestTaskLaunch(retryRepo, a.task)
    if (!prior || prior.task !== a.task) throw new Stop('다시 띄울 dispatch 와 Task 를 이력에서 찾지 못했다', 1)
    retryLaunch = prior
    retryDispatch = prior.dispatch
    a.worktree = prior.worktree
    a.run ||= prior.run ?? ''
  }
  retryRepo = a.repo || mainCheckout(a.worktree.replace(/^path:/, '') || process.cwd())
  const reusedTerminal = passValue(passthru, '--terminal')
  const terminalLaunch = reusedTerminal
    ? latestTerminal(retryRepo, reusedTerminal) ?? launchesAt(retryRepo, a.worktree.replace(/^path:/, '')).filter(row => row.terminal === reusedTerminal).at(-1) ?? null
    : null
  const priorSelection = terminalLaunch ?? retryLaunch
  const sameSpec = !!priorSelection && (!priorSelection.spec || realPath(priorSelection.spec) === realPath(a.spec))
  const sameSettings = !!priorSelection && ['agent', 'model', 'effort'].every(name => {
    const previous = priorSelection[name as 'agent' | 'model' | 'effort'] ?? null
    return reusedTerminal || previous === passValue(passthru, `--${name}`)
  })
  const continuation = sameSpec && sameSettings
  const reuseOpts = passthru.filter((x) => x === '--agent' || x === '--model' || x === '--effort')
  if (passthru.includes('--terminal') && reuseOpts.length > 0) {
    err(`거부: --terminal 은 ${reuseOpts.join(' ')} 와 함께 쓰지 못한다(invalid_argument)`)
    return 1
  }
  if (!passthru.includes('--terminal')) {
    const rejected = selectionReject(a.spec, passthru, retryRepo, !!a.task, continuation)
    if (rejected) {
      err(`거부: ${rejected}`)
      return 1
    }
  }
  const settings = checkLaunchSettings({ agent: passValue(passthru, '--agent'), model: passValue(passthru, '--model'), effort: passValue(passthru, '--effort') })
  for (const warning of settings.warnings) err(`경고: ${warning}`)
  if (settings.reject) {
    err(`거부: ${settings.reject}`)
    return 4
  }
  if (passValue(passthru, '--agent') === 'claude') {
    const profile = selectedReadiness(profilesRoot())
    if (profile && profile.missing.length > 0) {
      err(`거부: 선택된 Orca 의 Claude 프로필 ${profile.id} 에 ${profile.missing.join(', ')} 가 없어 worker 에게 플러그인과 지침이 보이지 않는다. 아래 명령으로 맞춘 뒤 다시 띄운다(--apply 를 빼면 목록만 본다)`)
      err(`${orchWord()} worker link-profile ${profile.id} --apply`)
      return 1
    }
  }
  if (passthru.includes('--terminal')) {
    const text = readFileSync(a.spec, 'utf8')
    const rejected = selectionVerdict(text, retryRepo, { launch: true, retry: true, continuation })
    if (rejected.length) throw new Stop(rejected.join('; '), 1)
  }
  if (!requireMigrated(a.repo || a.worktree.replace(/^path:/, ''), 'launch-worker', null)) return 2
  const poll = seconds('LAUNCH_POLL', '5')
  const wtWait = seconds('LAUNCH_WT_WAIT', '30')
  const wtPoll = seconds('LAUNCH_WT_POLL', '2')
  const call = (args: string[], timeoutMs?: number): Promise<RunResult> => execute([orcaBin(), ...withFull(args)], { timeoutMs })

  const specLine = await execute(scriptCommand(process.env.SPEC_LINE || scriptPath('spec-line'), [a.spec, '--require-permission']))
  if (specLine.code !== 0) {
    err('거부: 첫 지시 줄을 만들지 못했다(지시서에 `허락:` 줄을 적는다)')
    return 1
  }

  const gate = await lintGate(a, continuation, execute)
  if (gate.stop !== null) return gate.stop

  const specText = readFileSync(a.spec, 'utf8')
  const reviewPr = reviewPrOfSpec(specText)
  const created = !a.worktree
  let worktree: string
  if (created) {
    const args = ['--repo', a.repo, '--spec', a.spec, '--name', a.name]
    if (a.base) args.push('--base', a.base)
    if (a.resumeRemote) args.push('--resume-remote')
    const made = await execute(scriptCommand(process.env.MAKE_WORKTREE || scriptPath('make-worktree'), args), { timeoutMs: LONG_MS })
    if (made.code !== 0) {
      err(made.stderr)
      return 1
    }
    worktree = made.stdout.trim()
    out(`워크트리를 만들었다: ${worktree}`)
  } else {
    const target = realPath(a.worktree.replace(/^path:/, ''))
    if (!isDir(target)) {
      err(`워크트리가 없다: ${target}`)
      return 1
    }
    worktree = target
    const left = leftTerminals(worktree, passValue(passthru, '--terminal') ?? '')
    if (left) {
      out(`거부: 이 워크트리에 터미널이 남아 있다. 끝났는지 보고 orca terminal close --terminal <handle> 로 닫은 뒤 다시 띄운다\n${left}`)
      return 1
    }
    // --terminal 로 이어 쓰면 남은 변경은 그 에이전트가 하던 일이라 보지 않는다
    const dirty = reviewPr === null && !passthru.includes('--terminal') ? uncommitted(worktree) : []
    if (dirty.length > 0 && a.dirtyAck === null) {
      const shown = dirty.slice(0, DIRTY_SHOWN).join('\n') + (dirty.length > DIRTY_SHOWN ? `\n... 외 ${dirty.length - DIRTY_SHOWN}개` : '')
      out(
        `거부: 이 워크트리에 커밋 안 된 변경이 ${dirty.length}개 있다. 다른 PR 의 변경이 남았을 수 있다. ` +
          `무엇인지 보고 커밋하거나 정리한 뒤 다시 띄운다. 이어 할 일의 변경이면 --dirty-ack <이유> 를 준다\n${shown}`,
      )
      return 1
    }
    if (dirty.length > 0) out(`dirty-ack: ${a.dirtyAck}`)
  }

  if (passValue(passthru, '--agent') === 'codex') {
    const ssh = configureSshAgent(worktree, process.env.SSH_AUTH_SOCK)
    if (ssh.status === 'set') out(`SSH-AGENT 워크트리 core.sshCommand 를 설정했다: ${ssh.command}`)
    else if (ssh.status === 'failed') err(`경고: ssh-agent 설정을 건너뛴다. ${ssh.reason}`)
    else if (ssh.reason.startsWith('core.sshCommand')) err(`SSH-AGENT 건너뜀: ${ssh.reason}`)
  }

  const repo = a.repo || mainCheckout(worktree)
  if (reviewPr !== null) {
    let stopped: number | null
    try {
      stopped = await prepareReview(worktree, repo, reviewPr, execute)
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      err(`launch-worker: ${e.message}`)
      stopped = 2
    }
    if (stopped !== null) {
      err(`워크트리는 남아 있다: ${worktree}`)
      return stopped
    }
  }
  // 핸들러는 base 를 브랜치 이름으로 받는다. --base origin/main 으로 불러도 defaultBase 와 같은 꼴(main)로 넘긴다
  const ctx: FireContext = { repo, base: (a.base || defaultBase(repo) || '').replace(/^origin\//, ''), run: a.run || null }
  const branchOut = git(worktree, ['branch', '--show-current'])
  const common = {
    branch: (branchOut.code === 0 && branchOut.stdout.trim()) || null,
    agent: passValue(passthru, '--agent'),
    model: passValue(passthru, '--model'),
    effort: passValue(passthru, '--effort'),
  }
  const worker = { worktree: resolve(worktree), spec: resolve(a.spec) }

  let started = false
  try {
    const before = await fire(
      'before-launch',
      { worker: { task: a.task || null, dispatch: null, terminal: passValue(passthru, '--terminal'), ...worker }, ...common },
      ctx,
    )
    if (before.result !== 'pass' && before.result !== 'none') {
      err(`before-launch 가 ${before.result} 로 끝나 worker 를 띄우지 않는다`)
      return 1
    }

    let waited = 0
    while (!listed(worktree)) {
      if (waited >= wtWait) {
        err(unrecognizedHelp(worktree, waited))
        return 1
      }
      await sleep(wtPoll * 1000)
      waited += wtPoll || 1
    }
    err(`Orca 가 워크트리를 알아보기까지 ${secondsText(waited)}초 기다렸다`)

    const start = async (args: string[]): Promise<RunResult> => {
      let result = await call(['orchestration', 'worker-start', ...args, '--json'], LONG_MS)
      // worktree list 에 보인 직후에도 Orca 가 그 워크트리를 아직 고르지 못해 selector_not_found 로 끝나는 일이 있다.
      // 그 오류만 한 번 다시 부른다. 다른 오류는 다시 불러도 같은 결과라 그대로 멈춘다.
      if (result.code !== 0 && (result.stdout + result.stderr).includes('selector_not_found')) {
        err(`worker-start 가 selector_not_found 로 끝나 ${secondsText(wtPoll)}초 뒤 한 번 다시 부른다`)
        await sleep(wtPoll * 1000)
        result = await call(['orchestration', 'worker-start', ...args, '--json'], LONG_MS)
      }
      out(result.stdout + result.stderr)
      // 짧은 출력은 worker-start JSON 을 내지 않는다. 코디네이터가 고른 값과 대조하는 launch.effective 만 판정 줄로 남긴다(references/launch.md 「띄운 직후 확인」)
      if (short() && result.code === 0) out(`LAUNCH-EFFECTIVE ${jget(result.stdout, 'launch.effective') || '-'}`)
      // 실패한 시작의 receipt(failedStage, 남은 자원, request id)는 다시 불러 볼 수 없다. 다시 부르면 Task 가 하나 더 생긴다.
      // 그래서 짧은 출력에서도 receipt 전체를 한 줄로 남긴다
      if (short() && result.code !== 0) out(`START-FAIL ${receiptLine(result)}`)
      return result
    }
    let lastShow = ''
    const snapshot = worktreeSnapshot(worktree)
    const watch = async (dispatch: string): Promise<boolean> => {
      let spent = 0
      for (;;) {
        lastShow = (await call(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])).stdout
        const stage = jget(lastShow, 'worker.stage|stage')
        if (stage && stage !== 'worktree_creating') {
          out(`${dispatch} 단계: ${stage}`)
          return true
        }
        if (spent >= a.watch) {
          const life = await signsOfLife(lastShow, worktree, snapshot, call)
          if (life) {
            out(`${dispatch} 단계는 ${stage || '단계 없음'} 지만 일하는 흔적이 있어(${life}) 다시 띄우지 않는다`)
            return true
          }
          out(`STALLED-START ${dispatch} ${stage || '-'} watch=${a.watch}s,no-signs-of-life`)
          return false
        }
        await sleep(poll * 1000)
        spent += poll || 1
      }
    }

    const runArgs = a.run ? ['--run', a.run] : []
    const result = await start([...runArgs, ...(a.task ? ['--task', a.task, ...(a.retryOf ? ['--retry-of', a.retryOf] : [])] : ['--spec', specLine.stdout.trim()]), '--worktree', `path:${worktree}`, ...passthru])
    if (result.code !== 0) {
      const output = result.stdout + result.stderr
      if (passthru.includes('--terminal') && output.includes('agent_unconfigured')) {
        err(
          '--terminal 의 터미널이 에이전트를 인식하지 못했다(agent_unconfigured). replying.md 「이어 쓸 수 없는 터미널」 을 따른다. ' +
            '이 세션이 띄운 worker 의 작업이 push 됐는지 확인하고 orca terminal close 로 닫은 뒤 --terminal 을 빼고 --agent, --model, --effort 를 준다',
        )
        return 3
      }
      if (output.includes('agent-hooks-review-prompt')) {
        err('Codex 설치본에 .codex-plugin 이 없는 옛 버전이다: codex plugin marketplace upgrade fos-skills (docs/adr/007)')
      }
      const reason = startError(result.stdout)
      if (reason) err(`worker-start 오류: ${reason}`)
      err(`worker-start 가 종료 코드 ${result.code} 로 끝났다. launch.md 의 「첫 화면에서 멈춤」 과 「시작 직후 실패」 를 본다`)
      return 1
    }
    started = true
    const DISPATCH_KEYS = 'dispatch.id|dispatchId|worker.dispatchId'
    const TASK_KEYS = 'dispatch.taskId|taskId|task.id'
    const dispatch = jget(result.stdout, DISPATCH_KEYS)
    const task = jget(result.stdout, TASK_KEYS)
    if (!dispatch) {
      err('worker-start 출력에서 dispatch id 를 읽지 못했다')
      return 1
    }
    // 시작 확인이 늦어도 worker 가 끝났다고 단정할 수 없다. 그대로 두고 코디네이터에게 멈춤만 알린다.
    const stalled = a.watch > 0 && !(await watch(dispatch))
    // worker-show 결과의 터미널 키는 send-to-worker 가 읽는 키와 같다.
    const terminal = jget(lastShow, 'worker.agentTerminalHandle|dispatch.assigneeHandle') || jget(result.stdout, 'worker.agentTerminalHandle|dispatch.assigneeHandle|launch.terminalHandle') || passValue(passthru, '--terminal')
    // 짧은 출력은 터미널을 함께 낸다. 직접 실행(send-to-worker 가 읽는다)은 지금 꼴이다
    if (!stalled) out(short() ? `LAUNCHED ${dispatch} ${terminal || '-'} ${worktree}` : `LAUNCHED ${dispatch} ${worktree}`)
    const text = specText
    let effective = null
    try {
      const value = JSON.parse(result.stdout)?.result?.launch?.effective
      if (value && typeof value === 'object' && !Array.isArray(value)) effective = value
    } catch { /* receipt 를 읽지 못하면 실행 설정은 null 로 기록한다 */ }
    const reused = passValue(passthru, '--terminal')
    const inherited = reused ? terminalLaunch ?? retryLaunch : null
    const launch = {
      dispatch, task: task || null, terminal: terminal || null, worktree, branch: common.branch,
      run: a.run || jget(result.stdout, 'dispatch.runId|task.runId|run.id|worker.runId') || null,
      spec: resolve(a.spec),
      agent: reused ? inherited?.agent ?? null : common.agent,
      model: reused ? inherited?.model ?? null : common.model,
      effort: reused ? inherited?.effort ?? null : common.effort,
      effective,
      experiment: experimentOf(text)?.name ?? null,
      ...(gate.acked ? { lint_ack: gate.acked } : {}),
    }
    try {
      recordLaunch(repo, launch)
    } catch (e) {
      err(`launch-worker: 띄운 worker 를 기록하지 못했다. cleanup-sweep 이 이 터미널을 코디네이터의 것으로 알아보지 못한다: ${(e as Error).message}`)
    }
    // 멈춤도 정리·재개용 기록은 남긴다. 모델 배정 통계의 성공 이력에는 넣지 않는다.
    if (!stalled) try {
      recordHistory(repo, {
        ...launch, at: new Date().toISOString(), title: /^#\s+(.+)$/m.exec(text)?.[1] ?? null,
        row: selectionsOf(text)[0]?.row ?? null, retry_of: retryDispatch ?? inherited?.dispatch ?? null,
      })
    } catch (e) {
      err(`launch-worker: 띄우기 이력을 기록하지 못했다: ${(e as Error).message}`)
    }

    try {
      registerBoard(repo, a.spec, worktree, a.name, common.branch || '')
    } catch (e) {
      err(`launch-worker: 보드를 갱신하지 못했다: ${(e as Error).message}`)
    }

    try {
      await fire('worker-launched', { worker: { task: task || null, dispatch, terminal, ...worker }, ...common }, ctx)
    } catch (e) {
      // worker 는 이미 떴다. 어떤 예외로든 종료 코드를 바꾸면 코디네이터가 띄우기 실패로 읽고 같은 일을 다시 띄운다
      err(`launch-worker: worker-launched 를 내지 못했다: ${(e as Error)?.message ?? String(e)}`)
    }
    return stalled ? 1 : 0
  } finally {
    if (created && !started) {
      const hint = ['node', '--disable-warning=ExperimentalWarning', scriptPath('launch-worker'), '--spec', a.spec, '--worktree', worktree]
      hint.push(...(a.run ? ['--run', a.run] : []), '--', ...passthru)
      err(
        `워크트리는 남아 있다: ${worktree}\n같은 --name 으로 다시 부르면 make-worktree 가 거부한다. ` +
          `이어 띄우려면 --repo/--name/--base 대신 --worktree 를 준다:\n  ${hint.map(shQuote).join(' ')}`,
      )
      try {
        const left = leftTerminals(worktree)
        if (left) err(`실패한 띄우기가 남긴 터미널을 확인한다:\n${left}`)
      } catch (e) {
        if (!(e instanceof Stop)) throw e
      }
    }
  }
}

export function reportError(e: unknown): void {
  if (e instanceof Stop) {
    err(e.message)
    process.exitCode = e.code
  } else if (e instanceof ConfigError) {
    err(`launch-worker: ${e.message}`)
    process.exitCode = 2
  } else {
    err(`launch-worker: ${(e as Error)?.stack ?? String(e)}`)
    process.exitCode = 1
  }
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
