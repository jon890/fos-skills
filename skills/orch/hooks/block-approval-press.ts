// PreToolUse(Bash) hook: 보드 창 전용 스크립트 `approvals.ts press` 를 Bash 도구로 부르는 호출을 거부한다.
//
// 승인 기록은 사람이 보드 창에서 누른 버튼만 쓴다(docs/features/board-approval/spec.md REQ4).
// 이 hook 이 없으면 코디네이터가 한 줄로 스스로 승인할 수 있다. 창의 $.process.run 은 Bash 도구를 거치지 않아 막히지 않는다.
//
// 판정: `approvals.ts press`(파일 이름 뒤 따옴표 하나는 허용, `node "$ROOT/bin/approvals.ts" press ...`)가 있고 그 `press` 가
//     따옴표 안, heredoc 본문, 주석이 아니면 거부한다. 파일 이름은 따옴표 안이어도 된다. 경로를 따옴표로 감싸는 호출이 흔하기 때문이다.
//     `lib/approvals.ts` 를 여는 명령(`grep press lib/approvals.ts`), 커밋 메시지에 든 같은 글, `approvals.ts where` 는 통과한다.
// 막지 못하는 것: 스크립트 파일 안에서 부르는 것, 다른 이름의 사본, 변수로 조립한 호출. 설계의 「막지 못함」 이다.
//
// 입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.

import { hookCommand, mask, stripHeredocs } from './shell-text.ts'

const PRESS = /approvals\.ts["']?\s+(press)(?![\w-])/g

const REASON =
  'orch: 보드 창 전용 스크립트 `approvals.ts press` 를 Bash 도구로 부르지 않는다. ' +
  '승인과 고쳐 달라 기록은 사람이 보드 창에서 누른 버튼만 쓴다. ' +
  '승인이 필요하면 `orch board approval add` 로 올리고 사용자가 보드에서 누르게 한다.'

function callsPress(command: string): boolean {
  const text = stripHeredocs(command)
  const masked = mask(text)
  for (const m of text.matchAll(PRESS)) {
    const at = m.index + m[0].length - m[1].length
    if (masked.slice(at, at + m[1].length) === m[1]) return true
  }
  return false
}

const command = hookCommand()
if (command !== null && callsPress(command)) {
  const decision = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + '\n')
}
