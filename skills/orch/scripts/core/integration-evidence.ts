// 모듈 코드를 바꾼 PR 의 통합 테스트 기록 판정. 머지 관문(queue/steps/gate.ts)과 설정 검사표(config-schema.ts)가 쓴다.
// 꼴과 근거는 docs/features/gate-integration-evidence/design.md 가 소유한다.
//
// 설정: config.json 의 queue.integration_tests. 규칙 목록이고 규칙 하나는 { paths, command } 다.
//   paths   바뀐 파일 경로 glob(문자열이나 목록). `<모듈>` 이 꼭 하나 있어야 하고 경로 조각 하나에 맞는다.
//           `**` 는 `/` 를 넘는 아무 글자, `*` 는 조각 안의 아무 글자, `?` 는 조각 안의 한 글자다. 경로 전체가 맞아야 한다
//   command 그 모듈의 통합 테스트 명령. `<모듈>` 을 모듈 이름으로 바꾼다
// 설정이 없거나 빈 목록이면 규칙이 없다. 관문은 바뀐 파일을 읽지 않고 지금과 같다.
//
// PR 본문(코드 블록 밖):
//   「검증」 절(제목이 `검증` 으로 시작하는 Markdown 제목부터 같거나 높은 단계 제목 앞까지)의
//     `통합 테스트 통과: <모듈> | <명령> | <40자리 커밋>` 줄이 기록이다. 앞에 목록 표시(`- `, `* `)를 붙여도 된다
//   본문 어디든 `통합 테스트 생략: <모듈> <이유>` 줄은 그 모듈을 넘긴다. 이유가 비면 생략으로 보지 않는다
//   HTML 주석 안의 줄은 읽지 않는다. 칸 양끝의 백틱은 벗긴다. 목록 표시(번호, 체크박스 포함)를 앞에 붙여도 된다
//
// 판정(integrationProblems): 필요한 (모듈, 명령)마다
//   생략한 모듈이면 notes 에 `통합 테스트 생략 <모듈>: <이유>`
//   모듈과 명령이 같은 기록 중 커밋이 head 이거나 accept 가 받아들이면 통과
//   기록의 커밋이 모두 40자리가 아니면 `통합 테스트 기록의 커밋이 40자리가 아니다: <모듈>`
//   기록은 있는데 그 커밋이 아니면 `통합 테스트 기록이 head 가 아니다: <모듈>`
//   기록이 없으면 `통합 테스트 기록 없음: <모듈> (<명령>)`
// accept 는 기능 완료 근거의 검증 커밋과 같은 예외(base 만 합친 merge, 계획 폴더 삭제)를 받는다.

import { ConfigError, QUEUE_KEYS, section } from './config.ts'
import type { Config } from './config.ts'
import { isObject } from './json.ts'

export const MODULE_MARK = '<모듈>'

export type IntegrationRule = { paths: RegExp[]; command: string }
export type IntegrationNeed = { module: string; command: string }

function globSource(glob: string, key: string): string {
  const pieces = glob.split(MODULE_MARK)
  if (pieces.length !== 2) throw new ConfigError(`설정 파일의 ${key} 에는 ${MODULE_MARK} 가 꼭 하나 있어야 한다: ${glob}`)
  const part = (text: string): string => text.replace(/\*\*|[*?]|[.+^${}()|[\]\\]/g, (m) => (m === '**' ? '.*' : m === '*' ? '[^/]*' : m === '?' ? '[^/]' : `\\${m}`))
  return `^${part(pieces[0])}([^/]+)${part(pieces[1])}$`
}

// 규칙 목록. 꼴이 틀리면 ConfigError 다
export function integrationRules(config: Config): IntegrationRule[] {
  const body = section<Record<string, unknown>>(config, 'queue', QUEUE_KEYS)
  const raw = body.integration_tests
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new ConfigError('설정 파일의 queue.integration_tests 는 { paths, command } 규칙의 목록이어야 한다')
  return raw.map((rule, i) => {
    const key = `queue.integration_tests[${i}]`
    if (!isObject(rule)) throw new ConfigError(`설정 파일의 ${key} 는 { paths, command } 객체여야 한다`)
    const unknown = Object.keys(rule).filter((name) => name !== 'paths' && name !== 'command').sort()
    if (unknown.length > 0) throw new ConfigError(`설정 파일의 ${key} 에 모르는 키가 있다: ${unknown.join(', ')}`)
    const paths = typeof rule.paths === 'string' ? [rule.paths] : rule.paths
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p !== '')) {
      throw new ConfigError(`설정 파일의 ${key}.paths 는 비지 않은 glob 문자열이나 그 목록이어야 한다`)
    }
    const command = rule.command
    if (typeof command !== 'string' || !command.trim()) throw new ConfigError(`설정 파일의 ${key}.command 는 비지 않은 문자열이어야 한다`)
    return { paths: (paths as string[]).map((p) => new RegExp(globSource(p, `${key}.paths`))), command: command.trim() }
  })
}

