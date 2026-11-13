// config.json 의 docker 절을 읽는 판정. Docker 를 부르는 쪽(lib/docker.ts)과 설정 검사표(config-schema.ts)가 함께 쓴다.

import { DOCKER_KEYS, ConfigError, section } from './config.ts'
import type { Config } from './config.ts'
import { isObject } from './json.ts'

export { DOCKER_KEYS }
const CONTAINER_RULE_KEYS = ['label', 'name']
const IMAGE_RULE_KEYS = ['repository', 'keep']
export const DEFAULT_KEEP = 1

export type ContainerRule = { label: string | null; name: RegExp | null; pattern: string | null }
export type ImageRule = { repository: RegExp; keep: number; source: string }
export type DockerRules = { containers: ContainerRule[]; images: ImageRule[] }

function compile(pattern: unknown, where: string): RegExp {
  if (typeof pattern !== 'string' || !pattern) throw new ConfigError(`${where} 는 비지 않은 정규식 문자열이다`)
  try {
    return new RegExp(`^(?:${pattern})$`)
  } catch (e) {
    throw new ConfigError(`${where} 정규식이 틀렸다: ${(e as Error).message}`)
  }
}

function unknownKeys(body: Record<string, unknown>, known: string[], where: string): void {
  const extra = Object.keys(body)
    .filter((key) => !known.includes(key))
    .sort()
  if (extra.length) throw new ConfigError(`${where} 에 모르는 키가 있다: ${extra.join(', ')}`)
}

// config.json 의 docker 절을 읽는다. 절이 없으면 빈 규칙이다. 형식이 틀리면 ConfigError 다.
export function dockerRules(config: Config): DockerRules {
  const body = section<Record<string, unknown>>(config, 'docker', DOCKER_KEYS)
  const list = (key: string): unknown[] => {
    const value = body[key] ?? []
    if (!Array.isArray(value)) throw new ConfigError(`docker.${key} 는 객체 목록이다`)
    return value
  }
  const containers = list('containers').map((raw, i): ContainerRule => {
    const where = `docker.containers[${i}]`
    if (!isObject(raw)) throw new ConfigError(`${where} 는 객체다`)
    unknownKeys(raw, CONTAINER_RULE_KEYS, where)
    if (raw.label === undefined && raw.name === undefined) throw new ConfigError(`${where} 에 label 이나 name 이 있어야 한다`)
    if (raw.label !== undefined && (typeof raw.label !== 'string' || !raw.label || raw.label.startsWith('='))) {
      throw new ConfigError(`${where}.label 은 \`키\` 나 \`키=값\` 꼴의 문자열이다`)
    }
    return {
      label: (raw.label as string | undefined) ?? null,
      name: raw.name === undefined ? null : compile(raw.name, `${where}.name`),
      pattern: (raw.name as string | undefined) ?? null,
    }
  })
  const images = list('images').map((raw, i): ImageRule => {
    const where = `docker.images[${i}]`
    if (!isObject(raw)) throw new ConfigError(`${where} 는 객체다`)
    unknownKeys(raw, IMAGE_RULE_KEYS, where)
    const keep = raw.keep ?? DEFAULT_KEEP
    if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) throw new ConfigError(`${where}.keep 은 0 이상의 정수다`)
    return { repository: compile(raw.repository, `${where}.repository`), keep, source: String(raw.repository) }
  })
  return { containers, images }
}
