#!/usr/bin/env node
// 이 맥에 깔린 컨테이너 런타임을 감지해 런타임마다 이름, 켜짐 여부, context, VM 디스크 파일 크기를 보인다. 읽기 전용이다.
//
// 사용법:
//   container_runtimes.ts [--json-out FILE]
//
// 직접 지원하는 런타임은 아래 RUNTIMES 표 한곳이 소유한다(사람이 읽는 표는 references/runtimes.md).
// 런타임을 더하려면 표에 항목 하나를 더한다. 표에 없는 로컬 unix 소켓은 「알 수 없는 런타임」, ssh·tcp 엔드포인트는 「이 맥 밖의 엔진」 이다.
// 감지는 `docker context ls` 의 엔드포인트와 설치 흔적(앱 번들, 데이터 디렉터리, CLI)을 함께 본다. 꺼진 런타임은 context 가 응답하지 않으므로 설치 흔적이 있어야 보인다.
// 소켓 경로를 심볼릭 링크까지 풀어 같으면 context 를 런타임 하나로 합친다(`default` 가 `desktop-linux` 의 소켓을 가리키는 경우).
// 켜짐은 `docker --context <이름> info` 성공이다. 사용자의 현재 context 설정은 바꾸지 않는다.
// 앱 번들 위치는 환경변수 MAC_CLEANUP_APP_DIRS(`:` 로 구분, 기본 `/Applications:~/Applications`)로 바꾼다. 테스트가 쓴다.
// --json-out FILE 은 텍스트를 출력하면서 같은 결과를 JSON 으로 파일에 쓴다. runtime_start.ts, survey_docker.ts, runtime_reclaim.ts 가 이 파일을 읽는다.
//
// 종료 코드: 0 조사 완료(런타임이 없어도 0), 1 --json-out 파일을 쓸 수 없음.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { isMain, runText, which, write } from './io.ts'
import { pySplitLines, pyStrCompare } from './kit/py.ts'
import { dumpJson, exists, expanduser, loadJson, osErrorMessage, pyResolve } from './pylike.ts'
import { duKb, humanKb } from './survey_system.ts'

const USAGE = `usage: container_runtimes.ts [-h] [--json-out FILE]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
이 맥에 깔린 컨테이너 런타임을 감지해 런타임마다 이름, 켜짐 여부, context, VM 디스크 파일 크기를 보인다. 읽기 전용이다.

options:
  -h, --help       show this help message and exit
  --json-out FILE
`

const ENTRY: Entry = { prog: 'container_runtimes.ts', usage: USAGE, help: HELP, spec: { options: [{ name: 'json-out', value: true }], positionals: [] } }

export type Reclaim = 'fstrim' | 'disk-size' | 'none'
export type Kind = 'docker-desktop' | 'orbstack' | 'colima' | 'unknown' | 'remote'
export type State = 'running' | 'stopped' | 'unresponsive'

// 런타임 정의 한 줄. `~` 는 홈이다. colima 는 프로필마다 한 항목이 되므로 profileTemplate 을 쓴다
export type RuntimeDef = {
  kind: 'docker-desktop' | 'orbstack' | 'colima'
  label: string
  apps: string[] // 앱 번들 이름. MAC_CLEANUP_APP_DIRS 아래에서 찾는다
  dataDirs: string[]
  cli: string | null
  reclaim: Reclaim
}

export const RUNTIMES: RuntimeDef[] = [
  { kind: 'docker-desktop', label: 'Docker Desktop', apps: ['Docker.app'], dataDirs: ['~/Library/Containers/com.docker.docker'], cli: null, reclaim: 'disk-size' },
  { kind: 'orbstack', label: 'OrbStack', apps: ['OrbStack.app'], dataDirs: ['~/.orbstack'], cli: 'orb', reclaim: 'disk-size' },
  { kind: 'colima', label: 'Colima', apps: [], dataDirs: ['~/.colima'], cli: 'colima', reclaim: 'fstrim' },
]

// 런타임 종류와 프로필로 정해지는 값. 표의 값이 한곳에 모이도록 이 함수들이 소유한다
export const socketsOf = (kind: RuntimeDef['kind'], profile: string): string[] =>
  kind === 'docker-desktop' ? ['~/.docker/run/docker.sock', '~/.docker/desktop/docker.sock'] : kind === 'orbstack' ? ['~/.orbstack/run/docker.sock'] : [`~/.colima/${profile}/docker.sock`]
export const contextOf = (kind: RuntimeDef['kind'], profile: string): string => (kind === 'docker-desktop' ? 'desktop-linux' : kind === 'orbstack' ? 'orbstack' : profile === 'default' ? 'colima' : `colima-${profile}`)
export const diskOf = (kind: RuntimeDef['kind'], profile: string): string =>
  kind === 'docker-desktop' ? '~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw' : kind === 'orbstack' ? '~/.orbstack/data/data.img' : `~/.colima/_lima/_disks/${profile === 'default' ? 'colima' : `colima-${profile}`}/datadisk`