// 바뀐 파일이 맞는 (모듈, 명령). 모듈 이름 순서이고 겹치지 않는다
export function integrationNeeds(files: readonly string[], rules: readonly IntegrationRule[]): IntegrationNeed[] {
  const found = new Map<string, IntegrationNeed>()
  for (const file of files) {
    for (const rule of rules) {
      for (const path of rule.paths) {
        const module = path.exec(file)?.[1]
        if (!module) continue
        const command = rule.command.split(MODULE_MARK).join(module)
        found.set(`${module}\n${command}`, { module, command })
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.module === b.module ? (a.command < b.command ? -1 : 1) : a.module < b.module ? -1 : 1))
}

// 코드 블록(``` 나 ~~~)과 HTML 주석 밖의 줄. 닫는 줄은 여는 줄과 같은 글자로 그 길이 이상이고 뒤에 글이 없어야 한다(CommonMark)
function plainLines(body: string): string[] {
  let fence = ''
  const text = body.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, ''))
  return text.split(/\r\n|\n|\r/).filter((line) => {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = ''
      return false
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (open) {
      fence = open
      return false
    }
    return true
  })
}

// 「검증」 절의 줄. 같은 제목이 여럿이면 모두 모은다
function verificationLines(lines: string[]): string[] {
  const picked: string[] = []
  let level = 0
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      if (level && heading[1].length <= level) level = 0
      if (!level && /^검증/.test(heading[2].replace(/[*_]/g, '').trim())) {
        level = heading[1].length
        continue
      }
    }
    if (level) picked.push(line)
  }
  return picked
}

// 앞에 붙여도 되는 목록 표시: `- `, `* `, `+ `, `1. `, `1) `, 체크박스 `[ ] `, `[x] `
const LIST = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/
// 칸 양끝의 백틱을 벗긴다
const cell = (text: string): string => text.trim().replace(/^`+|`+$/g, '').trim()

export function integrationProblems(
  body: string,
  head: string,
  needs: readonly IntegrationNeed[],
  accept: (commit: string) => boolean = () => false,
): { reasons: string[]; notes: string[] } {
  const lines = plainLines(body)
  const skips = new Map<string, string>()
  for (const line of lines) {
    const m = new RegExp(`${LIST.source}통합 테스트 생략:\\s*(\\S+)(?:\\s+(.*))?$`).exec(line)
    const reason = m?.[2]?.trim()
    if (m && reason && !skips.has(cell(m[1]))) skips.set(cell(m[1]), reason)
  }
  const records = verificationLines(lines).flatMap((line) => {
    const m = new RegExp(`${LIST.source}통합 테스트 통과:\\s*(\\S+)\\s*\\|\\s*(.+?)\\s*\\|\\s*(\\S+)\\s*$`).exec(line)
    return m ? [{ module: cell(m[1]), command: cell(m[2]), commit: cell(m[3]).toLowerCase() }] : []
  })
  const reasons: string[] = []
  const notes: string[] = []
  const noted = new Set<string>()
  const judged = new Map<string, boolean>()
  const passes = (commit: string): boolean => {
    if (!/^[0-9a-f]{40}$/.test(commit)) return false
    if (commit === head.toLowerCase()) return true
    if (!judged.has(commit)) judged.set(commit, accept(commit))
    return judged.get(commit) as boolean
  }
  for (const need of needs) {
    const skip = skips.get(need.module)
    if (skip !== undefined) {
      if (!noted.has(need.module)) notes.push(`통합 테스트 생략 ${need.module}: ${skip}`)
      noted.add(need.module)
      continue
    }
    const mine = records.filter((r) => r.module === need.module && r.command === need.command)
    if (mine.some((r) => passes(r.commit))) continue
    if (mine.length === 0) reasons.push(`통합 테스트 기록 없음: ${need.module} (${need.command})`)
    else if (mine.every((r) => !/^[0-9a-f]{40}$/.test(r.commit))) reasons.push(`통합 테스트 기록의 커밋이 40자리가 아니다: ${need.module}`)
    else reasons.push(`통합 테스트 기록이 head 가 아니다: ${need.module}`)
  }
  return { reasons: [...new Set(reasons)], notes }
}
