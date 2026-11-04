// 사용자가 코디네이터와 대화 중인지 판정한다(사용자 결정 2026-11-04).
// 사용처: hooks/record-user-input.ts(입력 시각 기록), orch-loop.ts(대기 없음 알림), lib/decisions.ts(decision-pending 전달),
// user-active.ts(코디네이터가 대기를 다시 걸지 정할 때).
//
// 대화 중: 그 터미널의 마지막 사용자 입력이 ORCH_USER_ACTIVE_SEC(기본 600초) 안이다. 0 이면 늘 대화 중이 아닌 것으로 본다.
//     대기가 깨어날 때마다 처리와 재대기를 이으면 사용자 말이 뒤로 밀렸다. 그동안은 코디네이터가 대기를 다시 걸지 않고,
//     상주 루프는 대기 없음 알림과 decision-pending 전달을 미룬다. 사용자가 그 시간만큼 입력하지 않으면 루프가 알린다.
//     10분은 대화 한 턴 사이의 간격보다 길고, 미룬 알림이 너무 늦지 않은 값이다.
//
// 기록: Claude Code 의 UserPromptSubmit hook(hooks/record-user-input.ts)이 ORCA_TERMINAL_HANDLE 의 파일에 입력 시각을 쓴다.
//     폴더는 lib/machine.ts 의 머신 폴더 아래 user-input/ 이다. 저장소마다가 아니라 터미널마다다.
//     루프는 Run 등록의 coordinator_terminal 로 찾는다. 파일 꼴은 {"at": <epoch ms>}.
//     기록 없는 에이전트(Codex 코디네이터, hook 을 싣지 않은 세션)는 늘 대화 중이 아닌 것으로 보여 예전 동작과 같다.
//
// 자동 입력: orch 가 코디네이터 터미널에 넣는 글(AUTO_PROMPTS)은 사용자 입력으로 세지 않는다. 세면 알림이 자기 자신을 미룬다.
//     루프가 넣는 글은 이 파일의 접두 상수로 시작한다.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machineDir } from './machine.ts'

export const NO_WAIT_PREFIX = '대기 없음:'
export const DECISION_PREFIX = '정할 것 묻기:'
const AUTO_PROMPTS = [NO_WAIT_PREFIX, DECISION_PREFIX, '<task-notification>']
// Orca 가 코디네이터에게 넣는 메시지 알림
const ORCA_NOTICE = /^You have \d+ (?:new |unread )?orchestration message/i
const HANDLE = /^term_[\w-]+$/
// 이보다 오래된 기록은 쓸 때 지운다. 끝난 worker 터미널의 파일이 쌓이지 않게 한다
const PRUNE_MS = 7 * 24 * 3600 * 1000

export function inputDir(): string {
  return join(machineDir(), 'user-input')
}

export function activeMs(): number {
  const raw = Number(process.env.ORCH_USER_ACTIVE_SEC)
  return (Number.isFinite(raw) && raw >= 0 ? raw : 600) * 1000
}

export function isAutoPrompt(prompt: string): boolean {
  const text = prompt.trimStart()
  return AUTO_PROMPTS.some((prefix) => text.startsWith(prefix)) || ORCA_NOTICE.test(text)
}

// 입력 시각을 쓴다. 자동 입력이거나 handle 이 아니면 쓰지 않고 false 다
export function recordInput(terminal: string | undefined, prompt: string, now = Date.now()): boolean {
  if (!terminal || !HANDLE.test(terminal) || isAutoPrompt(prompt)) return false
  const dir = inputDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${terminal}.json`)
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ at: now })}\n`)
  renameSync(`${file}.tmp`, file)
  for (const name of readdirSync(dir)) {
    const other = join(dir, name)
    try {
      if (now - statSync(other).mtimeMs > PRUNE_MS) rmSync(other, { force: true })
    } catch {
      // 다른 hook 이 먼저 지웠다
    }
  }
  return true
}

// 마지막 사용자 입력 시각(epoch ms). 기록이 없거나 읽지 못하면 null
export function lastInput(terminal: string | null | undefined): number | null {
  if (!terminal || !HANDLE.test(terminal)) return null
  try {
    const at = (JSON.parse(readFileSync(join(inputDir(), `${terminal}.json`), 'utf8')) as { at?: unknown }).at
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

// 머리 주석의 「대화 중」. ago 는 마지막 입력 뒤 지난 초(기록이 없으면 null)다
export function userActive(terminal: string | null | undefined, now = Date.now()): { active: boolean; ago: number | null } {
  const at = lastInput(terminal)
  if (at === null) return { active: false, ago: null }
  const ago = Math.max(0, Math.floor((now - at) / 1000))
  return { active: now - at < activeMs(), ago }
}
