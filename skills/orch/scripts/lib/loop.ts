import { runKey } from '../core/loop.ts'
import type { LoopState, LoopStatus, RunEntry } from '../core/loop.ts'
// 상주 루프(orch-loop.ts)의 상태 판정 한 벌이다. 루프 상태 읽기, 생존 판정과 Run 등록을 맡는다.
// 사용처: orch-loop.ts(쓰는 쪽과 --status), orch-doctor.ts(session-resume 의 loop_alive).
// 파일 형식은 docs/data-schema.md 「orch 루트에 더하는 파일」 이 정한다. 경로는 모두 <orch 루트>/state/ 아래다.
//
//   loop.json            루프 상태. 루프의 부모 프로세스만 쓴다(옆 파일에 쓰고 rename). runs 가 없으면 Run 등록을 모르는 옛 루프다
//   loop.lock            한 저장소에 루프 하나. orch-loop.ts --foreground 가 쥔다
//   loop-runs/<Run>.json         루프에 등록된 Run 하나. {"run", "specs_dir", "registered_at", "coordinator_terminal"}. 아래 「Run 등록」
//   <Run> 은 runKey 로 바꾼 이름이다(영문, 숫자, _, ., - 밖의 글자를 _ 로).
//
// Run 등록(registerRun, unregisterRun, registeredRuns, ADR-012):
//   루프는 저장소마다 하나이고 여러 Run 을 맡는다. 등록은 Run 마다 파일 하나라 잠금 없이 만들고(옆 파일에 쓰고 rename) 지운다.
//   loop.json 은 루프의 부모만 쓰는 파일이라 다른 프로세스(--start, --stop)가 쓰지 않게 등록을 따로 둔다.
//   이미 등록된 Run 을 다시 등록하면 registered_at 은 그대로 두고 specs_dir 만 바꾼다. 주 Run 의 차례가 바뀌지 않게 하려는 것이다.
//   renew 를 주면 registered_at 을 지금으로 새로 쓴다. 살아 있는 루프 없이 --start 한 세션이 자기 등록이 살아 있음을 알리는 데 쓴다
//   (orch-loop.ts 머리 주석의 「Run」).
//   registeredRuns 는 registered_at 이 이른 순(같으면 Run id 순)이다. 앞이 주 Run 이다. 읽지 못한 파일은 건너뛴다.
//
// 생존(loopStatus): loop.json 이 있고, pid 가 살아 있고(lib/process.ts 의 alive), alive_at 이 now 에서 max(3 × tick_sec, 120) 초 안이면
//   살아 있다. tick_sec 은 loop.json 에 루프가 적은 값이다. last_tick 은 상태 보고용이고 판정에 쓰지 않는다.
//   틱 하나가 길어도(정리의 --wait, 끝난 dispatch 이어 쓰기) 부모가 틱과 따로 alive_at 을 쓰므로 죽은 것으로 보지 않는다.
//   죽은 이유는 `없음`(파일이 없거나 깨졌다), `pid <n> 종료`, `alive_at <시각> 이후 응답 없음` 가운데 하나다.
//   alive_at 만 오래됐고 pid 가 살아 있는 루프 프로세스(isLoopProcess 가 true 나 null)면 recheck: true 를 붙인다. 잠들었다 깬 macOS 에서는
//   루프의 생존 타이머가 아직 alive_at 을 쓰지 못했을 수 있다. 판정은 동기라 기다리지 않는다. 부르는 쪽(wait-important, doctor)이
//   recheckMs() 를 기다린 뒤 한 번 더 부르고, 그때도 죽었으면 죽음으로 낸다.
//   recheckMs 는 생존 타이머 간격(ORCH_LOOP_ALIVE_SEC, 양수 초, 기본 30. 양수가 아니면 기본값)에 여유(ORCH_LOOP_RECHECK_MARGIN_SEC, 기본 5초)를 더한 값이다.
//   간격은 부르는 쪽의 환경 변수로 읽는다. 루프는 그 값을 loop.json 에 적지 않는다.
//
// 루프 프로세스(isLoopProcess): pid 가 살아 있고 `ps -o command=` 의 명령줄에 orch-loop 가 들어 있으면 true 다.
//   죽은 루프의 pid 를 다른 프로세스가 다시 받았으면 그 프로세스를 루프로 보지 않는다(false).
//   pid 가 살아 있는데 ps 가 0 이 아닌 코드로 끝나거나 실행되지 않으면 판정할 수 없어 null 이다. 부르는 쪽은 null 을 루프 프로세스로
//   다룬다(잠금을 회수하지 않고, recheck 를 붙인다). 루프가 아니라고 잘못 보면 살아 있는 루프의 잠금을 빼앗아 루프가 둘이 된다.
//   ps 가 실패한 사이 pid 가 죽었으면 false 다.
//

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeParent, pathOf } from './paths.ts'
import { envMs } from './env.ts'
import { run } from './proc.ts'
import { alive } from './process.ts'
export const DEFAULT_ALIVE_SEC = 30

