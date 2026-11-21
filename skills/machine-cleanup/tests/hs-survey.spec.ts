// hs_survey.ts 가 홈서버 후보를 읽기 전용으로 모으는지 본다(스펙 REQ5, REQ8, REQ9, REQ10).
// homeserver-cleanup 의 판정 사례(이미지 이름 풀기, 설정 이미지, 백업 규칙)를 옮겼다. 값은 모두 가상이다.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { FakeRule } from '../../../modules/testkit/fake-bin.ts'
import { Repo, Sandbox, write } from './helpers.ts'
import { DAY, fakeProc, hermesDb, nowSec, sampleConfig } from './hs-helpers.ts'
import { backupRules, configuredRefs, containerMemory, isConfigured, lastDailyPrune, parseDockerSize, parseLinked, parseMeminfo, parseRef, ruleFor } from '../scripts/hs_survey.ts'

describe('이미지 판정(homeserver-cleanup 에서 옮김)', () => {
  test('레지스트리 포트의 콜론은 태그로 읽지 않고, 태그와 digest 를 나눈다', () => {
    assert.deepEqual(parseRef('localhost:5000/app'), ['localhost:5000/app', null, null])
    assert.deepEqual(parseRef('node:22-slim@sha256:abc'), ['node', '22-slim', 'sha256:abc'])
  })

  test('Compose 기본값, Dockerfile 의 FROM, settings 의 image, 내용 해시 태그를 지금 쓰는 이미지로 본다', () => {
    const box = new Sandbox('hss-')
    const root = join(box.root, 'checkout')
    write(join(root, 'services/app/compose.yaml'), 'services:\n  app:\n    image: ${APP_IMAGE:-ghcr.io/me/app:1}\n  job:\n    image: ghcr.io/me/job:${JOB_TAG:?태그}\n  gone:\n    image: ${GONE_IMAGE:?없음}\n')
    write(join(root, 'services/app/.env'), 'JOB_TAG=abc\n')
    write(join(root, 'services/app/Dockerfile'), 'FROM --platform=linux/amd64 python:3.12@sha256:aaa AS base\n')
    write(join(root, 'services/app/settings.json'), '{"image": "browser:v2"}')
    write(join(root, 'services/ci/Dockerfile'), 'FROM alpine\n')
    write(join(root, 'services/ci/start.sh'), 'a\n')
    const refs = configuredRefs(root, {
      compose: ['services/*/compose.yaml'], dockerfile: ['services/*/Dockerfile'], settings: ['services/*/settings.json'],
      content_tags: [{ name: 'ci-image', files: ['services/ci/Dockerfile', 'services/ci/start.sh'], length: 12 }],
    })
    const ci = createHash('sha256').update('FROM alpine\na\n').digest('hex').slice(0, 12)
    assert.deepEqual([...refs].sort(), ['alpine', 'browser:v2', `ci-image:${ci}`, 'ghcr.io/me/app:1', 'ghcr.io/me/job:abc', 'python:3.12@sha256:aaa'].sort())
  })

  test('digest 로 고정한 설정은 태그가 없는 이미지와도 맞고, 태그만 같고 digest 가 다르면 맞지 않는다', () => {
    const refs = ['python:3.12@sha256:aaa']
    assert.ok(isConfigured([], ['python@sha256:aaa'], refs))
    assert.ok(!isConfigured(['python:3.12'], ['python@sha256:bbb'], refs))
  })
})

