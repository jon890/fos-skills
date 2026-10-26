// 머지 큐를 걸면서 PR 마다 머지 뒤 마무리(`finish-pr.ts`)도 함께 건다.
//
// 머지 큐만 걸면 머지 뒤의 worker 정리, 배포 확인, 업무 완료, 보드 갱신이 코디네이터의 기억에 달린다.
// 이 명령이 그 일을 기본 절차로 만든다. 사용자가 말하지 않아도 머지 큐는 이 명령으로 건다.
//
// 사용법:
//     merge-with-finish.ts [래퍼 옵션] [merge_queue.ts 옵션] PR[!|~][:머지 전 명령] ...
//
//     1. PR 마다 `finish-pr.ts` 를 백그라운드로 시작한다. 출력은 <로그 폴더>/finish-<PR>.out 이다.
//        띄우기 전에 마무리 스크립트 파일이 있는지 보고, 띄운 프로세스가 시작된 것을 확인한 뒤에 `마무리 시작` 줄을 낸다.
//        스크립트가 없거나 띄우지 못하면(인터프리터가 없다 같은 것) 이유를 stderr 에 내고 머지 큐를 걸지 않고 1 로 끝난다.
//        마무리 없이 머지하면 머지 뒤 정리와 업무 완료가 빠지기 때문이다. 앞 PR 의 마무리는 이미 떠 있으면 그대로 돈다
//        그 PR 의 마무리가 이미 돌고 있으면(<로그 폴더>/finish-<PR>.pid 의 프로세스가 살아 있으면) 새로 시작하지 않는다.
//        신호를 보낼 권한이 없는 pid(EPERM)도 살아 있는 것으로 본다(lib/process.ts 의 alive).
//        머지 큐가 STOP 으로 멈춘 뒤 남은 PR 만 다시 걸어도 마무리가 겹치지 않는다
//     2. `merge_queue.ts` 를 같은 인자로 돌리고 그 종료 코드로 끝난다.
//        오래 걸리므로 Bash 도구의 run_in_background 로 건다. 셸의 `&` 나 nohup 은 쓰지 않는다
//
//     표시가 없는 PR 은 마무리가 배포를 확인한 뒤 업무의 마지막 PR 인지 스스로 판정한다(finish-pr.ts 머리 주석의 「마지막 PR 판정」).
//     코디네이터가 PR 마다 마지막인지 정하지 않아도 된다. 판정을 덮어야 할 때만 표시를 붙인다.
//     PR 번호 뒤의 `!` 는 판정 없이 업무의 마지막 PR 로 본다(`finish-pr.ts --complete`). 머지 큐에는 그 PR 마다
//     `--last-of-task <PR>` 를 인자 맨 앞에 넣어 before-merge 입력의 last_of_task 를 true 로 한다. 예: 449! , 446!:'./bin/backup-db.sh orders "pre-446"'
//     PR 번호 뒤의 `~` 는 판정 없이 중간 PR 로 본다(`finish-pr.ts --intermediate`). 업무를 완료하지 않고 지시서를 남기며
//     보드 항목을 done 으로 바꾸지 않는다. --board-item 으로 준 항목은 판정과 상관없이 done 으로 바꾼다.
//     before-merge 의 last_of_task 는 `!` 일 때만 true 다. 판정은 머지와 배포 뒤에야 하기 때문이다.
//     마지막 PR 이면 업무 완료 명령(`complete_cmd`)이 설정에 없는 저장소에서는 업무 완료만 건너뛰고 그 PR 의 지시서를 지운다.
//     표시와 `:명령` 은 PR 번호 바로 뒤에 `번호[!|~][:명령]` 순서로 쓴다. `!` 와 `~` 는 함께 쓸 수 없다. 머지 큐에는 표시를 뗀 인자가 넘어간다.
//
// 래퍼 옵션 (merge_queue.ts 에는 넘기지 않는다):
//     --finish-config FILE    finish-pr.ts 의 --config. 없으면 finish-pr.ts 가 orch 작업 폴더의 config.json 을 찾는다
//     --finish-arg ARG        finish-pr.ts 에 더 넘길 인자. 하나씩 준다. 값이 `--` 로 시작하면 `--finish-arg=--run` 처럼 쓴다
//     --run RUN_ID            worker 를 찾을 Orca Run. finish-pr.ts 에 `--run` 을 넘기고, 머지 큐의 정리 단계에도
//                             `--sweep-arg --run --sweep-arg RUN_ID` 를 넘겨 다른 Run 의 worker 터미널을 건너뛰게 한다.
//                             `--finish-arg=--run` 으로만 준 값도 정리 단계에 넘긴다. 어디에도 없으면 경고 한 줄을 낸다
//     --board-item PR=ID      그 PR 의 마무리가 판정과 상관없이 done 으로 바꿀 보드 항목(`finish-pr.ts --board-id`). PR 마다 준다.
//                             주지 않으면 마무리가 보드 파일에서 찾는다(finish-pr.ts 머리 주석의 「보드 항목」)
//     --finish-log-dir DIR    마무리 출력과 pid 폴더. 기본은 orch 작업 폴더의 queue/(lib/paths.ts 의 queue). handoff-cleanup.ts 가 이 폴더의 끝난 로그를 옮긴다
//     --no-finish             마무리를 걸지 않고 머지 큐만 돌린다
//     래퍼 옵션은 `--옵션 값` 과 `--옵션=값` 을 받는다. 고유 접두로 줄여 쓸 수 없다
//
// merge_queue.ts 옵션은 그대로 쓴다(--repo, --required, --require-up-to-date 같은 것). --repo 는 마무리에도 넘어간다.
// 값을 받는 머지 큐 옵션은 lib/queue-options.ts 의 목록이다. 그 옵션 바로 뒤의 인자는 숫자여도 PR 번호로 읽지 않는다.
//
// 머지 큐 기본값: --finish-config 파일(없으면 orch 작업 폴더의 config.json)의 `queue` 절을 읽어
// 명령줄에 없는 머지 큐 옵션을 채운다. 키는 before, required, verify_merged, verify_merged_when, docs_glob, method,
// after_merged, up_to_date_when, shared_paths, unit_prefix 이고 각각 --before, --required, --verify-merged,
// --verify-merged-when, --docs-glob, --method, --after-merged, --up-to-date-when, --shared-paths, --unit-prefix 가 된다.
// before, verify_merged, after_merged 는 옛 칸이라 머지 큐가 그 이벤트의 핸들러처럼 돌리고 DEPRECATED 줄을 낸다(merge_queue.ts 머리 주석).
// required 와 docs_glob 은 문자열 목록도 받아 쉼표로 잇고, shared_paths 는 정규식 목록도 받아 `|` 로 잇는다.
// skipped_is_missing, update_docs_on_overlap, require_up_to_date 는 true 면 같은 이름의 옵션을 붙이는 참거짓 값이다.
// unit_groups 는 단위 이름 목록의 목록이고 안쪽 목록마다 `--unit-group a,b` 가 된다.
// sweep_args 는 문자열 목록이고 항목마다 `--sweep-arg` 로 넘어간다. 명령줄에 `--sweep-arg` 가 하나라도 있으면 목록은 쓰지 않는다.
// 명령줄에 준 옵션이 우선한다. 모르는 키가 있으면 사용법 오류다.
// 저장소마다 같은 옵션을 매번 옮겨 적다 빠뜨리는 일을 막는다.
// MERGE_QUEUE, FINISH_PR 환경 변수로 두 명령 경로를 바꾼다. 확장자로 인터프리터를 고른다.
// FINISH_PR 은 lib/proc.ts 의 scriptCommand 다. MERGE_QUEUE 는 옛 명령의 규칙에 `.ts` 를 더한 것이다.
// `.ts` 는 이 프로세스의 node, `.py` 는 python3, 그 밖(옛 merge-queue.sh 같은 것)은 bash 다
//
// 업무 완료 명령과 핸들러: 설정 `finish.complete_cmd` 나 --finish-arg 의 `--complete-cmd` 와 <orch 루트>/hooks/after-deploy.ts 가
// 함께 있으면 사용법 오류로 멈추고, 마무리도 머지 큐도 걸지 않는다. 마무리는 배포를 기다린 뒤에야 이 충돌을 알아채는데,
// 그때는 이미 머지와 정리가 끝났기 때문이다.
// 업무 완료 명령이나 핸들러가 있으면 config.json 의 hooks.timeouts.after-deploy 값도 머지 큐를 걸기 전에 본다. 틀리면 사용법 오류다.
// 두 검사(충돌, hooks.timeouts.after-deploy)는 --no-finish 면 하지 않는다. 마무리를 걸지 않으면 after-deploy 가 나지 않기 때문이다.
// --finish-arg 는 finish-pr.ts 의 옵션 목록(lib/finish-options.ts)으로 펼쳐 본다. 그래서 finish-pr 이 받아들이는
// 고유 접두(`--complete-c`)와 `--complete-cmd=값` 도 알아본다. 접두가 여러 옵션에 맞으면 사용법 오류다.
//
// --finish-config 없이 orch 작업 폴더를 옮기기 전인 저장소에서 부르면 옮기는 명령을 알리고 머지 큐를 걸지 않는다(종료 코드 2).
// 옛 설정을 읽지 않으므로 그대로 걸면 머지 전 명령(DB 백업 같은 것)과 필수 체크가 경고 없이 빠진다.
//
// 종료 코드: merge_queue.ts 의 종료 코드. 2 는 사용법 오류(설정 파일 오류, 업무 완료 명령과 핸들러가 함께 있음 포함)이거나
//           옮기기 전이라는 뜻이기도 하다. 1 은 마무리를 띄우지 못해 머지 큐를 걸지 않았다는 뜻이기도 하다

