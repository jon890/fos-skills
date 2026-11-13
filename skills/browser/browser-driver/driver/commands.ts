// 명령 스펙과 도움말. `help` 출력이 명령 목록의 단일 소스다.

import { WAIT_TIMEOUT_DEFAULT } from './config.ts'

export type Command = { name: string; args: string[]; summary: string; returns?: string; note?: string }

// 대괄호로 감싸지 않은 인자의 개수
export const required = (c: Command): number => c.args.filter((a) => !a.startsWith('[')).length

export const usage = (c: Command): string => [c.name, ...c.args].join(' ')

export const COMMANDS: Command[] = [
  { name: "open", args: ["<url>", "[ready_timeout_ms]"], summary: "탭을 열고 로드가 끝날 때까지 기다린다", returns: "핸들 한 줄. 이후 모든 명령의 첫 인자로 넘긴다", note: "탭이 열린 자리를 stderr 에 한 줄 더 알린다. orca 는 워크트리, ego 는 프로필과 공간이다.\n$( ) 로 받으면 핸들만 들어온다.\n2>&1 로 받지 않는다. 그 줄이 핸들에 섞여 다음 명령이 탭을 찾지 못한다" },
  { name: "nav", args: ["<handle>", "<url>", "[ready_timeout_ms]"], summary: "이미 열린 탭을 다른 주소로 보낸다" },
  { name: "js", args: ["<handle>", "<expression>", "[--timeout <ms>]"], summary: "JS 표현식을 실행한다", returns: "표현식의 값", note: "숨은 요소나 겹침 화면은 이 명령으로 조작한다.\n인자는 작은따옴표로 감싼다. 큰따옴표는 셸이 $( 를 명령 치환으로 먹는다.\nego 는 `a; b` 처럼 문장이 여럿이면 마지막 문장의 값을 낸다. 이때 await 는 쓸 수 없다.\nego 는 기본으로 15초 안에 끝나지 않는 표현식을 실패로 끝낸다. 더 걸리는 비동기\n표현식은 --timeout 에 밀리초를 줘 그 시간까지 기다린다" },
  { name: "jsfile", args: ["<handle>", "<path>", "[--timeout <ms>]"], summary: "파일의 내용을 js 와 같은 방식으로 실행한다", returns: "js 와 같다", note: "셸 인용이 길어지는 여러 줄 스크립트에 쓴다" },
  { name: "click", args: ["<handle>", "<x>", "<y>", "[--button left|middle|right]"], summary: "CSS 픽셀 좌표를 실제 마우스 입력으로 누른다", note: "js 의 합성 이벤트로는 setPointerCapture 가 실패하고 자동 재생이 막힌다. 그때 쓴다.\n좌표는 뷰포트 기준이다. shot 으로 확인한 좌표를 넘긴다" },
  { name: "drag", args: ["<handle>", "<x1>", "<y1>", "<x2>", "<y2>", "[--button left|middle|right]"], summary: "한 좌표에서 눌러 다른 좌표까지 끌고 놓는다" },
  { name: "hover", args: ["<handle>", "<x>", "<y>"], summary: "마우스 포인터를 그 좌표로 옮긴다" },
  { name: "waitjs", args: ["<handle>", "<condition>", "[timeout_ms]"], summary: "JS 조건이 참이 될 때까지 기다린다", note: `고정 대기 대신 이것을 쓴다. 기본 제한 시간 ${WAIT_TIMEOUT_DEFAULT}ms` },
  { name: "ready", args: ["<handle>", "[timeout_ms]"], summary: "document.readyState 가 complete 가 될 때까지 기다린다" },
  { name: "url", args: ["<handle>"], summary: "지금 보고 있는 주소를 낸다", returns: "지금 보고 있는 주소", note: "조회 결과가 비면 먼저 이것으로 로그인 화면으로 튕겼는지 본다" },
  { name: "snap", args: ["<handle>"], summary: "화면의 접근성 트리를 낸다", returns: "화면의 접근성 트리" },
  { name: "shot", args: ["<handle>", "[path]", "[--size WxH]"], summary: "화면을 이미지 파일로 저장한다", returns: "저장한 경로", note: "--size 1280x800 처럼 주면 찍기 전에 뷰포트(CSS 픽셀)를 그 크기로 바꾼다. orca 백엔드만 지원하고\n나머지는 종료 코드 2 로 거절한다. 바꾼 크기는 그 탭에 남아 뒤 촬영도 같은 크기다" },
  { name: "console", args: ["<handle>"], summary: "콘솔 로그를 낸다", returns: "콘솔 로그 JSON" },
  { name: "errors", args: ["<handle>"], summary: "페이지 오류를 낸다", returns: "페이지 오류 JSON" },
  { name: "worktree", args: ["<handle>"], summary: "탭이 붙어 있는 워크트리 경로를 낸다", returns: "탭이 붙어 있는 워크트리 경로", note: "orca 백엔드 전용. 사람이 볼 화면은 ORCA_WORKTREE 로 워크트리를 고정하고\n갱신하기 전에 이것으로 기대한 곳의 탭인지 확인한다" },
  { name: "close", args: ["<handle>"], summary: "탭을 닫는다" },
  { name: "pages", args: ["[profile]"], summary: "그 프로필의 공간에 열려 있는 탭을 핸들과 함께 낸다", returns: "`<핸들><TAB><openedBy><TAB><주소>` 한 줄씩. 열린 탭이 없으면 아무것도 내지 않는다", note: "핸들은 open 이 내는 것과 같은 형식이라 close, nav, js 에 그대로 넘긴다.\npage 수가 한도에 차서 open 이 막히면 이것으로 무엇을 닫을지 고른다.\nopenedBy 가 agent 인 줄이 reset 이 닫을 대상이다" },
  { name: "spaces", args: ["[prefix]"], summary: "에이전트가 가진 공간을 id, 이름, 탭 수로 낸다", returns: "`<id><TAB><이름><TAB><탭 수>` 한 줄씩. 없으면 아무것도 내지 않는다", note: "작업이 끝났는데 남은 공간을 찾을 때 쓴다. 접두를 주면 그 이름으로 시작하는 공간만 낸다.\n사용자가 제어권을 가져간 공간은 목록에 나오지 않고, reset 도 그 공간을 닫지 않는다.\n찾은 공간은 reset --space-id <id> 로 하나씩 닫는다" },
  { name: "reset", args: ["[profile]", "[--space-id <id>]"], summary: "에이전트가 연 탭을 닫고 그 공간까지 닫는다", returns: "닫은 탭을 `<핸들><TAB><주소>` 한 줄씩. 공간을 닫았는지 남겼는지는 stderr 로 알린다", note: "BROWSER_EGO_SPACE 로 이름 준 공간에서만 돈다. 기본 공간이면 아무것도 닫지 않고 종료 코드 2 로 거절한다.\n--space-id 는 spaces 가 낸 id 의 공간을 이름과 무관하게 닫는다. 기본 공간과\n에이전트가 가지지 않은 공간은 id 로도 닫지 않고 종료 코드 2 로 거절한다.\n사용자가 직접 연 탭과 ego 가 소유를 판정하지 못한 탭은 남고, 그러면 공간도 남는다.\n남아도 종료 코드는 0 이다. 어느 쪽인지는 stderr 의 마지막 줄로 본다.\n에이전트가 열어 사람이 이어서 쓰고 있는 탭은 닫힌다. openedBy 로는 둘을 구분하지 못한다.\n무엇이 닫힐지는 pages 의 openedBy 열로 먼저 본다" },
]