export const startOf = (kind: RuntimeDef['kind'], profile: string): string[] => (kind === 'docker-desktop' ? ['open', '-a', 'Docker'] : kind === 'orbstack' ? ['orb', 'start'] : ['colima', 'start', '-p', profile])

export type Runtime = {
  id: string
  kind: Kind
  label: string
  profile: string | null
  state: State
  local: boolean
  context: string | null
  contexts: string[]
  endpoint: string | null
  disk_path: string | null
  disk_bytes: number | null
  start_command: string[] | null
  reclaim: Reclaim
  // 설명이 필요한 상태(예: 기대한 context 이름이 다른 엔진을 가리킴). 없으면 null
  note: string | null
}

type ContextInfo = { name: string; endpoint: string }

const unixPath = (endpoint: string): string | null => (endpoint.startsWith('unix://') ? endpoint.slice('unix://'.length) : null)

// 이 맥 안의 unix 소켓이면 true. ssh, tcp, npipe 와 빈 값은 아니다
export const isLocalEndpoint = (endpoint: string | null | undefined): boolean => !!endpoint && endpoint.startsWith('unix://')

// `docker context ls` 가 보이는 context 와 엔드포인트. docker 를 쓸 수 없으면 빈 목록이다
export function listContexts(): ContextInfo[] {
  const done = runText(['docker', 'context', 'ls', '--format', '{{json .}}'], { timeoutSec: 30, closeStdin: true })
  if (done.failure || done.code !== 0) return []
  const out: ContextInfo[] = []
  for (const text of pySplitLines(done.stdout)) {
    if (!text.trim()) continue
    try {
      const row = loadJson(text) as Record<string, unknown>
      if (typeof row.Name === 'string') out.push({ name: row.Name, endpoint: typeof row.DockerEndpoint === 'string' ? row.DockerEndpoint : '' })
    } catch {
      continue
    }
  }
  return out
}

// 명령이 실제로 쓸 엔드포인트. context 를 줬으면 그 context 의 것이다. 안 줬으면 docker 의 우선순위를 따라 환경변수 DOCKER_CONTEXT(DOCKER_HOST 보다 우선),
// 그다음 DOCKER_HOST, 없으면 현재 context 의 것이다.
// docker 를 실행하지 못하거나 context 를 읽지 못하면 던진다. 값이 비어 있으면 빈 문자열이다(isLocalEndpoint 가 false 라 삭제 도구가 거부한다)
export function contextEndpoint(context: string | null, environ: Record<string, string | undefined> = process.env): string {
  const name = context ?? (environ.DOCKER_CONTEXT || null)
  if (!name && environ.DOCKER_HOST) return environ.DOCKER_HOST
  const done = runText(['docker', 'context', 'inspect', ...(name ? [name] : []), '--format', '{{.Endpoints.docker.Host}}'], { timeoutSec: 30, closeStdin: true })
  if (done.failure) throw new Error(done.message)
  if (done.code !== 0) throw new Error(done.stderr.trim() || 'docker context inspect 가 실패했다')
  return done.stdout.trim()
}

// docker 가 context 로 응답하는지. 켜짐의 정의다
export function dockerResponds(context: string, timeoutSec = 15): boolean {
  const done = runText(['docker', '--context', context, 'info'], { timeoutSec, closeStdin: true })
  return !done.failure && done.code === 0
}

const appDirs = (environ: Record<string, string | undefined> = process.env): string[] => (environ.MAC_CLEANUP_APP_DIRS ?? '/Applications:~/Applications').split(':').filter(Boolean).map(expanduser)

function installed(def: RuntimeDef): boolean {
  if (def.apps.some((app) => appDirs().some((dir) => exists(`${dir}/${app}`)))) return true
  if (def.dataDirs.some((dir) => exists(expanduser(dir)))) return true
  return def.cli !== null && def.kind !== 'colima' && which(def.cli) !== null
}

// 설치된 Colima 프로필 이름. 디스크 디렉터리, 프로필 설정 파일, 그 프로필의 소켓을 가리키는 `colima`/`colima-<프로필>` context 에서 모은다
export function colimaProfiles(contexts: ContextInfo[]): string[] {
  const found = new Set<string>()
  const list = (dir: string): string[] => {
    try {
      return readdirSync(expanduser(dir))
    } catch {
      return []
    }
  }
  for (const name of list('~/.colima/_lima/_disks')) {
    if (name === 'colima') found.add('default')
    else if (name.startsWith('colima-')) found.add(name.slice('colima-'.length))
  }
  for (const name of list('~/.colima')) if (!name.startsWith('_') && exists(expanduser(`~/.colima/${name}/colima.yaml`))) found.add(name)
  // 이름만 colima 로 시작하는 다른 엔진(ssh context 등)이 프로필로 잡히지 않게, 엔드포인트가 그 프로필의 소켓일 때만 인정한다
  for (const ctx of contexts) {
    const profile = ctx.name === 'colima' ? 'default' : ctx.name.startsWith('colima-') && ctx.name.length > 'colima-'.length ? ctx.name.slice('colima-'.length) : null
    const path = unixPath(ctx.endpoint)
    if (profile !== null && path !== null && socketKey(path) === socketKey(socketsOf('colima', profile)[0])) found.add(profile)
  }
  return [...found].sort(pyStrCompare)
}