import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandArgs } from './lib/args.ts'
import { ConfigError, loadConfig, QUEUE_KEYS, section } from './lib/config.ts'
import type { Config } from './lib/config.ts'
import { checkLegacy, eventTimeoutSec, handlerFile } from './lib/events.ts'
import { FINISH_OPTIONS } from './lib/finish-options.ts'
import { isFile, real } from './lib/fs.ts'
import { makeParent, pathOf, requireMigrated } from './lib/paths.ts'
import { NO_LIMIT_MS, runInherit, scriptCommand } from './lib/proc.ts'
import { pidFileAlive } from './lib/process.ts'
import { QUEUE_FLAGS, QUEUE_GROUPS, QUEUE_REPEATED, QUEUE_VALUE_OPTIONS, QUEUE_VALUES } from './lib/queue-options.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const HERE = dirname(SCRIPT)
// 문자열 목록도 받는 queue 키와 목록을 잇는 구분자. 키와 옵션의 대응은 lib/queue-options.ts 의 QUEUE_VALUES 들이다
const QUEUE_LISTS: Readonly<Record<string, string>> = { required: ',', docs_glob: ',', shared_paths: '|' }
const PR_SPEC = /^(\d+)([!~]?)(:.*)?$/s
const LEGACY_KEY = '--complete-cmd'