describe('백업 규칙(homeserver-cleanup 에서 옮김)', () => {
  const md = '## 백업\n\n| 용도 | 무엇을 담나 | 만드는 것 | 보관 |\n| --- | --- | --- | --- |\n' +
    '| `db/` | 덤프 | backup-db.sh | 최신 7개 |\n| `deploy-{서비스}/` | 구성 | deploy.sh | 서비스별 최신 5개 |\n' +
    '| `deploy-web/` | 구성 | deploy-web.sh | 매일 정리가 최신 5개 |\n| `{서비스}-full-upgrade/` | 사본 | 사람 | 사람이 지운다 |\n\n## 다음 절\n| `other/` | a | b | c |\n'

  test('`{서비스}` 자리는 아무 이름과 맞고 자리가 없는 용도를 먼저 본다. 표에 없는 용도는 규칙이 없다', () => {
    const rules = backupRules(md, '백업')
    assert.equal(ruleFor('db', rules)?.keep, '최신 7개')
    assert.equal(ruleFor('deploy-web', rules)?.keep, '매일 정리가 최신 5개')
    assert.equal(ruleFor('deploy-npm', rules)?.keep, '서비스별 최신 5개')
    assert.equal(ruleFor('mysql-full-upgrade', rules)?.keep, '사람이 지운다')
    assert.equal(ruleFor('other', rules), null)
    assert.equal(ruleFor('dbx', rules), null)
  })

  test('절이 없으면 다른 절의 표에서 규칙을 읽지 않는다', () => {
    assert.deepEqual(backupRules('## 다른 절\n| `db/` | a | b | c |\n', '백업'), [])
  })
})