const socketKey = (path: string): string => pyResolve(expanduser(path))

// 같은 소켓을 가리키는 context 중 명령에 줄 대표. 기대 이름이 있으면 그것, 아니면 `default` 가 아닌 것, 없으면 첫 번째다
function pickContext(names: string[], expected: string | null): string | null {
  if (expected && names.includes(expected)) return expected
  return names.find((n) => n !== 'default') ?? names[0] ?? null
}

function diskInfo(path: string): [string | null, number | null] {
  const real = expanduser(path)
  if (!exists(real)) return [null, null]
  const rows = duKb(['-s', real])
  return [real, rows.length ? rows[0][0] * 1024 : null]
}

type Instance = { def: RuntimeDef; profile: string; id: string; label: string; sockets: string[]; matched: string[] }

// 런타임 목록을 만든다. 종류 순서(Docker Desktop, OrbStack, Colima 프로필 이름순) 뒤에 알 수 없는 런타임, 이 맥 밖의 엔진 순이다
export function detectRuntimes(): Runtime[] {
  const contexts = listContexts()
  const instances: Instance[] = []
  for (const def of RUNTIMES) {
    const profiles = def.kind === 'colima' ? colimaProfiles(contexts) : ['default']
    for (const profile of profiles) {
      instances.push({
        def,
        profile,
        id: def.kind === 'colima' ? `colima:${profile}` : def.kind,
        label: def.kind === 'colima' ? `Colima 프로필 ${profile}` : def.label,
        sockets: socketsOf(def.kind, profile).map(socketKey),
        matched: [],
      })
    }
  }
  const unknownByKey = new Map<string, string[]>()
  const remote: ContextInfo[] = []
  const localEndpoint = new Map<string, string>()
  for (const ctx of contexts) {
    localEndpoint.set(ctx.name, ctx.endpoint)
    const path = unixPath(ctx.endpoint)
    if (path === null) {
      if (ctx.endpoint) remote.push(ctx)
      continue
    }
    const key = socketKey(path)
    const owner = instances.find((i) => i.sockets.includes(key))
    if (owner) owner.matched.push(ctx.name)
    else if (!(ctx.name === 'default' && !exists(key))) unknownByKey.set(key, [...(unknownByKey.get(key) ?? []), ctx.name])
  }

  const out: Runtime[] = []
  for (const inst of instances) {
    const { def, profile } = inst
    const traced = def.kind === 'colima' ? true : installed(def)
    if (!traced && inst.matched.length === 0) continue
    const expected = contextOf(def.kind, profile)
    const [diskPath, diskBytes] = diskInfo(diskOf(def.kind, profile))
    let context = pickContext(inst.matched, expected)
    if (context === null) {
      // 소켓이 맞는 context 가 없다. 기대한 이름이 아직 없으면 런타임이 켜질 때 만들 이름이라 그대로 쓴다.
      // 이름이 이미 다른 엔드포인트(원격이나 다른 로컬 소켓)에 쓰이면 그 엔진을 이 런타임으로 오인하지 않도록 context 없이 두고 켜지도 않는다
      const owner = contexts.find((c) => c.name === expected)
      if (owner) {
        out.push({
          id: inst.id, kind: def.kind, label: inst.label, profile: def.kind === 'colima' ? profile : null, state: 'stopped', local: true, context: null, contexts: [], endpoint: null,
          disk_path: diskPath, disk_bytes: diskBytes, start_command: null, reclaim: def.reclaim,
          note: `기대한 context ${expected} 가 이 런타임의 소켓이 아닌 ${owner.endpoint} 를 가리켜 조사하지 않는다`,
        })
        continue
      }
      context = expected
    }
    out.push({
      id: inst.id,
      kind: def.kind,
      label: inst.label,
      profile: def.kind === 'colima' ? profile : null,
      state: dockerResponds(context) ? 'running' : 'stopped',
      local: true,
      context,
      contexts: inst.matched.length ? [...inst.matched].sort(pyStrCompare) : [context],
      endpoint: localEndpoint.get(context) ?? `unix://${expanduser(socketsOf(def.kind, profile)[0])}`,
      disk_path: diskPath,
      disk_bytes: diskBytes,
      start_command: startOf(def.kind, profile),
      reclaim: def.reclaim,
      note: null,
    })
  }
  for (const names of unknownByKey.values()) {
    const context = pickContext([...names].sort(pyStrCompare), null)!
    out.push({ id: `unknown:${context}`, kind: 'unknown', label: '알 수 없는 런타임', profile: null, state: dockerResponds(context) ? 'running' : 'unresponsive', local: true, context, contexts: [...names].sort(pyStrCompare), endpoint: localEndpoint.get(context) ?? null, disk_path: null, disk_bytes: null, start_command: null, reclaim: 'none', note: null })
  }
  const remoteSeen = new Set<string>()
  for (const ctx of remote) {
    if (remoteSeen.has(ctx.endpoint)) continue
    remoteSeen.add(ctx.endpoint)
    const names = remote.filter((c) => c.endpoint === ctx.endpoint).map((c) => c.name).sort(pyStrCompare)
    const context = pickContext(names, null)!
    out.push({ id: `remote:${context}`, kind: 'remote', label: '이 맥 밖의 엔진', profile: null, state: dockerResponds(context) ? 'running' : 'unresponsive', local: false, context, contexts: names, endpoint: ctx.endpoint, disk_path: null, disk_bytes: null, start_command: null, reclaim: 'none', note: null })
  }
  return out
}