class Usage extends Error {}

type Wrapper = {
  finishConfig: string | null
  finishArg: string[]
  logDir: string | null
  noFinish: boolean
  boardItems: Map<string, string>
  run: string | null
  repo: string
}

// mark 는 `!`(마지막), `~`(중간), 없으면 null(마무리가 판정한다)이다
type PrArg = { number: string; mark: '!' | '~' | null }

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function usageText(): string {
  const lines: string[] = []
  for (const line of readFileSync(SCRIPT, 'utf8').split('\n')) {
    if (!line.startsWith('//')) break
    lines.push(line.replace(/^\/\/ ?/, ''))
  }
  return lines.join('\n')
}

// `번호[!|~][:머지 전 명령]` 을 (번호, 표시, 머지 큐에 넘길 인자) 로 나눈다. PR 인자가 아니면 null 이다
function parseQueueSpec(arg: string): { number: string; mark: PrArg['mark']; queueArg: string } | null {
  const found = PR_SPEC.exec(arg)
  if (!found) return null
  const mark = found[2] === '!' || found[2] === '~' ? found[2] : null
  return { number: found[1], mark, queueArg: found[1] + (found[3] ?? '') }
}

// `name VALUE` 쌍의 VALUE. 없으면 null 이고, 쌍의 값이 서로 다르면 Usage 다
function pairValue(args: string[], name: string): string | null {
  const values = new Set<string>()
  for (let i = 0; i < args.length - 1; i++) if (args[i] === name) values.add(args[i + 1])
  if (values.size > 1) throw new Usage(`${name} 의 값이 서로 다르다: ${[...values].sort().join(', ')}`)
  return values.size === 1 ? [...values][0] : null
}

