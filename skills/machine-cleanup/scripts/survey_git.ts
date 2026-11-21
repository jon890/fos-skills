#!/usr/bin/env node
// 저장소별 워크트리와 브랜치의 정리 후보를 분류한다. 읽기 전용이다.
//
// 사용법:
//   survey_git.ts [--roots DIR...] [--no-fetch] [--no-check-prs] [--gh-timeout SEC] [--json] [--json-out FILE]
//
// 기본으로 저장소마다 `git fetch --prune origin` 으로 원격 ref 만 갱신한다. 네트워크가 없을 때 --no-fetch 로 끈다.
// 기본으로 머지 판정이 안 됐고 upstream 이 있는 브랜치마다 `gh pr list` 로 머지된 PR 이 있는지 묻는다.
// 원격 호출이 브랜치 수만큼 생긴다. squash 머지를 알아보는 용도다. 브랜치가 많아 빨리 보고 싶으면 --no-check-prs 로 끈다.
// --json-out 은 텍스트를 표준 출력에 내면서 같은 조사 결과를 JSON 으로 그 파일에도 쓴다. 한 번 조사로 사람이 읽는 목록과 delete_branches.ts 입력을 함께 남겨, 두 목록이 어긋나지 않게 한다.
// --fetch, --check-prs 는 예전 호출을 깨지 않으려고 받기만 하고 효과가 없다.
// gh 호출이 실패하면 그 브랜치의 pr_state 가 "error" 가 되고 분류는 gh 없이 낸 결과 그대로다. 실패 수는 합계에 따로 나온다.
// --json 은 브랜치와 워크트리마다 끝 커밋 전체 해시(tip)를 담는다. 지우기 직전 `git rev-parse` 값과 대조하는 용도다.
// 종료 코드: 0 조사 완료, 2 인자 오류.

import { writeFileSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { gitRun, isMain, runText, write } from './io.ts'
import { pyHead, pySplitLines, pyStrCompare } from './kit/py.ts'
import { dumpJson, expanduser, loadJson, parsePyInt, pyResolve } from './pylike.ts'
import { DEFAULT_GH_TIMEOUT, findRepos, surveyRepo } from './lib/git_survey.ts'

// 판정 함수는 홈서버 조사와 함께 쓰려고 lib/git_survey.ts 로 옮겼다. 예전 import 를 깨지 않으려고 다시 내보낸다
export { baseRef, classifyBranch, classifyWorktree, findRepos, inUse, judgePr, mergedPrs, parseBranches, parseStashBranches, parseWorktrees, surveyRepo, type Worktree } from './lib/git_survey.ts'

const USAGE = `usage: survey_git.ts [-h] [--roots ROOTS [ROOTS ...]] [--fetch] [--check-prs]
                     [--no-fetch] [--no-check-prs] [--gh-timeout SEC] [--json]
                     [--json-out FILE]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
저장소별 워크트리와 브랜치의 정리 후보를 분류한다. 읽기 전용이다.

options:
  -h, --help            show this help message and exit
  --roots ROOTS [ROOTS ...]
  --fetch               기본값이라 효과 없음. 예전 호출 호환용
  --check-prs           기본값이라 효과 없음. 예전 호출 호환용
  --no-fetch
  --no-check-prs
  --gh-timeout SEC
  --json
  --json-out FILE
`

const ENTRY: Entry = {
  prog: 'survey_git.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [
      { name: 'roots', value: true, plus: true },
      { name: 'fetch', value: false },
      { name: 'check-prs', value: false },
      { name: 'no-fetch', value: false },
      { name: 'no-check-prs', value: false },
      { name: 'gh-timeout', value: true, int: true },
      { name: 'json', value: false },
      { name: 'json-out', value: true },
    ],
    positionals: [],
  },
}

type Json = Record<string, any>

// 실행 중 프로세스의 cwd 목록. lsof 를 한 번만 돌린다
export function collectCwds(): Set<string> {
  const done = runText(['lsof', '-d', 'cwd', '-Fn'], { timeoutSec: 60 })
  if (done.failure) return new Set()
  return new Set(pySplitLines(done.stdout).filter((l) => l.startsWith('n')).map((l) => l.slice(1)))
}

