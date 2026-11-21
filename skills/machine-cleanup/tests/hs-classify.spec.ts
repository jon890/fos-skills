// hs_classify.ts 가 홈서버 등급 규칙대로 후보를 나누는지 본다(스펙 REQ6, REQ8, REQ9, REQ10, REQ7 의 sudo 넘기기).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'
import { DAY, sampleConfig } from './hs-helpers.ts'
import { backupGrade, backupOverRetention, classify, hermesBySource, hermesCandidates, imageGrade, imageOverRetention, memorySuggestions, report } from '../scripts/hs_classify.ts'

const PRUNE = 1_800_000_000
const before = PRUNE - DAY
const after = PRUNE + 3600

describe('백업 등급(REQ6)', () => {
  test('보관 칸을 등급으로 옮긴다', () => {
    assert.equal(backupGrade('매일 정리가 최신 5개를 남긴다').grade, '유지')
    assert.equal(backupGrade('최신 7개').grade, '유지')
    assert.equal(backupGrade('결과 검토 뒤 명시적 정리로 최신 5개').grade, '안전')
    assert.equal(backupGrade('확인이 끝나면 사람이 지운다').grade, '확인 필요')
    assert.deepEqual(backupGrade(null), { grade: '확인 필요', reason: '보관 규칙 표에 없다' })
  })

  test('유지인데 규칙보다 많으면 매일 정리 시각과 비교해 정상이나 원인 확인 필요를 붙인다', () => {
    const row = (mtimes: number[]) => ({ label: 'db', rule: '최신 2개', rule_key: 'db', entries: mtimes.map((m, i) => ({ name: String(i), mtime: m })) })
    assert.equal(backupOverRetention(row([before, before]), PRUNE), null)
    assert.equal(backupOverRetention(row([before, before, after]), PRUNE), '정상(마지막 매일 정리 뒤에 생김)')
    assert.equal(backupOverRetention(row([before, before, before]), PRUNE), '원인 확인 필요: db')
  })

  test('자리 없는 용도의 「서비스별」 개수 규칙은 판정하지 않는다', () => {
    const row = { label: 'deploy-all', rule: '매일 정리가 서비스별 최신 1개를 남긴다', rule_key: 'deploy-all', entries: [{ mtime: before }, { mtime: before }] }
    assert.equal(backupOverRetention(row, PRUNE), null)
  })
})

describe('이미지 등급', () => {
  const owned = [{ pattern: 'recovery/app-*', owner: '매일 정리', keep: 1 }]
  test('소유, 설정이 가리킴은 유지이고 그 밖은 확인 필요다', () => {
    assert.equal(imageGrade({ tags: ['recovery/app-1:x'], repos: ['recovery/app-1'] }, owned).grade, '유지')
    assert.equal(imageGrade({ tags: ['browser:v2'], repos: ['browser'], configured: true }, owned).grade, '유지')
    assert.equal(imageGrade({ tags: ['app:0'], repos: ['app'], running_other_version: true }, owned).grade, '확인 필요')
  })

  test('개수 규칙보다 많이 남은 소유 이미지에 판정을 붙인다', () => {
    const imgs = [
      { tags: ['recovery/app-a:1'], repos: ['recovery/app-a'], created: new Date(before * 1000).toISOString() },
      { tags: ['recovery/app-b:1'], repos: ['recovery/app-b'], created: new Date(before * 1000).toISOString() },
    ]
    assert.deepEqual(imageOverRetention(imgs, owned, PRUNE), [{ pattern: 'recovery/app-*', count: 2, keep: 1, verdict: '원인 확인 필요: recovery/app-*' }])
  })
})

describe('Hermes 후보(REQ10)', () => {
  const now = PRUNE
  const old = now - 40 * DAY
  const hermes = (linked: string[], sessions: any[]) => ({ profiles: [{ profile: 'p1', sessions }], linked })

  test('연결된 세션이나 30일 안의 활동이 트리 안에 있으면 트리 전체를 뺀다', () => {
    const sessions = [
      ['a', null, 'cron', old], ['a1', 'a', 'cron', old],
      ['b', null, 'api', old], ['b1', 'b', 'api', old],
      ['c', null, 'discord', old], ['c1', 'c', 'discord', now - DAY],
    ]
    const r = hermesCandidates(hermes(['b1'], sessions), now)
    assert.ok('candidates' in r)
    assert.deepEqual(r.candidates.map((x) => [x.profile, x.root, x.sessions]), [['p1', 'a', 2]])
  })

  test('출처별로 묶고 채팅 출처(discord)는 권장 묶음 뒤에 둔다', () => {
    const sessions = [['d1', null, 'discord', old], ['d2', null, 'discord', old], ['d3', null, 'discord', old], ['c1', null, 'cron', old], ['t1', null, 'tui', old], ['t2', null, 'tui', old]]
    const r = hermesCandidates(hermes([], sessions), now)
    assert.ok('candidates' in r)
    assert.deepEqual(hermesBySource(r.candidates).map(([s, items]) => [s, items.length]), [['tui', 2], ['cron', 1], ['discord', 3]])
  })

  test('연결 조회가 실패했으면 후보를 하나도 내지 않는다', () => {
    const r = hermesCandidates({ profiles: [{ profile: 'p1', sessions: [['a', null, 'cron', old]] }], linked_error: 'db down' }, now)
    assert.deepEqual(r, { error: 'db down' })
  })
})

