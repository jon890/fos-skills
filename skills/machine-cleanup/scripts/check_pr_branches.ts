#!/usr/bin/env node
// 조사 JSON 의 「PR 확인 필요(-D)」 브랜치마다 지워도 잃는 커밋이 없는지 확인한다. 읽기 전용이다.
//
// 사용법:
//   check_pr_branches.ts SURVEY_JSON [--pr-limit 5] [--gh-timeout SEC] [--json]
//
// SURVEY_JSON 은 `survey_git.ts --json` 을 저장한 파일이다. 브랜치마다 아래를 낸다.
// - 지금 `git rev-parse` 값이 조사 때의 tip 과 같은지
// - 그 브랜치의 PR 목록(최근 --pr-limit 건): 번호, 상태, head 가 tip 과 같은지, 머지 시각
// - 원격 어디에도 없는 로컬 커밋 수 (`git rev-list --count BR --not --remotes`)
// - 위 값으로 낸 판정 한 줄
// gh 는 저장소 cwd 에서 부르고, 실패하면 그 브랜치만 표시하고 계속한다. 브랜치를 지우지 않는다.
// 종료 코드: 0 확인 완료, 2 입력 파일 오류.

import { readArgs, type Entry } from './cli.ts'
import { pyStr } from './kit/py.ts'
import { gitRun, isMain, readTextStrict, runText, write } from './io.ts'
import { dumpJson, loadJson, parsePyInt } from './pylike.ts'

const USAGE = `usage: check_pr_branches.ts [-h] [--pr-limit PR_LIMIT] [--gh-timeout SEC]
                            [--json]
                            survey
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
조사 JSON 의 「PR 확인 필요(-D)」 브랜치마다 지워도 잃는 커밋이 없는지 확인한다. 읽기 전용이다.

positional arguments:
  survey

options:
  -h, --help           show this help message and exit
  --pr-limit PR_LIMIT
  --gh-timeout SEC
  --json
`

const ENTRY: Entry = {
  prog: 'check_pr_branches.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [
      { name: 'pr-limit', value: true, int: true },
      { name: 'gh-timeout', value: true, int: true },
      { name: 'json', value: false },
    ],
    positionals: [{ name: 'survey', nargs: 1 }],
  },
}

export const CLASS = 'PR 확인 필요(-D)'
const DEFAULT_GH_TIMEOUT = 20
const DEFAULT_PR_LIMIT = 5

type Json = Record<string, any>
export type PrFetcher = (repo: string, branch: string, limit: number, timeout: number) => Json[] | null

// 브랜치의 PR 목록(최근 limit 건, 상태 무관). 실패하면 null. 표준 입력을 닫지 않으면 gh 가 셸 반복문의 입력을 읽는다
export const ghPrs: PrFetcher = (repo, branch, limit, timeout) => {
  const done = runText(['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', String(limit), '--json', 'number,state,headRefOid,mergedAt'], { cwd: repo, timeoutSec: timeout, closeStdin: true })
  if (done.failure || done.code !== 0) return null
  try {
    const parsed = loadJson(done.stdout)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// 판정 한 줄. 지금 tip 이 없거나 조사 때와 다르면 커밋 수를 믿을 수 없으므로 다시 조사하게 한다
export function verdict(surveyedTip: string | null | undefined, currentTip: string | null, localOnly: number | null): string {
  if (!currentTip) return '브랜치 없음, 다시 조사'
  if (surveyedTip && currentTip !== surveyedTip) return 'tip 바뀜, 다시 조사'
  if (localOnly === null) return '로컬 커밋 수 확인 실패, 사용자 판단'
  if (localOnly === 0) return '잃는 커밋 없음'
  return `로컬 커밋 ${localOnly}개, 사용자 판단`
}

export function summarizePrs(prs: Json[], currentTip: string | null) {
  return prs.map((pr) => ({ number: pr.number ?? null, state: pr.state ?? null, head_is_tip: Boolean(currentTip) && pr.headRefOid === currentTip, merged_at: pr.mergedAt ?? null }))
}

export function checkBranch(repo: string, br: Json, prLimit = DEFAULT_PR_LIMIT, ghTimeout = DEFAULT_GH_TIMEOUT, fetchPrs: PrFetcher = ghPrs) {
  const name = br.name
  const done = gitRun(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`])
  const current = done.code === 0 ? done.stdout.trim() : null
  let localOnly: number | null = null
  if (current) {
    const counted = gitRun(repo, ['rev-list', '--count', `refs/heads/${name}`, '--not', '--remotes'])
    if (counted.code === 0 && /^\p{Nd}+$/u.test(counted.stdout.trim())) localOnly = parsePyInt(counted.stdout.trim())
  }
  const prs = fetchPrs(repo, name, prLimit, ghTimeout)
  return {
    repo,
    name,
    surveyed_tip: br.tip ?? null,
    current_tip: current,
    tip_same: Boolean(current) && current === br.tip,
    local_only_commits: localOnly,
    gh_error: prs === null,
    prs: prs === null ? [] : summarizePrs(prs, current || null),
    verdict: verdict(br.tip, current || null, localOnly),
  }
}

export function checkSurvey(survey: Json[], prLimit = DEFAULT_PR_LIMIT, ghTimeout = DEFAULT_GH_TIMEOUT, fetchPrs: PrFetcher = ghPrs) {
  const results: ReturnType<typeof checkBranch>[] = []
  for (const r of survey) for (const br of r.branches ?? []) if (br.class === CLASS) results.push(checkBranch(r.repo, br, prLimit, ghTimeout, fetchPrs))
  return results
}

const short = (tip: string | null) => (tip ? Array.from(tip).slice(0, 8).join('') : '-')

export function printText(results: ReturnType<typeof checkSurvey>): string {
  let out = ''
  for (const r of results) {
    out += `${r.repo}  ${r.name}\n`
    out += `  tip: 조사=${short(r.surveyed_tip)} 지금=${short(r.current_tip)} ${r.tip_same ? '같음' : '다름'}\n`
    out += `  원격에 없는 로컬 커밋: ${r.local_only_commits === null ? '?' : r.local_only_commits}\n`
    if (r.gh_error) out += '  PR: gh 확인 실패\n'
    else if (r.prs.length === 0) out += '  PR: 없음\n'
    for (const pr of r.prs) out += `  PR #${pyStr(pr.number)} ${pyStr(pr.state)} head=tip:${pr.head_is_tip ? '예' : '아니오'} 머지=${pr.merged_at || '-'}\n`
    out += `  판정: ${r.verdict}\n`
  }
  return `${out}\n${results.length}개 확인\n`
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  let survey: Json[]
  try {
    const loaded = loadJson(readTextStrict(args.positionals.survey as string))
    if (!Array.isArray(loaded)) throw new Error('최상위가 목록이 아니다')
    survey = loaded
  } catch (error) {
    write(2, `조사 JSON 을 읽을 수 없다: ${(error as Error).message}\n`)
    return 2
  }
  const prLimit = args.options['pr-limit'] === undefined ? DEFAULT_PR_LIMIT : parsePyInt(args.options['pr-limit'] as string)
  const ghTimeout = args.options['gh-timeout'] === undefined ? DEFAULT_GH_TIMEOUT : parsePyInt(args.options['gh-timeout'] as string)
  const results = checkSurvey(survey, prLimit, ghTimeout)
  write(1, args.options.json ? `${dumpJson(results)}\n` : printText(results))
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
