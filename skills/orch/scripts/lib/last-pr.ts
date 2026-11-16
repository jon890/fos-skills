// 머지한 PR 이 업무의 마지막 PR 인지 판정한다. finish-pr.ts(배포 확인 뒤)와 board-sync.ts(머지를 본 틱)가 함께 쓴다.
//
// 아래를 모두 만족하면 마지막이다.
//   - PR 제목에서 taskPattern 으로 업무 번호를 뽑았다
//   - 열린 PR 가운데 제목에서 같은 업무 번호를 뽑은 다른 PR 이 없다
//   - specsDir 의 spec-*.md 가운데 같은 업무를 가리키는 다른 지시서가 없다. 지시서가 업무를 가리키는지는 specTaskPattern 을
//     지시서의 줄마다 맞춰 본다. 첫 그룹이 업무 번호다. `브랜치:` 줄이 이 PR 의 브랜치인 지시서와, `브랜치:` 줄의 브랜치가
//     모두 MERGED PR 을 가진 지시서는 세지 않는다. 먼저 머지된 중간 PR 의 지시서가 남아 마지막 PR 을 막지 않게 하기 위해서다.
//     specsDir 가 없으면 이 조건은 보지 않는다
// 판정하지 못하면 last 는 null 이다. taskPattern 이 없다, 제목에서 업무 번호를 찾지 못했다, specsDir 는 있는데 specTaskPattern 이 없다,
// gh 조회가 실패했다가 여기 든다. 부르는 쪽이 null 을 어떻게 다룰지 정한다. gh 조회 실패는 다시 보면 풀릴 수 있어 retry 가 true 다.
//
// 판정하지 못한 PR 의 보드 항목을 닫아도 되는지는 closeUnjudged 가 정한다. board-sync.ts 와 finish-pr.ts 가 같은 조건을 쓴다
//
// 설정: config.json 의 finish 절 task_pattern, spec_task_pattern, specs_dir 다(rulesFrom). 정규식은 Python 정규식이고(lib/py.ts 의 pyRegExp)
// 업무 번호를 담을 그룹이 하나 이상 있어야 한다. 업무 번호는 영문, 숫자, `._/-` 만 받는다.
// GH 환경 변수로 gh 실행 파일을 바꾼다(lib/gh.ts 의 ghBin).

import { readdirSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { objectOr } from '../core/json.ts'
import { isFile } from './fs.ts'
import { ghJson } from './gh.ts'
import { orcaJson } from './orca.ts'
import { FINISHED_DISPATCH } from './worker-state.ts'
import { pyRegExp, pyStr } from './py.ts'
import { branchesOf } from './spec.ts'

const NUMBER_OK = /^[A-Za-z0-9._/-]+$/

export type LastPrRules = { taskPattern: RegExp | null; specTaskPattern: RegExp | null; specsDir: string | null }
export type LastPrVerdict = { last: boolean | null; retry: boolean; number: string | null; prs: string[]; specs: string[]; reason: string }
export type MergedPr = { number: string; title: string; branch: string }

// 정규식의 잡는 그룹 수. 빈 문자열에 늘 맞는 대안을 붙여 exec 결과의 길이로 센다
export function groupCount(re: RegExp): number {
  return (new RegExp(`(?:${re.source})|`).exec('') as RegExpExecArray).length - 1
}

// 업무 번호를 뽑는 정규식. 정규식이 아니거나 그룹이 없으면 Error 이고 메시지는 name 으로 시작한다
export function numberPattern(source: string, name: string): RegExp {
  let pattern: RegExp
  try {
    pattern = pyRegExp(source)
  } catch (e) {
    throw new Error(`${name} 이 정규식이 아니다: ${(e as Error).message}`)
  }
  if (groupCount(pattern) < 1) throw new Error(`${name} 에 업무 번호를 담을 그룹이 없다`)
  return pattern
}

// 글에서 업무 번호를 뽑는다. 맞지 않거나 번호가 비었거나 안전하지 않으면 null 이다
export function extractTaskNumber(text: string, pattern: RegExp): string | null {
  const number = pattern.exec(text || '')?.[1]
  if (!number) return null
  return NUMBER_OK.test(number) ? number : null
}

// finish 절에서 판정 규칙을 만든다. 정규식이 틀리면 Error 다
export function rulesFrom(finish: Record<string, unknown>, repo: string): LastPrRules {
  const pattern = (key: string) => {
    const value = finish[key]
    return typeof value === 'string' && value ? numberPattern(value, key) : null
  }
  const dir = typeof finish.specs_dir === 'string' && finish.specs_dir ? finish.specs_dir : null
  return { taskPattern: pattern('task_pattern'), specTaskPattern: pattern('spec_task_pattern'), specsDir: dir && !isAbsolute(dir) ? join(repo, dir) : dir }
}

// 지시서 폴더의 spec-*.md 경로와 내용. 이름 순이다. 폴더를 읽지 못하면 빈 목록이다
export function specFiles(dir: string): { path: string; text: string }[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found: { path: string; text: string }[] = []
  for (const name of names.filter((n) => n.startsWith('spec-') && n.endsWith('.md')).sort()) {
    const path = join(dir, name)
    if (!isFile(path)) continue
    try {
      found.push({ path, text: readFileSync(path, 'utf8') })
    } catch {
      continue
    }
  }
  return found
}

function list(repo: string, args: string[]): Record<string, unknown>[] | null {
  const got = ghJson<unknown>(args, { cwd: repo })
  if (!got.ok || !Array.isArray(got.data)) return null
  return got.data.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

// 머리 주석의 판정. reason 은 근거 줄의 괄호 안에 넣을 글이다
export function judgeLastPr(repo: string, pr: MergedPr, rules: LastPrRules): LastPrVerdict {
  const unknown = (why: string, number: string | null = null, retry = false): LastPrVerdict => ({
    last: null,
    retry,
    number,
    prs: [],
    specs: [],
    reason: `판정하지 못했다: ${why}`,
  })
  if (!rules.taskPattern) return unknown('task_pattern 이 없다')
  const pattern = rules.taskPattern
  const number = extractTaskNumber(pr.title, pattern)
  if (number === null) return unknown(`PR 제목에서 업무 번호를 찾지 못했다: ${pr.title}`)
  if (rules.specsDir && !rules.specTaskPattern) return unknown('specs_dir 는 있는데 spec_task_pattern 이 없다', number)
  const open = list(repo, ['pr', 'list', '--state', 'open', '--json', 'number,title', '--limit', '1000'])
  if (open === null) return unknown('열린 PR 을 읽지 못했다', number, true)
  const prs = open
    .filter((row) => pyStr(row.number) !== pr.number && extractTaskNumber(typeof row.title === 'string' ? row.title : '', pattern) === number)
    .map((row) => `#${pyStr(row.number)}`)
  const specs: string[] = []
  if (rules.specsDir) {
    const specPattern = rules.specTaskPattern as RegExp
    for (const spec of specFiles(rules.specsDir)) {
      const branches = branchesOf(spec.text)
      if (branches.includes(pr.branch)) continue
      if (!spec.text.split(/\r?\n/).some((line) => extractTaskNumber(line, specPattern) === number)) continue
      // 브랜치 줄이 없는 지시서는 아직 시작하지 않은 일이라 남은 것으로 센다
      let merged = branches.length > 0
      for (const branch of branches) {
        const rows = list(repo, ['pr', 'list', '--state', 'merged', '--head', branch, '--json', 'number', '--limit', '1'])
        if (rows === null) return unknown(`${basename(spec.path)} 의 브랜치 ${branch} 의 PR 을 읽지 못했다`, number, true)
        if (rows.length === 0) merged = false
      }
      if (!merged) specs.push(basename(spec.path))
    }
  }
  const specPart = rules.specsDir ? `남은 지시서 ${specs.join(' ') || '없음'}` : '지시서는 보지 않음(specs_dir 없음)'
  return { last: prs.length === 0 && specs.length === 0, retry: false, number, prs, specs, reason: `업무 ${number}, 남은 PR ${prs.join(' ') || '없음'}, ${specPart}` }
}

// 판정하지 못한 PR(last 가 null, gh 조회 실패는 retry 라 제외)의 마일스톤·단계 항목을 done 으로 닫아도 되는지.
// 판정 규칙이 없어도(task_pattern 이 없다) 항목의 상태가 일이 끝났음을 보이면 닫는다. 아래를 모두 만족할 때만이다. 하나라도 아니면 닫지 않는다.
//   - 판정 규칙을 읽지 못한 것이 아니다(rulesUnreadable)
//   - 열린 PR 이 없다(openPrs)
//   - 작업 중 worker 가 없다(activeWorker, hasActiveWorker 가 정한다)
//   - 남은 일 줄이 없다(remainingNote)
//   - 이 머지가 done 지점에 닿는다(reachedDone)
//   - 이 머지를 반영하면 모든 단계가 끝난다(allStepsDone)
// 잘못 닫으면 업무 완료로 번지므로 조건을 더 느슨하게 하지 않는다
export type UnjudgedClose = {
  rulesUnreadable: boolean
  openPrs: number
  activeWorker: boolean
  remainingNote: boolean
  reachedDone: boolean
  allStepsDone: boolean
}

export function closeUnjudged(verdict: Pick<LastPrVerdict, 'last' | 'retry'> | null, state: UnjudgedClose): boolean {
  if (verdict === null || verdict.last !== null || verdict.retry) return false
  return !state.rulesUnreadable && state.openPrs === 0 && !state.activeWorker && !state.remainingNote && state.reachedDone && state.allStepsDone
}

// 보드 줄이 working 이어도 Orca 의 dispatch 가 끝났으면 작업 중이 아니다. 끝난 상태는 lib/worker-state.ts 의 FINISHED_DISPATCH 뿐이다.
// abandoned 는 배정만 포기한 것이라 에이전트가 같은 워크트리에서 아직 돌 수 있어 끝으로 보지 않는다(references/launch.md). 그 밖의 값과 빈 값은 모르는 상태다.
// 「끝났다」 는 판정은 이 함수(dispatchFinished) 한 곳에만 둔다. finish-pr.ts 의 tellMerged 도 쓴다.
// 조회가 실패하거나 상태를 모르면 끝났다고 보지 않는다(허용 목록 밖은 모두 작업 중이다). 잘못 끝났다고 보면 살아 있는 worker 의 항목을 닫기 때문이다
export function dispatchFinished(status: unknown): boolean {
  return typeof status === 'string' && FINISHED_DISPATCH.has(status)
}

export function dispatchEnded(dispatch: string): boolean {
  const shown = orcaJson<{ dispatch?: unknown }>(['orchestration', 'worker-show', '--dispatch', dispatch])
  if (!shown.ok) return false
  const status = objectOr(objectOr(shown.data).dispatch).status
  return dispatchFinished(status)
}

// 작업 중 worker 가 있는지. skip 은 마무리가 종료를 확인한 줄처럼 이미 끝난 것을 아는 줄이다.
// 보드가 working 이라고 한 줄 가운데 dispatch id 가 있는 것은 Orca 로 실제 상태를 확인한다. id 가 없으면 확인할 수 없어 작업 중이다
export function hasActiveWorker<T extends { status: string; dispatch?: string | null }>(rows: readonly T[], skip: (row: T) => boolean = () => false): boolean {
  return rows.some((row) => {
    if (row.status !== 'working' || skip(row)) return false
    const dispatch = typeof row.dispatch === 'string' ? row.dispatch.trim() : ''
    return !(dispatch && dispatchEnded(dispatch))
  })
}