// 머지 큐의 정리 단계를 Run 으로 한정하는 인자를 더한 머지 큐 인자. Run 이 어디에도 없으면 경고만 내고 그대로 돌려준다.
// Run 이 서로 다른 곳에 있으면 Usage 다
function scopeSweep(wrapper: Wrapper, queue: string[]): string[] {
  if (queue.includes('--no-sweep')) return queue
  const sweep: string[] = []
  for (let i = 0; i < queue.length - 1; i++) if (queue[i] === '--sweep-arg') sweep.push(queue[i + 1])
  const sweepRun = pairValue(sweep, '--run')
  const runs = new Set([wrapper.run, pairValue(wrapper.finishArg, '--run'), sweepRun].filter((v): v is string => Boolean(v)))
  if (runs.size > 1) throw new Usage(`--run 의 값이 서로 다르다: ${[...runs].sort().join(', ')}`)
  if (runs.size === 0) {
    process.stderr.write('경고: 정리 단계가 Run 으로 한정되지 않는다. --run RUN_ID 를 주면 다른 Run 의 worker 터미널을 건너뛴다\n')
    return queue
  }
  if (sweepRun === null) return ['--sweep-arg', '--run', '--sweep-arg', [...runs][0], ...queue]
  return queue
}

// (래퍼 옵션, 머지 큐 인자 목록, PR 목록). 모르는 래퍼 옵션 값이면 Usage
function splitArgs(argv: string[]): { wrapper: Wrapper; queue: string[]; prs: PrArg[] } {
  const wrapper: Wrapper = { finishConfig: null, finishArg: [], logDir: null, noFinish: false, boardItems: new Map(), run: null, repo: '.' }
  const queue: string[] = []
  const prs: PrArg[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : null
    // `--옵션=값` 이면 그 값, 아니면 다음 인자. 다음 인자가 없으면 null 이다
    const value = (): string | null => {
      if (inline !== null) return inline
      if (i + 1 < argv.length) return argv[++i]
      return null
    }
    if (name === '--finish-config' || name === '--finish-arg' || name === '--finish-log-dir') {
      const got = value()
      if (got === null) throw new Usage(`${name} 에 값이 없다`)
      if (name === '--finish-arg') wrapper.finishArg.push(got)
      else if (name === '--finish-config') wrapper.finishConfig = got
      else wrapper.logDir = got
    } else if (name === '--run') {
      const got = value()
      if (!got) throw new Usage('--run 에 값이 없다')
      wrapper.run = got
    } else if (name === '--board-item') {
      const got = value() ?? ''
      const sep = got.indexOf('=')
      const number = sep >= 0 ? got.slice(0, sep) : got
      const item = sep >= 0 ? got.slice(sep + 1) : ''
      if (!(/^\d+$/.test(number) && sep >= 0 && item)) throw new Usage('--board-item 은 PR번호=항목id 형식이다')
      wrapper.boardItems.set(number, item)
    } else if (arg === '--no-finish') {
      wrapper.noFinish = true
    } else if (QUEUE_VALUE_OPTIONS.includes(arg)) {
      if (i + 1 >= argv.length) throw new Usage(`${arg} 에 값이 없다`)
      queue.push(arg, argv[i + 1])
      if (arg === '--repo') wrapper.repo = argv[i + 1]
      i += 1
    } else if (arg.startsWith('-')) {
      queue.push(arg)
    } else {
      const spec = parseQueueSpec(arg)
      if (spec === null) throw new Usage(`PR 번호가 아니다: ${arg}`)
      prs.push({ number: spec.number, mark: spec.mark })
      queue.push(spec.queueArg)
    }
  }
  return { wrapper, queue, prs }
}

// 머지 큐 인자 가운데 명령줄에 준 옵션 이름. 값 자리는 세지 않는다
function givenOptions(queue: string[]): Set<string> {
  const given = new Set<string>()
  let skip = false
  for (const arg of queue) {
    if (skip) skip = false
    else if (arg.startsWith('-')) {
      given.add(arg)
      skip = QUEUE_VALUE_OPTIONS.includes(arg)
    }
  }
  return given
}

function configPath(wrapper: Wrapper): string {
  return wrapper.finishConfig ? resolve(wrapper.finishConfig) : pathOf('config', wrapper.repo)
}

