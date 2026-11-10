// 짧은 출력(진입점의 orch cleanup sweep, 머지 큐가 이어 준 신호, lib/output.ts):
//     지운 것은 REMOVED <대상>, dry-run 의 지울 것은 WOULD-REMOVE <대상>, 남긴 것은 KEPT <대상> <이유>, 실패는 FAILED <대상> [<이유>] 이다.
//     대상은 워크트리 경로, branch:<브랜치>, remote:<브랜치>, terminal:<터미널>, dispatch:<id>, 지시서 경로 같은 것이다.
//     기준 브랜치 fast-forward 는 UPDATED base:<브랜치>(dry-run 은 WOULD-UPDATE) 다. FINISH-MISSING 같은 판정 줄은 그대로다.
//     끝 줄은 SWEEP <지운 수> <남긴 수>, dry-run 은 SWEEP-DRY <지울 수> <남길 수> 다. 줄 규칙은 sweepLine 이 소유한다


// 짧은 출력(진입점의 orch cleanup sweep, 머지 큐가 이어 준 신호, lib/output.ts)의 줄 하나. 머리 주석의 「짧은 출력」 이다.
// ctx.path 는 마지막 `정리 <경로>` 줄의 워크트리다. 그 뒤의 `건너뜀:`, `거부:`, 지울 것 줄이 이 경로를 쓴다.
// 남김 줄, 실패 줄, 지움 줄 차례로 본다. `원격 브랜치 삭제 실패 b: e` 가 REMOVED 로, `남김 x: 조회 실패` 가 FAILED 로 읽히지 않게 한다
import { dockerShortLine } from '../../lib/docker.ts'
import { isVerdict } from '../../lib/output.ts'

export type SweepContext = { path: string | null }

const SWEEP_RULES: [RegExp, (m: RegExpExecArray, ctx: SweepContext) => string | null][] = [
  [/^정리 (\S+) \(/, (m, ctx) => ((ctx.path = m[1]), null)],
  // 남긴 것. 이유에 「실패」 가 들어도 남김이라 실패 규칙보다 먼저 본다
  [/^건너뜀 (?:리뷰 워크트리|브랜치) (\S+)(?: \(#\d+\))?: (.*)/, (m) => `KEPT ${m[1]} ${m[2]}`],
  [/^(?:원격 브랜치|리뷰 브랜치|브랜치) 남김 (\S+): (.*)/, (m) => `KEPT branch:${m[1]} ${m[2]}`],
  [/^리뷰 흔적 남김 (#\d+): (.*)/, (m) => `KEPT review:${m[1]} ${m[2]}`],
  [/^(?:지시서를|PR 본문을) 남긴다 (\S+): (.*)/, (m) => `KEPT ${m[1]} ${m[2]}`],
  [/^지시서 남김: (.*)/, (m) => `KEPT specs ${m[1]}`],
  [/^건너뜀 detached (\S+): (.*)/, (m) => `KEPT ${m[1]} ${m[2]}`],
  [/^건너뜀: (.*?)\. 다음 실행에서/, (m, ctx) => `KEPT ${ctx.path ?? '-'} ${m[1]}`],
  // remove-worktree 의 거부 줄은 대개 경로로 시작한다. 경로를 두 번 내지 않는다
  [/^거부: (.*)/, (m, ctx) => (ctx.path && m[1].startsWith(ctx.path) ? `KEPT ${m[1]}` : `KEPT ${ctx.path ?? '-'} ${m[1]}`)],
  [/^없음: (\S+)/, (m) => `KEPT ${m[1]} 없음`],
  [/^git worktree 가 아니다: (\S+)/, (m) => `KEPT ${m[1]} git worktree 가 아니다`],
  [/^남김: (.*?) \((\S+)\)(?:\. 근거: (.*))?$/, (m) => `KEPT ${m[2]} ${m[1]}${m[3] ? ` 근거: ${m[3]}` : ''}`],
  [/^남김 (\S+): (.*)/, (m) => `KEPT ${m[1]} ${m[2]}`],
  [/^건너뜀 (\S+): (.*)/, (m) => `KEPT ${m[1]} ${m[2]}`],
  [/^원격 브랜치 정리 건너뜀: (.*)/, (m) => `KEPT remote ${m[1]}`],
  [/^기준 브랜치를 맞추지 않는다: (.*)/, (m) => `KEPT base ${m[1]}`],
  [/닫기 실패:? (\S+)(?: (.*))?$/, (m) => `FAILED terminal:${m[1]}${m[2] ? ` ${m[2]}` : ''}`],
  [/^dispatch release 실패 (\S+)/, (m) => `FAILED dispatch:${m[1]}`],
  [/^.*? 실패 ([^\s:]+)(?::? (.*))?$/, (m) => `FAILED ${m[1]}${m[2] ? ` ${m[2]}` : ''}`],
  // 지운 것
  [/^(?:removed|리뷰 워크트리 삭제|detached 워크트리 삭제) (\S+)/, (m) => `REMOVED ${m[1]}`],
  [/^(?:deleted branch|브랜치 삭제|리뷰 브랜치 삭제) (\S+)/, (m) => `REMOVED branch:${m[1]}`],
  [/^원격 브랜치 삭제 (\S+)/, (m) => `REMOVED remote:${m[1]}`],
  [/(?:^|\s)닫음 (\S+)/, (m) => `REMOVED terminal:${m[1]}`],
  [/^빈 셸을 닫았다: (\S+)/, (m) => `REMOVED terminal:${m[1]}`],
  [/^dispatch release (\S+)/, (m) => `REMOVED dispatch:${m[1]}`],
  [/^(?:지시서|PR 본문) (?:삭제|옮김) (\S+)/, (m) => `REMOVED ${m[1]}`],
  [/^기준 브랜치 fast-forward (\S+)/, (m) => `UPDATED base:${m[1]}`],
  // 지울 것(dry-run)
  [/^worktree 와 로컬 브랜치를 지울 것 (\S+)/, (m, ctx) => `WOULD-REMOVE ${ctx.path ?? `branch:${m[1]}`}`],
  [/^(?:리뷰 워크트리|detached 워크트리)를 지울 것 (\S+)/, (m) => `WOULD-REMOVE ${m[1]}`],
  [/^(?:리뷰 브랜치|브랜치)를 지울 것 (\S+)/, (m) => `WOULD-REMOVE branch:${m[1]}`],
  [/^원격 브랜치를 지울 것 (\S+)/, (m) => `WOULD-REMOVE remote:${m[1]}`],
  [/닫을 것:? (\S+)/, (m) => `WOULD-REMOVE terminal:${m[1]}`],
  [/^dispatch 를 release 할 것 (\S+)/, (m) => `WOULD-REMOVE dispatch:${m[1]}`],
  [/^(?:지시서를|PR 본문을) (?:지울 것|휴지통으로 옮길 것) (\S+)/, (m) => `WOULD-REMOVE ${m[1]}`],
  [/^기준 브랜치를 fast-forward 할 것 (\S+)/, (m) => `WOULD-UPDATE base:${m[1]}`],
]

export function sweepLine(line: string, ctx: SweepContext): string | null {
  const text = line.trim()
  const docker = dockerShortLine(text)
  if (docker !== undefined) return docker
  for (const [pattern, make] of SWEEP_RULES) {
    const m = pattern.exec(text)
    if (m) return make(m, ctx)
  }
  return isVerdict(text) ? text : null
}
