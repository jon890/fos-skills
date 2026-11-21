#!/usr/bin/env node
// 에이전트 세션 프로세스, 반복 helper 프로세스, 대화 기록 크기를 조사한다. 읽기 전용이다.
//
// 사용법:
//   survey_sessions.ts [--min-age-hours 24] [--log-age-days 30] [--json] [--json-out FILE]
//
// 종료 코드: 0 조사 완료, 2 인자 오류.
// 현재 세션과 그 조상 PID 는 항상 제외 표시한다.
//
// 「워크트리가 사라진 대화 기록」 절은 Claude 기록 폴더(`~/.claude/projects`, `CLAUDE_CONFIG_DIR` 이 있으면 그 `projects`)의
// 하위 폴더 가운데, 안의 `.jsonl` 을 이름순으로 열어 앞 50줄에서 처음 나온 `cwd` 경로가 이미 없는 폴더를 센다.
// `cwd` 를 읽지 못한 폴더는 후보에 넣지 않는다. 경과일은 폴더 안 파일의 가장 늦은 수정 시각으로 잰다.
// --json-out 은 이 후보를 `delete_sessions.ts` 입력 형식으로 파일에 쓴다.

import { writeFileSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { isMain, ljust, rjust, runText, write } from './io.ts'
import { dumpJson, isDir, osErrorMessage, parsePyFloat, parsePyInt, PyFloat, pyFixed, pyG, pyTime } from './pylike.ts'
import { ancestors, claudeProjectsDir, dirSizes, expandLogDirs, findOrphanSessions, groupHelpers, HELPER_MIN_COUNT, human, isAgent, ORPHAN_EXAMPLES, orphanBuckets, parseLsofCwd, parsePs } from './lib/session_survey.ts'

// 판정 함수는 홈서버 조사와 함께 쓰려고 lib/session_survey.ts 로 옮겼다. 예전 import 를 깨지 않으려고 다시 내보낸다
export { ancestors, claudeProjectsDir, dirSizes, findOrphanSessions, folderStats, groupHelpers, human, isAgent, orphanBuckets, parseEtime, parseLsofCwd, parsePs, readCwd, type Orphan, type PsRow } from './lib/session_survey.ts'

const USAGE = `usage: survey_sessions.ts [-h] [--min-age-hours MIN_AGE_HOURS]
                          [--log-age-days LOG_AGE_DAYS] [--json]
                          [--json-out FILE]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
에이전트 세션 프로세스, 반복 helper 프로세스, 대화 기록 크기를 조사한다. 읽기 전용이다.

options:
  -h, --help            show this help message and exit
  --min-age-hours MIN_AGE_HOURS
  --log-age-days LOG_AGE_DAYS
  --json
  --json-out FILE       워크트리가 사라진 대화 기록 후보를 delete_sessions.py 입력으로 쓴다
`

const ENTRY: Entry = {
  prog: 'survey_sessions.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [
      { name: 'min-age-hours', value: true, float: true },
      { name: 'log-age-days', value: true, int: true },
      { name: 'json', value: false },
      { name: 'json-out', value: true },
    ],
    positionals: [],
  },
}

const LOG_DIRS = ['~/.claude/projects', '~/.codex/sessions', '~/Library/Application Support/orca/codex-accounts/*/home/sessions']