// 설정의 queue 절에서 명령줄에 없는 머지 큐 옵션을 만든다. 절이 잘못됐으면 ConfigError
function queueDefaults(path: string, queue: string[], config: Config): string[] {
  const body = section<Record<string, unknown>>(config, 'queue', QUEUE_KEYS)
  const given = givenOptions(queue)
  const extra: string[] = []
  for (const [key, option] of Object.entries(QUEUE_VALUES)) {
    if (!(key in body) || given.has(option)) continue
    let value = body[key]
    if (Array.isArray(value) && key in QUEUE_LISTS && value.every((v) => typeof v === 'string')) value = value.join(QUEUE_LISTS[key])
    if (typeof value !== 'string' || !value) throw new ConfigError(`${path} 의 queue.${key} 는 비지 않은 문자열이어야 한다`)
    extra.push(option, value)
  }
  for (const [key, option] of Object.entries(QUEUE_FLAGS)) {
    if (!(key in body) || given.has(option)) continue
    if (typeof body[key] !== 'boolean') throw new ConfigError(`${path} 의 queue.${key} 는 true 나 false 여야 한다`)
    if (body[key]) extra.push(option)
  }
  for (const [key, option] of Object.entries(QUEUE_REPEATED)) {
    if (!(key in body)) continue
    const values = body[key]
    if (!Array.isArray(values) || !values.every((v) => typeof v === 'string' && v)) {
      throw new ConfigError(`${path} 의 queue.${key} 는 비지 않은 문자열 목록이어야 한다`)
    }
    if (!given.has(option)) for (const value of values as string[]) extra.push(option, value)
  }
  for (const [key, option] of Object.entries(QUEUE_GROUPS)) {
    if (!(key in body)) continue
    const groups = body[key]
    const ok =
      Array.isArray(groups) &&
      groups.length > 0 &&
      groups.every((g) => Array.isArray(g) && g.length >= 2 && g.every((m) => typeof m === 'string' && m && !m.includes(',')))
    if (!ok) throw new ConfigError(`${path} 의 queue.${key} 는 단위 이름이 둘 이상인 문자열 목록의 목록이어야 한다`)
    if (!given.has(option)) for (const members of groups as string[][]) extra.push(option, members.join(','))
  }
  return extra
}

// 마무리에 업무 완료 명령이 가는가. 설정의 finish.complete_cmd 나 --finish-arg 의 --complete-cmd 다. 없으면 null.
// --finish-arg 는 finish-pr 이 읽는 대로 옵션 이름을 펼친 뒤 본다. `--` 뒤는 finish-pr 이 옵션으로 읽지 않으므로 보지 않는다
function completeCommandSource(wrapper: Wrapper, config: Config): string | null {
  let expanded: string[]
  try {
    expanded = expandArgs(wrapper.finishArg, FINISH_OPTIONS)
  } catch (e) {
    throw new Usage(`--finish-arg: ${(e as Error).message}`)
  }
  const end = expanded.indexOf('--')
  const options = end >= 0 ? expanded.slice(0, end) : expanded
  if (options.some((arg) => arg === LEGACY_KEY || arg.startsWith(`${LEGACY_KEY}=`))) return `--finish-arg 의 ${LEGACY_KEY}`
  const value = config.finish?.complete_cmd
  return typeof value === 'string' && value ? 'finish.complete_cmd' : null
}

// 새 세션으로 띄워 이 명령이 끝나도 마무리가 이어 돌게 한다. 프로세스가 시작되면 null, 띄우지 못하면 이유다
function launch(cmd: string[], fd: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', fd, fd], detached: true })
    child.once('error', (e) => resolve(`${cmd[0]} 를 실행하지 못했다: ${e.message}`))
    child.once('spawn', () => {
      child.unref()
      resolve(null)
    })
  })
}

