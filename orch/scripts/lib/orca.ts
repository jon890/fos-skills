// Orca CLI 호출의 한 벌이다. 실행 파일은 ORCA 환경 변수, 없으면 orca 다. ORCA_CLI_COMMAND 는 읽지 않는다.
//
// `orca orchestration worker-list` 를 부르는 쪽이 알아야 할 동작(worker-list --help 와 실제 Orca 에서 확인했다):
//   - --run 없이 부르면 부른 터미널에 묶인 Run 의 worker 만 온다. 응답의 scope.source 는 bound 다.
//     모든 Run 을 받았을 때만 all 이고, --run 을 주면 flag 다.
//   - ORCA_TERMINAL_HANDLE 을 환경에서 빼도 범위는 넓어지지 않는다. 그 변수가 없으면 Orca CLI 가 작업 디렉터리의
//     활성 터미널로 호출자를 정한다. 그래서 이 모듈은 그 변수를 빼는 방식으로 범위를 다루지 않는다.
//   - 한 번에 100행까지 온다. --limit 100 으로 부르고 page.nextCursor 가 있으면 --cursor <값> 으로 끝까지 이어 읽는다.
//     첫 페이지만 읽으면 다른 worker 를 놓친다.

import { run } from './proc.ts'
import type { RunOptions, RunResult } from './proc.ts'

export function orcaBin(): string {
  return process.env.ORCA || 'orca'
}

export function orca(args: string[], opts?: RunOptions): RunResult {
  return run([orcaBin(), ...args], opts)
}

function brief(text: string): string {
  const line = text.trim()
  return line.length > 500 ? `${line.slice(0, 500)}...` : line
}

// --json 을 붙여 부르고 응답 봉투의 result 를 data 로 낸다. 봉투 전체가 아니다.
export function orcaJson<T>(args: string[], opts?: RunOptions): { ok: true; data: T } | { ok: false; error: string } {
  const command = `orca ${args.join(' ')}`
  const done = orca([...args, '--json'], opts)
  if (done.code !== 0) return { ok: false, error: `${command} 가 종료 코드 ${done.code} 로 끝났다: ${brief(done.stderr || done.stdout)}` }
  let envelope: unknown
  try {
    envelope = JSON.parse(done.stdout)
  } catch {
    return { ok: false, error: `${command} 의 출력이 JSON 이 아니다: ${brief(done.stdout)}` }
  }
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