export const META_COMMANDS: Command[] = [
  { name: "driver", args: [], summary: "지금 고른 백엔드 이름을 낸다" },
  { name: "doctor", args: [], summary: "백엔드 감지 결과와 준비 상태를 판정해 낸다" },
  { name: "config-path", args: [], summary: "설정 파일 경로를 한 줄로 낸다. 파일이 없어도 경로를 낸다" },
  { name: "help", args: [], summary: "이 도움말을 낸다" },
  { name: "install", args: ["[--dst <dir>]"], summary: "~/.claude/scripts/ 에 심볼릭 링크를 만든다" },
]

export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]))

// 명령별 서술을 `이름: 내용` 줄로 낸다. 값이 빈 명령은 건너뛴다.
//
// 반환값과 함정 절을 손으로 적으면 명령을 더할 때마다 두 곳을 고쳐야 하고,
// 한쪽만 고치면 도움말이 실제와 어긋난다.
function detail(field: 'returns' | 'note'): string[] {
  const out: string[] = []
  for (const c of COMMANDS) {
    const text = c[field]
    if (!text) continue
    const [head, ...rest] = text.split('\n')
    out.push(`  ${c.name}: ${head}`)
    out.push(...rest.map((r) => `    ${r}`))
  }
  return out
}

export function renderHelp(backendName: string | null = null, unsupported: ReadonlySet<string> = new Set()): string {
  const lines = [
    '브라우저 자동화 드라이버. 백엔드가 달라도 아래 명령은 같다.',
    '',
    '  B=~/.claude/scripts/browser-driver',
    '  PAGE=$($B open "https://example.com")',
    '  $B js "$PAGE" \'document.title\'',
    '',
    '명령',
  ]
  const width = Math.max(...[...COMMANDS, ...META_COMMANDS].map((c) => usage(c).length)) + 2
  for (const c of COMMANDS) {
    const mark = unsupported.has(c.name) ? '  (이 백엔드는 못 씀)' : ''
    lines.push(`  ${usage(c).padEnd(width)}${c.summary}${mark}`)
  }
  lines.push('')
  for (const c of META_COMMANDS) lines.push(`  ${usage(c).padEnd(width)}${c.summary}`)
  lines.push('', '반환값', '  아래 값을 stdout 으로 낸다. 적히지 않은 명령은 성공하면 아무것도 내지 않는다.')
  lines.push(...detail('returns'))
  lines.push('', '함정')
  lines.push(...detail('note'))
  lines.push(
    '',
    '종료 코드는 0 성공, 1 조작 실패, 2 잘못된 호출이나 환경 문제.',
    'ego 의 BROWSER_EGO_SPACE 는 open, pages, reset 이 쓸 공간의 기준 이름을 정한다. reset 은 이 이름이나 --space-id 가 있어야 돈다.',
    '공간을 나눠도 로그인 세션의 경계는 기존 프로필이다.',
    '백엔드별 상세는 README.md, 환경 진단은 doctor 를 본다.',
  )
  if (backendName) lines.push('', `지금 잡힌 백엔드: ${backendName}`)
  return lines.join('\n')
}
