// worker 터미널 화면의 판정 한 벌이다. 화면 문자열의 마지막 줄들로 에이전트가 무엇을 기다리는지 정한다.
// 사용처: nudge-worker.ts(입력할지 정하기와 --state, --classify), orch-loop.ts(멈춘 worker 찾기).
//
// 화면 상태:
//     working     작업 중이다. Claude 의 「✳ Thinking… (」 줄, Codex 의 「• Working (」 줄, 「esc to interrupt」
//     error       입력란이 비었고, 입력란 바로 위 마지막 메시지 묶음에 오류 줄이 있다. 모델 용량 초과나 API 오류로 멈춘 화면이다
//     interrupted 입력란이 비었고, 마지막 메시지 묶음에 사람이 Esc 로 끊은 표시(아래 「끊김 줄」)가 있다. 사람이 일부러 멈춘 작업이라 멈춤으로 세지 않는다
//     idle        입력란이 비어 있다. Claude 의 「❯」 만 있는 줄, Codex 의 「›」 줄이 비었거나 기본 안내 문구다
//     draft       입력란에 누가 쓰다 만 글이 있다. 덧붙여 보내면 그 글과 섞인다
//     permission  권한 확인 창에서 기다린다. 코디네이터가 대신 고르지 않는다
//     unknown     어느 것도 아니다
//     판정 순서는 permission, working, 입력란이다. 자동 재시도 중인 오류 화면은 「esc to interrupt」 가 있어 working 이다.
//     입력란이 비었으면 끊김 줄, 오류 줄 순서로 본다. 끊김 줄도 「■ 」 로 시작해 오류 줄의 꼴과 겹치기 때문이다.
//
// 마지막 메시지 묶음: 입력란 줄 위로 올라가며 테두리 줄과 상태 줄(✻, ※ 따위)을 건너뛰고, 묶음 시작 줄
//     (Claude 의 ⏺, ●, 지난 입력 ❯, >. Codex 의 •, ■, 지난 입력 ›)까지 모은 줄이다. 최대 BLOCK_LIMIT 줄이다.
//     오류 뒤에 사람이 「계속」 을 쳐서 답이 나왔으면 그 답이 마지막 묶음이라 error 가 아니라 idle 이다.
//     입력란 아래의 상태 줄(경과 시간, 컨텍스트 사용량, 단축키 안내)은 묶음에 들지 않는다. 그 줄은 틱마다 바뀐다.
//
// 오류 줄: 에이전트가 오류를 그리는 공통 형식만 둔다. 문구마다 다른 안내(요청 한도 같은 것)는 넣지 않는다.
//     Codex   「■ 」 로 시작하는 줄. Codex 0.164 의 history_cell 이 오류를 이 꼴로 그린다(「■ Selected model is at capacity…」)
//     Claude  「⎿」 뒤에 「API Error:」 나 「API Error (」 가 오는 줄. 「⏺」, 「●」 로 시작하거나 접두가 없는 줄은 답 본문이라
//             「API Error」 로 시작해도 오류 줄이 아니다
//     그 밖의 멈춤은 idle 로 남는다. 저장소의 worker-stalled 핸들러가 입력의 lines 로 직접 판정한다.
//
// 끊김 줄: Codex 의 「■ Conversation interrupted」 로 시작하는 줄. Codex 0.164 는 Esc 로 끊긴 턴을
//     「■ Conversation interrupted - use /feedback if something went wrong」 로 그린다
//     (codex-rs/tui/src/chatwidget/input_restore.rs 의 on_interrupted_turn, rust-v0.164.0).
//
// 멈춤 해시(stallHash): 마지막 메시지 묶음과, 입력란 위 화면에 있는 오류 줄의 수로 만든다. Codex 의 오류 묶음은 「■ 」 한 줄뿐이라,
//     이어 가게 한 worker 가 같은 오류로 다시 끝나면 묶음이 앞과 같다. 그때 화면에 오류 줄이 하나 늘어 해시가 바뀐다.
//     앞 오류 줄이 화면 위로 밀려나 같은 수로 보이면 같은 멈춤으로 센다. 화면이 그만큼 바뀌는 동안 작업 중 화면을 보는 일이 많아 드물다.

import { createHash } from 'node:crypto'

export type ScreenState = 'working' | 'error' | 'interrupted' | 'idle' | 'draft' | 'permission' | 'unknown'
// errors 는 입력란 위 화면의 오류 줄 수다. 입력란이 없으면 0 이다
export type Screen = { state: ScreenState; block: string[]; errors: number }

// 상태 줄과 입력란은 화면 아래에 있다. 위쪽 대화 기록의 「›」 와 「❯」 는 보지 않는다
const BOTTOM = 12
// 마지막 메시지 묶음으로 모을 최대 줄 수. 줄바꿈된 긴 오류(JSON 본문)도 첫 줄까지 닿게 BOTTOM 보다 넉넉하다
const BLOCK_LIMIT = 40

