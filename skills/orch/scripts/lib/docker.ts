// 작업이 만든 Docker 컨테이너, 네트워크, 이미지를 귀속을 확인한 것만 지운다.
//
// 무엇을 언제 지우고 무엇을 남기는지는 skills/orch/references/cleanup.md 의 「Docker 자원 반납」 이 소유한다.
// 이 모듈은 그 판정과 실행이다. 부르는 곳은 둘이다.
//   - remove-worktree.ts: 워크트리를 지운 직후 worktrees 에 그 경로를 준다
//   - cleanup-sweep.ts: 저장소마다 config.json 의 docker 절(dockerRules)을 rules 로 준다
//
// 귀속 근거:
//   - 워크트리: 컨테이너의 `com.docker.compose.project.working_dir` 표식이 지운 워크트리 경로이거나 그 아래다.
//     그 컨테이너가 속한 compose 프로젝트의 컨테이너가 모두 그 워크트리 것이면 프로젝트의 네트워크도 지운다.
//     같은 프로젝트 이름을 다른 체크아웃이 쓰면 네트워크를 남긴다
//   - containers 규칙: label 과 name 을 모두 채운 컨테이너다(준 것만 본다). name 정규식에 이름 붙은 묶음 `pid` 가 있으면
//     그 PID 의 프로세스가 없을 때만 지운다. 없으면 멈춘 컨테이너만 지운다. 정규식은 이름 전체에 맞춘다
//   - images 규칙: repository 정규식(전체 일치)에 맞는 태그 가운데, 저장소 이름마다 최근 keep 개와
//     어느 컨테이너(멈춘 것 포함)든 쓰는 이미지를 남기고 나머지 태그를 지운다. `<none>` 태그는 보지 않는다
//
// 지우지 않는 것: 이름 있는 볼륨(컨테이너는 `docker rm -f -v` 로 지워 익명 볼륨만 함께 지운다), build cache,
// 귀속 없는 dangling 이미지와 볼륨. 전역 정리는 mac-cleanup 스킬이 맡는다.
//
// Docker 를 실행하지 못하거나 데몬이 응답하지 않으면 `Docker 정리 건너뜀: <이유>` 한 줄만 내고 돌아온다. 예외를 던지지 않는다.
// 출력 줄은 아래다. dry-run(apply false)이면 `삭제` 대신 `지울 것` 이다.
//   Docker 컨테이너 삭제 <이름> (<id 12자>): <근거>       Docker 컨테이너 남김 <이름> (<id 12자>): <이유>
//   Docker 네트워크 삭제 <이름>: <근거>                    Docker 네트워크 남김 <이름>: <이유>
//   Docker 이미지 삭제 <저장소>:<태그>: <근거>             Docker 이미지 남김 <저장소>:<태그>: <이유>
// 남김 줄은 규칙이나 워크트리에 귀속된 것에만 낸다. 귀속되지 않은 자원은 줄을 내지 않는다.
//
// 환경 변수 DOCKER 로 docker 실행 파일을 바꾼다. 기본 docker.

import { alive as pidAlive } from './process.ts'
import { isObject } from '../core/json.ts'
import { ConfigError, section } from './config.ts'
import type { Config } from './config.ts'
import { run } from './proc.ts'
import type { RunResult } from './proc.ts'

export const DOCKER_KEYS: readonly string[] = ['containers', 'images']
const CONTAINER_RULE_KEYS = ['label', 'name']
const IMAGE_RULE_KEYS = ['repository', 'keep']
const WORKING_DIR = 'com.docker.compose.project.working_dir'
const PROJECT = 'com.docker.compose.project'
const TIMEOUT_MS = 60_000
export const DEFAULT_KEEP = 1

export type ContainerRule = { label: string | null; name: RegExp | null; pattern: string | null }
export type ImageRule = { repository: RegExp; keep: number; source: string }
export type DockerRules = { containers: ContainerRule[]; images: ImageRule[] }

export type Container = {
  id: string
  name: string
  running: boolean
  image: string
  labels: Record<string, string>
}

export type Image = { repository: string; tag: string; id: string; created: string }

export type Runner = (args: string[]) => RunResult
type Log = (line: string) => void

