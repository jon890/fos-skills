// 지시서의 `번호 예약:` 줄 읽기와, launch-worker 가 잡은 번호를 지시서에 적는 블록의 한 벌이다.
//
// 요청 줄: `번호 예약: <종류> <모듈> <이름>`. 종류는 sql, java, adr 이다(orch queue reserve 의 --kind). 모듈은 migrations.dirs,
//   migrations.watch, adr.dirs 의 이름이고 이름은 영문 설명이다(띄어 써도 된다). 목록 기호(-, *)와 굵은 글씨를 받는다. 줄마다 하나다.
//   종류가 셋 밖이거나 모듈·이름이 없으면 그 줄은 problems 에 든다. launch-worker 가 사용법 오류로 멈춘다.
//
// 블록: 마지막 요청 줄 바로 뒤에 둔다. BLOCK_START 와 BLOCK_END 사이를 다시 띄울 때마다 새로 쓴다(지시서에 하나만 둔다).
//   줄마다 `- <종류> <모듈> <이름>: <label> \`<경로>\`` 다. worker 는 그 경로로 파일을 만들고 스스로 번호를 고르지 않는다(templates/spec-common.md).
//
// 지시서에 적고 첫 메시지로 주지 않는 이유: 지시서는 worker 가 다시 뜨거나(--task, 충돌 후속) 맥락이 줄어도 다시 읽는다.
//   첫 메시지는 첫 세션에만 닿는다. 예약은 같은 (브랜치, 모듈, 이름) 이면 다시 불러도 같은 번호를 준다(reused).

export type ReserveKind = 'sql' | 'java' | 'adr'
export type ReserveRequest = { kind: ReserveKind; module: string; name: string }
export type Reserved = ReserveRequest & { label: string; path: string }

export const BLOCK_START = '<!-- orch-reserved: launch-worker 가 잡은 번호다. 손으로 고치지 않는다 -->'
export const BLOCK_END = '<!-- /orch-reserved -->'
const REQUEST = /^\s*(?:[-*]\s+)?(?:\*\*)?번호 예약(?:\*\*)?:(?:\*\*)?\s*(.*)$/
const KINDS: readonly string[] = ['sql', 'java', 'adr']

export function reserveRequestsOf(text: string): { requests: ReserveRequest[]; problems: string[] } {
  const requests: ReserveRequest[] = []
  const problems: string[] = []
  for (const line of blockless(text).split('\n')) {
    const m = REQUEST.exec(line)
    if (!m) continue
    const [kind, module, ...rest] = m[1].replace(/`/g, '').trim().split(/\s+/)
    const name = rest.join(' ')
    if (!KINDS.includes(kind) || !module || !name) {
      problems.push(`번호 예약 줄은 \`번호 예약: <sql|java|adr> <모듈> <이름>\` 꼴이다: ${line.trim()}`)
      continue
    }
    requests.push({ kind: kind as ReserveKind, module, name })
  }
  return { requests, problems }
}

// orch queue reserve 의 출력에서 RESERVED 줄을 읽는다. 없으면 null
export function reservedLine(stdout: string): { label: string; path: string } | null {
  const m = /^RESERVED \S+ (\S+) (\S+)(?: reused| renewed)?$/m.exec(stdout)
  return m ? { label: m[1], path: m[2] } : null
}

function blockless(text: string): string {
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start < 0 || end < start) return text
  const after = text.slice(end + BLOCK_END.length).replace(/^\n/, '')
  return text.slice(0, start) + after
}

// 옛 블록을 지우고 마지막 요청 줄 뒤에 새 블록을 둔다. reserved 가 비면 블록 없이 낸다. 요청 줄이 없으면 text 그대로다
export function withReservedBlock(text: string, reserved: readonly Reserved[]): string {
  const lines = blockless(text).split('\n')
  let last = -1
  lines.forEach((line, i) => {
    if (REQUEST.test(line)) last = i
  })
  if (last < 0 || reserved.length === 0) return lines.join('\n')
  const block = [
    BLOCK_START,
    '잡아 준 번호(이 경로로 만들고 스스로 고르지 않는다):',
    ...reserved.map((r) => `- ${r.kind} ${r.module} ${r.name}: ${r.label} \`${r.path}\``),
    BLOCK_END,
  ]
  lines.splice(last + 1, 0, ...block)
  return lines.join('\n')
}
