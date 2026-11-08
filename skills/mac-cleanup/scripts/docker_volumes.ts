#!/usr/bin/env node
// 이름이 64자리 hex 인 dangling 익명 volume 을 후보와 최근 생성으로 나눈다. 읽기 전용이다.
//
// 사용법:
//   docker_volumes.ts [--recent-hours 24] [--peek N|all] [--peek-image IMAGE] [--json] [--json-out FILE]
//
// --peek N 은 후보 중 큰 순서로 N개의 최상위 항목을 보인다. `all` 이면 후보를 모두 연다. 이미 있는 이미지로 컨테이너를 잠깐 띄워
// volume 을 읽기 전용으로 붙여 `ls -A` 만 돌리고, 이미지를 pull 하지 않으며 네트워크를 끊는다.
// --peek-image 가 없으면 로컬 이미지 중 alpine, busybox, debian, ubuntu 를 고른다.
// 기준 시간 안에 생긴 volume 은 "최근" 으로 따로 보이고 후보 합계에 넣지 않는다.
// ryuk 컨테이너가 떠 있으면 다른 세션이 테스트 중이라는 경고를 먼저 낸다.
// 크기는 `docker system df -v` 의 VOLUME 표에서 얻는다. 단위는 Docker 와 같은 10진수다.
// 열어 본 volume 에는 내용 종류(kind)를 붙인다: postgres, mysql, other. 열지 않은 volume 의 kind 는 JSON 에서 null 이다.
// --json-out FILE 은 텍스트를 출력하면서 같은 조사 결과를 JSON 으로 파일에 쓴다. 지우기는 `delete_volumes.ts` 가 이 파일을 읽는다.
//
// 종료 코드: 0 조사 완료, 1 docker 를 쓸 수 없음.

import { writeFileSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { isMain, rjust, runText, write } from './io.ts'
import { PY_SPACE, pyHead, pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'
import { dumpJson, formatLocal, fromIsoFormat, loadJson, osErrorMessage, parsePyFloat, parsePyInt, PyFloat, pyFixed, pyG, pyTime, splitWhitespace } from './pylike.ts'

const USAGE = `usage: docker_volumes.ts [-h] [--recent-hours RECENT_HOURS] [--peek N|all]
                         [--peek-image PEEK_IMAGE] [--json] [--json-out FILE]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
이름이 64자리 hex 인 dangling 익명 volume 을 후보와 최근 생성으로 나눈다. 읽기 전용이다.

options:
  -h, --help            show this help message and exit
  --recent-hours RECENT_HOURS
  --peek N|all
  --peek-image PEEK_IMAGE
  --json
  --json-out FILE
`

export const KINDS = ['postgres', 'mysql', 'other']
const UNITS: Record<string, number> = { B: 1, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4 }
const SIZE_RE = new RegExp(`^([0-9.]+)${PY_SPACE}*([kKMGT]?B)(?=\\n?$)`)
const PEEK_PREFERENCE = ['alpine', 'busybox', 'debian', 'ubuntu']
const MYSQL_MARKERS = ['ibdata1', '#innodb_redo', 'mysql', 'auto.cnf']

const ENTRY: Entry = {
  prog: 'docker_volumes.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [
      { name: 'recent-hours', value: true, float: true },
      { name: 'peek', value: true, check: (text) => (peekCount(text) === null ? '정수 또는 all 이어야 한다' : null) },
      { name: 'peek-image', value: true },
      { name: 'json', value: false },
      { name: 'json-out', value: true },
    ],
    positionals: [],
  },
}

export class DockerError extends Error {}

// docker 명령의 표준 출력. 실행하지 못하거나 시간이 넘거나 종료 코드가 0 이 아니면 DockerError 다(옛 구현의 RuntimeError, OSError, TimeoutExpired)
export function docker(args: string[], timeoutSec = 120): string {
  const done = runText(['docker', ...args], { timeoutSec })
  if (done.failure) throw new DockerError(done.message)
  if (done.code !== 0) throw new DockerError(done.stderr.trim())
  return done.stdout
}

// 이름이 소문자 hex 64자리이면 익명 volume 이다
export function isAnonymous(name: string): boolean {
  return /^[0-9a-f]{64}(?=\n?$)/.test(name)
}

// `256.6MB`, `0B`, `12kB` 를 바이트로 바꾼다. 알아볼 수 없으면 null 이다
export function parseSize(text: string | null | undefined): number | null {
  const m = SIZE_RE.exec(pyStrip(text ?? ''))
  if (!m) return null
  return Math.trunc(parsePyFloat(m[1]) * UNITS[m[2].toUpperCase()])
}

