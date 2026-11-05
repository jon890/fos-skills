import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { baseMergesOnly, featureBranch, featureEvidenceProblem, featureLoopRequested } from '../scripts/lib/feature-evidence.ts'
import { recordLaunch } from '../scripts/lib/launched.ts'

const HEAD = 'a'.repeat(40)
test('dispatch 지시서를 우선 보고 기록이 없을 때만 브랜치 지시서를 모은다', (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'feature-branch-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  spawnSync('git', ['init', '-q', repo])
  const specs = join(repo, '.orch/specs')
  mkdirSync(specs, { recursive: true })
  const loop = join(specs, 'spec-loop.md')
  const docs = join(specs, 'spec-docs.md')
  writeFileSync(loop, '브랜치: `feat/test`\n## 할 일\n루프를 쓴다(스펙: 새로 쓴다)\n')
  writeFileSync(docs, '브랜치: `feat/test`\n## 할 일\n루프 없이: 문서 정정\n')
  assert.equal(featureBranch(repo, 'feat/test'), true)
  // 오래된 계획 지시서와 새 문서 지시서를 함께 보아도 구현 PR 로 분류하지 않는다.
  writeFileSync(loop, '브랜치: `feat/test`\n## 할 일\n루프를 쓴다(스펙: 새로 쓴다)\n구현과 PR 은 코디네이터가 새 지시서로 맡긴다.\n')
  recordLaunch(repo, { dispatch: 'old', branch: 'feat/test', worktree: repo, terminal: null, run: null, spec: loop })
  utimesSync(join(repo, '.orch/state/launched-workers/old.json'), 1, 1)
  recordLaunch(repo, { dispatch: 'new', branch: 'feat/test', worktree: repo, terminal: null, run: null, spec: docs })
  assert.equal(featureBranch(repo, 'feat/test'), false)
  writeFileSync(docs, '브랜치: `feat/test`\n## 할 일\n루프를 쓴다(스펙: 새로 쓴다)\n')
  assert.equal(featureBranch(repo, 'feat/test'), true)
  // 계획 전용 지시서는 구현 PR 의 완료 근거를 요구하지 않는다.
  writeFileSync(docs, '브랜치: `feat/test`\n## 할 일\n루프를 쓴다(스펙: 새로 쓴다)\n구현과 PR 은 코디네이터가 새 지시서로 맡긴다.\n')
  assert.equal(featureBranch(repo, 'feat/test'), false)
  rmSync(join(repo, '.orch/state/launched-workers'), { recursive: true })
  writeFileSync(loop, readFileSync(docs, 'utf8'))
  assert.equal(featureBranch(repo, 'feat/test'), false)
})
test('구현 dispatch 뒤에 후속·충돌 해소 dispatch 가 붙어도 기능 PR 판정을 유지한다', (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'feature-followup-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  spawnSync('git', ['init', '-q', repo])
  const specs = join(repo, '.orch/specs')
  mkdirSync(specs, { recursive: true })
  const implementation = join(specs, 'spec-implementation.md')
  const followup = join(specs, 'spec-followup.md')
  writeFileSync(implementation, '브랜치: `feat/test`\n## 할 일\n루프를 쓴다(스펙: 새로 쓴다)\n')
  recordLaunch(repo, { dispatch: 'implementation', branch: 'feat/test', worktree: repo, terminal: null, run: null, spec: implementation })
  utimesSync(join(repo, '.orch/state/launched-workers/implementation.json'), 1, 1)
  for (const reason of ['후속 지적 반영', '기준 브랜치와 충돌 해소']) {
    writeFileSync(followup, `브랜치: \`feat/test\`\n## 할 일\n루프 없이: ${reason}\n`)
    recordLaunch(repo, { dispatch: 'followup', branch: 'feat/test', worktree: repo, terminal: null, run: null, spec: followup })
    assert.equal(featureBranch(repo, 'feat/test'), true)
  }
})
const BODY = `<!-- fos-feature-evidence -->
검증 커밋: ${HEAD}
인수 검증: 통과 | REQ1 API 응답과 DB 상태 확인, PR 본문의 실행 기록
문서 대조: 통과 | design과 domain 대조, 후보 없음: 기존 계약 재사용
독립 리뷰: 통과 | 독립 검토자의 리뷰 링크
후속 검증: 대기 | 배포 후 smoke, 코디네이터, CI 실행기, 기대값은 본문
<!-- /fos-feature-evidence -->`

test('기능 지시의 첫 줄만 보고 예시와 다른 절은 무시한다', () => {
  for (const heading of ['## 할 일', '## 할 일 · 후속']) {
    for (const prefix of ['', '- ', '1. ', '2) ', '- [ ] ', '* [x] ']) {
      assert.equal(featureLoopRequested(`${heading}\n\n${prefix}**루프를 쓴다(스펙: 새로 쓴다)**\n`), true)
    }
  }
  assert.equal(featureLoopRequested('## 할 일\n루프 없이: 오타\n## 참고\n루프를 쓴다(스펙: a)'), false)
  assert.equal(featureLoopRequested('```md\n## 할 일\n루프를 쓴다(스펙: a)\n```'), false)
})