export function dockerBin(): string {
  return process.env.DOCKER || 'docker'
}

const defaultRunner: Runner = (args) => run([dockerBin(), ...args], { timeoutMs: TIMEOUT_MS })

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

function labelMatches(labels: Record<string, string>, label: string): boolean {
  const at = label.indexOf('=')
  if (at < 0) return Object.hasOwn(labels, label)
  return labels[label.slice(0, at)] === label.slice(at + 1)
}

function under(child: string, parent: string): boolean {
  const base = parent.replace(/\/+$/, '')
  return child === base || child.startsWith(`${base}/`)
}
export { alive as pidAlive } from './process.ts'

export type Verdict = { container: Container; remove: boolean; reason: string }

// 워크트리 귀속 판정. 귀속된 컨테이너만 돌려준다. 늘 지운다
export function worktreeContainers(containers: Container[], worktrees: string[]): Verdict[] {
  const out: Verdict[] = []
  for (const container of containers) {
    const dir = container.labels[WORKING_DIR]
    const owner = dir ? worktrees.find((tree) => under(dir, tree)) : undefined
    if (owner) out.push({ container, remove: true, reason: `compose working_dir 이 지운 워크트리 ${owner} 아래다` })
  }
  return out
}

// 규칙 귀속 판정. 어느 규칙에도 맞지 않는 컨테이너는 돌려주지 않는다. 처음 맞은 규칙이 정한다
export function ruleContainers(containers: Container[], rules: ContainerRule[], alive: (pid: number) => boolean = pidAlive): Verdict[] {
  const out: Verdict[] = []
  for (const container of containers) {
    for (const rule of rules) {
      if (rule.label && !labelMatches(container.labels, rule.label)) continue
      const named = rule.name ? rule.name.exec(container.name) : null
      if (rule.name && !named) continue
      const pidText = named?.groups?.pid
      const by = [rule.label && `표식 ${rule.label}`, rule.pattern && `이름 ${rule.pattern}`].filter(Boolean).join(', ')
      if (pidText !== undefined) {
        const pid = Number(pidText)
        if (!/^\d+$/.test(pidText) || pid <= 0) out.push({ container, remove: false, reason: `${by}: 이름의 PID ${pidText} 를 읽지 못했다` })
        else if (alive(pid)) out.push({ container, remove: false, reason: `${by}: 띄운 프로세스 ${pid} 가 살아 있다` })
        else out.push({ container, remove: true, reason: `${by}: 띄운 프로세스 ${pid} 가 없다` })
      } else if (container.running) {
        out.push({ container, remove: false, reason: `${by}: 실행 중이고 이름에 띄운 PID 가 없다` })
      } else {
        out.push({ container, remove: true, reason: `${by}: 멈춘 컨테이너` })
      }
      break
    }
  }
  return out
}

export type ImageVerdict = { image: Image; remove: boolean; reason: string }

// 이미지 판정. 규칙에 맞는 태그만 돌려준다. containers 는 지울 컨테이너를 뺀 남은 목록이다
export function ruleImages(images: Image[], containers: Container[], rules: ImageRule[]): ImageVerdict[] {
  const users = new Map<string, string>()
  for (const container of containers) users.set(container.image, container.name)
  const groups = new Map<string, { rule: ImageRule; images: Image[] }>()
  for (const image of images) {
    if (image.tag === '<none>' || image.repository === '<none>') continue
    const rule = rules.find((r) => r.repository.test(image.repository))
    if (!rule) continue
    const group = groups.get(image.repository) ?? { rule, images: [] }
    group.images.push(image)
    groups.set(image.repository, group)
  }
  const out: ImageVerdict[] = []
  for (const { rule, images: tags } of groups.values()) {
    // 최근 것이 앞이다. created 는 ISO 8601 이라 문자열 비교로 정렬한다
    tags.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    tags.forEach((image, i) => {
      const user = users.get(image.id)
      if (i < rule.keep) out.push({ image, remove: false, reason: `저장소 ${image.repository} 의 최근 ${rule.keep} 개 안이다` })
      else if (user) out.push({ image, remove: false, reason: `컨테이너 ${user} 가 쓴다` })
      else out.push({ image, remove: true, reason: `규칙 ${rule.source}: 최근 ${rule.keep} 개 밖이고 쓰는 컨테이너가 없다` })
    })
  }
  return out
}

