#!/usr/bin/env node
// 기능 스펙의 최소 형식과 PR 계획의 요구사항 연결을 검사한다.
//
// cwd: 대상 저장소 루트.
// 사용: node check_feature.ts docs/features/run-cancel/spec.md [--plan tasks/plan1-cancel/index.json] [--draft]
// 종료 코드: 0 형식/연결 통과, 1 위반, 2 읽기/인자 오류.
//
// 스펙 검사:
// - 필수 절: 목표, 범위, 요구사항과 인수 조건, 결정. 새 형식은 REQ1/DECISION1, 기존 R1/D1 은 읽기 호환이다.
// - --design 은 책임·경계·데이터·일관성·검증 전략과 모든 요구사항의 연결을 검사한다.
// - verification_plan 이 있으면 그 파일(또는 phase 의 인수 검증 계획 절)과 PR 요구사항 연결을 검사한다.
//   경로는 계획 폴더 기준이다. --require-verification 은 새 계획의 누락도 막고, 기본값은 기존 계획을 그대로 읽는다.
// - 새 REQ 형식의 계획은 design 경로가 필요하다. 기존 R 형식 계획은 기술 설계 연결을 강제하지 않는다.
// - 결정 절은 `| D1 | 결정 | 답 | 누가 | 근거 |` 표이거나 `없음: <이유>` 한 줄이다.
//   「답」 이 비었거나 미정·TBD·? 면 닫히지 않은 결정이다.
//   「누가」 는 `사용자 YYYY-MM-DD`, `작성자`, `작성자(위임)` 중 하나다. 사용자 날짜 뒤에는 괄호 설명을 붙일 수 있다.
// - 제목과 첫 `##` 절 사이에 `확인: YYYY-MM-DD` 줄(사용자 확인 날짜)이 있다. `--draft` 면 이 줄을 요구하지 않는다.
//   `--plan` 과 함께 쓰면 계획이 가리킨 스펙에도 확인 줄을 요구한다. 확인 전에는 계획을 만들지 않는다.
// - 옛 `## 미결정` 절은 결정 표로 바꾸라고 알린다.
// 의미 완전성, 실제 실행 결과, 사용자 합의의 내용은 판정하지 않는다.
//
// 옵션은 argparse 처럼 긴 옵션의 고유한 접두(--dra)와 `--옵션=값` 을 받는다. 모르는 옵션은 사용법 오류(2)다.

import { isAbsolutePath, pyre, isRelativeTo, lstripPy, pathParent, posixJoin, pyPath, pyResolve, stripChars } from './pylike.ts'
import { isExpected, isMain, readTextFile as readText, ValueError, write } from './io.ts'
import { type Spec, parseCli, UsageError } from './cli.ts'
import { pySplitLines, pyStrCompare, pyStrip } from './kit/py.ts'

const SECTIONS = ['목표', '범위', '요구사항과 인수 조건', '결정']
const DESIGN_SECTIONS = ['요구사항 연결', '책임과 경계', '인터페이스와 데이터', '실패와 일관성', '검증 전략', '결정']
const ID = /^(?:REQ|R)[1-9][0-9]*$/
const DECISION_ID = /^(?:DECISION|D)[1-9][0-9]*$/
const DECIDER = /^(사용자 \p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}(?:\s*\([^()\n]+\))?|작성자|작성자\(위임\))$/u
const OPEN_ANSWERS = new Set(['', '미정', 'tbd', '?', '-'])
const CONFIRMED = pyre(/^확인:\s*(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2})\s*$/u)
const NO_DECISION = pyre(/^-?\s*없음:\s*\S[^\n]*$/)
const SPLIT_CELLS = /(?<!\\)\|/

const USAGE = `usage: check_feature.ts [-h] [--plan PLAN] [--require-verification] [--design DESIGN] [--draft] spec

기능 스펙의 최소 형식과 PR 계획의 요구사항 연결을 검사한다.

positional arguments:
  spec

options:
  -h, --help            show this help message and exit
  --plan PLAN
  --require-verification
                        새 기능 계획의 인수 검증 계획을 요구한다
  --design DESIGN       기술 설계 문서. 스펙의 기술 설계 절이면 스펙 경로를 준다
  --draft               사용자 확인 줄을 요구하지 않는다(인터뷰 중 형식 검사)
`

