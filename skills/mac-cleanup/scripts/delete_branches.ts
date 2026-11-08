#!/usr/bin/env node
// `survey_git.ts --json` 결과의 로컬 브랜치를 지운다. 기본은 dry-run 이다.
//
// 사용법:
//   delete_branches.ts SURVEY_JSON [--only merged pr-merged ...] [--apply]
//
// SURVEY_JSON 은 `survey_git.ts --json` 을 저장한 파일이고, `-` 이면 표준 입력을 읽는다.
// --only 로 지울 분류를 고른다. 기본은 merged 다.
//   merged     "삭제 후보(-d)". 브랜치가 이미 없으면 `유지` 로 보인다. 있으면 `git branch -d` 를 쓰고, `not fully merged` 로 거절되면
//              조사 JSON 의 tip 과 `git rev-parse` 가 같고 `merge-base --is-ancestor <브랜치> <base>` 가 0 일 때만 -D 를 쓴다.
//   pr-merged  "PR 머지됨(-D)". 실행 직전 `git rev-parse` 가 조사 JSON 의 tip 과 같을 때만 -D 를 쓴다.
// 그 밖의 분류와 `gh 확인 실패`(pr_state 가 error) 는 건드리지 않는다. 원격 브랜치는 지우지 않는다.
// --apply 가 없으면 아무것도 바꾸지 않고 무엇을 할지만 보인다.
//
// 종료 코드: 0 실패 없음, 1 실패가 하나라도 있음, 2 입력 오류.

import { readArgs, type Entry } from './cli.ts'
import { gitRun, isMain, readInput, rstrip, write } from './io.ts'
import { pyHead, pyStrCompare } from './kit/py.ts'
import { loadJson } from './pylike.ts'

const USAGE = `usage: delete_branches.ts [-h]
                          [--only {merged,pr-merged} [{merged,pr-merged} ...]]
                          [--apply]
                          survey_json
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
\`survey_git.py --json\` 결과의 로컬 브랜치를 지운다. 기본은 dry-run 이다.

positional arguments:
  survey_json

options:
  -h, --help            show this help message and exit
  --only {merged,pr-merged} [{merged,pr-merged} ...]
  --apply
`

const CLASS_BY_OPTION: Record<string, string> = { merged: '삭제 후보(-d)', 'pr-merged': 'PR 머지됨(-D)' }

const ENTRY: Entry = {
  prog: 'delete_branches.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [{ name: 'only', value: true, plus: true, choices: Object.keys(CLASS_BY_OPTION).sort(pyStrCompare) }, { name: 'apply', value: false }],
    positionals: [{ name: 'survey_json', nargs: 1 }],
  },
}

type Json = Record<string, any>
export type Result = { repo: string; branch: string; status: string; detail: string }

const result = (repo: string, branch: string, status: string, detail = ''): Result => ({ repo, branch, status, detail })

const git = (repo: string, ...args: string[]) => gitRun(repo, args, { timeoutSec: 60 })

// `-d` 가 거절된 뒤 -D 로 갈 수 있는지 본다. [가능 여부, 이유] 를 돌려준다
export function canForce(repo: string, base: string, br: Json): [boolean, string] {
  const head = git(repo, 'rev-parse', `refs/heads/${br.name}`)
  if (head.code !== 0) return [false, '브랜치가 없다']
  if (head.stdout.trim() !== br.tip) return [false, `tip 불일치(조사 ${pyHead(br.tip, 8)}, 지금 ${pyHead(head.stdout.trim(), 8)})`]
  const anc = git(repo, 'merge-base', '--is-ancestor', `refs/heads/${br.name}`, base)
  if (anc.code !== 0) return [false, `${base} 에 포함되지 않음`]
  return [true, '']
}