export function formatSize(num: number): string {
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (num < 1000) return unit === 'B' ? `${pyFixed(num, 0)}${unit}` : `${pyFixed(num, 1)}${unit}`
    num /= 1000
  }
  return `${pyFixed(num, 1)}TB`
}

// `2026-10-14T22:14:51+09:00` 를 epoch 초로 바꾼다. 알아볼 수 없으면 null 이다
export function parseCreated(text: unknown): number | null {
  return fromIsoFormat(text)
}

export type Volume = { name: string; created_ts: number | null; size_bytes: number | null; class: string; kind?: string | null; top_entries?: string[] | null; peek_error?: string | null }

// 생성 시각을 모르거나 기준 시간 안이면 '최근', 아니면 '후보' 다
export function classifyVolume(vol: { created_ts: number | null }, now: number, recentHours: number): string {
  const ts = vol.created_ts
  if (ts === null || now - ts < recentHours * 3600) return '최근'
  return '후보'
}

// dangling volume 이름 목록과 생성 시각, 크기 표로 익명 volume 항목을 만든다. 큰 순서로 정렬한다
export function buildVolumes(names: string[], created: Map<string, number | null>, sizes: Map<string, number | null>, now: number, recentHours: number): Volume[] {
  const items: Volume[] = []
  for (const name of names) {
    if (!isAnonymous(name)) continue
    const vol: Volume = { name, created_ts: created.get(name) ?? null, size_bytes: sizes.get(name) ?? null, class: '' }
    vol.class = classifyVolume(vol, now, recentHours)
    items.push(vol)
  }
  return items.sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0) || pyStrCompare(a.name, b.name))
}

// 최상위 항목 이름 목록으로 내용 종류를 정한다. PG_VERSION 이 있으면 postgres, MySQL 표지가 있으면 mysql, 아니면 other 다
export function classifyKind(entries: string[]): string {
  const names = new Set(entries)
  if (names.has('PG_VERSION')) return 'postgres'
  if (MYSQL_MARKERS.some((m) => names.has(m))) return 'mysql'
  return 'other'
}

// 열어 본(kind 가 있는) 후보의 종류별 개수와 크기를 더한다
export function summarizeKinds(items: Volume[]): Record<string, { count: number; size_bytes: number }> {
  const out: Record<string, { count: number; size_bytes: number }> = {}
  for (const vol of items) {
    if (vol.class !== '후보' || vol.kind === null || vol.kind === undefined) continue
    const slot = (out[vol.kind] ??= { count: 0, size_bytes: 0 })
    slot.count += 1
    slot.size_bytes += vol.size_bytes ?? 0
  }
  return out
}

// `--peek` 값. 정수 또는 `all` 이다. 알아볼 수 없으면 null
export function peekCount(text: string): number | null {
  if (text === 'all') return Infinity
  try {
    return parsePyInt(text)
  } catch {
    return null
  }
}

export function summarize(items: Volume[]): Record<string, { count: number; size_bytes: number }> {
  const out: Record<string, { count: number; size_bytes: number }> = {}
  for (const cls of ['후보', '최근']) {
    const picked = items.filter((v) => v.class === cls)
    out[cls] = { count: picked.length, size_bytes: picked.reduce((sum, v) => sum + (v.size_bytes ?? 0), 0) }
  }
  return out
}

export function hasRyuk(imageLines: string[]): boolean {
  return imageLines.some((line) => line.includes('ryuk'))
}

export function pickPeekImage(refs: string[]): string | null {
  for (const pref of PEEK_PREFERENCE) {
    for (const ref of refs) if (ref.split('/').at(-1)!.split(':')[0] === pref && !ref.endsWith(':<none>')) return ref
  }
  return null
}

// volume 의 최상위 항목을 읽기 전용으로 본다. 실패하면 오류 문장을 돌려준다
function peek(name: string, image: string): [string[] | null, string | null] {
  try {
    const out = docker(['run', '--rm', '--pull=never', '--network', 'none', '-v', `${name}:/v:ro`, '--entrypoint', 'ls', image, '-A', '/v'], 60)
    return [splitWhitespace(out), null]
  } catch (error) {
    return [null, pyHead((error as Error).message, 120)]
  }
}

