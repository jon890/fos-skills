// PreToolUse(Bash) hook: `cd X;` 나 줄바꿈 뒤에 오는 git 쓰기 명령을 거부하고 `&&` 나 `git -C` 를 요구한다.
//
// `cd` 가 실패해도 `;` 와 줄바꿈 뒤 명령은 돈다. 그러면 git 쓰기가 엉뚱한 체크아웃에서 돈다.
// 워크트리 만들기가 실패해 `cd` 가 실패했는데, 다음 줄의 `git merge` 가 메인 체크아웃에서 돈 일이 있었다(2026-10-21).
//
// 판정:
//     git 쓰기 명령은 `git [-c 키=값 ...] merge|commit|push|reset|rebase` 다(`merge-base` 같은 읽기 명령은 아니다).
//     `git -C 경로 ...` 는 cd 와 무관해 통과한다.
//     명령을 `;`, 줄바꿈, `&&`, `||`, `|`, `&` 로 나눠 차례로 본다. `cd`(또는 `pushd`)를 만난 뒤 git 쓰기까지 사이의 연결이 모두 `&&` 면 통과한다.
//     사이에 `;`, 줄바꿈, `||`, `&` 가 하나라도 있으면 거부한다.
//
// 오탐을 피하는 기준:
//     - 따옴표 안, heredoc 본문, 주석은 보지 않는다. 커밋 메시지에 든 `cd x;` 나 `git push` 문구는 명령이 아니다
//     - `2>&1`, `&>`, `>&2` 의 `&` 는 리다이렉션이라 연결자가 아니다
//     - `&&`, `||`, `|` 뒤 줄바꿈은 이어 쓰기라 같은 명령으로 본다
//     - `cd X || exit`, `cd X || return`, `cd X || { ...; exit 1; }` 는 실패하면 멈추므로 안전한 cd 로 본다
//     - cd 앞에 `set -e` 나 `set -o errexit` 가 있으면 cd 실패에서 멈추므로 그 뒤 cd 는 안전하다
//     - 괄호 subshell 과 `$(...)` 안의 cd 는 바깥 cwd 를 바꾸지 않는다. 그 안은 따로 판정하고 바깥에서는 지운다
//     - cd 없이 쓰는 git 쓰기는 Bash 도구의 cwd 에서 돈다. 이 hook 은 보지 않는다
//
// 입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
// hooks.json 은 이 파일을 PATH 의 `node` 로 부른다. node 를 찾지 못하면 Claude Code 는 오류를 보이고 막지 않는다.

import { hookCommand, mask, pieces, stripHeredocs } from './shell-text.ts'

const GIT_WRITE = /(?:^|[\s(])git\s+(?:-c\s+\S+\s+)*(?:merge|commit|push|reset|rebase)(?![\w-])/
const CD = /^\s*(?:(?:do|then|else)\s+)?(?:cd|pushd)(?:\s|$)/
const GUARD = /^\s*(?:exit|return)\b/
const ERREXIT = /^\s*set\s+(?:-[a-zA-Z]*e[a-zA-Z]*|-o\s+errexit)\b/
// `|| { echo 실패; exit 1; }` 는 `|| exit` 와 같다
const BRACE_GUARD = /\|\|\s*\{[^{}]*\b(?:exit|return)\b[^{}]*\}/g
const SUBSHELL = /\$?\(([^()]*)\)/

const REASON =
  'orch: `cd X;` 나 줄바꿈 뒤에 git 쓰기 명령(merge, commit, push, reset, rebase)을 두지 않는다. ' +
  'cd 가 실패해도 다음 명령이 돌아 다른 체크아웃에 쓴다. ' +
  '`cd X && git ...` 로 잇거나 `git -C X ...` 로 쓴다.'

// 괄호가 없는 가린 글 한 덩어리를 판정한다.
function unsafeFlat(input: string): boolean {
  const text = input.replace(BRACE_GUARD, '|| exit')
  let afterCd = false
  let unsafe = false
  let errexit = false
  for (const { join, start, end } of pieces(text)) {
    const segment = text.slice(start, end)
    if (afterCd && join === '||' && GUARD.test(segment) && !unsafe) {
      // `cd X || exit` 뒤에는 cd 가 성공했거나 이미 멈췄다
      afterCd = false
      continue
    }
    if (afterCd && join !== null && join !== '&&') unsafe = true
    if (ERREXIT.test(segment)) errexit = true
    if (CD.test(segment)) {
      afterCd = !errexit
      unsafe = false
      continue
    }
    if (afterCd && unsafe && GIT_WRITE.test(segment)) return true
  }
  return false
}

function unsafeGitAfterCd(command: string): boolean {
  let text = mask(stripHeredocs(command))
  // 안쪽 괄호부터 따로 판정한다. 바깥에서는 그 안의 cd 를 지우고 git 쓰기가 있었다는 것만 남긴다
  for (let m = SUBSHELL.exec(text); m; m = SUBSHELL.exec(text)) {
    if (unsafeFlat(m[1])) return true
    const standIn = GIT_WRITE.test(' ' + m[1]) ? 'git commit' : 'true'
    text = text.slice(0, m.index) + standIn + text.slice(m.index + m[0].length)
  }
  return unsafeFlat(text)
}

const command = hookCommand()
if (command !== null && unsafeGitAfterCd(command)) {
  const decision = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }) + '\n')
}
