// 두레이 adapter. 모든 두레이 호출은 dooray CLI 로 한다. 토큰은 CLI 설정에만 있고 이 파일은 읽지 않는다(D3).
//
// 출처:
//   task       `dooray --json stream list --since <ISO> --all` (공식 GET /common/v1/streams).
//              event(type comment) 본문에 내 멤버 링크가 있으면 mention, post 의 담당(to)·참조(cc)에 내가 있으면 assigned·cc
//   messenger  `dooray --json messenger channels --since <지난 받기>` 로 바뀐 방만 고르고, 방마다 `messenger logs <id> -n 50`.
//              logs 는 공식 문서에 없는 endpoint 라 실패해도 task 항목은 그대로 낸다(D1, R7)
// 멘션 판정: 본문의 `dooray://{orgId}/members/{내 id}` 링크. 메신저 본문의 표기는 실제 로그로 확인하지 못해 같은 링크로 가정했다.
// 메신저 호출 줄이기(D14): 봇 방과 나와의 대화는 건너뛰고, 최근 바뀐 순으로 MAX_CHANNELS 개까지만 읽는다.
//
// 설정(inbox.json 의 adapters 항목): { "type": "dooray", "messenger": true, "webUrl": "https://nhnent.dooray.com" }
//   messenger  false 면 메신저를 읽지 않는다. 기본 true
//   webUrl     업무 링크의 앞부분. 없으면 링크 없이 보인다
//
// CLI 출력 필드는 dooray CLI 0.29.1 실측(2026-11-02)이다. stream list 는 그 뒤에 더할 명령이라 공식 문서의 응답 형식을 따랐다.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Adapter, AdapterConfig, AdapterDeps, Context, FetchRequest, FetchResult, InboxItem, Message, Person } from '../lib/model.ts'

