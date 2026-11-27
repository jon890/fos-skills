// 메인 사이 요청(orch request)의 보드 항목을 「[보낸 저장소 요청] 제목 · 요청 46」 꼴로 보이게 읽는다.
// 새 항목은 칸에서 읽는다. request-from 은 받는 쪽 항목의 보낸 저장소 이름, request-to 는 보낸 쪽 항목의 받는 저장소 이름이다.
// 번호는 항목 id(req-<받는 저장소 이름>-<n>, 옛 id req-<n>)의 끝 숫자다. 제목은 요청 제목 그대로다.
// 옛 항목은 제목 「요청 R46: <제목> (<보낸 저장소>)」 와 「<받는 저장소> 요청 R46 기다림: <제목>」 에서 읽는다.
// 요청 항목이 아니면 null 이다.

const ID = /^req-(?:.+-)?(\d+)$/
const OLD_TO = /^요청 R(\d+): (.+?)(?: \(([^()\s]+)\))?$/
const OLD_FROM = /^(\S+) 요청 R(\d+) 기다림: (.+)$/

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * @param {{ id?: unknown, title?: unknown, 'request-from'?: unknown, 'request-to'?: unknown }} item
 * @returns {{ tag: string | null, number: number | null, title: string } | null}
 */
export function requestView(item) {
  const id = typeof item.id === 'string' ? ID.exec(item.id) : null
  const title = text(item.title) ?? ''
  const from = text(item['request-from'])
  const to = text(item['request-to'])
  const oldTo = OLD_TO.exec(title)
  const oldFrom = oldTo ? null : OLD_FROM.exec(title)
  if (!id && !oldTo && !oldFrom) return null
  const number = id ? Number(id[1]) : Number(oldTo ? oldTo[1] : oldFrom[2])
  if (oldTo) return { tag: tagOf(from ?? oldTo[3] ?? null, to), number, title: oldTo[2] }
  if (oldFrom) return { tag: tagOf(from, to ?? oldFrom[1]), number, title: oldFrom[3] }
  return { tag: tagOf(from, to), number, title: title || String(item.id) }
}

function tagOf(from, to) {
  if (from) return '[' + from + ' 요청]'
  if (to) return '[' + to + ' 에 보낸 요청]'
  return null
}

export function requestNumberText(number) {
  return '요청 ' + number
}
