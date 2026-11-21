#!/usr/bin/env node
// Gradle wrapper 버전 사용처, 캐시된 배포판, 실행 중 데몬을 비교해 삭제 후보를 보인다. 읽기 전용이다.
//
// 사용법: survey_gradle.ts [루트...]    기본 루트는 ~/projects ~/personal
// 종료 코드: 0 조사 완료.
// 지워도 wrapper 가 필요할 때 다시 받는다.
//
// 옛 셸 스크립트의 find, grep, sort 조합과 같은 결과를 낸다. 줄 정렬과 glob 순서는 바이트(UTF-8) 순서다.
// 사용처와 데몬 목록에 있는지는 글자가 같은지로 본다(옛 `grep -x` 는 버전의 점을 아무 글자로 읽었다).
// 사용처가 없는 dists 폴더(버전 이름을 읽지 못한 것)는 후보로 올리지 않는다. 옛 스크립트는 그런 폴더가 있으면
// 버전이 빈 후보가 되어 `~/.gradle/caches/` 와 `~/.gradle/daemon/` 전체를 지우는 줄을 냈다.

import { readdirSync, readFileSync } from 'node:fs'
import { isMain, ljust, runText, write } from './io.ts'
import { expanduser, isDir, isSymlink, osJoin } from './pylike.ts'

const HOME = expanduser('~')
const GRADLE = osJoin(HOME, '.gradle')
const PRUNE = new Set(['node_modules', 'worktrees', '.orca-worktree-trash'])
const WRAPPER_SUFFIX = '/gradle/wrapper/gradle-wrapper.properties'
const MAX_DEPTH = 6

const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const versionIn = (text: string): string | undefined => /[0-9]+(?:\.[0-9]+)+/.exec(text)?.[0]

// find ROOT -maxdepth 6 ( -name node_modules -o -name worktrees -o -name .orca-worktree-trash ) -prune -o -path '*/gradle/wrapper/gradle-wrapper.properties' -print
// 루트가 심볼릭 링크면 find 는 내려가지 않는다. 폴더 링크도 내려가지 않는다
function findWrappers(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = osJoin(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE.has(entry.name)) continue
        if (depth + 1 < MAX_DEPTH) visit(path, depth + 1)
      } else if (depth + 1 <= MAX_DEPTH && path.endsWith(WRAPPER_SUFFIX)) found.push(path)
    }
  }
  if (PRUNE.has(root.split('/').at(-1)!) && isDir(root)) return found
  if (!isDir(root) || isSymlink(root)) return found
  visit(root, 0)
  return found
}

// du -sh 가 낸 크기. 폴더가 여럿이면 옛 셸처럼 dists 는 마지막 줄(awk END), 그 밖은 첫 줄(head -1)이다. 폴더가 없으면 null
function duSize(paths: string[], pick: 'first' | 'last' = 'first'): string | null {
  if (paths.length === 0) return null
  const done = runText(['du', '-sh', ...paths], { timeoutSec: 600 })
  if (done.failure) return null
  // awk '{print $1}' 처럼 앞 공백(BSD du -h 는 크기를 오른쪽 맞춤한다)을 건너뛰고 첫 칸을 읽는다
  const rows = done.stdout.split('\n').map((l) => l.split(/[ \t]+/).find(Boolean)).filter((cell): cell is string => cell !== undefined)
  return (pick === 'last' ? rows.at(-1) : rows[0]) ?? null
}

const tilde = (path: string) => (path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path)

// 셸 glob `$G/wrapper/dists/gradle-$version-*` 와 같다. 이름순이다
function distsFor(version: string): string[] {
  const dists = osJoin(GRADLE, 'wrapper/dists')
  let names: string[]
  try {
    names = readdirSync(dists)
  } catch {
    return []
  }
  const prefix = `gradle-${version}-`
  return names
    .filter((n) => n.startsWith(prefix))
    .sort(byteCompare)
    .map((n) => osJoin(dists, n))
}

function subdirs(parent: string): string[] {
  try {
    return readdirSync(parent)
      .filter((n) => /^[0-9]/.test(n))
      .sort(byteCompare)
      .map((n) => osJoin(parent, n))
      .filter(isDir)
  } catch {
    return []
  }
}

