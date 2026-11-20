import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { collectFeedback, feedbackRepos, localFeedbackCount, notifyFeedback, releasedVersion, versionResult } from '../scripts/lib/feedback-loop.ts'
import { duplicateOf, parse, render } from '../scripts/lib/feedback.ts'

let root: string, core: string, local: string, merged: string
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim()
}
function candidate(repo: string, slug: string, status: string, target?: string): string {
  const dir = join(repo, '.orch', 'feedback')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${slug}.md`)
  const text = render(slug, { 스킬: 'orch (SKILL.md)', 대상: target || '확인 필요', 상황: '실행', 문제: '실패', '바라는 기능': '개선', 근거: 'log:1', 판단: '반복·구조·효과 확인', 상태: status })
  writeFileSync(file, target ? text : text.replace(/^- 대상: .*\n/m, ''))
  return file
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'feedback-loop-'))
  core = join(root, 'fos-skills'); local = join(root, 'sample')
  for (const repo of [core, local]) { mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main') }
  mkdirSync(join(core, '.claude-plugin'))
  writeFileSync(join(core, '.claude-plugin', 'plugin.json'), '{"version":"1.0.0"}\n')
  git(core, 'add', '.'); git(core, 'commit', '-qm', 'initial')
  writeFileSync(join(core, 'change.txt'), 'merged\n')
  git(core, 'add', '.'); git(core, 'commit', '-qm', 'merged PR')
  merged = git(core, 'rev-parse', 'HEAD')
  writeFileSync(join(core, '.claude-plugin', 'plugin.json'), '{"version":"1.1.0"}\n')
  git(core, 'add', '.'); git(core, 'commit', '-qm', 'version')
  git(core, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const gh = join(root, 'gh')
  writeFileSync(gh, '#!/usr/bin/env node\nconst pr=process.argv[4];if(pr==="5")process.exit(1);process.stdout.write(JSON.stringify(pr==="3"?{state:"CLOSED"}:pr==="4"?{state:"OPEN"}:{state:"MERGED",mergeCommit:{oid:process.env.FEEDBACK_MERGED_SHA}}))\n')
  chmodSync(gh, 0o755)
  process.env.ORCH_FEEDBACK_GH = gh
  process.env.FEEDBACK_MERGED_SHA = merged
})
afterEach(() => {
  delete process.env.ORCH_FEEDBACK_GH
  delete process.env.FEEDBACK_MERGED_SHA
  delete process.env.ORCA
  rmSync(root, { recursive: true, force: true })
})

test('보드는 후보와 받은 알림을 저장소별로 세고 보류는 뺀다', () => {
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  candidate(local, 'core-new', '후보', 'core 스킬')
  candidate(local, 'mine-new', '후보', '이 저장소')
  candidate(core, 'own-new', '후보', '이 저장소')
  candidate(local, 'received', '반영됨 #2 (1.1.0)', 'core 스킬')
  candidate(local, 'rejected', '기각(이유)', '이 저장소')
  candidate(local, 'held', '보류(나중)', 'core 스킬')
  candidate(local, 'waiting', '채택 #4', 'core 스킬')
  assert.equal(localFeedbackCount(core, repos), 2)
  assert.equal(localFeedbackCount(local, repos), 3)
})

test('PR 머지 뒤 실제 version 변경 commit이 있어야 알림 대상으로 분류한다', () => {
  assert.equal(releasedVersion(core, merged), '1.1.0')
  const coreFile = candidate(local, 'accepted', '채택 #2')
  candidate(local, 'closed', '채택 #3')
  candidate(local, 'open', '채택 #4')
  candidate(local, 'failed', '채택 #5')
  candidate(local, 'new', '후보')
  candidate(local, 'mine', '후보', '이 저장소')
  const mineAccepted = candidate(local, 'mine-accepted', '채택 #2', '이 저장소')
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  const result = collectFeedback(repos)
  process.env.ORCH_FEEDBACK_GH = join(root, 'missing-gh')
  assert.equal(localFeedbackCount(core, repos), 2, 'core 보드는 후보와 마지막 분류의 보낼 알림을 센다')
  assert.equal(localFeedbackCount(local, repos), 1, '다른 저장소는 자기 몫 후보만 센다')
  assert.equal(localFeedbackCount(core, repos, Date.now() + 31 * 60 * 1000), 1, '오래된 분류는 보낼 알림에 쓰지 않는다')
  process.env.ORCH_FEEDBACK_GH = join(root, 'gh')
  assert.deepEqual(result.rows.map(row => [row.candidate.slug, row.group]).sort(), [
    ['accepted', '보낼 알림'], ['closed', '닫힌 PR'], ['failed', '조회 실패'], ['mine', '저장소 몫'], ['mine-accepted', '저장소 몫'], ['new', '판정할 core 후보'], ['open', 'PR 머지 대기'],
  ])
  assert.equal(result.rows.find(row => row.candidate.slug === 'accepted')?.version, '1.1.0')
  assert.equal(parse(readFileSync(coreFile, 'utf8'))?.values.상태, '채택 #2', '모아 보기는 읽기 전용이다')
  const lines = notifyFeedback(result, join(root, 'trash'))
  assert.ok(lines.some(line => line.includes('UPDATED sample\taccepted')))
  assert.ok(lines.some(line => line.includes('MESSAGE-SKIP sample none')))
  assert.equal(parse(readFileSync(coreFile, 'utf8'))?.values.상태, '반영됨 #2 (1.1.0)')
  assert.equal(parse(readFileSync(mineAccepted, 'utf8'))?.values.상태, '채택 #2', '저장소 몫은 원래 저장소 doctor가 처리한다')
  assert.equal(collectFeedback(repos).rows.find(row => row.candidate.slug === 'accepted')?.group, '받은 알림')
})

test('반영 PR보다 먼저 오른 version은 알림 조건을 채우지 않는다', () => {
  const later = git(core, 'rev-parse', 'HEAD')
  assert.equal(releasedVersion(core, later), null)
})

test('origin/main 누락과 깨진 plugin.json은 버전 대기가 아닌 조회 실패다', () => {
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  candidate(local, 'accepted', '채택 #2')
  git(core, 'update-ref', '-d', 'refs/remotes/origin/main')
  assert.equal(collectFeedback(repos).rows[0].group, '조회 실패')
  git(core, 'reset', '--hard', merged)
  writeFileSync(join(core, '.claude-plugin', 'plugin.json'), '{broken\n')
  git(core, 'add', '.'); git(core, 'commit', '-qm', 'broken version')
  git(core, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  assert.match(versionResult(core, merged).error ?? '', /JSON/)
  assert.equal(collectFeedback(repos).rows[0].group, '조회 실패')
})

test('저장소 이름에 공백과 한글이 있는 중복 대표도 읽는다', () => {
  const file = candidate(local, 'duplicate', '기각(중복: 한국 저장소/accepted)')
  assert.equal(duplicateOf(parse(readFileSync(file, 'utf8'))!), '한국 저장소/accepted')
})

test('저장소별 메시지 한 통을 보낸 뒤에만 파일을 휴지통으로 옮긴다', () => {
  const accepted = candidate(local, 'accepted', '채택 #2')
  const rejected = candidate(local, 'rejected', '기각(고칠 필요 없음)')
  const collected = collectFeedback([{ name: 'fos-skills', path: core }, { name: 'sample', path: local }])
  const sent: string[] = []
  const lines = notifyFeedback(collected, join(root, 'trash'), {
    findMain: () => ({ kind: 'main', run: 'run', terminal: 'terminal', alive: ['run'] }),
    notifyRun: (_run, _kind, body) => { sent.push(body); return { ok: true, id: 'message' } },
  })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /accepted: PR #2, 버전 1\.1\.0/)
  assert.match(sent[0], /rejected: 기각\(고칠 필요 없음\)/)
  assert.match(sent[0], /플러그인 갱신 필요/)
  assert.ok(lines.some(line => line === 'MESSAGE-SENT sample 2'))
  assert.equal(readFileSync(join(root, 'trash', 'sample', 'accepted.md'), 'utf8').includes('반영됨 #2 (1.1.0)'), true)
  assert.equal(readFileSync(join(root, 'trash', 'sample', 'rejected.md'), 'utf8').includes('기각(고칠 필요 없음)'), true)
  assert.equal(collectFeedback([{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]).rows.length, 0)
  assert.throws(() => readFileSync(accepted, 'utf8'))
  assert.throws(() => readFileSync(rejected, 'utf8'))
})

test('메시지 전송 실패는 알림 상태를 남겨 doctor가 나중에 보게 한다', () => {
  const file = candidate(local, 'accepted', '채택 #2')
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  const lines = notifyFeedback(collectFeedback(repos), join(root, 'trash'), {
    findMain: () => ({ kind: 'main', run: 'run', terminal: 'terminal', alive: ['run'] }),
    notifyRun: () => ({ ok: false, error: '연결 실패' }),
  })
  assert.ok(lines.some(line => line === 'MESSAGE-FAIL sample 연결 실패'))
  assert.equal(parse(readFileSync(file, 'utf8'))?.values.상태, '반영됨 #2 (1.1.0)')
  assert.equal(collectFeedback(repos).rows.find(row => row.candidate.slug === 'accepted')?.group, '받은 알림')
})

test('서로 다른 저장소의 같은 이름을 섞지 않고 휴지통의 대표 결과도 읽는다', () => {
  candidate(core, 'same', '채택 #2', 'core 스킬')
  candidate(local, 'same', '채택 #3', 'core 스킬')
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  const trash = join(root, 'trash')
  const first = collectFeedback(repos, trash)
  assert.equal(first.rows.find(row => row.repo.name === 'sample' && row.candidate.slug === 'same')?.group, '닫힌 PR')
  notifyFeedback(first, trash, {
    findMain: () => ({ kind: 'main', run: 'run', terminal: 'terminal', alive: ['run'] }),
    notifyRun: () => ({ ok: true, id: 'sent' }),
  })
  candidate(local, 'duplicate', '기각(중복: fos-skills/same)', 'core 스킬')
  const second = collectFeedback(repos, trash)
  const duplicate = second.rows.find(row => row.candidate.slug === 'duplicate')
  assert.equal(duplicate?.group, '보낼 알림')
  assert.equal(duplicate?.pr, 2)
  assert.equal(duplicate?.version, '1.1.0')
})

test('대표와 중복 후보를 한 통으로 알리고 대표의 결과를 중복 후보에 남긴다', () => {
  candidate(local, 'representative', '채택 #2', 'core 스킬')
  const duplicate = candidate(local, 'duplicate', '기각(중복: representative)', 'core 스킬')
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  const sent: string[] = []
  const lines = notifyFeedback(collectFeedback(repos), join(root, 'trash'), {
    findMain: () => ({ kind: 'main', run: 'run', terminal: 'terminal', alive: ['run'] }),
    notifyRun: (_run, _kind, body) => { sent.push(body); return { ok: true, id: 'sent' } },
  })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /representative: PR #2, 버전 1\.1\.0/)
  assert.match(sent[0], /duplicate: PR #2, 버전 1\.1\.0/)
  assert.ok(lines.includes('MESSAGE-SENT sample 2'))
  assert.equal(parse(readFileSync(join(root, 'trash', 'sample', 'duplicate.md'), 'utf8'))?.values.상태, '반영됨 #2 (1.1.0)')
  assert.equal(existsSync(duplicate), false)
})

test('대표가 기각됐거나 없으면 중복 후보에 그 결과를 알린다', () => {
  candidate(local, 'rejected', '기각(효과 없음)', 'core 스킬')
  const duplicate = candidate(local, 'duplicate', '기각(중복: rejected)', 'core 스킬')
  const missing = candidate(local, 'missing', '기각(중복: absent)', 'core 스킬')
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  const collected = collectFeedback(repos)
  assert.equal(collected.rows.find(row => row.candidate.slug === 'duplicate')?.resultStatus, '기각(대표 rejected: 기각(효과 없음))')
  assert.equal(collected.rows.find(row => row.candidate.slug === 'missing')?.resultStatus, '기각(대표 없음: absent)')
  const sent: string[] = []
  notifyFeedback(collected, join(root, 'trash'), {
    findMain: () => ({ kind: 'main', run: 'run', terminal: 'terminal', alive: ['run'] }),
    notifyRun: (_run, _kind, body) => { sent.push(body); return { ok: true, id: 'sent' } },
  })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /대표 rejected: 기각\(효과 없음\)/)
  assert.match(sent[0], /대표 없음: absent/)
  assert.equal(existsSync(duplicate), false)
  assert.equal(existsSync(missing), false)
})

test('휴지통에 옮긴 기각 대표도 나중에 생긴 중복 후보의 결과로 쓴다', () => {
  candidate(local, 'rejected', '기각(효과 없음)', 'core 스킬')
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  const trash = join(root, 'trash')
  notifyFeedback(collectFeedback(repos, trash), trash, {
    findMain: () => ({ kind: 'main', run: 'run', terminal: 'terminal', alive: ['run'] }),
    notifyRun: () => ({ ok: true, id: 'sent' }),
  })
  candidate(local, 'duplicate', '기각(중복: rejected)', 'core 스킬')
  assert.equal(collectFeedback(repos, trash).rows[0].resultStatus, '기각(대표 rejected: 기각(효과 없음))')
})

test('메시지 뒤 휴지통 이동이 실패해도 같은 알림을 다시 보내지 않는다', () => {
  const file = candidate(local, 'accepted', '채택 #2', 'core 스킬')
  const repos = [{ name: 'fos-skills', path: core }, { name: 'sample', path: local }]
  const trash = join(root, 'trash')
  writeFileSync(trash, '휴지통 경로를 파일로 막는다')
  let count = 0
  const deps = {
    findMain: () => ({ kind: 'main' as const, run: 'run', terminal: 'terminal', alive: ['run'] }),
    notifyRun: () => { count++; return { ok: true as const, id: 'sent' } },
  }
  assert.ok(notifyFeedback(collectFeedback(repos), trash, deps).some(line => line.startsWith('TRASH-FAIL')))
  assert.equal(existsSync(`${file}.sent`), true)
  notifyFeedback(collectFeedback(repos), trash, deps)
  assert.equal(count, 1)
})

test('실제 Orca 목록 형식과 읽지 못하는 저장소를 명령에서 표시한다', () => {
  const broken = join(root, 'broken')
  mkdirSync(join(broken, '.orch'), { recursive: true })
  writeFileSync(join(broken, '.orch', 'feedback'), '파일이므로 읽을 수 없다')
  candidate(local, 'new', '후보')
  const orca = join(root, 'orca')
  const repos = [{ path: core, displayName: 'fos-skills' }, { path: local, displayName: 'sample' }, { path: broken, displayName: 'broken' }]
  writeFileSync(orca, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,result:{repos:${JSON.stringify(repos)}}}))\n`)
  chmodSync(orca, 0o755)
  process.env.ORCA = orca
  assert.equal(feedbackRepos().length, 3)
  const script = new URL('../scripts/feedback/feedback-candidates.ts', import.meta.url).pathname
  const before = readFileSync(join(local, '.orch', 'feedback', 'new.md'), 'utf8')
  const output = execFileSync(process.execPath, [script, 'collect'], { cwd: core, encoding: 'utf8', env: process.env })
  assert.match(output, /판정할 core 후보/)
  assert.match(output, /READ-FAIL broken/)
  assert.equal(readFileSync(join(local, '.orch', 'feedback', 'new.md'), 'utf8'), before)
})