const run = (argv: string[], timeoutSec = 30): string => {
  const done = runText(argv, { timeoutSec })
  return done.failure ? '' : done.stdout
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const minAgeHours = args.options['min-age-hours'] === undefined ? 24 : parsePyFloat(args.options['min-age-hours'] as string)
  const logAgeDays = args.options['log-age-days'] === undefined ? 30 : parsePyInt(args.options['log-age-days'] as string)
  const jsonOut = args.options['json-out'] as string | undefined

  const rows = parsePs(run(['ps', '-axo', 'pid=,ppid=,etime=,tty=,rss=,pcpu=,command=']))
  const parents = new Map(rows.map((r) => [r.pid, r.ppid]))
  const protectedPids = new Set([...ancestors(process.ppid, parents), process.pid])
  const sessions = rows.filter((r) => isAgent(r.command)).map((r) => ({ ...r }))
  let cwds = new Map<number, string>()
  if (sessions.length) cwds = parseLsofCwd(run(['lsof', '-a', '-p', sessions.map((r) => r.pid).join(','), '-d', 'cwd', '-Fpn']))
  const detailed = sessions.map((r) => ({ ...r, cwd: cwds.get(r.pid) ?? '?', protected: protectedPids.has(r.pid), old: r.hours >= minAgeHours }))
  const helpers = groupHelpers(rows)
  const logs = expandLogDirs(LOG_DIRS).map((dir) => {
    const [total, old] = dirSizes(dir, logAgeDays)
    return { dir, total, older_than_days: old }
  })

  const projects = claudeProjectsDir()
  const orphans = isDir(projects) ? findOrphanSessions(projects) : []
  const now = pyTime()
  if (jsonOut) {
    try {
      writeFileSync(jsonOut, dumpJson({ base: projects, created: new PyFloat(now), orphans: orphans.map((o) => ({ ...o, newest_mtime: new PyFloat(o.newest_mtime) })) }))
    } catch (error) {
      write(2, `--json-out 을 쓸 수 없다: ${osErrorMessage(error, jsonOut)}\n`)
      return 2
    }
  }

  if (args.options.json) {
    write(1, `${dumpJson({ sessions: detailed.map((r) => ({ ...r, hours: new PyFloat(r.hours), cpu: new PyFloat(r.cpu) })), helpers, logs })}\n`)
    return 0
  }

  write(1, `## 에이전트 세션 ${detailed.length}개 (오래됨 기준 ${pyG(minAgeHours)}시간)\n`)
  write(1, `${rjust('PID', 7)} ${rjust('시간', 7)} ${ljust('TTY', 8)} ${rjust('RSS', 9)} ${rjust('CPU', 5)}  표시   cwd\n`)
  for (const r of [...detailed].sort((a, b) => b.hours - a.hours)) {
    const mark = r.protected ? '현재' : r.old ? '오래됨' : ''
    write(1, `${rjust(String(r.pid), 7)} ${rjust(pyFixed(r.hours, 1), 6)}h ${ljust(r.tty, 8)} ${rjust(human(r.rss_kb * 1024), 9)} ${rjust(pyFixed(r.cpu, 1), 5)}  ${ljust(mark, 5)}  ${r.cwd}\n`)
  }
  write(1, "현재 세션과 조상은 '현재' 로 표시했다. 종료 대상에 넣지 않는다.\n")
  write(1, `\n## 반복 helper 프로세스 (같은 명령줄 ${HELPER_MIN_COUNT}개 이상)\n`)
  for (const g of helpers) write(1, `${rjust(String(g.count), 4)}개 ${rjust(human(g.rss_kb * 1024), 9)}  ${g.command}\n`)
  if (helpers.length === 0) write(1, '없음\n')
  write(1, `\n## 대화 기록 (오래된 기준 ${logAgeDays}일)\n`)
  for (const item of logs) write(1, `${rjust(human(item.total), 9)} 중 오래된 것 ${rjust(human(item.older_than_days), 9)}  ${item.dir}\n`)
  if (logs.length === 0) write(1, '없음\n')
  write(1, `\n## 워크트리가 사라진 대화 기록 (${projects})\n`)
  if (orphans.length === 0) write(1, '없음\n')
  else {
    for (const [days, [count, size]] of orphanBuckets(orphans, now)) write(1, `${rjust(String(days), 3)}일 넘은 것 ${rjust(String(count), 5)}개 ${rjust(human(size), 9)}\n`)
    write(1, `전체 ${orphans.length}개 ${rjust(human(orphans.reduce((sum, o) => sum + o.size_bytes, 0)), 9)}. 크기 상위 ${Math.min(ORPHAN_EXAMPLES, orphans.length)}개:\n`)
    for (const o of orphans.slice(0, ORPHAN_EXAMPLES)) write(1, `${rjust(human(o.size_bytes), 9)} ${rjust(pyFixed((now - o.newest_mtime) / 86400, 0), 5)}일 전  ${o.cwd}\n`)
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
