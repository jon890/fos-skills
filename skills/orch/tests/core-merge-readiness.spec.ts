import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blocksMerge, blocksReady, CONDITIONS, judgeReadiness, matchBoardItems } from '../scripts/core/merge-readiness.ts'
import type { FactValues, ReadinessAsk, ReadinessPolicy, ReadinessSnapshot } from '../scripts/core/merge-readiness.ts'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const pass = { name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS' }
const policy: ReadinessPolicy = {
  required: ['Tests'], allowFail: [], skippedIsMissing: false, allowNoChecks: true,
  review: null, integrationRules: [], migrationDirs: {}, privateWords: false,
}
// 모든 조건을 통과하는 값. 테스트마다 하나만 바꾼다
const clean: FactValues = {
  checks: { ok: true, value: [pass], head: HEAD },
  threads: { ok: true, value: '0' },
  mergeable: { ok: true, value: 'MERGEABLE' },
  body: { ok: true, value: '', head: HEAD },
  holdBody: { ok: true, value: null },
  specHold: { ok: true, value: null },
  boardItems: { ok: true, value: [] },
}
const full: ReadinessAsk = { scope: 'full' }

function snap(facts: FactValues = {}, pr: Partial<ReadinessSnapshot['pr']> = {}): ReadinessSnapshot {
  return { pr: { number: 7, head: HEAD, base: 'main', branch: 'feat/x', draft: false, ...pr }, facts: { ...clean, ...facts } }
}

const texts = (snapshot: ReadinessSnapshot, ask: ReadinessAsk = full, p: ReadinessPolicy = policy) => judgeReadiness(snapshot, p, ask).reasons.map((r) => r.text)

test('모든 값이 통과면 이유가 없고 summary 는 관문 로그 꼴이다', () => {
  const judged = judgeReadiness(snap(), policy, full)
  assert.deepEqual(judged.reasons, [])
  assert.deepEqual(judged.need, [])
  assert.equal(judged.summary, 'fails=0 threads=0 mergeable=MERGEABLE')
})

test('값이 없으면 범위 안의 조건이 달라는 값을 need 로 돌려준다', () => {
  const judged = judgeReadiness({ pr: snap().pr, facts: {} }, policy, full)
  assert.deepEqual(new Set(judged.need), new Set(['checks', 'specHold', 'boardItems', 'threads', 'holdBody', 'mergeable', 'body']))
  const first = judgeReadiness({ pr: snap().pr, facts: {} }, policy, { scope: 'light', stopAtFirst: true })
  assert.deepEqual(first.need, ['checks'])
})

test('조건마다 걸린 이유를 지금 관문의 문구와 출력 순서로 낸다', () => {
  const failed = { name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE' }
  const reasons = texts(snap({
    checks: { ok: true, value: [failed], head: HEAD },
    threads: { ok: true, value: '2' },
    mergeable: { ok: true, value: 'CONFLICTING' },
  }))
  assert.deepEqual(reasons, [
    '실패한 체크 1 개',
    '체크가 아직 끝나지 않았다(진행 중 0, 나타나지 않은 필수 체크 Tests)',
    '미해결 리뷰 스레드 2 개',
    'base(main) 와 충돌한다(mergeable=CONFLICTING)',
  ])
  assert.deepEqual(texts(snap({ mergeable: { ok: true, value: '' } })), ['mergeable=조회 실패'])
})

test('체크 대기 뒤(compat checksAfterWait)에는 실패만 본다', () => {
  const pending = { name: 'Tests', status: 'IN_PROGRESS', conclusion: null }
  const s = snap({ checks: { ok: true, value: [pending], head: HEAD } })
  assert.equal(texts(s).length, 1)
  assert.deepEqual(texts(s, { scope: 'full', compat: { checksAfterWait: true } }), [])
})

test('체크 조회 실패는 조회 실패와 진행 중 두 줄이다. 대기 뒤에는 한 줄이다', () => {
  const s = snap({ checks: { ok: false, error: '체크 조회 실패' } })
  const judged = judgeReadiness(s, policy, full)
  assert.deepEqual(judged.reasons.map((r) => [r.kind, r.text]), [
    ['lookup', '체크 조회 실패'],
    ['ci', '체크가 아직 끝나지 않았다(진행 중 ?, 나타나지 않은 필수 체크 ?)'],
  ])
  assert.equal(judged.summary, 'fails= threads=0 mergeable=MERGEABLE')
  assert.deepEqual(texts(s, { scope: 'full', compat: { checksAfterWait: true } }), ['체크 조회 실패'])
})

test('조회 실패는 값 하나에 lookup 하나이고 그 값을 쓰는 가장 앞 조건 자리에 나온다', () => {
  const judged = judgeReadiness(snap({
    threads: { ok: false, error: '스레드 조회 실패' },
    body: { ok: false, error: 'PR 본문 또는 HEAD 조회 실패' },
    privateWords: { ok: true, value: { findings: null, failed: [] } },
  }), { ...policy, privateWords: true }, full)
  assert.deepEqual(judged.reasons.map((r) => [r.kind, r.text]), [['lookup', '스레드 조회 실패'], ['lookup', 'PR 본문 또는 HEAD 조회 실패']])
  assert.equal(judged.summary, 'fails=0 mergeable=MERGEABLE')
})

test('HEAD 가 다른 값이 있으면 다른 이유를 버리고 head 이유 하나만 낸다', () => {
  const s = snap({
    threads: { ok: true, value: '3' },
    mergeable: { ok: true, value: 'CONFLICTING' },
    body: { ok: true, value: '', head: OTHER },
  })
  const judged = judgeReadiness(s, policy, full)
  assert.deepEqual(judged.reasons, [{ code: 'head', kind: 'head', stage: 'ready', text: `검사 뒤 HEAD 가 바뀌었다 checked=${HEAD.slice(0, 8)} now=${OTHER.slice(0, 8)}`, wait: 'HEAD 가 바뀌었다' }])
  const checks = snap({ checks: { ok: true, value: [pass], head: '' } })
  assert.equal(judgeReadiness(checks, policy, { scope: 'full', compat: { checkHeadStop: true } }).reasons[0].code, 'head-checks')
  assert.equal(judgeReadiness(checks, policy, full).reasons[0].text, `체크 조회 중 HEAD 가 바뀌었다 checked=${HEAD} now=?`)
})

test('보류는 merge 단계다. blocksReady 는 false, blocksMerge 는 true 다', () => {
  const s = snap({ specHold: { ok: true, value: '배포 대기' } })
  const judged = judgeReadiness(s, policy, full)
  assert.deepEqual(judged.reasons.map((r) => [r.code, r.stage, r.text, r.wait]), [['hold-spec', 'merge', '배포 대기', '지시서 보류: 배포 대기']])
  assert.equal(blocksReady(judged), false)
  assert.equal(blocksMerge(judged), true)
  assert.equal(blocksReady(judgeReadiness(snap({ threads: { ok: true, value: '1' } }), policy, full)), true)
})

test('compat oldHolds 는 보드 보류를 보지 않고 지시서 보류가 있으면 본문 보류를 내지 않는다', () => {
  const board = [{ id: 'x', branch: 'feat/x', status: 'doing', next: ['머지 보류 사용자 확인'] }]
  const s = snap({ specHold: { ok: true, value: '지시서' }, holdBody: { ok: true, value: '본문' }, boardItems: { ok: true, value: board } })
  assert.deepEqual(texts(s), ['지시서', '본문', '보드 보류: 머지 보류 사용자 확인'])
  assert.deepEqual(texts(s, { scope: 'full', compat: { oldHolds: true } }), ['지시서'])
  const lookup = snap({ holdBody: { ok: false, error: 'PR 본문을 읽지 못해 머지 보류 줄을 확인할 수 없다' }, specHold: { ok: true, value: '지시서' } })
  assert.deepEqual(judgeReadiness(lookup, policy, { scope: 'full', only: ['hold'], compat: { oldHolds: true } }).reasons.map((r) => [r.kind, r.stage]), [['hold', 'merge'], ['lookup', 'merge']])
})

test('draft 는 compat noDraft 가 아니면 걸린다', () => {
  const s = snap({}, { draft: true })
  assert.deepEqual(texts(s), ['draft PR 이다'])
  assert.deepEqual(texts(s, { scope: 'full', compat: { noDraft: true } }), [])
})

test('light 범위의 이유는 full 이유 가운데 light 조건의 것과 같다', () => {
  const s = snap({
    threads: { ok: true, value: '1' },
    mergeable: { ok: true, value: 'CONFLICTING' },
    specHold: { ok: true, value: '보류' },
  }, { draft: true })
  const fullReasons = judgeReadiness(s, policy, full).reasons
  const lightCodes = new Set(CONDITIONS.filter((c) => c.scope === 'light').map((c) => c.kind))
  assert.deepEqual(judgeReadiness(s, policy, { scope: 'light' }).reasons, fullReasons.filter((r) => lightCodes.has(r.kind as never)))
})

test('stopAtFirst 는 평가 순서의 첫 이유에서 멈춘다', () => {
  const s = snap({ threads: { ok: true, value: '1' }, specHold: { ok: true, value: '보류' } })
  assert.deepEqual(texts(s, { scope: 'light', stopAtFirst: true }), ['보류'])
})

test('only 와 skip 은 조건의 종류로 고른다', () => {
  const s = snap({ threads: { ok: true, value: '1' }, specHold: { ok: true, value: '보류' } })
  assert.deepEqual(texts(s, { scope: 'full', only: ['hold'] }), ['보류'])
  assert.deepEqual(texts(s, { scope: 'full', skip: ['hold'] }), ['미해결 리뷰 스레드 1 개'])
})

test('리뷰는 리뷰 체크가 success 면 영수증을 달라지 않고, 아니면 영수증을 달라 판단한다', () => {
  const review = { checks: ['Review'], trustedBots: [{ login: 'bot', receiptMarker: '<!-- r -->' }] }
  const p = { ...policy, review } as ReadinessPolicy
  const passed = snap({ reviewRollup: { ok: true, value: [{ name: 'Review', status: 'COMPLETED', conclusion: 'SUCCESS' }], head: HEAD } })
  const ok = judgeReadiness(passed, p, full)
  assert.deepEqual(ok.reasons, [])
  assert.equal(ok.basis, '리뷰 체크 Review success')
  const waiting = snap({ reviewRollup: { ok: true, value: [], head: HEAD } })
  assert.deepEqual(judgeReadiness(waiting, p, full).need, ['receipts'])
  const none = { ...waiting, facts: { ...waiting.facts, receipts: { ok: true as const, value: { receipts: [] } } } }
  assert.deepEqual(texts(none, full, p), [`HEAD ${HEAD.slice(0, 8)} 에 현재 HEAD 를 확인한 봇 영수증이나 리뷰 체크(Review) 성공이 없다`])
  const rejected = { ...waiting, facts: { ...waiting.facts, receipts: { ok: true as const, value: { rejected: '봇 지적' } } } }
  assert.deepEqual(texts(rejected, full, p), ['봇 지적'])
})

test('통합 테스트 기록은 확인이 필요한 커밋이 있을 때만 acceptedCommits 를 달라고 한다', () => {
  const rules = [{ paths: [/^([^/]+)\/src\//], command: 'npm run it' }]
  const p = { ...policy, integrationRules: rules } as ReadinessPolicy
  const commit = 'c'.repeat(40)
  const body = `## 검증\n- 통합 테스트 통과: api | npm run it | ${commit}\n`
  const base = snap({ body: { ok: true, value: body, head: HEAD } })
  assert.deepEqual(judgeReadiness(base, p, full).need, ['integrationFiles'])
  const files = { ...base.facts, integrationFiles: { ok: true as const, value: ['api/src/a.ts'] } }
  assert.deepEqual(judgeReadiness({ ...base, facts: files }, p, full).need, ['acceptedCommits'])
  assert.deepEqual(texts({ ...base, facts: { ...files, acceptedCommits: { ok: true, value: [commit] } } }, full, p), [])
  assert.deepEqual(texts({ ...base, facts: { ...files, acceptedCommits: { ok: true, value: [] } } }, full, p), ['통합 테스트 기록이 head 가 아니다: api'])
})

test('마이그레이션은 더한 파일이 있을 때만 base 를 달라 하고 base 이하 번호를 막는다', () => {
  const p = { ...policy, migrationDirs: { api: ['db/migration'] } }
  const s = snap({ files: { ok: true, value: ['db/migration/V2__a.sql'], head: HEAD } })
  assert.deepEqual(judgeReadiness(s, p, full).need, ['baseMigrations'])
  const reasons = texts({ ...s, facts: { ...s.facts, baseMigrations: { ok: true, value: ['db/migration/V3__b.sql'] } } }, full, p)
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /^api V2: base 최고 V3 이하\. 기존 예약 인자로/)
  assert.deepEqual(judgeReadiness(snap({ files: { ok: true, value: ['src/a.ts'], head: HEAD } }), p, full).need, [])
})

test('비공개 낱말은 찾은 위치와 읽지 못한 곳을 따로 낸다', () => {
  const p = { ...policy, privateWords: true }
  const reasons = judgeReadiness(snap({ privateWords: { ok: true, value: { findings: 'PR 본문 2번째 줄(목록 1번째 줄)', failed: ['리뷰'] } } }), p, full).reasons
  assert.deepEqual(reasons.map((r) => r.kind), ['private', 'lookup'])
  assert.equal(reasons[1].text, '비공개 낱말 검사: 리뷰 조회 실패')
})

test('보드 항목은 pr 칸을 먼저 보고 없으면 열린 항목의 브랜치로 찾는다', () => {
  const items = [
    { id: 'done', branch: 'feat/x', status: 'done' },
    { id: 'open', branch: 'feat/x', status: 'doing' },
    { id: 'byPr', pr: '#9', status: 'doing' },
  ]
  assert.deepEqual(matchBoardItems(items, '9', 'feat/x', null), { by: 'pr', ids: ['byPr'] })
  assert.deepEqual(matchBoardItems(items, '7', 'feat/x', null), { by: 'branch', ids: ['open'] })
  assert.equal(matchBoardItems(items, '7', 'other', null), null)
})
