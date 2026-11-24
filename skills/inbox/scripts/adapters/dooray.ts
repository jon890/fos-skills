// 두레이 adapter. 모든 두레이 호출은 dooray CLI 로 한다. 토큰은 CLI 설정에만 있고 이 파일은 읽지 않는다(D3).
//
// 출처:
//   task       `dooray --json stream list` 로 지난 커서까지 받는다(첫 받기는 피드 전체).
//              --json 은 API 원소를 그대로 낸다. 429 는 CLI 종료 코드 6 이고 다른 실패와 같이 task 오류로 남는다.
//              원소 하나의 업무 조회가 실패하면 그 원소만 빼고 오류 한 줄에 수를 남긴다
//              event(type comment) 본문에 내 멤버 링크가 있으면 mention, post 의 담당(to)·참조(cc)에 내가 있으면 assigned·cc
//   messenger  `dooray --json messenger channels --since <지난 받기>` 로 바뀐 방만 고르고, 방마다 `messenger logs <id> -n 50`.
//              logs 는 공식 문서에 없는 endpoint 라 실패해도 task 항목은 그대로 낸다(D1, R7).
//              읽지 못한 방은 dooray-retry-channels 캐시에 적어 다음 받기에 다시 읽고, 커서는 앞으로 옮긴다
// 출처마다 커서(FetchResult.cursors)를 따로 내므로 한 출처의 실패가 다른 출처의 받기를 멈추지 않는다.
// 토큰 오류처럼 나를 읽지 못하면 auth 오류 한 줄만 낸다.
// 멘션 판정: 본문의 `dooray://{orgId}/members/{내 id}` 링크. 메신저 본문도 같은 링크 표기다(화면 실측은 content-preview 의 messenger-rendering.md).
// 메신저 호출 줄이기(D14): 봇 방과 나와의 대화는 건너뛰고, 바뀐 방을 오래된 순으로 MAX_CHANNELS 개까지만 읽는다.
//   남은 방이 있으면 마지막으로 읽은 방의 updatedAt 을 cursor 로 내어 다음 받기가 거기서 잇는다. 놓치는 방이 없게 하려는 것이다.
//   한 방의 logs LOG_COUNT 개가 모두 지난 받기 뒤의 것이면 MORE_LOG_COUNT 개로 다시 읽는다.
//
// 설정(inbox.json 의 adapters 항목): { "type": "dooray", "messenger": true, "webUrl": "https://example.dooray.com" }
//   messenger  false 면 메신저를 읽지 않는다. 기본 true
//   webUrl     업무 링크의 앞부분. 없으면 링크 없이 보인다
//
// 두레이 호출은 CLI 의 인증 방식(토큰 또는 웹 SESSION 쿠키)과 무관하다. 어느 쪽이든 같은 명령과 JSON 으로 읽는다.
// 실측(dooray CLI 0.33.0 웹 방식, 2026-11-14): member get me, stream list --all, messenger channels·logs, post get, post comment list 가 모두 성공했다.
//   웹 stream 의 event(type comment)에는 시각 칸이 없다(body, creator, id, postId, read, type 뿐). 그래서 같은 업무의 댓글 목록에서 그 댓글의 createdAt 을 찾아 쓴다.
//   웹 방식의 messenger logs 는 오래된 메시지로 거슬러 가지 못한다. CLI 가 「더 오래된 메시지가 있지만 그 이전으로 갈 수단이 없다」 고 알린다.
// stream list 밖의 CLI 출력 필드는 dooray CLI 0.29.1 실측(2026-11-02)이다. 토큰 방식 stream 원소는 공식 문서의 응답 형식을 따랐다.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Adapter, AdapterConfig, AdapterDeps, Context, FetchRequest, FetchResult, InboxItem, Message, Person } from '../lib/model.ts'

