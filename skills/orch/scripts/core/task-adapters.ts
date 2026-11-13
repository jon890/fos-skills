// 업무 도구의 설정 판정과 번호·주소 값 변환. 어댑터를 더할 때 TASK_ADAPTERS 의 줄과 lib 의 주소 만들기를 더한다.
import { BOARD_KEYS, ConfigError, section } from './config.ts'
import type { Config } from './config.ts'
import { isObject } from './json.ts'

export type TaskAdapter = { kind: 'dooray'; name: '두레이'; host: string; webUrl: string; project: string }
  | { kind: 'url-template'; name: string; host: string; url: string }
export const TASK_ADAPTER_KEYS = { dooray: ['adapter', 'web_url', 'project'], 'url-template': ['adapter', 'url', 'name'] } as const
function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`설정 파일의 board.task.${key} 는 비지 않은 문자열이어야 한다`)
  return value
}
function hostOf(value: string, key: string): string {
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && url.host) return url.host } catch {}
  throw new ConfigError(`설정 파일의 board.task.${key} 는 http·https 주소여야 한다`)
}
export const TASK_ADAPTERS: Record<string, (body: Record<string, unknown>) => TaskAdapter> = {
  dooray: (b) => { const webUrl = text(b.web_url, 'web_url').replace(/\/+$/, ''); return { kind: 'dooray', name: '두레이', host: hostOf(webUrl, 'web_url'), webUrl, project: text(b.project, 'project') } },
  'url-template': (b) => { const url = text(b.url, 'url'); if (!url.includes('{number}')) throw new ConfigError('설정 파일의 board.task.url 에 {number} 가 있어야 한다'); return { kind: 'url-template', name: b.name === undefined ? '업무' : text(b.name, 'name'), host: hostOf(url, 'url'), url } },
}
export function taskAdapterOf(config: Config): TaskAdapter | null {
  const body = section<{ task?: unknown }>(config, 'board', BOARD_KEYS).task
  if (body === undefined) return null
  if (!isObject(body)) throw new ConfigError('설정 파일의 board.task 는 객체여야 한다')
  const kind = body.adapter
  if (typeof kind !== 'string' || !Object.hasOwn(TASK_ADAPTERS, kind)) throw new ConfigError('설정 파일의 board.task.adapter 를 모른다')
  const keys: readonly string[] = TASK_ADAPTER_KEYS[kind as keyof typeof TASK_ADAPTER_KEYS]
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new ConfigError(`설정 파일의 board.task.${key} 는 모르는 키다`)
  return TASK_ADAPTERS[kind](body)
}
export function normalizeRef(adapter: TaskAdapter | null, ref: string): string { return adapter?.kind === 'dooray' && !ref.includes('/') ? `${adapter.project}/${ref}` : ref }
export function urlFromLine(adapter: TaskAdapter | null, line: string): string | null {
  if (!adapter) return null
  for (const match of line.matchAll(/https?:\/\/[^\s<>()「」`'"]+/g)) {
    const value = match[0].replace(/[.,]+$/, '')
    try { if (new URL(value).host === adapter.host) return value } catch {}
  }
  return null
}
export function templateUrl(adapter: Extract<TaskAdapter, { kind: 'url-template' }>, ref: string): string { return adapter.url.replaceAll('{number}', encodeURIComponent(ref).replaceAll('%2F', '/')) }
export function doorayParts(ref: string): { project: string; number: string } | null {
  const at = ref.lastIndexOf('/'); const project = ref.slice(0, at), number = ref.slice(at + 1)
  return at > 0 && /^\d+$/.test(number) ? { project, number } : null
}