const lines = pySplitLines

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const recentGiven = args.options['recent-hours'] as string | undefined
  const recentHours = recentGiven === undefined ? 24 : parsePyFloat(recentGiven)
  const peekN = args.options.peek === undefined ? 0 : peekCount(args.options.peek as string)!
  const jsonOut = args.options['json-out'] as string | undefined
  let names: string[]
  let created: Map<string, number | null>
  let sizes: Map<string, number | null>
  let running: string[]
  let refs: string[]
  try {
    names = splitWhitespace(docker(['volume', 'ls', '-f', 'dangling=true', '-q']))
    const anon = names.filter(isAnonymous)
    created = new Map()
    if (anon.length) for (const entry of loadJson(docker(['volume', 'inspect', ...anon])) as Record<string, any>[]) created.set(entry.Name, parseCreated(entry.CreatedAt))
    const df = loadJson(docker(['system', 'df', '-v', '--format', '{{json .Volumes}}'], 300) || '[]') as Record<string, any>[]
    sizes = new Map(df.map((v) => [v.Name, parseSize(v.Size)]))
    running = lines(docker(['ps', '--format', '{{.Image}}']))
    refs = lines(docker(['images', '--format', '{{.Repository}}:{{.Tag}}']))
  } catch (error) {
    write(2, `docker 를 쓸 수 없다: ${(error as Error).message}\n`)
    return 1
  }

  const now = pyTime()
  const items = buildVolumes(names, created, sizes, now, recentHours)
  const totals = summarize(items)
  const ryuk = hasRyuk(running)
  const peeks = new Map<string, [string[] | null, string | null]>()
  const image = (args.options['peek-image'] as string | undefined) ?? pickPeekImage(refs)
  if (peekN > 0) {
    if (!image) write(2, '경고: 내용을 열 로컬 이미지가 없어 --peek 을 건너뛴다. --peek-image 로 지정한다\n')
    else for (const vol of items.filter((v) => v.class === '후보').slice(0, peekN)) peeks.set(vol.name, peek(vol.name, image))
  }

  for (const vol of items) {
    vol.kind = null
    const found = peeks.get(vol.name)
    if (found) {
      vol.top_entries = found[0]
      vol.peek_error = found[1]
      if (vol.top_entries !== null) vol.kind = classifyKind(vol.top_entries)
    }
  }
  const payload = {
    ryuk_running: ryuk,
    recent_hours: recentGiven === undefined ? recentHours : new PyFloat(recentHours),
    peek_image: peeks.size ? image : null,
    totals,
    kind_totals: summarizeKinds(items),
    volumes: items.map((v) => ({ ...v, created_ts: v.created_ts === null ? null : new PyFloat(v.created_ts) })),
  }
  if (jsonOut) {
    try {
      writeFileSync(jsonOut, `${dumpJson(payload)}\n`)
    } catch (error) {
      write(2, `--json-out 파일을 쓸 수 없다: ${osErrorMessage(error, jsonOut)}\n`)
      return 1
    }
  }
  if (args.options.json) {
    write(1, `${dumpJson(payload)}\n`)
    return 0
  }

  if (ryuk) write(1, '경고: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 지우기 전에 사용자에게 알린다\n')
  for (const cls of ['후보', '최근']) {
    const title = cls === '후보' ? '후보(하루 넘은 dangling 익명 volume)' : `최근(${pyG(recentHours)}시간 안, 후보에서 뺀다)`
    write(1, `## ${title}\n`)
    for (const vol of items.filter((v) => v.class === cls)) {
      const made = vol.created_ts ? formatLocal(vol.created_ts) : '-'
      const size = vol.size_bytes !== null ? formatSize(vol.size_bytes) : '?'
      write(1, `${rjust(size, 9)}  ${made}  ${vol.name}\n`)
      const found = peeks.get(vol.name)
      if (found) {
        const [entries, err] = found
        const shown = entries !== null ? `[${vol.kind}] ${entries.slice(0, 12).join(' ')}` : `열지 못함: ${err}`
        write(1, `           내용: ${shown}\n`)
      }
    }
  }
  write(1, '\n## 합계\n')
  for (const cls of ['후보', '최근']) write(1, `${rjust(String(totals[cls].count), 4)}개 ${rjust(formatSize(totals[cls].size_bytes), 9)}  ${cls}\n`)
  const kinds = payload.kind_totals
  if (Object.keys(kinds).length) {
    write(1, '\n## 열어 본 후보의 종류별 합계\n')
    for (const kind of KINDS) if (kind in kinds) write(1, `${rjust(String(kinds[kind].count), 4)}개 ${rjust(formatSize(kinds[kind].size_bytes), 9)}  ${kind}\n`)
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