describe('메모리 제안(REQ8)', () => {
  test('한도에 가까운 컨테이너와 스왑 상위 프로세스를 제안으로만 낸다', () => {
    const s = memorySuggestions({ mem_total: 100, mem_available: 50, swap_used: 2048, swap_top: [{ name: 'java', swap: 2048 }], containers: [{ name: 'web', usage: 95, limit: 100 }] })
    assert.equal(s.length, 2)
    assert.match(s[0], /web: 메모리 사용이 한도의 95%/)
    assert.match(s[1], /java/)
  })
})

function sampleSurvey(root: string) {
  return {
    now: PRUNE + 7200, last_daily_prune: PRUNE, home: '/home/example-user',
    host: { disk_total: 1000, disk_free: 500 },
    memory: { mem_total: 100, mem_available: 40, swap_total: 10, swap_used: 0, swap_top: [], containers: [] },
    docker: { summary: [], dangling_volumes: 0, unused_images: [{ id: 'sha256:0123456789abcdef0123', tags: ['recovery/app-x:1'], repos: ['recovery/app-x'], created: '2026-01-01T00:00:00Z', size: 10 }] },
    backups: { root: '/srv/backup', rules_found: true, rows: [
      { label: 'db', rule: '최신 7개', rule_key: 'db', entries: [], size: 10, complete: true },
      { label: 'oneoff-20261001', rule: null, rule_key: null, entries: [{ name: 'x', mtime: 1 }], size: 5, complete: true },
    ] },
    paths: [{ path: '/var/cache/apt', owner: null, size: 9, complete: true }, { path: '~/ci/logs', owner: 'CI 실행 스크립트', size: 3, complete: true }],
    cache_dirs: [], trash: [], journal: '1.2G', snaps: [{ name: 'core', revision: '17', size: 1 }],
    git: { cwd_check: '완료', repos: [
      { path: join(root, 'ops'), repo: join(root, 'ops'), ops: true, survey_only: false, build_worktrees: [], fetch: '완료', base: 'origin/main', gh_errors: [], worktrees: [], branches: [{ name: 'merged-one', class: '삭제 후보(-d)', tip: 'a' }] },
      { path: '~/agents', repo: '/home/example-user/agents', ops: false, survey_only: true, build_worktrees: ['~/agents/.build-*'], fetch: '완료', base: 'origin/main', gh_errors: [], worktrees: [{ path: '/home/example-user/agents/.build-1', class: '제거 후보' }], branches: [{ name: 'main', class: '유지' }] },
    ] },
    sessions: { agents: [], logs: [], log_age_days: 30, orphans: { base: '/home/example-user/.claude/projects', created: 1, orphans: [] } },
    hermes: { profiles: [{ profile: 'default', sessions: [['old', null, 'cron', PRUNE - 40 * DAY]] }], linked: [] },
  }
}

describe('hs_classify 명령', () => {
  test('유지는 승인 후보와 나뉘고, 원인 판정과 표에 올릴 용도, sudo 명령을 보고한다(REQ6, REQ7)', () => {
    const box = new Sandbox('hsc-')
    const cfg = sampleConfig(box.root)
    const surveyFile = write(join(box.root, 'survey.json'), JSON.stringify(sampleSurvey(box.root)))
    const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
    const gitOut = join(box.root, 'git.json')
    const hermesOut = join(box.root, 'hermes.tsv')
    const r = box.run('hs_classify', [surveyFile, '--config', cfgFile, '--git-out', gitOut, '--orphans-out', join(box.root, 'orph.json'), '--hermes-out', hermesOut])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /\| 유지 \| [0-9a-f]+ \| recovery\/app-x:1 /)
    assert.match(r.stdout, /표에 올릴 용도\(지울지와 함께 표에 올릴지 묻는다\):\n- oneoff-20261001/)
    assert.match(r.stdout, /ssh -t example-host 'sudo apt-get clean'/)
    assert.match(r.stdout, /ssh -t example-host 'sudo journalctl --vacuum-size=1G'/)
    assert.match(r.stdout, /ssh -t example-host 'sudo snap remove core --revision=17'/)
    assert.match(r.stdout, /제안\(스킬은 재시작이나 한도 변경을 하지 않는다\)/)
    assert.match(r.stdout, /대화 기록 \(오래된 기준 30일\): 없음/)
    assert.match(r.stdout, /### 출처 cron: 루트 1개, 세션 1개 \(권장 묶음\)\n- default:old {2}마지막 활동=/)
    // 조사만 하는 저장소는 삭제 입력에 없고, 빌드 워크트리는 원인 수정 제안으로 나온다
    assert.match(r.stdout, /~\/agents \(조사만\. 승인 후보에 넣지 않는다\)/)
    assert.match(r.stdout, /원인 수정 제안: 빌드 스크립트가 남긴 워크트리 1개/)
    assert.equal(readFileSync(hermesOut, 'utf8'), 'cron\tdefault:old\n')
    const git = JSON.parse(readFileSync(gitOut, 'utf8'))
    assert.deepEqual(git.map((x: any) => x.repo), [join(box.root, 'ops')])
  })

  test('보고 문서의 등급 결과는 유지 백업을 승인 후보로 두지 않는다', () => {
    const c = classify(sampleSurvey('/r'), sampleConfig('/r'))
    assert.equal(c.backups.find((b: any) => b.label === 'db').grade, '유지')
    assert.ok(report(sampleSurvey('/r'), sampleConfig('/r'), c).includes('| 유지 | db |'))
  })
})