function firstLine(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim()).split('\n')[0] || `종료 코드 ${result.code}`
}

class DockerUnavailable extends Error {}

function call(runner: Runner, args: string[]): RunResult {
  const result = runner(args)
  if (result.code === 127) throw new DockerUnavailable(`${dockerBin()} 를 실행하지 못했다 (${firstLine(result)})`)
  return result
}

function readContainers(runner: Runner): Container[] {
  const ids = call(runner, ['ps', '-aq', '--no-trunc'])
  if (ids.code !== 0) throw new DockerUnavailable(`컨테이너 목록을 읽지 못했다 (${firstLine(ids)})`)
  const list = ids.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!list.length) return []
  const inspected = call(runner, ['container', 'inspect', ...list])
  // 목록과 inspect 사이에 사라진 컨테이너가 있으면 종료 코드가 1 이어도 나머지는 JSON 으로 나온다
  let rows: unknown
  try {
    rows = JSON.parse(inspected.stdout || '[]')
  } catch {
    throw new DockerUnavailable(`컨테이너 정보를 읽지 못했다 (${firstLine(inspected)})`)
  }
  if (!Array.isArray(rows)) throw new DockerUnavailable('컨테이너 정보가 목록이 아니다')
  return rows.filter(isObject).map((row) => {
    const config = isObject(row.Config) ? row.Config : {}
    const state = isObject(row.State) ? row.State : {}
    const labels = isObject(config.Labels) ? (config.Labels as Record<string, string>) : {}
    return {
      id: String(row.Id ?? ''),
      name: String(row.Name ?? '').replace(/^\//, ''),
      running: state.Running === true,
      image: String(row.Image ?? ''),
      labels,
    }
  })
}

function readImages(runner: Runner): Image[] {
  const listed = call(runner, ['image', 'ls', '--no-trunc', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}'])
  if (listed.code !== 0) throw new DockerUnavailable(`이미지 목록을 읽지 못했다 (${firstLine(listed)})`)
  const rows = listed.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length >= 3)
  const ids = [...new Set(rows.map((cols) => cols[2]))]
  const created = new Map<string, string>()
  if (ids.length) {
    const inspected = call(runner, ['image', 'inspect', '--format', '{{.Id}}\t{{.Created}}', ...ids])
    for (const line of inspected.stdout.split('\n')) {
      const [id, at] = line.split('\t')
      if (id && at) created.set(id, at)
    }
  }
  return rows.map(([repository, tag, id]) => ({ repository, tag, id, created: created.get(id) ?? '' }))
}

const short = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12)

export type CleanupOptions = {
  worktrees?: string[]
  rules?: DockerRules
  apply: boolean
  log: Log
  runner?: Runner
  alive?: (pid: number) => boolean
}

// 지운 컨테이너의 compose 프로젝트 가운데 모든 컨테이너가 지운 워크트리 것인 프로젝트의 네트워크를 지운다
function removeNetworks(runner: Runner, projects: Set<string>, opts: CleanupOptions): void {
  const verb = opts.apply ? '삭제' : '지울 것'
  for (const project of [...projects].sort()) {
    const listed = call(runner, ['network', 'ls', '--filter', `label=${PROJECT}=${project}`, '--format', '{{.ID}}\t{{.Name}}'])
    if (listed.code !== 0) {
      opts.log(`Docker 네트워크 남김 ${project}: 목록을 읽지 못했다 (${firstLine(listed)})`)
      continue
    }
    for (const line of listed.stdout.split('\n')) {
      const [id, name] = line.split('\t')
      if (!id) continue
      if (!opts.apply) {
        opts.log(`Docker 네트워크 ${verb} ${name}: compose 프로젝트 ${project}`)
        continue
      }
      const removed = call(runner, ['network', 'rm', id])
      if (removed.code === 0) opts.log(`Docker 네트워크 ${verb} ${name}: compose 프로젝트 ${project}`)
      else opts.log(`Docker 네트워크 남김 ${name}: 삭제 실패 (${firstLine(removed)})`)
    }
  }
}

