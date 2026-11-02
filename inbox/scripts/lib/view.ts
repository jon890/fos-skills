// 받은 항목을 저장소 하나의 보드에 보일 목록으로 나눈다. 파일을 읽지 않는 순수 함수다.
//
// 저장소 필터(<orch 폴더>/config/notification.json)는 adapter 이름 아래 값 목록을 둔다.
//   { "dooray": { "projects": ["4360962059627319964", "AI-스마트홈-AI"], "channels": ["스마트홈 개발"] }, "slack": { "channels": ["C012"] } }
// 항목의 scope 가 그 adapter 아래 어느 목록의 값 하나와 같으면 그 저장소의 항목이다.
//
// 나누는 규칙(R8, R9, D9, D10):
//   필터 파일이 없는 저장소       받은 항목을 모두 보인다
//   필터에 enabled: false 인 저장소  알림을 보지 않는다(board 가 enabled false 를 낸다). 다른 보드의 미분류 판정에도 세지 않는다
//   필터 파일이 있는 저장소       자기 필터에 든 항목을 보인다
//     기본 보드이거나 기본 보드를 정하지 않았으면  어느 필터에도 들지 않은 「미분류」 도 목록에 더한다
//     그 밖의 보드                                  미분류는 새 항목 수만 낸다
// 넘긴 항목과 days 보다 오래된 항목은 어디에도 보이지 않는다.

import type { InboxItem } from './model.ts'

// adapter 이름 아래 값 목록을 두고, 「enabled: false」 로 이 저장소의 보드가 알림을 보지 않게 끈다
export type RepoFilter = Record<string, unknown>

// 필터가 이 저장소의 알림을 끄는지. 끈 저장소는 알림을 소유하지 않아 다른 보드의 미분류 판정에도 들지 않는다
export function isOff(filter: RepoFilter | null): boolean {
  return filter !== null && filter.enabled === false
}

export type ViewInput = {
  items: InboxItem[]
  dismissed: Set<string>
  now: Date
  days: number
  // 이 저장소의 필터. 파일이 없으면 null
  filter: RepoFilter | null
  // 필터 파일을 가진 모든 저장소의 필터(이 저장소 포함)
  knownFilters: RepoFilter[]
  // 이 저장소가 기본 보드인지. 기본 보드를 정하지 않았으면 null
  isDefault: boolean | null
}

export type View = {
  items: InboxItem[]
  newCount: number
  // 이 보드에 목록으로 보이지 않은 미분류 새 항목 수
  unclassified: number
}

function values(filter: RepoFilter, adapter: string): Set<string> {
  const section = filter[adapter]
  if (!section || typeof section !== 'object') return new Set()
  return new Set(
    Object.values(section)
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .map((value) => String(value).trim())
      .filter(Boolean),
  )
}

export function matches(item: InboxItem, filter: RepoFilter): boolean {
  const wanted = values(filter, item.adapter)
  return item.scope.some((value) => wanted.has(value))
}

// 새 항목 먼저, 같은 묶음 안에서는 최신순
export function order(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const rank = (item: InboxItem) => (item.state === 'new' ? 0 : 1)
    return rank(a) - rank(b) || Date.parse(b.at) - Date.parse(a.at)
  })
}

export function visibleItems(items: InboxItem[], dismissed: Set<string>, now: Date, days: number): InboxItem[] {
  const from = now.getTime() - days * 24 * 60 * 60 * 1000
  return items.filter((item) => !dismissed.has(item.id) && item.state !== 'dismissed' && !(Date.parse(item.at) < from))
}

export function boardView(input: ViewInput): View {
  if (isOff(input.filter)) return { items: [], newCount: 0, unclassified: 0 }
  const visible = visibleItems(input.items, input.dismissed, input.now, input.days)
  let shown: InboxItem[]
  let unclassified = 0
  if (!input.filter) {
    shown = visible
  } else {
    const own = input.filter
    const filters = input.knownFilters.includes(own) ? input.knownFilters : [...input.knownFilters, own]
    const mine = visible.filter((item) => matches(item, own))
    const loose = visible.filter((item) => !filters.some((filter) => matches(item, filter)))
    if (input.isDefault === false) {
      shown = mine
      unclassified = loose.filter((item) => item.state === 'new').length
    } else {
      shown = [...mine, ...loose]
    }
  }
  const items = order(shown)
  return { items, newCount: items.filter((item) => item.state === 'new').length, unclassified }
}