// 마무리를 걸었거나 이미 돌고 있으면 true. 띄우지 못하면 이유를 stderr 에 내고 false 다
async function startFinish(wrapper: Wrapper, pr: PrArg): Promise<boolean> {
  const repo = real(wrapper.repo)
  const logDir = wrapper.logDir ?? pathOf('queue', repo)
  makeParent(join(logDir, 'x'), repo)
  const pidFile = join(logDir, `finish-${pr.number}.pid`)
  if (pidFileAlive(pidFile)) {
    out(`마무리는 이미 돌고 있다: PR ${pr.number} (${pidFile})`)
    return true
  }
  const script = process.env.FINISH_PR || join(HERE, 'finish-pr.ts')
  // 인터프리터는 없는 스크립트도 띄운 뒤 실패로 끝나, 띄우기 결과만으로는 알 수 없다
  if (!isFile(script)) {
    process.stderr.write(`merge-with-finish: 마무리를 띄우지 못했다: PR ${pr.number}: 마무리 스크립트가 없다: ${script}\n`)
    return false
  }
  const args = [pr.number, '--repo', repo, '--pid-file', pidFile]
  if (wrapper.finishConfig) args.push('--config', wrapper.finishConfig)
  if (pr.mark === '!') args.push('--complete')
  else if (pr.mark === '~') args.push('--intermediate')
  const boardId = wrapper.boardItems.get(pr.number)
  if (boardId) args.push('--board-id', boardId)
  args.push(...wrapper.finishArg)
  const outFile = join(logDir, `finish-${pr.number}.out`)
  const fd = openSync(outFile, 'w')
  let failure: string | null
  try {
    failure = await launch(scriptCommand(script, args), fd)
  } finally {
    closeSync(fd)
  }
  if (failure) {
    process.stderr.write(`merge-with-finish: 마무리를 띄우지 못했다: PR ${pr.number}: ${failure}\n`)
    return false
  }
  const note = pr.mark === '!' ? '업무의 마지막 PR' : pr.mark === '~' ? '중간 PR' : '마지막 PR 인지는 배포 뒤 판정'
  out(`마무리 시작: PR ${pr.number} (${note}) -> ${outFile}`)
  return true
}

// MERGE_QUEUE 의 명령줄. 옛 명령은 `.py` 면 python3, 그 밖은 bash 로 띄웠고 여기에 `.ts` 를 더했다(머리 주석)
function queueCommand(script: string, args: string[]): string[] {
  if (extname(script) === '.ts') return [process.execPath, '--disable-warning=ExperimentalWarning', script, ...args]
  if (extname(script) === '.py') return ['python3', script, ...args]
  return ['bash', script, ...args]
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof splitArgs>
  try {
    parsed = splitArgs(argv)
  } catch (e) {
    if (!(e instanceof Usage)) throw e
    process.stderr.write(`merge-with-finish: ${e.message}\n`)
    return 2
  }
  const { wrapper, prs } = parsed
  if (prs.length === 0) {
    out(usageText())
    return 2
  }
  if (!wrapper.finishConfig && !requireMigrated(wrapper.repo, 'merge-with-finish', '설정 파일을 --finish-config 로 직접 준다')) return 2
  let config: Config
  let queue: string[]
  try {
    const path = configPath(wrapper)
    config = loadConfig(wrapper.repo, wrapper.finishConfig ? { file: wrapper.finishConfig } : {})
    if (!wrapper.noFinish) {
      const source = completeCommandSource(wrapper, config)
      if (source) checkLegacy('after-deploy', wrapper.repo, source)
      // 마무리는 배포를 기다린 뒤에야 after-deploy 를 낸다. 시간 제한 값이 틀린 것을 머지 큐를 걸기 전에 알린다
      if (source || handlerFile('after-deploy', wrapper.repo)) eventTimeoutSec('after-deploy', wrapper.repo)
    }
    const lastOfTask = prs.filter((pr) => pr.mark === '!').flatMap((pr) => ['--last-of-task', pr.number])
    queue = [...lastOfTask, ...scopeSweep(wrapper, [...queueDefaults(path, parsed.queue, config), ...parsed.queue])]
    if (wrapper.run && pairValue(wrapper.finishArg, '--run') === null) wrapper.finishArg.push('--run', wrapper.run)
  } catch (e) {
    if (!(e instanceof Usage) && !(e instanceof ConfigError)) throw e
    process.stderr.write(`merge-with-finish: ${e.message}\n`)
    return 2
  }
  if (!wrapper.noFinish) {
    for (const pr of prs) if (!(await startFinish(wrapper, pr))) return 1
  }
  const done = await runInherit(queueCommand(process.env.MERGE_QUEUE || join(HERE, 'merge_queue.ts'), queue), { timeoutMs: NO_LIMIT_MS })
  return done.code
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  },
)