export const MAX_CHANNELS = 20
export const LOG_COUNT = 50
export const MORE_LOG_COUNT = 300
export const TASK_FEED_SINCE = 'prev-15d'
const STREAM_PAGE_SIZE = 200
const STREAM_ORDER_MARGIN_MS = 60_000
const SKIP_CHANNEL_TYPES = new Set(['bot', 'me'])
const EXCERPT = 80
const MIN_REACTION_MINOR = 35

type Json = Record<string, any>
type Me = { id: string; orgId: string }
type PostInfo = { projectId: string; projectCode: string; taskNumber: string; subject: string }

// 두레이 본문의 링크 표기를 읽을 글로 바꾼다. 「[@이름](dooray://…)」 은 「@이름」 이 된다
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/\s+/g, ' ')
    .trim()
}

// 메신저 로그의 text 는 보통 글이지만, 일부 메시지는 {"type":0,"text":"…"} 같은 JSON 문자열로 온다. 그 안의 text 를 꺼낸다
export function messageText(value: unknown): string {
  const raw = String(value ?? '')
  if (!raw.trimStart().startsWith('{')) return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && typeof parsed.text === 'string' ? parsed.text : raw
  } catch {
    return raw
  }
}

export function excerptOf(text: string): string {
  const plain = plainText(text)
  return [...plain].length > EXCERPT ? [...plain].slice(0, EXCERPT).join('') + '…' : plain
}

export function mentions(text: string, memberId: string): boolean {
  return new RegExp(`dooray://[^/\\s)]+/members/${memberId}(?![0-9])`).test(text)
}

function memberOf(value: Json | undefined): Person {
  const member = value?.member ?? value ?? {}
  return { id: String(member.organizationMemberId ?? ''), name: String(member.name ?? '') }
}

