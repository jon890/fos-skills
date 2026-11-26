import type { InboxItem } from './model.ts'

export const MUTE_KEYS = ['excludeProjects', 'excludeChannels'] as const
export type MuteKey = typeof MUTE_KEYS[number]

export function muteKey(item: InboxItem): MuteKey | undefined {
  if (item.adapter !== 'dooray') return
  if (item.source === 'task') return 'excludeProjects'
  if (item.source === 'messenger') return 'excludeChannels'
}

export function muteLabel(key: MuteKey): string {
  return key === 'excludeProjects' ? '프로젝트' : '대화방'
}

export function muteTarget(item: InboxItem): { key: MuteKey; value: string; name: string } | undefined {
  const key = muteKey(item)
  if (!key) return
  const value = item.scope[0]
  const name = (key === 'excludeProjects'
    ? item.scopeName || item.scope[1] || item.title.match(/^(.+)\/\d+(?:\s|$)/)?.[1]
    : item.title)?.trim()
  if (value && name) return { key, value, name }
}

export function filterValues(list: unknown): string[] {
  return Array.isArray(list) ? list.map((value) => String(value).trim()).filter(Boolean) : []
}