export const MAX_CHANNELS = 20
export const LOG_COUNT = 50
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

  function fetchTasks(request: FetchRequest, self: Me, now: string): InboxItem[] {
    const elements = json(['stream', 'list', '--since', request.since, '--all'])
    if (!Array.isArray(elements)) throw new Error('dooray stream list 출력이 목록이 아니다')
    const items: InboxItem[] = []
    for (const element of elements as Json[]) {
      if (element?.type === 'event') {
        const event = element.event ?? {}
        if (event.type !== 'comment' || !event.postId) continue
        const from = memberOf(event.creator)
        const text = String(event.body?.content ?? '')
        if (from.id === self.id || !mentions(text, self.id)) continue
        // 공식 문서의 event 원소에는 시각이 없다. 추가 필드가 오면 쓰고, 없으면 처음 받은 시각을 쓴다
        const at = iso(event.createdAt ?? event.at ?? event.updatedAt) || now
        items.push(taskItem('mention', `comment:${event.id}`, String(event.postId), from, at, text,
          { kind: 'task', postId: String(event.postId), commentId: String(event.id ?? '') }))
      } else if (element?.type === 'post') {
        const post = element.post ?? {}
        const from = memberOf(post.users?.from)
        if (!post.id || from.id === self.id) continue
        const ids = (list: unknown) => (Array.isArray(list) ? list.map((user: Json) => memberOf(user).id) : [])
        const kind = ids(post.users?.to).includes(self.id) ? 'assigned' : ids(post.users?.cc).includes(self.id) ? 'cc' : null
        const at = iso(post.createdAt)
        // 오래된 업무가 고쳐져 피드에 다시 오면 새 알림이 아니다
        if (!kind || !at || at < request.since) continue
        items.push(taskItem(kind, `post:${post.id}`, String(post.id), from, at, String(post.body?.content ?? post.subject ?? ''),
          { kind: 'task', postId: String(post.id) }))
      }
    }
    return items
  }

  function fetchMessenger(request: FetchRequest, self: Me): { items: InboxItem[]; failures: string[] } {
    const channels = json(['messenger', 'channels', '--since', request.lastFetchedAt ?? request.since])
    if (!Array.isArray(channels)) throw new Error('dooray messenger channels 출력이 목록이 아니다')
    const picked = (channels as Json[])
      .filter((channel) => channel?.id && !SKIP_CHANNEL_TYPES.has(String(channel.type)))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, MAX_CHANNELS)
    const items: InboxItem[] = []
    const failures: string[] = []
    for (const channel of picked) {
      let logs: Json[]
      try {
        logs = json(['messenger', 'logs', String(channel.id), '-n', String(LOG_COUNT)])
      } catch (error) {
        failures.push(`${channel.title || channel.id}: ${(error as Error).message}`)
        continue
      }
      for (const log of Array.isArray(logs) ? logs : []) {
        const senderId = String(log?.sender?.member?.organizationMemberId ?? '')
        const text = String(log?.text ?? '')
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
    // 메신저 로그에는 보낸 사람 이름이 없어 풀어 둔다. 1:1 방은 제목이 없어 보낸 사람 이름을 제목으로 쓴다
    const names = resolvePeople(items.map((item) => item.from.id))
    for (const item of items) {
      item.from.name = names.get(item.from.id) ?? ''
      if (!item.title) item.title = item.from.name ? `${item.from.name} 대화` : '대화'
    }
    return { items, failures }
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

  function taskComments(postId: string, extra: string[]): Json[] {
    const list = json(['post', 'comment', 'list', '--id', postId, ...extra])
    return Array.isArray(list) ? list : []
  }

  function channelLogs(channelId: string, count: number): Json[] {
    const logs = json(['messenger', 'logs', channelId, '-n', String(count)])
    return Array.isArray(logs) ? logs : []
  }

  return {
    name: 'dooray',

    fetch(request: FetchRequest): FetchResult {
      const errors: Record<string, string> = {}
      const items: InboxItem[] = []
      let self: Me
      try {
        self = me()
      } catch (error) {
        const reason = (error as Error).message
        return { items, errors: readMessenger ? { task: reason, messenger: reason } : { task: reason } }
      }
      const now = deps.now().toISOString()
      try {
        items.push(...fetchTasks(request, self, now))
      } catch (error) {
        errors.task = (error as Error).message
      }
      if (readMessenger) {
        try {
          const result = fetchMessenger(request, self)
          items.push(...result.items)
          if (result.failures.length > 0) errors.messenger = `대화방 ${result.failures.length}개 읽기 실패: ${result.failures[0]}`
        } catch (error) {
          errors.messenger = (error as Error).message
        }
      }
      return { items, errors }
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
        const fromMissing = item.from.name ? [] : [item.from.id]
        return { item, body: String(post?.body?.content ?? ''), previous, unresolved: [...new Set([...unresolved, ...fromMissing])] }
      }
      const logs = channelLogs(item.target.channelId, 30).reverse()
      const { previous, unresolved } = withNames(logs.map((log) => ({
        id: String(log?.sender?.member?.organizationMemberId ?? ''),
        at: iso(log?.sentAt),
        text: plainText(String(log?.text ?? '')),
      })))
      const mention = logs.find((log) => String(log?.id) === item.target.logId)
      return { item, body: String(mention?.text ?? item.excerpt), previous, unresolved }
    },

    resolvePeople,

    answered(item: InboxItem): boolean {
      const self = me()
      if (item.target.kind === 'task') {
        return taskComments(item.target.postId, ['--since', item.at, '--size', '100'])
          .some((comment) => String(comment?.creator?.member?.organizationMemberId ?? '') === self.id && iso(comment?.createdAt) > item.at)
      }
      return channelLogs(item.target.channelId, LOG_COUNT)
        .some((log) => String(log?.sender?.member?.organizationMemberId ?? '') === self.id && iso(log?.sentAt) > item.at)
    },

    compose(item: InboxItem, body: string, signature: string): string {
      const self = me()
      const name = item.from.name.replace(/[[\]]/g, '')
      const mention = item.from.id ? `[@${name}](dooray://${self.orgId}/members/${item.from.id} "member") ` : ''
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
