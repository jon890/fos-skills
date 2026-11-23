export type BoardItem = Record<string, unknown> & { id: string }

// 보드 항목의 pr 칸(`#492`, `492, 495`, `492/495`)에 든 PR 번호들. 글자에 붙은 숫자(`#492 (v2)` 의 `2`)는 읽지 않는다.
// 옮기기 전 Python 의 \w 가 한글도 글자로 보았으므로 유니코드 글자와 숫자를 글자로 센다
export function prNumbers(field: unknown): Set<string> {
  const text = !field ? '' : typeof field === 'string' ? field : JSON.stringify(field)
  return new Set([...text.matchAll(/(?<![\p{L}\p{N}_])#?(\d+)(?![\p{L}\p{N}_])/gu)].map((m) => m[1]))
}

// 중간 PR 판정이 하위 항목에 남기는 줄의 머리. 단계 줄이 아니라 진행률에 세지 않는다
export const NOTE = '남은 일: '

export type BoardDetail = string | { text: string; done?: unknown }

export type BoardStep = { number: number; done: boolean; text: string }

export function detailText(detail: BoardDetail): string {
  return typeof detail === 'string' ? detail : detail.text
}

// board.ts set 의 --detail 인자. 완료 값은 옛 입력 표시(✓)로 넘긴다. 빈 목록은 하위 항목을 지운다
export function detailArgs(details: BoardDetail[]): string[] {
  if (details.length === 0) return ['--detail', '']
  return details.flatMap((d) => ['--detail', typeof d === 'string' ? d : (d.done === true ? '✓ ' : '') + d.text])
}

// 남은 일 줄. 남은 PR 도 지시서도 없으면 null
export function noteLine(prs: string[], specs: string[]): string | null {
  const parts = [prs.length > 0 ? `PR ${prs.join(' ')}` : '', specs.length > 0 ? `지시서 ${specs.join(' ')}` : ''].filter(Boolean)
  return parts.length > 0 ? NOTE + parts.join(', ') : null
}

// 하위 항목에서 남은 일 줄을 빼고 note 를 붙인 목록
export function withNote(details: BoardDetail[], note: string | null): BoardDetail[] {
  const kept = details.filter((d) => !detailText(d).startsWith(NOTE))
  return note ? [...kept, note] : kept
}