describe('메모리와 기타 해석', () => {
  test('meminfo 에서 여유 메모리와 스왑 사용량을 바이트로 읽는다', () => {
    assert.deepEqual(parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n'), { mem_total: 1024000, mem_available: 409600, swap_total: 204800, swap_used: 153600 })
  })

  test('docker stats 와 inspect 한도를 이름으로 합친다', () => {
    assert.equal(parseDockerSize('95.5MiB'), Math.round(95.5 * 1024 * 1024))
    const rows = containerMemory('{"Name":"web","MemUsage":"100MiB / 384MiB"}\n{"Name":"free","MemUsage":"1GiB / 7.6GiB"}\n', '/web 402653184 805306368\n/free 0 0\n')
    assert.deepEqual(rows[0], { name: 'free', usage: 1024 ** 3, limit: null, swap_limit: null })
    assert.deepEqual(rows[1], { name: 'web', usage: 100 * 1024 ** 2, limit: 402653184, swap_limit: 805306368 })
  })

  test('매일 정리 시각은 지금보다 앞선 가장 최근 시각이다', () => {
    const now = new Date(2026, 10, 21, 2, 0)
    assert.equal(lastDailyPrune(now, '03:00'), new Date(2026, 10, 20, 3, 0).getTime() / 1000)
    assert.equal(lastDailyPrune(new Date(2026, 10, 21, 4, 0), '03:00'), new Date(2026, 10, 21, 3, 0).getTime() / 1000)
  })

  test('연결 조회 출력의 탭과 줄로 나뉜 id 를 모으고 NULL 은 뺀다', () => {
    assert.deepEqual(parseLinked('a\tb\nNULL\tc\n\nb\n'), ['a', 'b', 'c'])
  })
})

const IMAGES = JSON.stringify([
  { Id: 'sha256:used', RepoTags: ['app:1'], RepoDigests: [], Created: '2026-11-01T00:00:00Z', Size: 100 },
  { Id: 'sha256:old', RepoTags: ['app:0'], RepoDigests: [], Created: '2026-10-01T00:00:00Z', Size: 50 },
  { Id: 'sha256:conf', RepoTags: ['browser:v2'], RepoDigests: [], Created: '2026-10-02T00:00:00Z', Size: 70 },
])

const DOCKER: FakeRule[] = [
  { args: ['info'], stdout: '27.0\n' },
  { args: ['system', 'df'], stdout: '{"Type":"Images","Size":"220B","Reclaimable":"120B"}\n' },
  { args: ['ps', '-aq'], stdout: 'c1\n' },
  { args: ['ps', '-q'], stdout: 'c1\n' },
  { args: ['inspect', '{{.Image}} {{.Config.Image}}'], stdout: 'sha256:used app:1\n' },
  { args: ['inspect', '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}'], stdout: '/app 402653184 805306368\n' },
  { args: ['image', 'ls'], stdout: 'sha256:used\nsha256:old\nsha256:conf\n' },
  { args: ['image', 'inspect'], stdout: IMAGES },
  { args: ['volume', 'ls'], stdout: 'v1\nv2\n' },
  { args: ['stats'], stdout: '{"Name":"app","MemUsage":"380MiB / 384MiB"}\n' },
]

// 가상 홈서버 하나를 만든다. 저장소, 워크트리, 백업, 휴지통, Hermes 세션, 가짜 /proc
function homeserver(opts: { worktreeBusy?: boolean; unreadable?: boolean; linkedFails?: boolean } = {}) {
  const box = new Sandbox('hss-')
  const cfg = sampleConfig(box.root)
  box.fake('docker', DOCKER)
  box.fake('journalctl', [{ args: ['--disk-usage'], stdout: 'Archived and active journals take up 1.2G in the file system.\n' }])
  box.fake('linked-sessions', opts.linkedFails ? [{ code: 1, stderr: 'db down' }] : [{ stdout: 'linked-1\tNULL\n' }])
  box.fake('flock', [{ code: 75 }])
  // 운영 checkout: main 하나, 머지된 브랜치 하나, 머지된 워크트리 하나
  const repo = new Repo(cfg.checkout)
  repo.commit('init', 1_700_000_000)
  repo.git('branch', 'merged-one')
  repo.git('branch', 'feature-wt')
  repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const wt = join(box.root, 'wt-feature')
  repo.git('worktree', 'add', '-q', wt, 'feature-wt')
  write(join(cfg.checkout, 'services/web/settings.json'), '{"image": "browser:v2"}')
  write(join(cfg.checkout, 'docs/rules.md'), '## 백업\n\n| 용도 | 무엇 | 누가 | 보관 |\n| --- | --- | --- | --- |\n| `db/` | 덤프 | s | 최신 1개 |\n')
  write(join(cfg.backup.root, 'db/a/x'), 'aa')
  write(join(cfg.backup.root, 'db/b/x'), 'bb')
  write(join(cfg.backup.root, 'oneoff-20261001/x'), 'cc')
  write(join(box.home, '.local/share/Trash/info/f.trashinfo'), '[Trash Info]\nDeletionDate=2026-11-01T10:00:00\n')
  write(join(box.home, '.local/share/Trash/files/f'), 'zz')
  write(join(box.home, 'ci/logs/1.log'), 'log')
  const old = nowSec() - 40 * DAY
  hermesDb(join(cfg.hermes.data, 'state.db'), [['root-old', null, 'cron', old], ['child-old', 'root-old', 'cron', old], ['linked-1', null, 'api', old]])
  hermesDb(join(cfg.hermes.data, 'profiles/p1/state.db'), [['recent', null, 'discord', nowSec()]])
  const uid = process.getuid!()
  fakeProc(box.root, [
    { pid: 10, uid, name: 'shell', swapKb: 2048, cwd: opts.worktreeBusy ? join(wt, 'sub') : box.home },
    { pid: 11, uid: uid + 1, name: 'other', swapKb: 4096, cwd: null },
    ...(opts.unreadable ? [{ pid: 12, uid, name: 'mine', cwd: null }] : []),
  ])
  const cfgFile = write(join(box.root, 'cfg.json'), JSON.stringify(cfg))
  return { box, cfg, cfgFile, wt }
}

function survey(h: ReturnType<typeof homeserver>, extra: string[] = []) {
  const r = h.box.run('hs_survey', ['--config', h.cfgFile, '--no-check-prs', ...extra], { env: h.box.env({ HS_ROOT: h.box.root }) })
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout)
}

