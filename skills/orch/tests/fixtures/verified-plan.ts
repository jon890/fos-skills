import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../../../../modules/testkit/git.ts'

export const HEAD_MISMATCH = '기능 완료 근거의 검증 커밋이 현재 PR HEAD 와 다르다'

export function verifiedPlan(repo: string, extraChange: boolean): { verified: string; head: string } {
  const dir = join(repo, 'plans', 'topic')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ name: 'topic', phases: [{ file: 'phase.md' }] }))
  writeFileSync(join(dir, 'phase.md'), 'plan')
  git(repo, ['add', 'plans/topic'])
  git(repo, ['commit', '-qm', 'add plan'])
  const verified = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['rm', '-qr', 'plans/topic'])
  if (extraChange) {
    writeFileSync(join(repo, 'outside.txt'), 'outside the plan')
    git(repo, ['add', 'outside.txt'])
  }
  git(repo, ['commit', '-qm', 'remove plan'])
  return { verified, head: git(repo, ['rev-parse', 'HEAD']) }
}

export function verifiedPlanEvidence(verified: string): string {
  return `<!-- fos-feature-evidence -->
검증 커밋: ${verified}
인수 검증: 통과 | REQ1 실제 실행 로그
문서 대조: 통과 | 설계 대조
독립 리뷰: 통과 | 별도 리뷰 결과
후속 검증: 없음 | 배포 없는 변경
<!-- /fos-feature-evidence -->`
}
