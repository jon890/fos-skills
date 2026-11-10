import { isObject, objectOr } from '../core/json.ts'
// Orca CLI 호출의 한 벌이다. 실행 파일은 ORCA 환경 변수, 없으면 orca 다. ORCA_CLI_COMMAND 는 읽지 않는다.
//
// `orca orchestration worker-list` 를 부르는 쪽이 알아야 할 동작(worker-list --help 와 실제 Orca 에서 확인했다):
//   - --run 없이 부르면 부른 터미널에 묶인 Run 의 worker 만 온다. 응답의 scope.source 는 bound 다.
//     모든 Run 을 받았을 때만 all 이고, --run 을 주면 flag 다.
//   - ORCA_TERMINAL_HANDLE 을 환경에서 빼도 범위는 넓어지지 않는다. 그 변수가 없으면 Orca CLI 가 작업 디렉터리의
//     활성 터미널로 호출자를 정한다. 그래서 이 모듈은 그 변수를 빼는 방식으로 범위를 다루지 않는다.
//   - 한 번에 100행까지 온다. --limit 100 으로 부르고 page.nextCursor 가 있으면 --cursor <값> 으로 끝까지 이어 읽는다.
//     첫 페이지만 읽으면 다른 worker 를 놓친다.
//
// `orca orchestration ...` 는 Orca 1.4.246 부터 --full 없이 부르면 에이전트용으로 줄인 보기를 낸다(2026-11-02 실측).
// 줄인 보기는 키 이름이 다르고(worker.stage 대신 stage, from_handle 대신 from) 판정에 쓰는 값(dispatchStatus, workerState,
// resource, thread_id, created_at, run_id)을 빼며 본문을 200자로 자른다. orch 는 전체 기록의 키를 읽으므로
// orchestration 명령에는 늘 withFull 로 --full 을 붙인다. 붙이지 않으면 값이 빈 채로 판정이 엇나간다
// (띄운 worker 의 단계를 읽지 못해 abandon 하고 다시 띄우거나, 살아 있는 dispatch 를 끝난 것으로 본다).

import { run } from './proc.ts'
import type { RunOptions, RunResult } from './proc.ts'

export function orcaBin(): string {
  return process.env.ORCA || 'orca'
}

// orchestration 명령이면 --full 을 붙인 인자를 낸다. 실행 파일을 뺀 인자를 받는다. 이미 있으면 그대로 둔다
export function withFull(args: string[]): string[] {
  if (args[0] !== 'orchestration' || args.includes('--full')) return args
  return [...args, '--full']
}

export function orca(args: string[], opts?: RunOptions): RunResult {
  return run([orcaBin(), ...withFull(args)], opts)
}

function brief(text: string): string {
  const line = text.trim()
  return line.length > 500 ? `${line.slice(0, 500)}...` : line
}

// --json 을 붙여 부르고 응답 봉투의 result 를 data 로 낸다. 봉투 전체가 아니다.
export function orcaJson<T>(args: string[], opts?: RunOptions): { ok: true; data: T } | { ok: false; error: string } {
  const command = `orca ${args.join(' ')}`
  const { done, envelope, parsed } = readEnvelope(args, opts)
  if (done.code !== 0) return { ok: false, error: `${command} 가 종료 코드 ${done.code} 로 끝났다: ${brief(done.stderr || done.stdout)}` }
  if (!parsed) return { ok: false, error: `${command} 의 출력이 JSON 이 아니다: ${brief(done.stdout)}` }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return { ok: false, error: `${command} 의 응답이 봉투 객체가 아니다` }
  }
  const body = envelope as { ok?: unknown; result?: unknown; error?: unknown }
  if (body.ok === false) return { ok: false, error: `${command} 가 실패를 알렸다: ${brief(JSON.stringify(body.error ?? null))}` }
  if (!('result' in body)) return { ok: false, error: `${command} 의 응답에 result 가 없다` }
  return { ok: true, data: body.result as T }
}

// Orca 에 등록된 저장소의 외부 워크트리 표시 설정(`orca repo show` 의 externalWorktreeVisibility). 못 읽으면 빈 문자열이다.
// `git worktree add` 로 만든 워크트리는 Orca 에게 외부 워크트리다. 이 값이 hide 면 Orca 가 숨겨 worker-start 가 그 경로를 찾지 못한다.
export function repoVisibility(repo: string): string {
  const got = orcaJson<{ repo?: { externalWorktreeVisibility?: unknown } } | null>(['repo', 'show', '--repo', `path:${repo}`])
  if (!got.ok) return ''
  const value = got.data?.repo?.externalWorktreeVisibility
  return typeof value === 'string' ? value : ''
}

// hide 일 때 사용자가 고를 조치. 설정은 사용자가 바꾼다. 명령이 스스로 바꾸면 사용자가 숨겨 둔 다른 워크트리까지 드러난다.
export function repoVisibilityActions(repo: string): string {
  return [
    '  1) Orca 화면에서 그 워크트리를 등록한다',
    `  2) orca repo set --repo path:${repo} --external-worktree-visibility show`,
  ].join('\n')
}

// 응답 봉투를 읽는 곳은 하나다. 호출자는 결과 반환과 예외 처리 중 기존 계약을 고른다.
function readEnvelope(args: string[], opts?: RunOptions): { done: RunResult; envelope: unknown; parsed: boolean } {
  const done = orca([...args, '--json'], opts)
  try { return { done, envelope: JSON.parse(done.stdout), parsed: true } }
  catch { return { done, envelope: null, parsed: false } }
}

// send-to-worker 가 쓰던 엄격한 ok 검사와 오류 본문을 보존한다.
export function orcaJsonOrThrow(args: string[], options: { failure?: (message: string, structured: boolean) => Error; run?: RunOptions } = {}): Record<string, any> {
  const { done, envelope } = readEnvelope(args, options.run)
  const body = objectOr(envelope)
  if (done.code !== 0 || !isObject(envelope) || !body.ok) {
    const detail = Array.from((done.stdout + done.stderr).trim()).slice(0, 300).join('')
    const message = `orca ${args.slice(0, 2).join(' ')} 실패: ${detail}`
    throw options.failure ? options.failure(message, body.ok === false && !!objectOr(body.error).code) : new Error(message)
  }
  return objectOr(body.result)
}

// 기존 호출자의 종료 코드·결과·예외 계약을 같은 닫기 명령에 연결한다.
type CloseOptions = RunOptions & { checkResponse?: boolean }
type OrcaResult = { ok: true; data: unknown } | { ok: false; error: string }
type OrcaFailure = (message: string, structured: boolean) => Error
export function closeTerminal(handle: string, options: CloseOptions & { mode: 'result' }): OrcaResult
export function closeTerminal(handle: string, options: CloseOptions & { mode: 'throw'; failure?: OrcaFailure }): Record<string, any>
export function closeTerminal(handle: string, options?: CloseOptions): boolean
export function closeTerminal(handle: string, options: CloseOptions & { mode?: 'result' | 'throw'; failure?: OrcaFailure } = {}): boolean | OrcaResult | Record<string, any> {
  const { checkResponse = true, mode, failure, ...runOptions } = options
  const args = ['terminal', 'close', '--terminal', handle]
  if (mode === 'result') return orcaJson(args, runOptions)
  if (mode === 'throw') return orcaJsonOrThrow(args, { failure, run: runOptions })
  return checkResponse ? orcaJson(args, runOptions).ok : orca([...args, '--json'], runOptions).code === 0
}