describe('hs_survey 명령', () => {
  test('모든 절이 나오고 메모리 네 항목이 있다(REQ5, REQ8)', () => {
    const h = homeserver()
    const s = survey(h, ['--no-fetch'])
    for (const key of ['host', 'memory', 'docker', 'backups', 'paths', 'cache_dirs', 'trash', 'journal', 'snaps', 'git', 'sessions', 'hermes']) assert.ok(key in s, key)
    assert.equal(s.memory.mem_available, 2000000 * 1024)
    assert.equal(s.memory.swap_used, 1000000 * 1024)
    assert.deepEqual(s.memory.containers[0], { name: 'app', usage: 380 * 1024 ** 2, limit: 402653184, swap_limit: 805306368 })
    assert.deepEqual(s.memory.swap_top.map((p: any) => p.name), ['other', 'shell'])
    assert.equal(s.journal, '1.2G')
    assert.deepEqual(s.docker.unused_images.map((i: any) => [i.id, i.configured, i.running_other_version]), [['sha256:old', false, true], ['sha256:conf', true, false]])
    assert.deepEqual(s.backups.rows.map((r: any) => [r.label, r.rule]).sort(), [['db', '최신 1개'], ['oneoff-20261001', null]])
    assert.ok(s.paths.some((p: any) => p.path === '~/ci/logs' && p.owner === 'CI 실행 스크립트'))
    assert.equal(s.trash[0].moved, '2026-11-01T10:00:00')
  })

  test('조사 전후로 파일 목록이 같다(REQ5)', () => {
    const h = homeserver()
    // 가짜 실행 파일의 호출 기록은 뺀다
    const list = () => readdirSync(h.box.root, { recursive: true }).map(String).filter((p) => !p.startsWith('fakes')).sort()
    const before = list()
    survey(h, ['--no-fetch'])
    assert.deepEqual(list(), before)
  })

  test('Claude·Codex 기록이 없으면 빈 목록이고, Hermes 세션과 연결 목록을 읽는다(REQ10)', () => {
    const h = homeserver()
    const s = survey(h, ['--no-fetch'])
    assert.deepEqual(s.sessions.logs, [])
    assert.deepEqual(s.sessions.orphans.orphans, [])
    assert.deepEqual(s.hermes.linked, ['linked-1'])
    assert.deepEqual(s.hermes.profiles.map((p: any) => [p.profile, p.sessions.length]), [['default', 3], ['p1', 1]])
  })

  test('연결 조회가 실패하면 그 사실을 적는다', () => {
    const s = survey(homeserver({ linkedFails: true }), ['--no-fetch'])
    assert.match(s.hermes.linked_error, /연결 세션 조회 실패/)
  })

  test('머지된 브랜치와 워크트리가 후보이고 현재 브랜치는 후보가 아니다(REQ9)', () => {
    const s = survey(homeserver(), ['--no-fetch'])
    const repo = s.git.repos[0]
    assert.equal(repo.ops, true)
    assert.deepEqual(repo.branches.map((b: any) => [b.name, b.class]), [['merged-one', '삭제 후보(-d)']])
    assert.deepEqual(repo.worktrees.map((w: any) => w.class), ['제거 후보'])
  })

  test('워크트리 안에서 도는 프로세스가 있으면 후보에서 빠진다(REQ9)', () => {
    const s = survey(homeserver({ worktreeBusy: true }), ['--no-fetch'])
    assert.deepEqual(s.git.repos[0].worktrees, [])
  })

  test('같은 사용자의 cwd 를 읽지 못하면 확인하지 못함으로 두고 지우지 않는다(REQ9)', () => {
    const s = survey(homeserver({ unreadable: true }), ['--no-fetch'])
    assert.match(s.git.cwd_check, /확인하지 못함\(같은 사용자 프로세스 1개의 cwd 를 읽지 못함: mine\./)
    assert.deepEqual(s.git.repos[0].worktrees, [])
  })

  test('운영 checkout 의 fetch 는 잠금을 얻지 못하면 그 저장소만 건너뛴다(REQ5)', () => {
    const s = survey(homeserver())
    assert.equal(s.git.repos[0].fetch, '잠금 실패')
  })

  test('조사만 하는 저장소는 유지 항목까지 모두 보인다', () => {
    const h = homeserver()
    h.cfg.repos[0].survey_only = true
    writeFileSync(h.cfgFile, JSON.stringify(h.cfg))
    const s = survey(h, ['--no-fetch'])
    assert.equal(s.git.repos[0].survey_only, true)
    assert.ok(s.git.repos[0].branches.some((b: any) => b.name === 'main'))
  })
})
