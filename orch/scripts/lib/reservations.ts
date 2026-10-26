// 마이그레이션 번호 예약(docs/adr/017-orch-migration-reserve.md)의 파일, 잠금, 번호 판정을 이 모듈 한 곳이 소유한다.
// 명령은 reserve-migration.ts, 읽기만 하는 쪽은 상주 루프의 자동 머지다.
//
// 파일: <orch 루트>/state/migration-reservations.json
//   {"reservations": [{"module", "version"(숫자 목록), "label"(`V13`), "branch", "name"(설명의 slug), "path"(저장소 루트 기준 파일 경로), "at"(ISO 8601 UTC)}]}
//   (module, version) 은 한 항목에만 있고, (branch, module, name) 도 한 항목에만 있다(docs/data-schema.md 의 행).
//   name 은 받은 설명을 slug 로 바꾼 값이다. 같은 예약인지 이 값으로 가리고, 파일 이름의 설명 조각도 이 값이다.
//   쓰는 쪽은 잠금 안에서 옆 파일(<파일>.<pid>.tmp)에 쓰고 rename 한다. 읽는 쪽은 잠금 없이 읽어도 반쯤 쓴 파일을 보지 않는다.
//   쓰기나 rename 이 실패하면 옆 파일을 지우고(실패는 무시) 그 오류를 다시 던진다.
//   최상위가 틀리면(JSON 이 아님, reservations 목록이 없음) Error 다. 부르는 쪽은 읽지 못한 것으로 다룬다.
//   형식이 맞지 않는 항목은 건너뛰고 skipped 로 센다. 다음 쓰기에서 빠진다.
//
// 잠금: 같은 폴더의 migration-reservations.lock. 경로는 lockFile 이 정하고, 잡고 푸는 일은 reserve-migration.ts 가 lib/events.ts 의 acquireLock, ownsLock, releaseLock 으로 한다
//   (wx 로 만들고 pid 를 적는다. 죽은 pid 는 reclaim 으로 회수한다). 보장 범위도 그 파일의 「잠금」 과 같다.
//
// 판정:
//   - nextVersion  그 모듈의 version[0] 최대값에 1 을 더한 [n] 과 V<n>. 없으면 [1], V1.
//                  V1_2 처럼 자리가 여럿이어도 새 번호는 V2 다. Flyway 는 V2 를 V1_2 보다 뒤로 정렬한다
//   - choose       같은 (branch, module, name) 예약이 있고 again 이 아니면 그 예약을 다시 쓴다(reused).
//                  그 번호가 base 최고 이하가 됐거나 다른 브랜치의 열린 PR 이나 다른 예약과 같은 번호면 새로 정한다(renewed).
//                  새로 정할 때는 base 최고, 열린 PR 이 더한 그 모듈 마이그레이션, 다시 정하는 예약을 뺀 남은 예약을 모두 센다.
//                  같은 브랜치의 열린 PR 파일도 세되, 다시 정하는 예약과 같은 (모듈, 번호)인 파일 하나는 뺀다. 그 예약으로 만든 파일이다
//   - prune        gone 이 true 인 항목만 지운다. null(판정 못 함)과 false 는 남긴다. 지우면 그 번호가 다시 나가기 때문이다

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compareVersion } from './auto-merge.ts'
import type { Migration } from './auto-merge.ts'
import { makeParent, pathOf } from './paths.ts'

export type Reservation = { module: string; version: number[]; label: string; branch: string; name: string; path: string; at: string }

// gh 의 files 행 가운데 더한 파일로 보는 changeType. 없는 행도 더한 파일로 본다
const ADDED_CHANGES: ReadonlySet<string> = new Set(['ADDED', 'RENAMED', 'COPIED'])

export function reservationsFile(repo: string): string {
  return join(pathOf('state', repo), 'migration-reservations.json')
}

export function lockFile(repo: string): string {
  return join(dirname(reservationsFile(repo)), 'migration-reservations.lock')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

export function readReservations(repo: string): { list: Reservation[]; skipped: number } {
  const file = reservationsFile(repo)
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

export function writeReservations(repo: string, list: Reservation[]): void {
  const file = reservationsFile(repo)
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
  at: string
  baseMax: Migration | null
  open: { branch: string; migrations: Migration[] }[]
  reservations: Reservation[]
}): { reservation: Reservation; reused: boolean; renewed: boolean; list: Reservation[] } {
  const { module, branch, baseMax, open, reservations } = input
  const name = slug(input.name)
  const mine = reservations.find((r) => r.branch === branch && r.module === module && r.name === name) ?? null
  const rest = reservations.filter((r) => r !== mine)
  const base = baseMax && baseMax.module === module ? baseMax : null

  if (mine && !input.again) {
    const stale = base !== null && compareVersion(mine.version, base.version) <= 0
    const clash =
      open.some((o) => o.branch !== branch && o.migrations.some((m) => same(m, mine))) || rest.some((r) => same(r, mine))
    if (!stale && !clash) return { reservation: mine, reused: true, renewed: false, list: reservations }
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
  const reservation: Reservation = {
    module,
    version: next.version,
    label: next.label,
    branch,
    name,
    path: `${input.dir}/${next.label}__${name}.sql`,
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