const PERMISSION = /Do you want to (proceed|make this edit|create)|Would you like to (run|make|apply)|Allow command\?/u
const WORKING = /esc to interrupt|^\s*• Working \(|^\S\s+[A-Z][a-z]+…/u
const CLAUDE_INPUT = /^\s*❯(?:\s(.*))?$/u
const CODEX_INPUT = /^\s*›(?:\s(.*))?$/u
// Codex 는 빈 입력란에 안내 문구를 흐리게 보여 준다. 화면 문자열로는 입력한 글과 구분되지 않아 알려진 문구만 빈 것으로 본다
const CODEX_PLACEHOLDERS = new Set([
  'Ask Codex to do anything',
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
])
const ERROR = /^\s*■\s|^\s*⎿\s*API Error(?::|\s*\()/u
const INTERRUPTED = /^\s*■\s+Conversation interrupted\b/u
const BLOCK_START = /^\s*(?:[⏺●•■]|[❯›>](?:\s|$))/u
const DECORATION = /^[\s─━═│┃╭╮╰╯┌┐└┘├┤▔▁-]*$/u
const STATUS = /^\s*[✻✳✶✢✽※]/u
// Python 의 str.splitlines 와 같은 줄 경계다. 화면 문자열에 \r 이나 \u2028 이 섞여도 같은 줄로 나눈다
export const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u

// `orca terminal read --screen` 의 result 에서 화면 줄. tail 이 목록이 아니면 문자열로 보고 나눈다
export function screenLines(result: Record<string, unknown>): string[] {
  const tail = ((result.terminal as { tail?: unknown }) || {}).tail || []
  return Array.isArray(tail) ? tail.map(String) : String(tail).split(LINE_BREAK)
}

// 빈 줄을 뺀 화면의 끝 줄들. 줄 끝 공백을 지운다. 핸들러 입력의 lines 가 이 값이다
export function screenTail(lines: string[], limit = BLOCK_LIMIT): string[] {
  return lines
    .filter((line) => line.trim())
    .map((line) => line.trimEnd())
    .slice(-limit)
}

function isError(line: string): boolean {
  return ERROR.test(line) && !INTERRUPTED.test(line)
}

function lastBlock(lines: string[], input: number): string[] {
  const block: string[] = []
  for (let i = input - 1; i >= 0 && input - i <= BLOCK_LIMIT; i--) {
    const line = lines[i]
    if (DECORATION.test(line) || STATUS.test(line)) continue
    block.push(line)
    if (BLOCK_START.test(line)) break
  }
  return block.reverse()
}

// 머리 주석의 「화면 상태」 와 「마지막 메시지 묶음」. block 과 errors 는 입력란이 있을 때만 채운다
export function readScreen(raw: string[]): Screen {
  const lines = screenTail(raw, Number.POSITIVE_INFINITY)
  const tail = lines.slice(-BOTTOM)
  if (tail.some((line) => PERMISSION.test(line))) return { state: 'permission', block: [], errors: 0 }
  if (tail.some((line) => WORKING.test(line))) return { state: 'working', block: [], errors: 0 }
  for (let i = lines.length - 1; i >= lines.length - tail.length; i--) {
    const line = lines[i]
    const claude = CLAUDE_INPUT.exec(line)
    const codex = claude ? null : CODEX_INPUT.exec(line)
    if (!claude && !codex) continue
    const block = lastBlock(lines, i)
    const errors = lines.slice(0, i).filter(isError).length
    // 선택 창의 「❯ 1. Yes」 는 위에서 권한 확인으로 판정했다. 남은 「❯ 글」 은 입력란의 글이다
    const text = ((claude ?? codex)?.[1] ?? '').trim()
    const empty = claude ? !text : !text || CODEX_PLACEHOLDERS.has(text)
    if (!empty) return { state: 'draft', block, errors }
    if (block.some((row) => INTERRUPTED.test(row))) return { state: 'interrupted', block, errors }
    return { state: block.some(isError) ? 'error' : 'idle', block, errors }
  }
  return { state: 'unknown', block: [], errors: 0 }
}

export function classify(lines: string[]): ScreenState {
  return readScreen(lines).state
}

// 머리 주석의 「멈춤 해시」. 입력란 아래의 상태 줄이 바뀌어도 같다. 같은 멈춤이 이어지는지 보는 데 쓴다(orch-loop.ts 의 「멈춤 확인」)
export function stallHash(screen: Screen): string {
  return createHash('sha256').update(`${screen.errors}\n${screen.block.join('\n')}`).digest('hex').slice(0, 16)
}
