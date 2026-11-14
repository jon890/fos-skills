// 두레이 adapter. 모든 두레이 호출은 dooray CLI 로 한다. 토큰은 CLI 설정에만 있고 이 파일은 읽지 않는다(D3).
//
// 출처:
//   task       `dooray --json stream list --since <지난 받기 또는 기간 시작> --all` (공식 GET /common/v1/streams, jon890/dooray-cli #248 로 더한 명령).
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
const SKIP_CHANNEL_TYPES = new Set(['bot', 'me'])
const EXCERPT = 80

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

export function createDooray(config: AdapterConfig, deps: AdapterDeps): Adapter {
  const { run, cache } = deps
  const readMessenger = config.messenger !== false
  const webUrl = typeof config.webUrl === 'string' ? config.webUrl.replace(/\/+$/, '') : ''

  function json(argv: string[]): any {
    const result = run(['dooray', '--json', ...argv])
    if (result.code !== 0) {
      const reason = (result.stderr || result.stdout || `종료 코드 ${result.code}`).trim().split('\n')[0]
      throw new Error(`dooray ${argv.slice(0, 2).join(' ')}: ${reason}`)
    }
    return JSON.parse(result.stdout || 'null')
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
  function commentTime(postId: string, commentId: string): string {
    if (!commentId) return ''
    try {
      const found = taskComments(postId, ['--latest', '100']).find((comment) => String(comment?.id) === commentId)
      return iso(found?.createdAt)
    } catch {
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

  function fetchTasks(request: FetchRequest, self: Me, now: string): { items: InboxItem[]; failures: string[] } {
    // 피드는 2주에 수천 건이라, 지난 받기가 있으면 그 뒤만 읽는다. 앞서 받은 항목은 캐시에 남아 있다
    const elements = json(['stream', 'list', '--since', request.cursors.task ?? request.since, '--all'])
    if (!Array.isArray(elements)) throw new Error('dooray stream list 출력이 목록이 아니다')
    const items: InboxItem[] = []
    const failures: string[] = []
    // 원소 하나(지운 업무, 권한 없는 업무)가 실패해도 나머지는 받는다. 실패한 원소는 다시 읽지 않는다
    for (const element of elements as Json[]) {
      try {
        const item = taskElement(element, request, self, now)
        if (item) items.push(item)
      } catch (error) {
        failures.push((error as Error).message)
      }
    }
    fillNames(items)
    return { items, failures }
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
    const known = new Map((channels as Json[]).filter((channel) => channel?.id).map((channel) => [String(channel.id), channel]))
    for (const id of retry) if (!known.has(id)) known.set(id, { id, title: '', type: 'private', updatedAt: from })
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

    fetch(request: FetchRequest): FetchResult {
      const errors: Record<string, string> = {}
      const cursors: Record<string, string> = {}
      const items: InboxItem[] = []
      let self: Me
      try {
        self = me()
      } catch (error) {
        // 토큰 오류는 출처마다 나누지 않고 한 줄로 낸다(R7)
        return { items, errors: { auth: (error as Error).message }, cursors }
      }
      const now = deps.now().toISOString()
      try {
        const result = fetchTasks(request, self, now)
        items.push(...result.items)
        cursors.task = now
        if (result.failures.length > 0) errors.task = `업무 ${result.failures.length}개 읽기 실패: ${result.failures[0]}`
      } catch (error) {
        errors.task = (error as Error).message
      }
      if (readMessenger) {
        try {
          const result = fetchMessenger(request, self)
          items.push(...result.items)
          cursors.messenger = result.cursor
          if (result.failures.length > 0) errors.messenger = `대화방 ${result.failures.length}개 읽기 실패: ${result.failures[0]}`
        } catch (error) {
          errors.messenger = (error as Error).message
        }
      }
      return { items, errors, cursors }
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
  }
}