export function loopFile(repo: string): string {
  return join(pathOf('state', repo), 'loop.json')
}

function runFile(repo: string, run: string): string {
  return join(pathOf('state', repo), 'loop-runs', `${runKey(run)}.json`)
}

function readRunFile(file: string): RunEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunEntry
    if (!parsed || typeof parsed.run !== 'string' || !parsed.run) return null
    return {
      run: parsed.run,
      specs_dir: typeof parsed.specs_dir === 'string' && parsed.specs_dir ? parsed.specs_dir : null,
      registered_at: typeof parsed.registered_at === 'string' ? parsed.registered_at : '',
      coordinator_terminal: typeof parsed.coordinator_terminal === 'string' && parsed.coordinator_terminal ? parsed.coordinator_terminal : null,
    }
  } catch {
    return null
  }
}

// 머리 주석의 「Run 등록」. 새로 등록했으면 true, 이미 등록돼 있었으면 false
export function registerRun(repo: string, run: string, specsDir: string | null, renew = false, coordinatorTerminal?: string | null): boolean {
  const file = runFile(repo, run)
  const before = readRunFile(file)
  const at = (!renew && before?.registered_at) || new Date().toISOString()
  const entry: RunEntry = {
    run,
    specs_dir: specsDir ?? before?.specs_dir ?? null,
    registered_at: at,
    coordinator_terminal: coordinatorTerminal === undefined ? before?.coordinator_terminal ?? null : coordinatorTerminal,
  }
  replace(file, `${JSON.stringify(entry)}\n`, repo)
  return before === null
}

// 지웠으면 true, 등록돼 있지 않았으면 false
export function unregisterRun(repo: string, run: string): boolean {
  try {
    unlinkSync(runFile(repo, run))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

// 파일 이름이 같아도(runKey 가 겹친다) 안의 Run 이 다르면 등록되지 않은 것이다
export function isRegistered(repo: string, run: string): boolean {
  return readRunFile(runFile(repo, run))?.run === run
}

export function registeredRuns(repo: string): RunEntry[] {
  const dir = join(pathOf('state', repo), 'loop-runs')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries = names.filter((name) => name.endsWith('.json')).map((name) => readRunFile(join(dir, name))).filter((e): e is RunEntry => e !== null)
  return entries.sort((a, b) => (a.registered_at < b.registered_at ? -1 : a.registered_at > b.registered_at ? 1 : a.run < b.run ? -1 : a.run > b.run ? 1 : 0))
}

export function lockFile(repo: string): string {
  return join(pathOf('state', repo), 'loop.lock')
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

// 옆 파일에 쓰고 바꾼다. 쓰는 도중에 끊겨도 읽는 쪽이 반쯤 쓴 파일을 보지 않는다.
// 폴더 만들기와 git 무시(makeParent)는 파일이 처음 생길 때만 한다. 생존 타이머가 쓸 때마다 git 을 부르지 않게 한다
function replace(file: string, content: string, repo: string): void {
  if (!existsSync(file)) makeParent(file, repo)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, file)
}

export function readLoop(repo: string): LoopState | null {
  let parsed: unknown
  try {
    const raw = readText(loopFile(repo))
    if (raw === null) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as LoopState
}

// loop.json 을 쓴다. 루프의 부모 프로세스만 부른다(머리 주석).
export function writeLoop(repo: string, state: LoopState): void {
  replace(loopFile(repo), `${JSON.stringify(state, null, 1)}\n`, repo)
}

// 머리 주석의 「루프 프로세스」
export function isLoopProcess(pid: number): boolean | null {
  if (!alive(pid)) return false
  const done = run(['ps', '-o', 'command=', '-p', String(pid)], { env: { LC_ALL: 'C' } })
  if (done.code !== 0) return alive(pid) ? null : false
  return done.stdout.includes('orch-loop')
}

// 머리 주석의 「생존」. 다시 판정하기 전에 기다릴 ms
export function recheckMs(): number {
  return envMs('ORCH_LOOP_ALIVE_SEC', DEFAULT_ALIVE_SEC) + envMs('ORCH_LOOP_RECHECK_MARGIN_SEC', 5)
}
// 외부 상태는 여기서 읽고, 결과는 값만으로 정한다.
export function loopStatus(repo: string, now: number): LoopStatus {
  const state = readLoop(repo)
  const pid = Number(state?.pid)
  const live = state !== null && alive(pid)
  const result = judgeLoop(state, now, live)
  return !result.alive && result.recheck ? judgeLoop(state, now, live, isLoopProcess(pid)) : result
}

export { DEFAULT_TICK_SEC, MIN_DEAD_SEC, runKey } from '../core/loop.ts'
export type { LoopState, LoopStatus, RunEntry } from '../core/loop.ts'

import { judgeLoop } from '../core/loop.ts'