test('필수 블록 누락, 예시 사본, 중복과 오래된 HEAD 를 막는다', () => {
  assert.ok(featureEvidenceProblem('', HEAD, true))
  assert.equal(featureEvidenceProblem('', HEAD), null)
  assert.ok(featureEvidenceProblem('```md\n' + BODY + '\n```', HEAD, true))
  assert.ok(featureEvidenceProblem(BODY + BODY, HEAD))
  assert.ok(featureEvidenceProblem(BODY, 'b'.repeat(40)))
  assert.ok(featureEvidenceProblem(BODY.replace('문서 대조: 통과', '문서 대조: 통과 | 중복\n문서 대조: 통과'), HEAD))
})

test('인수 검증, 문서 대조와 독립 리뷰는 모두 현재 근거가 필요하다', () => {
  assert.equal(featureEvidenceProblem(BODY, HEAD, true), null)
  for (const key of ['인수 검증', '문서 대조', '독립 리뷰']) {
    assert.ok(featureEvidenceProblem(BODY.replace(`${key}: 통과`, `${key}: 대기`), HEAD))
    assert.ok(featureEvidenceProblem(BODY.replace(new RegExp(`${key}:.*`), `${key}: 통과 | TBD`), HEAD))
    assert.ok(featureEvidenceProblem(BODY.replace(new RegExp(`${key}:.*\n`), ''), HEAD))
  }
})

test('후속 검증 대기는 머지를 허용하지만 완료와 정리는 막는다', () => {
  assert.equal(featureEvidenceProblem(BODY, HEAD), null)
  assert.ok(featureEvidenceProblem(BODY, HEAD, true, true))
  assert.equal(featureEvidenceProblem(BODY.replace('후속 검증: 대기', '후속 검증: 통과'), HEAD, true, true), null)
  assert.equal(featureEvidenceProblem(BODY.replace('후속 검증: 대기', '후속 검증: 없음'), HEAD, true, true), null)
})

// 검증 커밋 뒤 base 를 합친 merge 커밋만 있는 HEAD(update-branch 가 만든 꼴)를 임시 git 저장소로 본다.
// origin/main 은 refs/remotes/origin/main 을 직접 두어 흉내 낸다.
describe('baseMergesOnly', () => {
  let tmp = ''
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const git = (...args: string[]): string => {
    const done = spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8', env })
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
    return done.stdout.trim()
  }
  const commit = (name: string, body: string): string => {
    writeFileSync(join(tmp, name), body)
    git('add', '-A')
    git('commit', '-q', '-m', name)
    return git('rev-parse', 'HEAD')
  }
  // main 에 커밋을 더하고 origin/main 을 그 커밋으로 둔다
  const advanceMain = (name: string): string => {
    git('checkout', '-q', 'main')
    const sha = commit(name, `${name}\n`)
    git('update-ref', 'refs/remotes/origin/main', sha)
    git('checkout', '-q', 'feat')
    return sha
  }
  const mergeMain = (): string => {
    git('merge', '-q', '--no-ff', '--no-edit', 'main')
    return git('rev-parse', 'HEAD')
  }

  let verified = ''
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-feature-evidence-')))
    git('init', '-q', '-b', 'main')
    git('update-ref', 'refs/remotes/origin/main', commit('a.txt', 'a\n'))
    git('checkout', '-q', '-b', 'feat')
    verified = commit('feat.txt', 'feat\n')
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test('base 를 합친 merge 만 더한 HEAD 는 검증 커밋을 받아들인다. 두 번 합쳐도 같다', () => {
    advanceMain('b.txt')
    const once = mergeMain()
    assert.equal(baseMergesOnly(tmp, once, verified, 'main'), true)
    advanceMain('c.txt')
    const twice = mergeMain()
    assert.equal(baseMergesOnly(tmp, twice, verified, 'main'), true)
    const body = BODY.replace(HEAD, verified)
    assert.equal(featureEvidenceProblem(body, twice, true, false, (v) => baseMergesOnly(tmp, twice, v, 'main')), null)
    assert.ok(featureEvidenceProblem(body, twice, true))
  })

  test('검증 뒤 코드 커밋, merge 커밋에 더한 변경, base 밖 브랜치의 merge 는 받아들이지 않는다', () => {
    advanceMain('b.txt')
    mergeMain()
    const code = commit('more.txt', 'more\n')
    assert.equal(baseMergesOnly(tmp, code, verified, 'main'), false)

    git('reset', '-q', '--hard', verified)
    git('merge', '-q', '--no-ff', '--no-commit', 'main')
    writeFileSync(join(tmp, 'feat.txt'), 'changed in merge\n')
    git('add', '-A')
    git('commit', '-q', '--no-edit')
    const edited = git('rev-parse', 'HEAD')
    assert.equal(baseMergesOnly(tmp, edited, verified, 'main'), false)

    git('reset', '-q', '--hard', verified)
    git('checkout', '-q', '-b', 'side', 'main')
    commit('side.txt', 'side\n')
    git('checkout', '-q', 'feat')
    git('merge', '-q', '--no-ff', '--no-edit', 'side')
    const side = git('rev-parse', 'HEAD')
    assert.equal(baseMergesOnly(tmp, side, verified, 'main'), false)
  })

  test('HEAD 가 검증 커밋 자신이거나 모르는 커밋이면 false 다', () => {
    assert.equal(baseMergesOnly(tmp, verified, verified, 'main'), false)
    assert.equal(baseMergesOnly(tmp, 'f'.repeat(40), verified, 'main'), false)
  })
})
