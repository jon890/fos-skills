// 기능 PR 의 완료 근거 형식. 의미와 실행 사실은 코디네이터가 확인한다.
// 새 상태 저장소 없이 PR 본문을 읽고, 현재 HEAD 의 기록과 필수 검토 누락을 막는다.
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ghJson } from './gh.ts'
import { loadConfig } from './config.ts'
import { pathOf } from './paths.ts'
import { specsOnBranch, taskFirstLine } from './spec.ts'

export const EVIDENCE_START = '<!-- fos-feature-evidence -->'
const END = '<!-- /fos-feature-evidence -->'

export function featureLoopRequested(text: string): boolean {
  return /^루프를 쓴다\s*\(스펙\s*:/.test(taskFirstLine(text)?.text ?? '')
}

function withoutExamples(text: string): string {
  let fence = ''
  return text.split('\n').filter((line) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (mark) {
      if (!fence) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''
      return false
    }
    return !fence
  }).join('\n')
}

// 머지 큐를 직접 부른 경우에도 기본/설정 지시서에서 기능 경로를 찾는다.
export function featureBranch(repo: string, branch: string, explicit?: string): boolean {
  const config = loadConfig(repo)
  const configured = config.finish?.specs_dir
  if (configured !== undefined && typeof configured !== 'string') throw new Error('finish.specs_dir 는 경로 문자열이어야 한다')
  const dirs = [pathOf('specs', repo), explicit, configured].filter((v): v is string => Boolean(v))
  return dirs.some((dir) => {
    const full = isAbsolute(dir) ? dir : join(repo, dir)
    if (!existsSync(full)) return false
    return specsOnBranch(full, branch).some((file) => featureLoopRequested(readFileSync(file, 'utf8')))
  })
}

export function featureEvidenceProblem(body: string, head: string, required = false, afterMerge = false): string | null {
  const plain = withoutExamples(body)
  if (!required && !plain.includes(EVIDENCE_START)) return null // 기존 PR 은 읽기 호환
  const parts = plain.split(EVIDENCE_START)
  if (parts.length !== 2 || parts[1].split(END).length !== 2) return '기능 완료 근거 블록이 하나 필요하다'
  const block = parts[1].split(END)[0]
  const fields = new Map<string, string>()
  for (const line of block.split('\n')) {
    const match = /^(검증 커밋|인수 검증|문서 대조|독립 리뷰|후속 검증):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    if (fields.has(match[1])) return `기능 완료 근거의 ${match[1]} 이 중복됐다`
    fields.set(match[1], match[2].trim())
  }
  if (!/^[a-f0-9]{40}$/i.test(head) || fields.get('검증 커밋') !== head) return '기능 완료 근거의 검증 커밋이 현재 PR HEAD 와 다르다'
  for (const key of ['인수 검증', '문서 대조', '독립 리뷰', '후속 검증']) {
    const value = fields.get(key) ?? ''
    const match = /^(통과|대기|없음)\s*\|\s*(.+)$/.exec(value)
    if (!match || /^(?:TBD|미정|없음|[-?]|<.*>)$/i.test(match[2].trim())) return `기능 완료 근거의 ${key} 에 판정과 실제 근거가 필요하다`
    const allowed = key === '후속 검증' ? (afterMerge ? ['통과', '없음'] : ['통과', '대기', '없음']) : ['통과']
    if (!allowed.includes(match[1])) return `${key} 이 완료되지 않았다: ${value}`
  }
  return null
}

// finish-pr 밖의 자동 정리와 보드 동기화도 같은 후속 검증 기준을 적용한다.
export function featureCompletionProblem(repo: string, number: string, branch = '', specsDir?: string, knownBody = ''): string | null {
  const required = featureBranch(repo, branch, specsDir) || knownBody.includes(EVIDENCE_START)
  const got = ghJson<{ body?: unknown; headRefOid?: unknown; headRefName?: unknown }>(
    ['pr', 'view', number, '--json', 'body,headRefOid,headRefName', '--jq', '.'], { cwd: repo, cache: false })
  if (!got.ok || !got.data || typeof got.data !== 'object') return '기능 완료 근거 조회 실패'
  const body = typeof got.data.body === 'string' ? got.data.body : ''
  const discovered = typeof got.data.headRefName === 'string' ? got.data.headRefName : branch
  if (!required && !body.includes(EVIDENCE_START) && !featureBranch(repo, discovered, specsDir)) return null
  return featureEvidenceProblem(body, String(got.data.headRefOid ?? ''), true, true)
}