// 판정하고 지운다. 머리 주석의 출력 줄을 log 로 낸다. Docker 를 쓸 수 없으면 한 줄 경고만 낸다
export function dockerCleanup(opts: CleanupOptions): void {
  const runner = opts.runner ?? defaultRunner
  const worktrees = opts.worktrees ?? []
  const rules = opts.rules ?? { containers: [], images: [] }
  if (!worktrees.length && !rules.containers.length && !rules.images.length) return
  const verb = opts.apply ? '삭제' : '지울 것'
  try {
    const containers = readContainers(runner)
    const verdicts = [...worktreeContainers(containers, worktrees)]
    const seen = new Set(verdicts.map((v) => v.container.id))
    for (const v of ruleContainers(containers, rules.containers, opts.alive)) if (!seen.has(v.container.id)) verdicts.push(v)
    const gone = new Set<string>()
    for (const { container, remove, reason } of verdicts) {
      const label = `${container.name} (${short(container.id)})`
      if (!remove) {
        opts.log(`Docker 컨테이너 남김 ${label}: ${reason}`)
        continue
      }
      if (opts.apply) {
        const removed = call(runner, ['rm', '-f', '-v', container.id])
        if (removed.code !== 0) {
          opts.log(`Docker 컨테이너 남김 ${label}: 삭제 실패 (${firstLine(removed)})`)
          continue
        }
      }
      gone.add(container.id)
      opts.log(`Docker 컨테이너 ${verb} ${label}: ${reason}`)
    }
    const projects = new Set<string>()
    for (const v of worktreeContainers(containers, worktrees)) {
      const project = v.container.labels[PROJECT]
      if (!project || !gone.has(v.container.id)) continue
      const others = containers.filter((c) => c.labels[PROJECT] === project && !gone.has(c.id))
      if (others.length) opts.log(`Docker 네트워크 남김 ${project}: 같은 compose 프로젝트의 다른 컨테이너 ${others.map((c) => c.name).join(', ')} 가 있다`)
      else projects.add(project)
    }
    removeNetworks(runner, projects, opts)
    if (!rules.images.length) return
    const left = containers.filter((c) => !gone.has(c.id))
    for (const { image, remove, reason } of ruleImages(readImages(runner), left, rules.images)) {
      const ref = `${image.repository}:${image.tag}`
      if (!remove) {
        opts.log(`Docker 이미지 남김 ${ref}: ${reason}`)
        continue
      }
      if (opts.apply) {
        const removed = call(runner, ['image', 'rm', ref])
        if (removed.code !== 0) {
          opts.log(`Docker 이미지 남김 ${ref}: 삭제 실패 (${firstLine(removed)})`)
          continue
        }
      }
      opts.log(`Docker 이미지 ${verb} ${ref}: ${reason}`)
    }
  } catch (e) {
    if (!(e instanceof DockerUnavailable)) throw e
    opts.log(`Docker 정리 건너뜀: ${e.message}`)
  }
}

// 짧은 출력(lib/output.ts)에서 위 정리 줄을 판정 줄로 바꾼다. Docker 줄이 아니면 undefined 다.
// cleanup-sweep 과 remove-worktree 가 같은 규칙을 쓴다. 남김 줄의 이유에 든 「삭제 실패」 는 남김으로 본다
export function dockerShortLine(line: string): string | null | undefined {
  const text = line.trim()
  let m = /^Docker (?:네트워크|컨테이너|이미지) 남김 (\S+?):? (.*)$/.exec(text)
  if (m) return `KEPT docker:${m[1]} ${m[2]}`
  m = /^Docker (?:네트워크|컨테이너|이미지) 삭제 (\S+?):/.exec(text)
  if (m) return `REMOVED docker:${m[1]}`
  m = /^Docker (?:네트워크|컨테이너|이미지) 지울 것 (\S+?):/.exec(text)
  if (m) return `WOULD-REMOVE docker:${m[1]}`
  m = /^Docker 정리 건너뜀: (.*)$/.exec(text)
  if (m) return `KEPT docker ${m[1]}`
  return undefined
}
