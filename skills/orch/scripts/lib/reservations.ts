// 마이그레이션 번호 예약(docs/adr/017-orch-migration-reserve.md)과 ADR 번호 예약의 파일, 잠금, 번호 판정을 이 모듈 한 곳이 소유한다.
// 명령은 reserve-migration.ts, 읽기만 하는 쪽은 상주 루프의 자동 머지다. 자동 머지는 마이그레이션 예약만 읽는다.
//
// 파일: 예약 종류(ReservationStore)마다 하나다. 마이그레이션은 <orch 루트>/state/migration-reservations.json,
//   ADR 은 같은 폴더의 adr-reservations.json 이다. ADR 예약을 따로 두는 것은 자동 머지가 ADR 번호를 마이그레이션 번호로 세지 않게 하려는 것이다.
//   {"reservations": [{"module", "version"(숫자 목록), "label"(`V13`, ADR 은 `ADR-084`), "branch", "name"(파일 이름의 설명 조각),
//   "path"(저장소 루트 기준 파일 경로), "at"(ISO 8601 UTC)}]}
//   (module, version) 은 한 항목에만 있고, (branch, module, name) 도 한 항목에만 있다(docs/data-schema.md 의 행). 두 파일의 module 은 서로 다른 이름 공간이다.
//   name 은 받은 설명을 migrationName 으로 바꾼 값이다. SQL 은 slug, Java 는 받은 이름 그대로, ADR 은 adrSlug 다. 같은 예약인지 이 값으로 가린다.
//   쓰는 쪽은 잠금 안에서 옆 파일(<파일>.<pid>.tmp)에 쓰고 rename 한다. 읽는 쪽은 잠금 없이 읽어도 반쯤 쓴 파일을 보지 않는다.
//   쓰기나 rename 이 실패하면 옆 파일을 지우고(실패는 무시) 그 오류를 다시 던진다.
//   최상위가 틀리면(JSON 이 아님, reservations 목록이 없음) Error 다. 부르는 쪽은 읽지 못한 것으로 다룬다.
//   형식이 맞지 않는 항목은 건너뛰고 skipped 로 센다. 다음 쓰기에서 빠진다.
//
// 잠금: 같은 폴더의 migration-reservations.lock 하나가 두 파일을 함께 지킨다. 경로는 lockFile 이 정하고, 잡고 푸는 일은 reserve-migration.ts 가
//   lib/events.ts 의 acquireLock, ownsLock, releaseLock 으로 한다(wx 로 만들고 pid 를 적는다. 죽은 pid 는 reclaim 으로 회수한다).
//   보장 범위도 그 파일의 「잠금」 과 같다.
//
// ADR 번호(adrOf): ADR 폴더 바로 아래의 `<숫자>-<설명>.md` 다. 하위 폴더의 파일과 INDEX.md 처럼 숫자로 시작하지 않는 파일은 세지 않는다.
//   폴더마다 번호가 따로다. label 은 `ADR-` 뒤에 파일 이름의 숫자를 그대로 붙인다(`084-x.md` 는 `ADR-084`).
//   새 번호의 자릿수는 그 폴더에서 센 번호 가운데 가장 긴 자릿수이고, 센 번호가 없으면 3 이다. 번호가 그보다 길면 그 길이를 쓴다.
//
// 판정:
//   - nextVersion  그 모듈의 version[0] 최대값에 1 을 더한 [n] 과 V<n>. 없으면 [1], V1.
//                  V1_2 처럼 자리가 여럿이어도 새 번호는 V2 다. Flyway 는 V2 를 V1_2 보다 뒤로 정렬한다
//   - choose       같은 (branch, module, name) 예약이 있고 again 이 아니면 그 예약을 다시 쓴다(reused).
//                  그 번호가 base 최고 이하가 됐거나 다른 브랜치의 열린 PR 이나 다른 예약과 같은 번호면 새로 정한다(renewed).
//                  예약의 경로가 이번에 받은 폴더와 종류로 만든 경로와 다르면(SQL 로 받고 Java 로 다시 부름) 새로 정한다(renewed).
//                  새로 정할 때는 base 최고, 열린 PR 이 더한 그 모듈 파일, 다시 정하는 예약을 뺀 남은 예약을 모두 센다.
//                  같은 브랜치의 열린 PR 파일도 세되, 다시 정하는 예약과 같은 (모듈, 번호)인 파일 하나는 뺀다. 그 예약으로 만든 파일이다.
//                  kind 가 adr 이면 label 과 경로를 위 「ADR 번호」 꼴로 만든다. 부르는 쪽은 ADR 예약 파일의 목록을 넘긴다
//   - prune        gone 이 true 인 항목만 지운다. null(판정 못 함)과 false 는 남긴다. 지우면 그 번호가 다시 나가기 때문이다

import { isObject } from '../core/json.ts'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compareVersion } from './auto-merge.ts'
import type { Migration } from './auto-merge.ts'
import { ADR_KEYS, ConfigError, section } from './config.ts'
import type { Config } from './config.ts'
import { makeParent, pathOf } from './paths.ts'