// 브랜치 하나를 처리한다. status: 삭제, 삭제 예정, 유지, 건드리지 않음, 실패
export function processBranch(repo: string, base: string, br: Json, only: string[], apply: boolean): Result {
  const name = br.name
  const cls = br.class
  const selected = new Set(only.map((o) => CLASS_BY_OPTION[o]))
  if (br.pr_state === 'error') return result(repo, name, '건드리지 않음', 'gh 확인 실패')
  if (!selected.has(cls)) return result(repo, name, '건드리지 않음', `분류 ${cls ?? 'None'}`)
  if (!br.tip) return result(repo, name, '유지', '조사 JSON 에 tip 이 없다')

  if (cls === 'PR 머지됨(-D)') {
    const head = git(repo, 'rev-parse', `refs/heads/${name}`)
    if (head.code !== 0) return result(repo, name, '유지', '브랜치가 없다')
    if (head.stdout.trim() !== br.tip) return result(repo, name, '유지', `tip 불일치(조사 ${pyHead(br.tip, 8)}, 지금 ${pyHead(head.stdout.trim(), 8)})`)
    if (!apply) return result(repo, name, '삭제 예정', '-D (PR 머지됨, tip 일치)')
    const done = git(repo, 'branch', '-D', name)
    return result(repo, name, done.code === 0 ? '삭제' : '실패', done.code === 0 ? '-D' : done.stderr.trim())
  }

  // 삭제 후보(-d)
  if (git(repo, 'rev-parse', `refs/heads/${name}`).code !== 0) return result(repo, name, '유지', '브랜치가 없다')
  if (!apply) {
    const [ok, why] = canForce(repo, base, br)
    return result(repo, name, '삭제 예정', `-d${ok ? '' : ` (거절되면 유지: ${why})`}`)
  }
  let done = git(repo, 'branch', '-d', name)
  if (done.code === 0) return result(repo, name, '삭제', '-d')
  if (!done.stderr.includes('not fully merged')) return result(repo, name, '실패', done.stderr.trim())
  const [ok, why] = canForce(repo, base, br)
  if (!ok) return result(repo, name, '유지', `-d 거절, ${why}`)
  done = git(repo, 'branch', '-D', name)
  return result(repo, name, done.code === 0 ? '삭제' : '실패', done.code === 0 ? '-d 거절 뒤 -D (tip 일치, base 에 포함)' : done.stderr.trim())
}

export function run(survey: Json[], only: string[], apply: boolean): Result[] {
  const results: Result[] = []
  for (const repo of survey) for (const br of repo.branches) results.push(processBranch(repo.repo, repo.base, br, only, apply))
  return results
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const only = (args.options.only as string[] | undefined) ?? ['merged']
  const apply = args.options.apply === true
  let survey: Json[]
  try {
    const loaded = loadJson(readInput(args.positionals.survey_json as string))
    if (!Array.isArray(loaded) || loaded.some((r) => r === null || typeof r !== 'object' || !('repo' in r) || !('base' in r) || !('branches' in r) || typeof r.repo !== 'string' || typeof r.base !== 'string' || !Array.isArray(r.branches) || r.branches.some((b: unknown) => b === null || typeof b !== 'object' || typeof (b as Json).name !== 'string' || ((b as Json).tip !== undefined && (b as Json).tip !== null && typeof (b as Json).tip !== 'string')))) throw new Error('survey_git.ts --json 형식이 아니다')
    survey = loaded
  } catch (error) {
    write(2, `입력을 읽을 수 없다: ${(error as Error).message}\n`)
    return 2
  }

  write(1, apply ? '## 실행\n' : '## dry-run (변경 없음, 실제 삭제는 --apply)\n')
  const results = run(survey, only, apply)
  for (const r of results) write(1, `${rstrip(`[${r.status}] ${r.repo}  ${r.branch}  ${r.detail}`)}\n`)
  const counts = new Map<string, number>()
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  write(1, '\n## 합계\n')
  for (const key of [...counts.keys()].sort(pyStrCompare)) write(1, `${String(counts.get(key)).padStart(4)}  ${key}\n`)
  return counts.get('실패') ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