export const STATE_TEXT: Record<State, string> = { running: '켜짐', stopped: '꺼짐', unresponsive: '응답 없음' }

// 런타임 하나의 출력 줄들. dfText 가 있으면 `docker system df` 결과를 들여써 붙인다
export function describeRuntime(rt: Runtime, dfText: string | null = null): string[] {
  const lines = [`${rt.id}  ${rt.label}  ${STATE_TEXT[rt.state]}`]
  const same = rt.contexts.filter((c) => c !== rt.context)
  lines.push(`  context: ${rt.context ?? '-'}${same.length ? ` (같은 소켓으로 합친 context: ${same.join(', ')})` : ''}`)
  if (rt.kind === 'remote') lines.push(`  엔드포인트: ${rt.endpoint}`)
  if (rt.disk_path) lines.push(`  VM 디스크 파일: ${rt.disk_path}  ${rt.disk_bytes === null ? '?' : humanKb(rt.disk_bytes / 1024)}`)
  else if (rt.local && rt.kind !== 'unknown') lines.push('  VM 디스크 파일: 찾지 못함')
  if (rt.note) lines.push(`  주의: ${rt.note}`)
  if (rt.state === 'stopped' && rt.start_command) {
    lines.push(`  켜는 명령: ${rt.start_command.join(' ')}`)
    lines.push(`  켜서 조사하기: 승인 묶음 후보${rt.disk_bytes === null ? '' : `(VM 디스크 ${humanKb(rt.disk_bytes / 1024)})`}`)
  }
  if (rt.kind === 'unknown') lines.push('  디스크 회수는 사용자 몫이다. 이 스킬은 하지 않는다. docker CLI 로 조사와 정리는 한다')
  if (rt.kind === 'remote') lines.push('  이 맥 밖의 엔진이다. 크기만 보이고 승인 묶음과 삭제 대상에 넣지 않는다')
  if (dfText) for (const line of pySplitLines(dfText.trimEnd())) lines.push(`    ${line}`)
  return lines
}

// 파일의 runtimes 를 읽는다. 형식이 맞지 않으면 던진다
export function readRuntimesFile(path: string): Runtime[] {
  const data = loadJson(readFileSync(path, 'utf8')) as { runtimes?: unknown }
  const list = data?.runtimes
  if (!Array.isArray(list) || list.some((r) => r === null || typeof r !== 'object' || typeof (r as Runtime).id !== 'string' || typeof (r as Runtime).kind !== 'string')) throw new Error('container_runtimes.ts --json-out 형식이 아니다')
  return list as Runtime[]
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const runtimes = detectRuntimes()
  const jsonOut = args.options['json-out'] as string | undefined
  if (jsonOut) {
    try {
      writeFileSync(jsonOut, `${dumpJson({ runtimes })}\n`)
    } catch (error) {
      write(2, `--json-out 파일을 쓸 수 없다: ${osErrorMessage(error, jsonOut)}\n`)
      return 1
    }
  }
  write(1, '## 컨테이너 런타임\n')
  if (runtimes.length === 0) write(1, '감지한 런타임 없음\n')
  for (const rt of runtimes) {
    let df: string | null = null
    if (rt.state === 'running' && rt.context) {
      const done = runText(['docker', '--context', rt.context, 'system', 'df'], { timeoutSec: 60, closeStdin: true })
      if (!done.failure && done.code === 0) df = done.stdout
    }
    write(1, `${describeRuntime(rt, df).join('\n')}\n`)
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