export function orcaPaths(): Set<string> | null {
  const done = runText(['orca', 'worktree', 'list', '--json'], { timeoutSec: 30 })
  if (done.failure) return null
  try {
    const data = loadJson(done.stdout) as Json
    return new Set((data.result?.worktrees ?? []).filter((w: Json) => w.path).map((w: Json) => pyResolve(w.path)))
  } catch {
    return null
  }
}

const short = (tip: string | null) => (tip ? pyHead(tip, 8) : '-')

// 조사 결과(shown)를 사람이 읽는 텍스트로 만든다. 줄 끝 개행은 붙이지 않는다
export function formatReport(shown: Json[], repoCount: number, checkPrs: boolean): string {
  const lines: string[] = []
  const totals = new Map<string, number>()
  const ghFailed = shown.reduce((sum, r) => sum + r.gh_errors.length, 0)
  const py = (value: unknown) => (value === null || value === undefined ? 'None' : value === true ? 'True' : value === false ? 'False' : String(value))
  for (const r of shown) {
    lines.push(`## ${r.repo}  (기준 ${r.base})`)
    for (const w of r.worktrees) {
      if (w.class !== '유지') totals.set(`워크트리 ${w.class}`, (totals.get(`워크트리 ${w.class}`) ?? 0) + 1)
      const orcaMark = w.orca === null ? '' : w.orca ? ' orca' : ' 비-orca'
      lines.push(`  [워크트리 ${w.class}]${orcaMark} ${w.path}  브랜치=${py(w.branch)} 변경=${w.dirty} stash=${w.stash} 앞섬=${py(w.ahead)} 경과=${py(w.age_days)}일 사용중=${py(w.in_use)} 끝=${short(w.tip)}${w.pr_state === 'error' ? ' gh확인실패' : ''}`)
    }
    for (const b of r.branches) {
      if (b.class !== '유지') totals.set(`브랜치 ${b.class}`, (totals.get(`브랜치 ${b.class}`) ?? 0) + 1)
      lines.push(`  [브랜치 ${b.class}] ${b.name}  끝=${short(b.tip)}${b.pr_state === 'error' ? ' gh확인실패' : ''}`)
    }
  }
  lines.push(`\n## 합계 (저장소 ${repoCount}개 조사, 후보가 있는 저장소 ${shown.length}개)`)
  for (const key of [...totals.keys()].sort(pyStrCompare)) lines.push(`${String(totals.get(key)).padStart(4)}  ${key}`)
  if (checkPrs) lines.push(`${String(ghFailed).padStart(4)}  gh 확인 실패`)
  if (totals.size === 0) lines.push('후보 없음')
  return lines.join('\n')
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const roots = (args.options.roots as string[] | undefined) ?? ['~/projects', '~/personal']
  const fetch = !args.options['no-fetch']
  const checkPrs = !args.options['no-check-prs']
  const ghTimeout = args.options['gh-timeout'] === undefined ? DEFAULT_GH_TIMEOUT : parsePyInt(args.options['gh-timeout'] as string)
  const jsonOut = args.options['json-out'] as string | undefined

  const repos = findRepos(roots)
  if (fetch) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    for (const repo of repos) {
      const done = gitRun(repo, ['fetch', '--prune', 'origin'], { timeoutSec: 30, env })
      if (done.code !== 0) write(2, `경고: fetch 실패 ${repo}: ${pyHead(done.stderr.trim(), 120)}\n`)
    }
  }
  const cwds = collectCwds()
  const orca = orcaPaths()
  const results: Json[] = []
  for (const repo of repos) {
    const r = surveyRepo(repo, cwds, orca, checkPrs, ghTimeout)
    if (r) results.push(r)
  }
  const shown: Json[] = []
  for (const r of results) {
    // gh 확인에 실패한 항목은 분류가 "유지" 여도 남겨, 확인하지 못했다는 사실이 보고에서 빠지지 않게 한다.
    r.worktrees = r.worktrees.filter((w: Json) => w.class !== '유지' || w.pr_state === 'error')
    r.branches = r.branches.filter((b: Json) => b.class !== '유지' || b.pr_state === 'error')
    if (r.worktrees.length || r.branches.length) shown.push(r)
  }

  if (jsonOut) writeFileSync(expanduser(jsonOut), `${dumpJson(shown)}\n`)
  if (args.options.json) {
    write(1, `${dumpJson(shown)}\n`)
    return 0
  }
  write(1, `${formatReport(shown, repos.length, checkPrs)}\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