export type Reservation = { module: string; version: number[]; label: string; branch: string; name: string; path: string; at: string }

// gh 의 files 행 가운데 더한 파일로 보는 changeType. 없는 행도 더한 파일로 본다
const ADDED_CHANGES: ReadonlySet<string> = new Set(['ADDED', 'RENAMED', 'COPIED'])

// 예약 파일의 종류. 마이그레이션 예약은 자동 머지가 읽고, ADR 예약은 reserve-migration.ts 만 읽는다
export type ReservationStore = 'migration' | 'adr'

const STORE_FILES: Record<ReservationStore, string> = { migration: 'migration-reservations.json', adr: 'adr-reservations.json' }

export function reservationsFile(repo: string, store: ReservationStore = 'migration'): string {
  return join(pathOf('state', repo), STORE_FILES[store])
}

export function lockFile(repo: string): string {
  return join(dirname(reservationsFile(repo)), 'migration-reservations.lock')
}

function isReservation(value: unknown): value is Reservation {
  if (!isObject(value)) return false
  const text = (key: string) => typeof value[key] === 'string' && value[key] !== ''
  const version = value.version
  return (
    ['module', 'label', 'branch', 'name', 'path', 'at'].every(text) &&
    Array.isArray(version) &&
    version.length > 0 &&
    version.every((n) => Number.isInteger(n) && n >= 0)
  )
}

export function readReservations(repo: string, store: ReservationStore = 'migration'): { list: Reservation[]; skipped: number } {
  const file = reservationsFile(repo, store)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { list: [], skipped: 0 }
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`${file} 가 JSON 이 아니다: ${(e as Error).message}`)
  }
  if (!isObject(parsed) || !Array.isArray(parsed.reservations)) throw new Error(`${file} 의 최상위는 {"reservations": [...]} 여야 한다`)
  const list = parsed.reservations.filter(isReservation)
  return { list, skipped: parsed.reservations.length - list.length }
}

export function writeReservations(repo: string, list: Reservation[], store: ReservationStore = 'migration'): void {
  const file = reservationsFile(repo, store)
  makeParent(file, repo)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify({ reservations: list }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // 옆 파일이 없거나 지우지 못했다. 원래 오류를 던지는 것이 먼저다
    }
    throw e
  }
}

export function addedPaths(files: unknown): string[] {
  const found: string[] = []
  if (!Array.isArray(files)) return found
  for (const file of files) {
    if (!isObject(file) || typeof file.path !== 'string') continue
    if (typeof file.changeType === 'string' && !ADDED_CHANGES.has(file.changeType)) continue
    found.push(file.path)
  }
  return found
}

export type MigrationKind = 'sql' | 'java'
// 예약 종류. adr 은 마이그레이션이 아니라 ADR 문서 번호다
export type ReserveKind = MigrationKind | 'adr'

const EXTENSIONS: Record<MigrationKind, string> = { sql: '.sql', java: '.java' }
const ADR_FILE = /^(\d+)-[^/]+\.md$/
const ADR_WIDTH = 3
// Java 마이그레이션의 설명 조각. 파일 이름이 클래스 이름(V<버전>__<이름>)이라 ASCII Java 식별자만 받는다
const JAVA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// 공백과 - 는 _ 로 바꾸고 영문 소문자, 숫자, _ 밖의 글자는 지운다. 이어진 _ 는 하나로 줄이고 앞뒤의 _ 는 뗀다
export function slug(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[\s-]/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (!out) throw new Error(`설명을 파일 이름 조각으로 바꾸면 빈다: ${JSON.stringify(name)}. 영문이나 숫자로 준다`)
  return out
}

// ADR 파일 이름 조각. 공백과 _ 는 - 로 바꾸고 영문 소문자, 숫자, - 밖의 글자는 지운다. 이어진 - 는 하나로 줄이고 앞뒤의 - 는 뗀다
export function adrSlug(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[\s_]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!out) throw new Error(`설명을 파일 이름 조각으로 바꾸면 빈다: ${JSON.stringify(name)}. 영문이나 숫자로 준다`)
  return out
}

// SQL 은 slug 로 바꾸고, Java 는 대소문자를 지킨 채 식별자인지만 보고, ADR 은 adrSlug 로 바꾼다. 아니면 Error
export function migrationName(name: string, kind: ReserveKind): string {
  if (kind === 'sql') return slug(name)
  if (kind === 'adr') return adrSlug(name)
  if (!JAVA_NAME.test(name)) {
    throw new Error(`Java 마이그레이션 이름은 영문자나 _ 로 시작하고 영문자, 숫자, _ 만 쓰는 Java 식별자여야 한다: ${JSON.stringify(name)}. 예: GroupSettingBackfill`)
  }
  return name
}