function iso(value: unknown): string {
  const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

export function taskCursorTime(cursor: string | undefined, now: number): number | null {
  const ms = Date.parse(cursor ?? '')
  return Number.isFinite(ms) && ms <= now ? ms : null
}

// 피드의 숫자 커서는 나노초, 마이크로초, 밀리초 또는 초 단위다.
function streamCursorTime(cursor: string): number {
  const digits = cursor.length
  if (digits >= 18) return Number(cursor.slice(0, -6))
  if (digits >= 15) return Number(cursor.slice(0, -3))
  if (digits >= 12) return Number(cursor)
  return Number(cursor) * 1000
}

export function createDooray(config: AdapterConfig, deps: AdapterDeps): Adapter {
  const { run, cache } = deps
  const readMessenger = config.messenger !== false
  const webUrl = typeof config.webUrl === 'string' ? config.webUrl.replace(/\/+$/, '') : ''

  function readJson(argv: string[]): { data: any; stderr: string } {
    const result = run(['dooray', '--json', ...argv])
    if (result.code !== 0) {
      const reason = (result.stderr || result.stdout || `종료 코드 ${result.code}`).trim().split('\n')[0]
      throw new Error(`dooray ${argv.slice(0, 2).join(' ')}: ${reason}`)
    }
    return { data: JSON.parse(result.stdout || 'null'), stderr: result.stderr }
  }

  function json(argv: string[]): any {
    return readJson(argv).data
  }

  function me(): Me {
    const saved = cache.read<Me | null>('dooray-me', null)
    if (saved?.id && saved.orgId) return saved
    const value = json(['member', 'get', 'me'])
    const found = { id: String(value?.id ?? ''), orgId: String(value?.defaultOrganization?.id ?? '') }
    if (!found.id) throw new Error('dooray member get me 에 id 가 없다')
    cache.write('dooray-me', found)
    return found
  }

  function postInfo(postId: string): PostInfo {
    const posts = cache.read<Record<string, PostInfo>>('dooray-posts', {})
    if (posts[postId]) return posts[postId]
    const value = json(['post', 'get', '--id', postId])
    const info = {
      projectId: String(value?.project?.id ?? ''),
      projectCode: String(value?.project?.code ?? ''),
      taskNumber: String(value?.taskNumber ?? ''),
      subject: String(value?.subject ?? ''),
    }
    posts[postId] = info
    cache.write('dooray-posts', posts)
    return info
  }

  function taskUrl(postId: string): string {
    return webUrl ? `${webUrl}/project/tasks/${postId}` : ''
  }

  function taskItem(kind: InboxItem['kind'], idPart: string, postId: string, from: Person, at: string, text: string, target: Record<string, string>): InboxItem {
    const info = postInfo(postId)
    return {
      id: `dooray:task:${idPart}`,
      adapter: 'dooray',
      source: 'task',
      kind,
      title: [info.taskNumber, info.subject].filter(Boolean).join(' '),
      url: taskUrl(postId),
      scope: [info.projectId, info.projectCode].filter(Boolean),
      from,
      at,
      excerpt: excerptOf(text),
      target,
      state: 'new',
    }
  }

  // 댓글 목록은 업무마다 한 번만 읽는다(listOf 가 기억한다). 읽지 못하면 빈 시각을 내어 호출한 쪽이 받은 시각으로 채운다
  // 읽지 못한 업무도 그 받기 안에서 기억해 다시 부르지 않는다(429 에 같은 목록을 멘션 수만큼 다시 부르지 않으려는 것)
  const unreadablePosts = new Set<string>()
  function commentTime(postId: string, commentId: string): string {
    if (!commentId || unreadablePosts.has(postId)) return ''
    const times = cache.read<Record<string, string>>('dooray-comment-times', {})
    if (times[commentId]) return times[commentId]
    try {
      const found = taskComments(postId, ['--latest', '100']).find((comment) => String(comment?.id) === commentId)
      const at = iso(found?.createdAt)
      if (at) cache.write('dooray-comment-times', { ...times, [commentId]: at })
      return at
    } catch {
      unreadablePosts.add(postId)
      return ''
    }
  }

  // 원소 하나를 항목으로 바꾼다. 내 알림이 아니면 null
  function taskElement(element: Json, request: FetchRequest, self: Me, now: string): InboxItem | null {
    if (element?.type === 'event') {
      const event = element.event ?? {}
      if (event.type !== 'comment' || !event.postId) return null
      const from = memberOf(event.creator)
      const text = String(event.body?.content ?? '')
      if (from.id === self.id || !mentions(text, self.id)) return null
      // 웹 방식 stream 의 event 원소에는 시각 칸이 없다(실측 2026-11-14). 시각 필드가 오면 쓰고,
      // 없으면 그 업무의 댓글 목록에서 같은 id 의 댓글 시각을 찾는다. 그래도 없으면 처음 받은 시각을 쓴다
      const at = iso(event.createdAt ?? event.at ?? event.updatedAt) || commentTime(String(event.postId), String(event.id ?? '')) || now
      return taskItem('mention', `comment:${event.id}`, String(event.postId), from, at, text,
        { kind: 'task', postId: String(event.postId), commentId: String(event.id ?? '') })
    }
    if (element?.type === 'post') {
      const post = element.post ?? {}
      const from = memberOf(post.users?.from)
      if (!post.id || from.id === self.id) return null
      const ids = (list: unknown) => (Array.isArray(list) ? list.map((user: Json) => memberOf(user).id) : [])
      const kind = ids(post.users?.to).includes(self.id) ? 'assigned' : ids(post.users?.cc).includes(self.id) ? 'cc' : null
      const at = iso(post.createdAt)
      // 오래된 업무가 고쳐져 피드에 다시 오면 새 알림이 아니다
      if (!kind || !at || at < request.since) return null
      return taskItem(kind, `post:${post.id}`, String(post.id), from, at, String(post.body?.content ?? post.subject ?? ''),
        { kind: 'task', postId: String(post.id) })
    }
    return null
  }

  function feedItems(value: unknown): Json[] {
    if (!Array.isArray(value)) throw new Error('dooray stream list 출력이 목록이 아니다')
    return value
  }

  function fullFeed(): Json[] {
    return feedItems(json(['stream', 'list', '--since', TASK_FEED_SINCE, '--all']))
  }

  function taskFeed(since: number | null): { elements: Json[]; fellBack?: boolean } {
    if (since === null) return { elements: fullFeed() }
    // 예전 CLI 의 --since 는 걸친 페이지에서 시각 없는 댓글을 버린다. 페이지 원본과 다음 커서를 그대로 읽는다.
    const items: Json[] = []
    let before: string | undefined
    let previousTime = Infinity
    const recover = () => ({ elements: fullFeed(), fellBack: true })
    for (;;) {
      const argv = ['stream', 'list', '--size', String(STREAM_PAGE_SIZE)]
      if (before) argv.push('--before', before)
      const { data, stderr } = readJson(argv)
      const page = feedItems(data)
      items.push(...page)
      if (page.length === 0) return { elements: items }
      const next = /--before\s+(\d+)\s*$/m.exec(stderr)?.[1]
      if (!next) return page.length < STREAM_PAGE_SIZE ? { elements: items } : recover()
      const at = streamCursorTime(next)
      if (at < since - STREAM_ORDER_MARGIN_MS) return { elements: items }
      if (at >= previousTime) return recover()
      before = next
      previousTime = at
    }
  }

  function fetchTasks(request: FetchRequest, self: Me, now: string): { items: InboxItem[]; failures: string[]; fellBack?: boolean } {
    const { elements, fellBack } = taskFeed(taskCursorTime(request.cursors.task, Date.parse(now)))
    unreadablePosts.clear()
    const items: InboxItem[] = []
    const failures: string[] = []
    // 원소 하나(지운 업무, 권한 없는 업무)가 실패해도 나머지는 받는다. 실패한 원소는 다시 읽지 않는다
    for (const element of elements) {
      try {
        const item = taskElement(element, request, self, now)
        if (item) items.push(item)
      } catch (error) {
        failures.push((error as Error).message)
      }
    }
    fillNames(items)
    return { items, failures, fellBack }
  }

  // 보낸 사람 이름이 피드나 로그에 없으면 member get 으로 푼다. 풀지 못하면 빈 이름으로 두고 context 가 알린다
  function fillNames(items: InboxItem[]): void {
    const names = resolvePeople(items.filter((item) => !item.from.name).map((item) => item.from.id))
    for (const item of items) if (!item.from.name) item.from.name = names.get(item.from.id) ?? ''
  }

  function fetchMessenger(request: FetchRequest, self: Me): { items: InboxItem[]; failures: string[]; cursor: string } {
    const from = request.cursors.messenger ?? request.since
    const now = deps.now().toISOString()
    const channels = json(['messenger', 'channels', '--since', from])
    if (!Array.isArray(channels)) throw new Error('dooray messenger channels 출력이 목록이 아니다')
    // 지난번에 읽지 못한 방은 바뀌지 않았어도 다시 읽는다
    const retry = new Set(cache.read<string[]>('dooray-retry-channels', []))
    const titles = cache.read<Record<string, string>>('dooray-channel-titles', {})
    const known = new Map((channels as Json[]).filter((channel) => channel?.id).map((channel) => [String(channel.id), channel]))
    for (const channel of known.values()) titles[String(channel.id)] = String(channel.title || '')
    cache.write('dooray-channel-titles', titles)
    for (const id of retry) if (!known.has(id)) known.set(id, { id, title: titles[id] ?? '', type: 'private', updatedAt: from })
    const changed = [...known.values()]
      .filter((channel) => !SKIP_CHANNEL_TYPES.has(String(channel.type)))
      .sort((a, b) => (Date.parse(a.updatedAt ?? '') || 0) - (Date.parse(b.updatedAt ?? '') || 0))
    const picked = changed.slice(0, MAX_CHANNELS)
    // 남은 방이 있으면 마지막으로 읽은 방의 시각부터 다음에 잇는다. 없으면 이번 받기 시각이다
    const cursor = changed.length > MAX_CHANNELS ? iso(picked[picked.length - 1].updatedAt) || from : now
    const items: InboxItem[] = []
    const failures: string[] = []
    const failed: string[] = []
    for (const channel of picked) {
      let logs: Json[]
      try {
        logs = channelLogs(String(channel.id), LOG_COUNT)
        const oldest = logs.reduce((min, log) => Math.min(min, Date.parse(log?.sentAt ?? '') || 0), Infinity)
        if (logs.length >= LOG_COUNT && oldest > Date.parse(from)) logs = channelLogs(String(channel.id), MORE_LOG_COUNT)
      } catch (error) {
        failures.push(`${channel.title || channel.id}: ${(error as Error).message}`)
        failed.push(String(channel.id))
        continue
      }
      for (const log of Array.isArray(logs) ? logs : []) {
        const senderId = String(log?.sender?.member?.organizationMemberId ?? '')
        const text = messageText(log?.text)
        const at = iso(log?.sentAt)
        if (!senderId || senderId === self.id || !at || at < request.since || !mentions(text, self.id)) continue
        const title = String(channel.title || '')
        items.push({
          id: `dooray:messenger:${channel.id}:${log.id}`,
          adapter: 'dooray',
          source: 'messenger',
          kind: 'mention',
          title,
          url: '',
          scope: [String(channel.id), title].filter(Boolean),
          from: { id: senderId, name: '' },
          at,
          excerpt: excerptOf(text),
          target: { kind: 'messenger', channelId: String(channel.id), logId: String(log.id) },
          state: 'new',
        })
      }
    }
    // 읽지 못한 방과, 이번에 차례가 오지 않은 재시도 방을 다음 받기에 넘긴다
    const unread = [...retry].filter((id) => !picked.some((channel) => String(channel.id) === id))
    cache.write('dooray-retry-channels', [...new Set([...failed, ...unread])])
    // 메신저 로그에는 보낸 사람 이름이 없어 풀어 둔다. 1:1 방은 제목이 없어 보낸 사람 이름을 제목으로 쓴다
    fillNames(items)
    for (const item of items) if (!item.title) item.title = item.from.name ? `${item.from.name} 대화` : '대화'
    return { items, failures, cursor }
  }

  function resolvePeople(ids: string[]): Map<string, string> {
    const people = cache.read<Record<string, string>>('dooray-people', {})
    const found = new Map<string, string>()
    let changed = false
    for (const id of new Set(ids.filter(Boolean))) {
      if (people[id]) {
        found.set(id, people[id])
        continue
      }
      try {
        const name = String(json(['member', 'get', id])?.name ?? '')
        if (name) {
          people[id] = name
          found.set(id, name)
          changed = true
        }
      } catch {
        // 풀지 못한 id 는 결과에서 빠진다. context 가 unresolved 로 알린다
      }
    }
    if (changed) cache.write('dooray-people', people)
    return found
  }

  function withNames(messages: { id: string; at: string; text: string }[]): { previous: Message[]; unresolved: string[] } {
    const names = resolvePeople(messages.map((message) => message.id))
    const unresolved = [...new Set(messages.map((message) => message.id).filter((id) => id && !names.has(id)))]
    return {
      previous: messages.map((message) => ({ from: { id: message.id, name: names.get(message.id) ?? '' }, at: message.at, text: message.text })),
      unresolved,
    }
  }

  // 한 번의 받기(이 adapter 인스턴스) 안에서는 같은 목록을 다시 부르지 않는다. 답함 확인이 받기와 같은 방을 또 읽지 않게 한다
  const memo = new Map<string, Json[]>()

  function listOf(argv: string[]): Json[] {
    const key = argv.join('\u0000')
    if (!memo.has(key)) {
      const value = json(argv)
      memo.set(key, Array.isArray(value) ? value : [])
    }
    return memo.get(key) as Json[]
  }

  function taskComments(postId: string, extra: string[]): Json[] {
    return listOf(['post', 'comment', 'list', '--id', postId, ...extra])
  }

  function channelLogs(channelId: string, count: number): Json[] {
    return listOf(['messenger', 'logs', channelId, '-n', String(count)])
  }

  // 보낸 사람 이름이 비었으면 다시 풀어 본다. 받기 때 풀지 못한 사람도 맥락을 읽을 때 풀릴 수 있다
  function withSender(item: InboxItem): InboxItem {
    if (item.from.name || !item.from.id) return item
    const name = resolvePeople([item.from.id]).get(item.from.id) ?? ''
    return { ...item, from: { ...item.from, name } }
  }

  function senderMissing(item: InboxItem): string[] {
    return withSender(item).from.name ? [] : [item.from.id]
  }

  return {
    name: 'dooray',
    sources: readMessenger ? ['task', 'messenger'] : ['task'],

    fetch(request: FetchRequest, source?: string): FetchResult {
      const errors: Record<string, string> = {}
      const cursors: Record<string, string> = {}
      const items: InboxItem[] = []
      let taskFellBack = false
      let self: Me
      try {
        self = me()
      } catch (error) {
        // 토큰 오류는 출처마다 나누지 않고 한 줄로 낸다(R7)
        return { items, errors: { auth: (error as Error).message }, cursors }
      }
      const now = deps.now().toISOString()
      if (source === undefined || source === 'task') {
        try {
          const result = fetchTasks(request, self, now)
          items.push(...result.items)
          cursors.task = now
          taskFellBack = result.fellBack === true
          if (result.failures.length > 0) errors.task = `업무 ${result.failures.length}개 읽기 실패: ${result.failures[0]}`
        } catch (error) {
          errors.task = (error as Error).message
        }
      }
      if (readMessenger && (source === undefined || source === 'messenger')) {
        try {
          const result = fetchMessenger(request, self)
          items.push(...result.items)
          cursors.messenger = result.cursor
          if (result.failures.length > 0) errors.messenger = `대화방 ${result.failures.length}개 읽기 실패: ${result.failures[0]}`
        } catch (error) {
          errors.messenger = (error as Error).message
        }
      }
      return { items, errors, cursors, ...(taskFellBack ? { fullScanSources: ['task'] } : {}) }
    },

    context(item: InboxItem): Context {
      if (item.target.kind === 'task') {
        const post = json(['post', 'get', '--id', item.target.postId])
        const comments = taskComments(item.target.postId, ['--latest', '20']).reverse()
        const { previous, unresolved } = withNames(comments.map((comment) => ({
          id: String(comment?.creator?.member?.organizationMemberId ?? ''),
          at: iso(comment?.createdAt),
          text: plainText(String(comment?.body?.content ?? '')),
        })))
        return { item: withSender(item), body: String(post?.body?.content ?? ''), previous, unresolved: [...new Set([...unresolved, ...senderMissing(item)])] }
      }
      const logs = channelLogs(item.target.channelId, 30).reverse()
      const { previous, unresolved } = withNames(logs.map((log) => ({
        id: String(log?.sender?.member?.organizationMemberId ?? ''),
        at: iso(log?.sentAt),
        text: plainText(messageText(log?.text)),
      })))
      const mention = logs.find((log) => String(log?.id) === item.target.logId)
      return { item: withSender(item), body: mention ? messageText(mention.text) : item.excerpt, previous, unresolved: [...new Set([...unresolved, ...senderMissing(item)])] }
    },

    resolvePeople,

    answered(item: InboxItem): boolean {
      const self = me()
      if (item.target.kind === 'task') {
        const comments = taskComments(item.target.postId, ['--latest', '100'])
        // 멘션 댓글의 실제 시각을 기준으로 삼는다. 피드에 시각이 없어 item.at 이 처음 받은 시각일 수 있다
        const mention = comments.find((comment) => item.target.commentId && String(comment?.id) === item.target.commentId)
        const after = iso(mention?.createdAt) || item.at
        return comments.some((comment) => String(comment?.creator?.member?.organizationMemberId ?? '') === self.id && iso(comment?.createdAt) > after)
      }
      return channelLogs(item.target.channelId, LOG_COUNT)
        .some((log) => String(log?.sender?.member?.organizationMemberId ?? '') === self.id && iso(log?.sentAt) > item.at)
    },

    compose(item: InboxItem, body: string, signature: string): string {
      const self = me()
      const sender = withSender(item)
      const name = sender.from.name.replace(/[[\]]/g, '')
      // 이름 없는 멘션(「[@](…)」)은 받는 사람이 보이지 않는다. 풀지 못하면 등록하지 않는다(R3)
      if (sender.from.id && !name) throw new Error(`보낸 사람 이름을 풀지 못했다: ${sender.from.id}. dooray member get 으로 확인한다`)
      const mention = sender.from.id ? `[@${name}](dooray://${self.orgId}/members/${sender.from.id} "member") ` : ''
      const tail = signature.trim() ? `\n\n${signature.trim()}` : ''
      return `${mention}${body.trim()}${tail}`
    },

    reply(item: InboxItem, text: string): string {
      const dir = mkdtempSync(join(deps.tmpDir, 'inbox-reply-'))
      const file = join(dir, 'body.md')
      try {
        writeFileSync(file, text)
        const argv = item.target.kind === 'task'
          ? ['dooray', 'post', 'comment', 'add', '--id', item.target.postId, '--body-file', file]
          : ['dooray', 'messenger', 'channel-send', '--channel', item.target.channelId, '--body-file', file]
        const result = run(argv)
        if (result.code !== 0) throw new Error((result.stderr || result.stdout || `종료 코드 ${result.code}`).trim().split('\n')[0])
        return item.url
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },

    react(item, emoji, { confirmed }): void {
      if (item.source === 'messenger') throw new Error('메신저 멘션에는 리액션을 달 수 없다. 넘김을 권한다')
      if (item.kind === 'assigned' || item.kind === 'cc') {
        throw new Error('담당·참조로 온 업무 알림에는 리액션을 달 댓글이 없다. 답장이나 넘김을 권한다')
      }
      if (item.source !== 'task' || item.target.kind !== 'task' || !item.target.postId || !item.target.commentId) {
        throw new Error('리액션을 달 업무나 댓글을 찾을 수 없다. 답장이나 넘김을 권한다')
      }
      if (!confirmed) return

      const version = run(['dooray', '--version'])
      const parts = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.stdout.trim())
      const upgrade = `dooray-cli 를 0.${MIN_REACTION_MINOR}.0 이상으로 올린다`
      if (version.code !== 0 || !parts) {
        throw new Error(`dooray-cli 버전을 확인할 수 없다. ${upgrade}`)
      }
      const [, major, minor, patch, prerelease] = parts
      // 0.35.0 사전 배포판에는 API 키 방식 지원이 없을 수 있다
      if (Number(major) === 0 && (Number(minor) < MIN_REACTION_MINOR ||
          (Number(minor) === MIN_REACTION_MINOR && Number(patch) === 0 && prerelease))) {
        throw new Error(`리액션을 달려면 ${upgrade}`)
      }

      const result = run(['dooray', 'post', 'comment', 'react', '--id', item.target.postId, '--comment-id', item.target.commentId, `--emoji=${emoji}`])
      if (result.code === 3) {
        throw new Error('웹 세션이 없거나 만료되어 리액션을 달지 않았다. 이 알림은 넘김을 권한다.\n다시 시도하려면 dooray config set session-cookie - 로 웹 세션을 갱신한다')
      }
      if (result.code !== 0) {
        throw new Error(result.stderr.trimEnd() || result.stdout.trimEnd() || `dooray 종료 코드 ${result.code}`)
      }
    },
  }
}