const SPEC: Spec = {
  options: [
    { name: 'plan', value: true },
    { name: 'require-verification', value: false },
    { name: 'design', value: true },
    { name: 'draft', value: false },
  ],
  positionals: [{ name: 'spec', nargs: 1 }],
}

// 코드 예시 안의 제목과 표는 계약으로 읽지 않는다. 첫 `##` 앞은 빈 이름('')의 머리로 모은다
export function sections(text: string): Map<string, string> {
  const result = new Map<string, string[]>([['', []]])
  let current = ''
  let fence: string | null = null
  for (const line of splitLines(text)) {
    const marker = pyre(/^\s*(`{3,}|~{3,})/).exec(line)
    if (marker) {
      const token = marker[1]
      if (fence === null) fence = token
      else if (token[0] === fence[0] && token.length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    if (line.startsWith('## ')) {
      current = pyStrip(line.slice(3))
      if (!result.has(current)) result.set(current, [])
    } else {
      result.get(current)!.push(line)
    }
  }
  return new Map([...result].map(([name, lines]) => [name, pyStrip(lines.join('\n'))]))
}

const splitLines = (text: string) => pySplitLines(text)

export function* tableRows(body: string): Generator<string[]> {
  for (const line of splitLines(body)) {
    if (lstripPy(line).startsWith('|')) {
      yield stripChars(pyStrip(line), '|')
        .split(SPLIT_CELLS)
        .map((cell) => pyStrip(cell).replaceAll('\\|', '|'))
    }
  }
}

function checkDecisions(body: string): string[] {
  const rows = [...tableRows(body)].filter((cells) => cells.length > 0 && DECISION_ID.test(cells[0]))
  if (rows.length === 0) {
    if (NO_DECISION.test(pyStrip(body))) return []
    return ['결정 절에 DECISION1 같은 ID 의 결정 표나 「없음: <이유>」 한 줄이 필요하다']
  }
  const problems: string[] = []
  const seen = new Set<string>()
  for (const cells of rows) {
    const did = cells[0]
    if (seen.has(did)) problems.push(`결정 ID 중복: ${did}`)
    seen.add(did)
    if (cells.length < 5) {
      problems.push(`${did}: 결정, 답, 누가, 근거 칸이 필요하다`)
      continue
    }
    const [, title, answer, decider, reason] = cells
    if (!title) problems.push(`${did}: 무엇을 정했는지 결정 칸이 비었다`)
    if (OPEN_ANSWERS.has(answer.toLowerCase())) problems.push(`${did}: 답이 닫히지 않았다(${answer || '빈칸'}). 사용자에게 묻거나 근거를 남겨 정한다`)
    if (!DECIDER.test(decider)) problems.push(`${did}: 누가 칸은 「사용자 YYYY-MM-DD」, 「작성자」, 「작성자(위임)」 중 하나다(지금 ${decider || '빈칸'})`)
    const explanation = /\(([^()]*)\)$/.exec(decider)?.[1] ?? ''
    if (/대기|미정|tbd/i.test(explanation)) problems.push(`${did}: 누가 칸의 괄호 설명에 미확정 상태가 있다(${explanation}). 결정을 확정한 뒤 기록한다`)
    if (!reason) problems.push(`${did}: 근거 칸이 비었다`)
  }
  return problems
}

// date.fromisoformat 은 실제 달력의 날짜만 받는다
function validDate(text: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return false
  const [y, m, d] = text.split('-').map(Number)
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return d <= days[m - 1]
}

function checkConfirmed(head: string): string[] {
  for (const line of splitLines(head)) {
    const match = CONFIRMED.exec(pyStrip(line))
    if (match) {
      if (!validDate(match[1])) return [`확인 줄의 날짜가 올바르지 않다: ${match[1]}`]
      return []
    }
  }
  return ['사용자 확인 줄(제목 아래 「확인: YYYY-MM-DD」)이 없다. 사용자가 스펙을 확인하기 전에는 계획을 만들지 않는다']
}

function checkDomainChanges(rawBody: string, draft = false): string[] {
  const body = pyStrip(rawBody.replace(pyre(/<!--[\s\S]*?-->/g), ''))
  if (!body || body.startsWith('도메인 규칙 변경 없음:')) return []
  const rows = [...tableRows(body)].filter((cells) => cells.length > 0 && /(?<![\p{L}\p{N}_])RULE(?:[1-9][0-9]*|(?:-[A-Z0-9]+)+)(?![\p{L}\p{N}_])/u.test(cells[0]))
  if (rows.length === 0) return ['도메인 규칙 변경 절에 RULE ID 의 변경 표 또는 「도메인 규칙 변경 없음: 이유」 가 필요하다']
  const problems: string[] = []
  for (const cells of rows) {
    if (cells.length !== 6 || cells.some((cell) => !cell || OPEN_ANSWERS.has(cell.toLowerCase()))) {
      problems.push(`${cells[0]}: 규칙, 변경 내용, 결정 상태, 제안자, 확정 근거, 외부 검토가 필요하다`)
      continue
    }
    if (!['제안', '확인 대기', '확정'].includes(cells[2])) problems.push(`${cells[0]}: 모르는 결정 상태 ${cells[2]}`)
    else if (!draft && cells[2] !== '확정') problems.push(`${cells[0]}: 도메인 규칙이 확정되지 않았다(${cells[2]})`)
    if (cells[2] === '확정' && ['없음', '미정', 'tbd'].includes(cells[4].toLowerCase())) problems.push(`${cells[0]}: 확정 근거가 필요하다`)
  }
  return problems
}

export function checkSpec(text: string, draft = false): [Set<string>, string[]] {
  const found = sections(text)
  const problems: string[] = []
  const ids: string[] = []
  if (found.has('미결정') && !found.has('결정')) problems.push('옛 「미결정」 절을 「결정」 표로 바꾼다(spec 의 references/interview.md)')
  for (const name of SECTIONS) if (!found.get(name)) problems.push(`스펙의 필수 절이 없거나 비었다: ${name}`)
  for (const cells of tableRows(found.get('요구사항과 인수 조건') ?? '')) {
    if (cells.length === 0 || !ID.test(cells[0])) continue
    const rid = cells[0]
    if (ids.includes(rid)) problems.push(`요구사항 ID 중복: ${rid}`)
    ids.push(rid)
    if (cells.length < 3 || !cells[1] || !cells[2]) problems.push(`${rid}: 요구사항과 인수 조건이 필요하다`)
  }
  if (ids.length === 0) problems.push('요구사항 표에 REQ1 같은 ID 와 인수 조건이 필요하다')
  if (found.get('결정')) problems.push(...checkDecisions(found.get('결정')!))
  problems.push(...checkDomainChanges(found.get('도메인 규칙 변경') ?? '', draft))
  if (!draft) problems.push(...checkConfirmed(found.get('') ?? ''))
  return [new Set(ids), problems]
}

// 설계의 구조·요구사항 연결만 검사한다. 의미와 독립 검토는 판정하지 않는다
export function checkDesign(rawText: string, requirementIds: Set<string>, inline = false): string[] {
  let text = rawText
  if (inline) {
    const body = sections(text).get('기술 설계') ?? ''
    text = body.replace(/(?<![^\n])### /g, '## ')
  }
  const found = sections(text)
  const problems = DESIGN_SECTIONS.filter((name) => !found.get(name)).map((name) => `기술 설계의 필수 절이 없거나 비었다: ${name}`)
  const linked = new Set<string>()
  for (const cells of tableRows(found.get('요구사항 연결') ?? '')) {
    if (cells.length === 0 || !ID.test(cells[0])) continue
    const rid = cells[0]
    if (linked.has(rid)) problems.push(`기술 설계 요구사항 ID 중복: ${rid}`)
    linked.add(rid)
    if (cells.length < 2 || !cells[1]) problems.push(`${rid}: 기술 설계의 해결 방법이 비었다`)
  }
  if ([...linked].some((id) => !requirementIds.has(id))) problems.push('기술 설계에 스펙에 없는 요구사항 ID 가 있다')
  const unlinked = [...requirementIds].filter((id) => !linked.has(id))
  if (unlinked.length) problems.push(`기술 설계에 연결하지 않은 요구사항: ${unlinked.sort(pyStrCompare).join(', ')}`)
  if (found.get('결정')) problems.push(...checkDecisions(found.get('결정')!))
  return problems
}

// 저장소 루트 기준 상대 경로를 실제 경로로 바꾼다. 절대 경로와 저장소 밖은 던진다
function inside(root: string, value: unknown): string {
  if (typeof value !== 'string' || !pyStrip(value) || isAbsolutePath(value)) throw new ValueError('스펙 경로는 저장소 루트 기준 상대경로여야 한다')
  const path = pyResolve(posixJoin(root, value))
  if (!isRelativeTo(path, pyResolve(root))) throw new ValueError('스펙 경로가 저장소 밖을 가리킨다')
  return path
}

// worker 가 할 수 없는 실행 환경을 가리키는 낱말이다. 실행 환경 칸에 있으면 담당은 코디네이터여야 한다.
// 원본은 templates/verification-plan.md 의 주석이다. 둘을 함께 고친다
const WORKER_IMPOSSIBLE = ['Orca', 'worker 띄우', 'worker 를 띄', 'worker 를 시작', '워커 띄', '코디네이터 세션']

function workerEnvironment(environment: string): string {
  // 테스트 대역을 뜻하는 명사구만 뺀다. 같은 칸에 실제 환경도 있으면 그 부분은 그대로 검사한다.
  return environment.replace(/(?:가짜|모의|fake|mock|stub)\s+`?orca`?(?:\s+(?:cli|명령))?|`?orca`?\s+(?:대역|스텁|모형|mock|stub)/gi, '')
}

// 검증 계획의 구조와 PR 요구사항 연결만 본다. 절차의 충분성·실행 결과는 보지 않는다
export function checkVerification(text: string, assigned: Set<string>): string[] {
  const body = sections(text).get('인수 검증 계획') ?? ''
  if (!body) return ['인수 검증 계획 절이 없거나 비었다']
  const legacyHeaders = ['요구사항', '준비 조건', '실행 절차', '기대 결과', '실행 환경', '선행 조건', '시점']
  // 실행 담당 칸은 실행 환경 다음에 온다. 칸이 없는 옛 표는 담당을 검사하지 않고 그대로 받는다
  const headers = [...legacyHeaders.slice(0, 5), '실행 담당', ...legacyHeaders.slice(5)]
  const rows = [...tableRows(body)]
  const owned = rows.length > 0 && rows[0].length === headers.length && rows[0].every((cell, i) => cell === headers[i])
  const legacy = rows.length > 0 && rows[0].length === legacyHeaders.length && rows[0].every((cell, i) => cell === legacyHeaders[i])
  if (!owned && !legacy) return [`인수 검증 계획 표의 열은 ${headers.join(', ')} 순서여야 한다`]
  const width = owned ? headers.length : legacyHeaders.length
  const problems: string[] = []
  const covered = new Set<string>()
  for (const cells of rows.slice(1)) {
    if (cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    if (cells.length !== width) {
      problems.push('인수 검증 사례에 준비 조건·절차·기대값·환경·담당·선행 조건·시점이 필요하다')
      continue
    }
    const [rid, , , , environment] = cells
    const owner = owned ? cells[5] : ''
    const prerequisite = cells[width - 2]
    const timing = cells[width - 1]
    for (const id of rid.split(/[,、]/).map((value) => value.trim()).filter(Boolean)) {
      if (!ID.test(id)) problems.push(`인수 검증에 이번 PR 범위 밖의 요구사항: ${id}. 한 칸에 ID 를 쉼표로 나눠 적는다`)
      else if (!assigned.has(id)) problems.push(`인수 검증에 이번 PR 범위 밖의 요구사항: ${id}`)
      else covered.add(id)
    }
    if (cells.some((cell) => OPEN_ANSWERS.has(cell.toLowerCase()) || cell.includes('{{') || cell.includes('}}'))) {
      problems.push(`${rid}: 인수 검증 사례의 빈칸·미정·양식 자리표시자를 채운다`)
    }
    if (owned && owner !== 'worker' && owner !== '코디네이터') problems.push(`${rid}: 실행 담당은 worker 또는 코디네이터다: ${owner}`)
    const actualEnvironment = workerEnvironment(environment).toLowerCase()
    const blocked = WORKER_IMPOSSIBLE.find((word) => actualEnvironment.includes(word.toLowerCase()))
    if (owner === 'worker' && blocked) problems.push(`${rid}: 실행 환경에 \`${blocked}\` 가 있어 worker 가 할 수 없는 검증이다. 실행 담당을 코디네이터로 적는다`)
    if (timing !== 'PR 전' && timing !== 'PR 뒤') problems.push(`${rid}: 인수 검증 시점은 PR 전 또는 PR 뒤다`)
    if (!pyre(/^(없음|push|머지|배포)(?:\s|$|[(:])/).test(prerequisite)) problems.push(`${rid}: 선행 조건은 없음, push, 머지, 배포 중 하나로 시작한다`)
    if (timing === 'PR 전' && (prerequisite.startsWith('머지') || prerequisite.startsWith('배포'))) problems.push(`${rid}: 머지·배포가 필요한 검증은 PR 뒤다`)
  }
  const uncovered = [...assigned].filter((id) => !covered.has(id))
  if (uncovered.length) problems.push(`인수 검증 사례가 없는 요구사항: ${uncovered.sort(pyStrCompare).join(', ')}`)
  return problems
}

function checkVerificationFile(data: Record<string, unknown>, planPath: string | null, assigned: Set<string>, required: boolean): string[] {
  const value = data.verification_plan
  if (value === undefined || value === null) return required ? ['새 기능 계획에 verification_plan 경로가 필요하다'] : []
  if (planPath === null) return ['검증 계획을 읽으려면 계획 index 경로가 필요하다']
  try {
    // 경로는 repo 기준인 spec/design 과 달리 index.json 의 부모 기준이다
    const directory = pathParent(pyResolve(planPath))
    if (typeof value !== 'string' || !pyStrip(value) || isAbsolutePath(value)) throw new ValueError('verification_plan 은 계획 폴더 기준 상대경로여야 한다')
    const path = pyResolve(posixJoin(directory, value))
    if (!isRelativeTo(path, directory)) throw new ValueError('verification_plan 이 다른 계획 폴더를 가리킨다')
    return checkVerification(readText(path), assigned)
  } catch (error) {
    if (!isExpected(error)) throw error
    return [`인수 검증 계획을 읽을 수 없다: ${errorText(error)}`]
  }
}

const errorText = (error: Error) => error.message

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'string')

export function checkPlan(data: unknown, root: string, expectedSpec: string | null = null, planPath: string | null = null, requireVerification = false): string[] {
  if (!isRecord(data)) return ['계획 index 는 객체여야 한다']
  let spec: string
  let ids: Set<string>
  let problems: string[]
  try {
    spec = inside(root, data.spec)
    ;[ids, problems] = checkSpec(readText(spec))
  } catch (error) {
    if (!isExpected(error)) throw error
    return [`계획의 스펙을 읽을 수 없다: ${errorText(error)}`]
  }
  if (expectedSpec !== null && spec !== pyResolve(expectedSpec)) problems.push('검사한 스펙과 계획의 spec 이 다르다')
  // 새 REQ 형식은 기술 설계를 필수로 연결한다. 기존 R 계획은 경로·스키마를 유지한다
  const designValue = data.design
  if (designValue !== undefined && designValue !== null) {
    try {
      const design = inside(root, designValue)
      problems.push(...checkDesign(readText(design), ids, design === spec))
    } catch (error) {
      if (!isExpected(error)) throw error
      problems.push(`계획의 기술 설계를 읽을 수 없다: ${errorText(error)}`)
    }
  } else if ([...ids].some((rid) => rid.startsWith('REQ'))) {
    problems.push('새 기능 계획에 design 경로가 필요하다. technical-design 을 먼저 완료한다')
  }
  const assignedValue = data.requirements
  if (!isStringList(assignedValue)) return [...problems, '계획 requirements 에 이번 PR 의 요구사항 ID 목록이 필요하다']
  const assigned = assignedValue
  if (new Set(assigned).size !== assigned.length || assigned.some((id) => !ids.has(id))) problems.push('계획 requirements 에 중복 또는 스펙에 없는 ID 가 있다')
  // 계획 단계에서 이미 작성한 ADR 등 문서 요구사항은 파일을 근거로 연결한다.
  // 명시한 ID 만 phase 배정에서 제외하며, 일반 구현 요구사항까지 자동 면제하지 않는다.
  const documented = new Set<string>()
  const planDocs = data.plan_commit_requirements
  if (planDocs !== undefined) {
    if (!isRecord(planDocs)) problems.push('plan_commit_requirements 는 요구사항 ID 와 문서 경로의 객체여야 한다')
    else for (const [id, value] of Object.entries(planDocs)) {
      if (!assigned.includes(id)) problems.push(`계획 문서에 이번 PR 범위 밖의 요구사항: ${id}`)
      try {
        const document = inside(root, value)
        if (!document.endsWith('.md') || !pyStrip(readText(document))) throw new ValueError('내용이 있는 Markdown 문서가 필요하다')
        documented.add(id)
      } catch (error) {
        if (!isExpected(error)) throw error
        problems.push(`${id}: 계획 커밋의 문서를 읽을 수 없다: ${errorText(error)}`)
      }
    }
  }
  const phases = data.phases
  if (!Array.isArray(phases) || phases.length === 0) return [...problems, '요구사항을 구현할 phases 배열이 필요하다']
  const covered = new Set<string>()
  phases.forEach((phase, i) => {
    const reqs = isRecord(phase) ? phase.requirements : undefined
    if (!isStringList(reqs)) {
      problems.push(`phase ${i + 1}: requirements ID 목록이 필요하다`)
      return
    }
    if (reqs.some((id) => !assigned.includes(id))) problems.push(`phase ${i + 1}: 이번 PR 범위 밖의 요구사항 ID 가 있다`)
    for (const id of reqs) covered.add(id)
  })
  const unassigned = assigned.filter((id) => !covered.has(id) && !documented.has(id))
  if (unassigned.length) problems.push(`phase 에 배정하지 않은 요구사항: ${[...new Set(unassigned)].sort(pyStrCompare).join(', ')}`)
  problems.push(...checkVerificationFile(data, planPath, new Set(assigned), requireVerification))
  return problems
}

export type Run = { code: number; stdout: string; stderr: string }

// 인자를 읽고 검사한다. 출력은 쓰지 않고 돌려준다. verify_task 가 같은 폴더의 함수로 부른다
export function run(argv: string[], cwd: string): Run {
  let parsed
  try {
    parsed = parseCli(argv, SPEC)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    return { code: 2, stdout: '', stderr: `${USAGE.split('\n')[0]}\ncheck_feature.ts: error: ${error.message}\n` }
  }
  if (parsed.help) return { code: 0, stdout: USAGE, stderr: '' }
  const specArg = parsed.positionals.spec as string
  const planArg = parsed.options.plan as string | undefined
  const designArg = parsed.options.design as string | undefined
  const draft = parsed.options.draft === true
  const requireVerification = parsed.options['require-verification'] === true
  if (requireVerification && planArg === undefined) {
    return { code: 2, stdout: '', stderr: `${USAGE.split('\n')[0]}\ncheck_feature.ts: error: --require-verification 은 --plan 과 함께 쓴다\n` }
  }
  let problems: string[]
  try {
    const spec = inside(cwd, pyPath(specArg))
    let ids: Set<string>
    ;[ids, problems] = checkSpec(readText(spec), draft && planArg === undefined && designArg === undefined)
    if (designArg !== undefined) {
      const design = inside(cwd, pyPath(designArg))
      problems.push(...checkDesign(readText(design), ids, design === spec))
    }
    if (planArg !== undefined) {
      const planPath = posixJoin(cwd, pyPath(planArg))
      problems.push(...checkPlan(JSON.parse(readText(planPath)), cwd, spec, planPath, requireVerification))
    }
  } catch (error) {
    if (!isExpected(error)) throw error
    return { code: 2, stdout: '', stderr: `${errorText(error)}\n` }
  }
  const out = [...new Set(problems)].map((problem) => `${problem}\n`).join('')
  return { code: problems.length ? 1 : 0, stdout: out, stderr: '' }
}

export function main(argv: string[]): number {
  const result = run(argv, process.cwd())
  if (result.stdout) write(1, result.stdout)
  if (result.stderr) write(2, result.stderr)
  return result.code
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