export function migrationPath(dir: string, label: string, name: string, kind: ReserveKind): string {
  if (kind === 'adr') return `${dir}/${label.slice('ADR-'.length)}-${name}.md`
  return `${dir}/${label}__${name}${EXTENSIONS[kind]}`
}

// ADR 폴더 바로 아래의 번호 붙은 ADR. dirs 는 모듈 이름에서 폴더로 간다. 머리 주석의 「ADR 번호」
export function adrOf(path: string, dirs: Record<string, string>): Migration | null {
  const slash = path.lastIndexOf('/')
  const parent = slash < 0 ? '' : path.slice(0, slash)
  for (const [module, dir] of Object.entries(dirs)) {
    if (parent !== dir) continue
    const m = ADR_FILE.exec(path.slice(slash + 1))
    return m ? { module, version: [Number(m[1])], label: `ADR-${m[1]}`, path } : null
  }
  return null
}

// 센 ADR 가운데 가장 긴 번호 자릿수. 없으면 3 이다
function adrWidth(module: string, taken: Migration[]): number {
  let width = 0
  for (const m of taken) if (m.module === module && m.label.startsWith('ADR-')) width = Math.max(width, m.label.length - 'ADR-'.length)
  return width || ADR_WIDTH
}

// orch 설정의 adr.dirs. 모듈 이름에서 저장소 루트 기준 폴더로 간다. 값이 틀리면 ConfigError 다
export function adrDirs(config: Config): Record<string, string> {
  const adr = section<Record<string, unknown>>(config, 'adr', ADR_KEYS)
  if (adr.dirs === undefined) return {}
  if (!isObject(adr.dirs)) throw new ConfigError('설정 파일의 adr.dirs 는 객체여야 한다')
  const dirs: Record<string, string> = {}
  for (const [module, value] of Object.entries(adr.dirs)) {
    const dir = typeof value === 'string' ? value.replace(/\/+$/, '') : ''
    if (!dir) throw new ConfigError(`설정 파일의 adr.dirs.${module} 는 저장소 루트 기준 폴더여야 한다: ${JSON.stringify(value)}`)
    dirs[module] = dir
  }
  return dirs
}

export function nextVersion(module: string, taken: Migration[]): { version: number[]; label: string } {
  let max = 0
  for (const m of taken) if (m.module === module && m.version[0] > max) max = m.version[0]
  return { version: [max + 1], label: `V${max + 1}` }
}

function same(a: { module: string; version: number[] }, b: { module: string; version: number[] }): boolean {
  return a.module === b.module && compareVersion(a.version, b.version) === 0
}

export function choose(input: {
  module: string
  name: string
  branch: string
  again: boolean
  dir: string
  // 기본 sql. java 면 name 을 대소문자 그대로 쓰고 .java 경로를, adr 이면 `<번호>-<adrSlug>.md` 경로를 낸다
  kind?: ReserveKind
  at: string
  baseMax: Migration | null
  open: { branch: string; migrations: Migration[] }[]
  reservations: Reservation[]
}): { reservation: Reservation; reused: boolean; renewed: boolean; list: Reservation[] } {
  const { module, branch, baseMax, open, reservations } = input
  const kind = input.kind ?? 'sql'
  const name = migrationName(input.name, kind)
  const mine = reservations.find((r) => r.branch === branch && r.module === module && r.name === name) ?? null
  const rest = reservations.filter((r) => r !== mine)
  const base = baseMax && baseMax.module === module ? baseMax : null

  if (mine && !input.again) {
    const stale = base !== null && compareVersion(mine.version, base.version) <= 0
    const moved = mine.path !== migrationPath(input.dir, mine.label, name, kind)
    const clash =
      open.some((o) => o.branch !== branch && o.migrations.some((m) => same(m, mine))) || rest.some((r) => same(r, mine))
    if (!stale && !clash && !moved) return { reservation: mine, reused: true, renewed: false, list: reservations }
  }

  const taken: Migration[] = base ? [base] : []
  let skippedOwn = false
  for (const o of open) {
    for (const m of o.migrations) {
      if (!skippedOwn && mine && o.branch === branch && same(m, mine)) {
        skippedOwn = true
        continue
      }
      taken.push(m)
    }
  }
  taken.push(...rest)
  const next = nextVersion(module, taken)
  const label = kind === 'adr' ? `ADR-${String(next.version[0]).padStart(adrWidth(module, taken), '0')}` : next.label
  const reservation: Reservation = {
    module,
    version: next.version,
    label,
    branch,
    name,
    path: migrationPath(input.dir, label, name, kind),
    at: input.at,
  }
  return { reservation, reused: false, renewed: mine !== null && !input.again, list: [...rest, reservation] }
}

export function prune(list: Reservation[], gone: (r: Reservation) => boolean | null): { kept: Reservation[]; removed: Reservation[] } {
  const kept: Reservation[] = []
  const removed: Reservation[] = []
  for (const r of list) (gone(r) === true ? removed : kept).push(r)
  return { kept, removed }
}
