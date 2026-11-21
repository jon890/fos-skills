#!/usr/bin/env node
// `survey_sessions.ts --json-out` 결과의 「워크트리가 사라진 대화 기록」 폴더를 지운다. 기본은 dry-run 이다.
//
// 사용법:
//   delete_sessions.ts ORPHAN_JSON --older-than-days N [--apply]
//
// ORPHAN_JSON 은 `survey_sessions.ts --json-out FILE` 이 쓴 파일이고, `-` 이면 표준 입력을 읽는다.
// --older-than-days N(필수)보다 가장 늦은 수정 시각이 오래된 폴더만 고른다.
// 지우기 직전에 폴더마다 다시 확인하고, 하나라도 다르면 남기고 이유를 낸다.
//   1. 경로가 기록 폴더(`projects`) 바로 아래의 실제 폴더이고 심볼릭 링크가 아니다
//   2. 기록 안의 `cwd` 가 조사 때와 같고 지금도 없다
//   3. 폴더 안 파일의 가장 늦은 수정 시각이 조사 때와 같다(그사이 세션이 기록을 이었으면 남긴다)
// --apply 가 없으면 아무것도 바꾸지 않고 무엇을 할지만 보인다.
//
// 종료 코드: 0 실패 없음, 1 실패가 하나라도 있음, 2 입력 오류.

import { rmSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { isMain, readInput, rjust, rstrip, write } from './io.ts'
import { pyStrCompare } from './kit/py.ts'
import { abspath, basename, dirname, exists, isDir, isSymlink, loadJson, osErrorMessage, parsePyFloat, pyG, pyTime } from './pylike.ts'
import { folderStats, human, readCwd } from './survey_sessions.ts'

const USAGE = `usage: delete_sessions.ts [-h] --older-than-days OLDER_THAN_DAYS [--apply]
                          orphan_json
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
\`survey_sessions.py --json-out\` 결과의 「워크트리가 사라진 대화 기록」 폴더를 지운다. 기본은 dry-run 이다.

positional arguments:
  orphan_json

options:
  -h, --help            show this help message and exit
  --older-than-days OLDER_THAN_DAYS
  --apply
`

const ENTRY: Entry = {
  prog: 'delete_sessions.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [{ name: 'older-than-days', value: true, float: true, required: true }, { name: 'apply', value: false }],
    positionals: [{ name: 'orphan_json', nargs: 1 }],
  },
}

const MTIME_TOLERANCE = 1e-3

type Json = Record<string, any>
type Result = { path: string; status: string; detail: string; size_bytes: number }

const result = (item: Json, status: string, detail = ''): Result => ({ path: item.path, status, detail, size_bytes: item.size_bytes || 0 })

// 지우기 직전 재확인. 문제가 있으면 이유 문장, 없으면 null
export function recheck(item: Json, base: string): string | null {
  const path = item.path
  if (basename(base) !== 'projects') return '기록 폴더가 projects 가 아니다'
  if (dirname(abspath(path)) !== abspath(base)) return '기록 폴더 바로 아래가 아니다'
  if (isSymlink(path) || !isDir(path)) return '실제 폴더가 아니거나 이미 없다'
  const cwd = readCwd(path)
  if (cwd === null) return 'cwd 를 읽을 수 없다'
  if (cwd !== item.cwd) return `cwd 가 조사 때와 다르다: ${cwd}`
  if (exists(cwd)) return `cwd 가 다시 생겼다: ${cwd}`
  const [, newest] = folderStats(path)
  if (newest === null || Math.abs(newest - item.newest_mtime) > MTIME_TOLERANCE) return '조사 뒤 수정 시각이 바뀌었다(세션이 기록을 이었다)'
  return null
}

export type Remover = (path: string) => void

// shutil.rmtree. 폴더 안의 링크는 따라가지 않고 링크만 지운다
const rmtree: Remover = (path) => rmSync(path, { recursive: true })

// 폴더 하나를 처리한다. status: 삭제, 삭제 예정, 유지, 실패
export function processItem(item: Json, base: string, olderThanDays: number, apply: boolean, now: number, remove: Remover = rmtree): Result {
  if (item.newest_mtime >= now - olderThanDays * 86400) return result(item, '유지', `${pyG(olderThanDays)}일 이내 수정`)
  const why = recheck(item, base)
  if (why) return result(item, '유지', why)
  if (!apply) return result(item, '삭제 예정', item.cwd)
  try {
    remove(item.path)
  } catch (error) {
    return result(item, '실패', osErrorMessage(error, item.path))
  }
  return result(item, '삭제', item.cwd)
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const olderThanDays = parsePyFloat(args.options['older-than-days'] as string)
  const apply = args.options.apply === true
  let base: string
  let items: Json[]
  try {
    const data = loadJson(readInput(args.positionals.orphan_json as string)) as Json
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('survey_sessions.ts --json-out 형식이 아니다')
    base = data.base
    items = data.orphans
    // 삭제 전에 모든 항목을 검사한다. 하나라도 틀리면 아무것도 지우지 않고 입력 오류로 끝낸다
    const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    if (typeof base !== 'string' || !Array.isArray(items) || items.some((i) => i === null || typeof i !== 'object' || !['path', 'cwd', 'newest_mtime'].every((k) => k in i) || typeof i.path !== 'string' || typeof i.cwd !== 'string' || !finite(i.newest_mtime) || (i.size_bytes !== undefined && i.size_bytes !== null && !finite(i.size_bytes)))) {
      throw new Error('survey_sessions.ts --json-out 형식이 아니다')
    }
  } catch (error) {
    write(2, `입력을 읽을 수 없다: ${(error as Error).message}\n`)
    return 2
  }

  const now = pyTime()
  write(1, apply ? '## 실행\n' : '## dry-run (변경 없음, 실제 삭제는 --apply)\n')
  write(1, `기준: ${pyG(olderThanDays)}일 넘은 폴더\n`)
  const results = items.map((i) => processItem(i, base, olderThanDays, apply, now))
  for (const r of results) write(1, `${rstrip(`[${r.status}] ${rjust(human(r.size_bytes), 9)}  ${r.path}  ${r.detail}`)}\n`)
  const counts = new Map<string, [number, number]>()
  for (const r of results) {
    const slot = counts.get(r.status) ?? [0, 0]
    slot[0] += 1
    slot[1] += r.size_bytes
    counts.set(r.status, slot)
  }
  write(1, '\n## 합계\n')
  for (const key of [...counts.keys()].sort(pyStrCompare)) {
    const [count, size] = counts.get(key)!
    write(1, `${rjust(String(count), 4)}개 ${rjust(human(size), 9)}  ${key}\n`)
  }
  return counts.get('실패') ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