export function main(argv: string[]): number {
  const roots = argv.length ? argv : [osJoin(HOME, 'projects'), osJoin(HOME, 'personal')]
  const used: string[] = []

  write(1, '## wrapper 버전과 사용처\n')
  const rows: string[] = []
  for (const root of roots) {
    for (const file of findWrappers(root)) {
      let text: string
      try {
        text = readFileSync(file, 'latin1')
      } catch {
        continue
      }
      let first: string | undefined
      for (const line of text.split('\n')) {
        first = /gradle-[0-9.]+-(?:bin|all)/.exec(line)?.[0]
        if (first) break
      }
      const v = first ? versionIn(first) : undefined
      if (v) {
        used.push(v)
        rows.push(`${ljust(v, 8)} ${file.slice(0, -WRAPPER_SUFFIX.length)}`)
      }
    }
  }
  for (const row of rows.sort(byteCompare)) write(1, `${row}\n`)

  write(1, '\n## 캐시된 배포판과 크기\n')
  const cached = new Set<string>()
  const distsDir = osJoin(GRADLE, 'wrapper/dists')
  let distNames: string[] = []
  try {
    distNames = readdirSync(distsDir).filter((n) => n.startsWith('gradle-')).sort(byteCompare)
  } catch {
    distNames = []
  }
  for (const n of distNames) {
    if (!isDir(osJoin(distsDir, n))) continue
    const v = versionIn(n)
    if (v) cached.add(v)
  }
  for (const d of [...subdirs(osJoin(GRADLE, 'caches')), ...subdirs(osJoin(GRADLE, 'daemon'))]) cached.add(d.split('/').at(-1)!)
  const sorted = [...cached].sort(byteCompare)
  for (const v of sorted) {
    const dists = duSize(distsFor(v), 'last') ?? '-'
    const caches = duSize(isDir(osJoin(GRADLE, `caches/${v}`)) ? [osJoin(GRADLE, `caches/${v}`)] : []) ?? '-'
    const daemon = duSize(isDir(osJoin(GRADLE, `daemon/${v}`)) ? [osJoin(GRADLE, `daemon/${v}`)] : []) ?? '-'
    write(1, `${ljust(v, 8)} dists ${ljust(dists, 7)} caches ${ljust(caches, 7)} daemon ${ljust(daemon, 7)}\n`)
  }

  write(1, '\n## 실행 중 데몬 버전\n')
  const running = new Set<string>()
  const pgrep = runText(['pgrep', '-fl', 'GradleDaemon'], { timeoutSec: 60, closeStdin: true })
  if (!pgrep.failure) {
    for (const line of pgrep.stdout.split('\n')) {
      for (const m of line.matchAll(/gradle-[0-9.]+/g)) {
        const v = versionIn(m[0])
        if (v) running.add(v)
      }
    }
  }
  if (running.size) for (const v of [...running].sort(byteCompare)) write(1, `${v}\n`)
  else write(1, '없음\n')

  write(1, '\n## 삭제 후보 (사용처도 데몬도 없는 버전)\n')
  // 경로는 한 줄에 하나씩, 실제로 있는 것만 낸다. 지우는 명령은 glob 반복문이 아니라 이 경로를 그대로 적은 한 줄이다
  const paths: string[] = []
  for (const v of sorted) {
    if (used.includes(v) || running.has(v)) continue
    for (const d of [...distsFor(v), osJoin(GRADLE, `caches/${v}`), osJoin(GRADLE, `daemon/${v}`)]) {
      if (!isDir(d)) continue
      write(1, `${ljust(v, 8)} ${ljust(duSize([d]) ?? '', 7)} ${tilde(d)}\n`)
      paths.push(tilde(d))
    }
  }
  if (paths.length === 0) {
    write(1, '없음\n')
  } else {
    write(1, '\n## 승인 뒤 돌릴 명령 (출력만 하고 돌리지 않는다)\n')
    write(1, `rm -rf ${paths.join(' ')}\n`)
  }
  write(1, '지워도 wrapper 가 필요할 때 다시 받는다.\n')
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
