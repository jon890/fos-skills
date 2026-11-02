// 업무 알림함의 공통 모델이다. 보드와 답변 흐름은 이 모델만 읽고, 도구마다 다른 일은 adapter 가 맡는다.
// 모델과 계약의 설계는 docs/features/work-inbox/spec.md 「설계」 가 소유한다.

export type Kind = 'mention' | 'assigned' | 'cc'
export type ItemState = 'new' | 'answered' | 'dismissed'

export type Person = { id: string; name: string }

export type InboxItem = {
  // '<adapter>:<출처>:<원본 id>'. 같은 알림은 받을 때마다 같은 id 다
  id: string
  adapter: string
  // adapter 안의 출처. 두레이는 'task', 'messenger'. 받기 오류도 출처마다 따로 남긴다
  source: string
  kind: Kind
  title: string
  // 사람이 여는 주소. 모르면 ''
  url: string
  // 저장소 필터와 맞출 값. 두레이 업무는 프로젝트 id 와 코드, 메신저는 대화방 id 와 이름이다
  scope: string[]
  from: Person
  // ISO 8601
  at: string
  excerpt: string
  // 답변을 등록할 곳. adapter 만 읽는다
  target: Record<string, string>
  state: ItemState
}

export type FetchRequest = {
  // 이 시각보다 오래된 알림은 받지 않는다(설정 days)
  since: string
  // 지난 받기 시각. 처음이면 null. 메신저처럼 바뀐 곳만 읽는 출처가 쓴다
  lastFetchedAt: string | null
}

export type FetchResult = {
  items: InboxItem[]
  // 출처 이름과 오류 한 줄. 실패한 출처의 항목은 지난 캐시에 남은 것을 그대로 쓴다
  errors: Record<string, string>
}

export type Message = { from: Person; at: string; text: string }

export type Context = {
  item: InboxItem
  // 업무 본문이나 멘션한 메시지 본문
  body: string
  // 앞 대화. 오래된 것부터
  previous: Message[]
  // 이름으로 풀지 못한 사람 id. 비어 있지 않으면 초안을 쓰지 않는다
  unresolved: string[]
}

export interface Adapter {
  readonly name: string
  fetch(request: FetchRequest): FetchResult
  context(item: InboxItem): Context
  resolvePeople(ids: string[]): Map<string, string>
  // 알림 뒤에 내 답이 있는지
  answered(item: InboxItem): boolean
  // 보낼 본문을 합성한다. 받는 사람 멘션과 signature 를 붙인다(R10)
  compose(item: InboxItem, body: string, signature: string): string
  // 합성한 본문을 등록하고 주소나 '' 를 낸다. 실패하면 던진다
  reply(item: InboxItem, text: string): string
}

export type RunResult = { code: number; stdout: string; stderr: string }
// 외부 명령을 부르는 함수. 테스트에서 가짜로 바꾼다
export type Runner = (argv: string[]) => RunResult

// adapter 가 쓰는 사람 단위 캐시. 이름마다 JSON 값 하나다
export interface Cache {
  read<T>(name: string, fallback: T): T
  write(name: string, value: unknown): void
}

export type AdapterConfig = { type: string } & Record<string, unknown>

export type AdapterDeps = { run: Runner; cache: Cache; now: () => Date; tmpDir: string }

export type AdapterFactory = (config: AdapterConfig, deps: AdapterDeps) => Adapter
