// handoff-cleanup.ts 를 임시 git 저장소와 가짜 gh, orca 로 돌려 본다. 휴지통 폴더도 임시 폴더라 홈의 휴지통에는 아무것도 옮기지 않는다.
//
// 판정(큐 로그가 끝났는지, 지시서가 끝났는지, 폴더를 남길지, 겹친 후보를 한 번만 세는지)은 모두 명령을 돌려
// 출력과 남은 파일로 본다. 가짜 gh, orca 는 이 테스트를 도는 node 를 shebang 에 박은 실행 파일이다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, beforeEach, afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/handoff-cleanup.ts', import.meta.url))
const SHIM = fileURLToPath(new URL('../scripts/handoff-cleanup.py', import.meta.url))
const DAY = 86400

// 열린 PR 의 head 는 FAKE_OPEN(JSON 목록)이다. FAKE_GH_FAILS=1 이면 실패한다
const FAKE_GH = `const fs = require('node:fs')
if (process.env.FAKE_GH_FAILS === '1') process.exit(1)
const heads = JSON.parse(process.env.FAKE_OPEN || '[]')
fs.writeSync(1, JSON.stringify(heads.map((headRefName) => ({ headRefName }))) + '\\n')
`
// git 을 부를 때마다 인자를 FAKE_GIT_LOG 에 한 줄로 남기고 PATH 의 git 으로 넘긴다.
// FAKE_LS_REMOTE_CODE 가 있으면 ls-remote 는 git 을 부르지 않고 그 코드로 끝난다
const FAKE_GIT = `const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GIT_LOG, args.join(' ') + '\\n')
if (args[0] === 'ls-remote' && process.env.FAKE_LS_REMOTE_CODE) process.exit(Number(process.env.FAKE_LS_REMOTE_CODE))
process.exit(spawnSync('git', args, { stdio: 'inherit' }).status ?? 1)
`
// 살아 있는 Task 는 FAKE_TASKS(JSON 목록)다. FAKE_ORCA_FAILS=1 이면 실패한다
const FAKE_ORCA = `const fs = require('node:fs')
if (process.env.FAKE_ORCA_FAILS === '1') process.exit(1)
const args = process.argv.slice(2)
const say = (value) => fs.writeSync(1, JSON.stringify({ ok: true, result: value }) + '\\n')
if (args.includes('task-list')) say({ tasks: JSON.parse(process.env.FAKE_TASKS || '[]') })
else say({ workers: [], scope: { source: 'all' } })
`

let bindir: string
before(() => {
  bindir = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-cleanup-bin-')))
  writeNodeBin(bindir, 'gh', FAKE_GH)
  writeNodeBin(bindir, 'orca', FAKE_ORCA)
  writeNodeBin(bindir, 'git', FAKE_GIT)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

type Result = { code: number | null; stdout: string; stderr: string }

let tmp: string
let repo: string
let orch: string
let previews: string
let trash: string
let env: NodeJS.ProcessEnv

function sh(...cmd: string[]): string {
  const done = spawnSync(cmd[0], cmd.slice(1), { env, encoding: 'utf8' })
  assert.equal(done.status, 0, `${cmd.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-cleanup-')))
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GH: join(bindir, 'gh'),
    ORCA: join(bindir, 'orca'),
  }
  for (const key of ['ORCH_DIR', 'GH_HOST', 'GIT', 'FAKE_OPEN', 'FAKE_TASKS', 'FAKE_GH_FAILS', 'FAKE_ORCA_FAILS', 'FAKE_LS_REMOTE_CODE']) delete env[key]
  const origin = join(tmp, 'origin.git')
  repo = join(tmp, 'repo')
  sh('git', 'init', '-q', '--bare', '-b', 'main', origin)
  sh('git', 'clone', '-q', origin, repo)
  sh('git', '-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  sh('git', '-C', repo, 'push', '-q', '-u', 'origin', 'main')
  orch = join(repo, '.orch')
  previews = join(repo, 'previews')
  for (const dir of ['queue', 'specs', 'bin', 'state']) mkdirSync(join(orch, dir), { recursive: true })
  mkdirSync(previews)
  trash = join(tmp, 'trash')
  writeFileSync(join(repo, 'board.json'), JSON.stringify({ items: [{ id: 'item-done', status: 'done' }, { id: 'item-doing', status: 'doing', details: ['keep-me'] }] }))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// repo 아래에 파일(text 가 null 이면 폴더)을 만들고 수정 시각을 ageDays 일 전보다 조금 더 전으로 맞춘다
function make(rel: string, text: string | null = 'x', ageDays = 0): string {
  const target = join(repo, rel)
  mkdirSync(text === null ? target : dirname(target), { recursive: true })
  if (text !== null) writeFileSync(target, text)
  const stamp = Date.now() / 1000 - ageDays * DAY - 60
  utimesSync(target, stamp, stamp)
  return target
}

function age(target: string, days: number): void {
  const stamp = Date.now() / 1000 - days * DAY
  utimesSync(target, stamp, stamp)
}

function clean(args: string[] = [], extra: Record<string, string> = {}, opts: { noBoard?: boolean } = {}): Result {
  const base = opts.noBoard ? [] : ['--board', 'board.json']
  const done = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--trash', trash, ...base, ...args],
    { env: { ...env, ...extra }, encoding: 'utf8' },
  )
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function ok(args: string[] = [], extra: Record<string, string> = {}): Result {
  const done = clean(args, extra)
  assert.equal(done.code, 0, done.stderr)
  return done
}

const spec = (branch: string, item: string): string => `브랜치: \`${branch}\`\n보드 항목 id: \`${item}\`\n`

// git 호출을 기록하는 가짜 git 으로 돌린다. 기록한 인자 줄을 함께 돌려준다
function withGitLog(args: string[], extra: Record<string, string> = {}): Result & { gitCalls: string[] } {
  const gitLog = join(tmp, 'git.log')
  const done = ok(args, { GIT: join(bindir, 'git'), FAKE_GIT_LOG: gitLog, ...extra })
  const gitCalls = existsSync(gitLog) ? readFileSync(gitLog, 'utf8').split('\n').filter((line) => line) : []
  return { ...done, gitCalls }
}

describe('handoff-cleanup', () => {
  test('기본은 후보만 보이고 아무것도 옮기지 않는다', () => {
    const old = make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    const r = ok()
    assert.match(r.stdout, /^후보 \.orch\/queue\/q\.out$/m)
    assert.equal(existsSync(old), true)
    assert.equal(existsSync(trash), false)
    assert.doesNotMatch(r.stdout, /휴지통 폴더/)
  })

  test('--apply 이면 옮기고 휴지통 폴더를 알린다', () => {
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    const r = ok(['--apply'])
    assert.match(r.stdout, /^옮김 \.orch\/queue\/q\.out$/m)
    assert.ok(r.stdout.includes(`휴지통 폴더: ${trash}`), r.stdout)
    assert.equal(existsSync(join(trash, '.orch/queue/q.out')), true)
  })

  test('.omc 가 없는 저장소도 돌고 .omc 를 만들지 않는다', () => {
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    const finished = make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    const lines = new Set(ok().stdout.split('\n').filter((line) => line))
    assert.deepEqual(lines, new Set(['후보 .orch/queue/q.out', `지시서를 휴지통으로 옮길 것 ${finished}`]))
    assert.equal(existsSync(join(repo, '.omc')), false)
  })

  test('.omc 아래 다른 도구의 파일은 기본으로 건드리지 않는다', () => {
    make('.omc/previews/old.html', '<html>', 9)
    make('.omc/state/session.json', '{}', 9)
    make('.omc/raw.csv', 'a,b\n', 9)
    make('.omc/handoffs/queue/q.out', 'QUEUE-DONE\n', 9)
    assert.equal(ok().stdout, '')
  })

  test('큐 로그는 마지막 3줄에 끝 표시가 있고 --queue-days 일 넘게 지났을 때만 옮긴다', () => {
    make('.orch/queue/done.out', 'a\nQUEUE-DONE\n', 2)
    make('.orch/queue/finish-7.out', 'FINISH-FAIL\n', 2)
    make('.orch/queue/stop.out', 'x\nSTOP 12 체크 실패\n', 2)
    make('.orch/queue/finish-done.out', 'FINISH-DONE', 2)
    make('.orch/queue/recent.out', 'QUEUE-DONE\n', 0)
    make('.orch/queue/running.out', '진행 중\n', 5)
    make('.orch/queue/mid-word.out', '진행 중 STOP 이라는 말이 줄 가운데 있다\n', 5)
    make('.orch/queue/far.out', 'QUEUE-DONE\n1\n2\n3\n', 5)
    ok(['--apply'])
    for (const name of ['done.out', 'finish-7.out', 'stop.out', 'finish-done.out']) assert.equal(existsSync(join(trash, '.orch/queue', name)), true, name)
    for (const name of ['recent.out', 'running.out', 'mid-word.out', 'far.out']) assert.equal(existsSync(join(orch, 'queue', name)), true, name)
  })

  test('수정 시각이 기준일과 정확히 같으면 옮기지 않고 넘으면 옮긴다', () => {
    const edge = make('.orch/queue/edge.out', 'QUEUE-DONE\n', 0)
    const now = Date.now() / 1000
    utimesSync(edge, now - DAY + 30, now - DAY + 30)
    assert.equal(ok().stdout, '')
    utimesSync(edge, now - DAY - 30, now - DAY - 30)
    assert.match(ok().stdout, /후보 \.orch\/queue\/edge\.out/)
  })

  test('지시서는 보드 항목이 done 이고 브랜치가 원격과 워크트리에 없고 열린 PR 도 없을 때만 휴지통으로 옮긴다', () => {
    make('.orch/specs/spec-common.md', '공통\n', 9)
    make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    make('.orch/specs/spec-not-yet.md', spec('feat/not-yet', 'item-doing'))
    make('.orch/specs/spec-open-pr.md', spec('feat/open', 'item-done'))
    make('.orch/specs/spec-remote.md', spec('feat/remote', 'item-done'))
    make('.orch/specs/spec-unknown-item.md', spec('feat/unknown', 'item-none'))
    make('.orch/specs/spec-no-branch.md', '# 브랜치가 없는 문서\n')
    sh('git', '-C', repo, 'push', '-q', 'origin', 'main:refs/heads/feat/remote')
    ok(['--apply'], { FAKE_OPEN: JSON.stringify(['feat/open']) })
    assert.equal(existsSync(join(trash, '.orch/specs/spec-finished.md')), true)
    assert.equal(existsSync(join(orch, 'specs/spec-finished.md')), false)
    for (const name of ['spec-common.md', 'spec-not-yet.md', 'spec-open-pr.md', 'spec-remote.md', 'spec-unknown-item.md', 'spec-no-branch.md']) {
      assert.equal(existsSync(join(orch, 'specs', name)), true, name)
    }
  })

  test('보드 항목 줄이 없는 지시서는 그 조건을 건너뛴다', () => {
    make('.orch/specs/spec-plain.md', '브랜치: `feat/plain`\n')
    ok(['--apply'])
    assert.equal(existsSync(join(trash, '.orch/specs/spec-plain.md')), true)
  })

  test('보드의 items 가 id 로 묶은 객체여도 읽는다', () => {
    writeFileSync(join(repo, 'board.json'), JSON.stringify({ items: { k: { id: 'item-done', status: 'done' } } }))
    make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    ok(['--apply'])
    assert.equal(existsSync(join(trash, '.orch/specs/spec-finished.md')), true)
  })

  test('보드를 읽지 못하면 보드 항목 줄이 있는 지시서는 옮기지 않는다', () => {
    writeFileSync(join(repo, 'board.json'), 'not json')
    make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    ok(['--apply'])
    assert.equal(existsSync(join(orch, 'specs/spec-finished.md')), true)
  })

  test('보드 파일이 비어 있으면 보드 항목 줄이 있는 지시서는 옮기지 않는다', () => {
    writeFileSync(join(repo, 'board.json'), '')
    const target = make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    ok(['--apply'])
    assert.equal(existsSync(target), true)
  })

  test('브랜치 줄과 보드 항목 줄이 모두 **이름**: 꼴이어도 보드 조건을 본다', () => {
    const bold = (branch: string, item: string) => `- **브랜치**: \`${branch}\`\n- **보드 항목 id**: \`${item}\`\n`
    const doing = make('.orch/specs/spec-bold-doing.md', bold('feat/bold-doing', 'item-doing'))
    make('.orch/specs/spec-bold-done.md', bold('feat/bold-done', 'item-done'))
    ok(['--apply'])
    assert.equal(existsSync(doing), true, 'doing 항목의 지시서가 옮겨졌다')
    // 같은 꼴이라도 done 이면 옮긴다. 두 줄을 모두 읽었다는 뜻이다
    assert.equal(existsSync(join(trash, '.orch/specs/spec-bold-done.md')), true)
  })

  test('원격 브랜치 조회가 「없음」 말고 다른 이유로 실패하면 지시서를 남긴다', () => {
    const target = make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    const r = withGitLog(['--apply'], { FAKE_LS_REMOTE_CODE: '128' })
    assert.ok(r.gitCalls.some((line) => line.startsWith('ls-remote --exit-code --heads origin feat/finished')), r.gitCalls.join('\n'))
    assert.equal(existsSync(target), true)
  })

  test('끝난 지시서는 휴지통에 orch 폴더 이름 아래로 옮기고 같은 이름이 있으면 .2 를 붙인다', () => {
    make('.orch/specs/spec-x.md', spec('feat/x', 'item-done') + 'first\n')
    mkdirSync(join(trash, '.orch/specs'), { recursive: true })
    writeFileSync(join(trash, '.orch/specs/spec-x.md'), 'older')
    const r = ok(['--apply'])
    assert.equal(readFileSync(join(trash, '.orch/specs/spec-x.md'), 'utf8'), 'older')
    assert.match(readFileSync(join(trash, '.orch/specs/spec-x.md.2'), 'utf8'), /first/)
    assert.match(r.stdout, /지시서 옮김 .*spec-x\.md -> .*spec-x\.md\.2/)
  })

  test('워크트리가 살아 있는 브랜치의 지시서는 남긴다', () => {
    make('.orch/specs/spec-wt.md', spec('feat/wt', 'item-done'))
    sh('git', '-C', repo, 'worktree', 'add', '-q', '-b', 'feat/wt', join(tmp, 'wt'))
    ok(['--apply'])
    assert.equal(existsSync(join(orch, 'specs/spec-wt.md')), true)
  })

  test('살아 있는 dispatch 가 쓰는 지시서는 남기고 남긴다 줄을 낸다', () => {
    const target = make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    const tasks = [{ id: 't1', status: 'dispatched', spec: `지시서 ${target} 를 끝까지 읽고 수행한다.` }]
    const r = ok(['--apply'], { FAKE_TASKS: JSON.stringify(tasks) })
    assert.match(r.stderr, /지시서를 남긴다 .*spec-finished\.md: 살아 있는 dispatch 가 쓴다/)
    assert.equal(existsSync(target), true)
  })

  test('살아 있는 지시서 목록을 읽지 못하면 지시서는 하나도 옮기지 않고 큐 로그는 옮긴다', () => {
    const target = make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    const r = withGitLog(['--apply'], { FAKE_ORCA_FAILS: '1' })
    assert.match(r.stderr, /살아 있는 dispatch 의 지시서를 읽지 못해/)
    assert.equal(existsSync(target), true)
    assert.equal(existsSync(join(trash, '.orch/queue/q.out')), true)
    // 지시서마다 판정하지 않는다. 원격 조회도 지시서 줄도 없다
    assert.deepEqual(r.gitCalls.filter((line) => line.startsWith('ls-remote')), [])
    assert.doesNotMatch(r.stderr, /지시서를 남긴다/)
  })

  test('열린 PR 을 읽지 못하면 지시서는 옮기지 않는다', () => {
    make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    const r = ok(['--apply'], { FAKE_GH_FAILS: '1' })
    assert.match(r.stderr, /열린 PR 을 읽지 못해/)
    assert.equal(existsSync(join(orch, 'specs/spec-finished.md')), true)
  })

  test('오래된 폴더와 미리보기는 보드 파일과 .keep 에 이름이 있으면 남긴다', () => {
    make('.orch/old-report', null, 4)
    make('.orch/keep-me', null, 4)
    make('.orch/pinned-note', null, 4)
    make('.orch/.keep', 'pinned-note\n', 9)
    make('.orch/fresh', null, 1)
    make('previews/old.html', '<html>', 4)
    make('previews/pinned.html', '<html>', 9)
    make('previews/pinned-too', null, 9)
    make('previews/.keep', 'pinned.html\n pinned-too \n', 9)
    for (const dir of ['bin', 'queue', 'specs', 'state']) age(join(orch, dir), 9)
    ok(['--apply', '--previews', 'previews'])
    assert.equal(existsSync(join(trash, '.orch/old-report')), true)
    assert.equal(existsSync(join(trash, 'previews/old.html')), true)
    for (const rel of ['.orch/keep-me', '.orch/pinned-note', '.orch/fresh', 'previews/pinned.html', 'previews/pinned-too', 'previews/.keep', '.orch/bin', '.orch/queue', '.orch/specs', '.orch/state', 'board.json']) {
      assert.equal(existsSync(join(repo, rel)), true, rel)
    }
  })

  test('--previews 가 없으면 미리보기 폴더는 보지 않는다', () => {
    make('previews/old.html', '<html>', 9)
    assert.equal(ok().stdout, '')
  })

  test('csv 와 tsv 는 하루 넘게 지난 것만 옮기고 bin 아래는 뺀다', () => {
    make('.orch/data/raw.csv', 'a,b\n', 2)
    make('.orch/scratch/raw.TSV', 'a\tb\n', 2)
    make('.orch/scratch/new.csv', 'a,b\n', 0)
    make('.orch/bin/lookup.csv', 'a,b\n', 30)
    make('.orch/scratch/notes.txt', 'n', 30)
    ok(['--apply', '--folder-days', '100'])
    assert.equal(existsSync(join(trash, '.orch/data/raw.csv')), true)
    assert.equal(existsSync(join(trash, '.orch/scratch/raw.TSV')), true)
    for (const rel of ['.orch/scratch/new.csv', '.orch/bin/lookup.csv', '.orch/scratch/notes.txt']) assert.equal(existsSync(join(repo, rel)), true, rel)
  })

  test('옮길 폴더 안의 파일은 따로 세지 않고 폴더만 한 번 낸다', () => {
    make('previews/old-dir/data.csv', 'a,b\n', 5)
    age(join(previews, 'old-dir'), 5)
    assert.deepEqual(ok(['--previews', 'previews']).stdout.split('\n').filter((line) => line), ['후보 previews/old-dir'])
  })

  test('휴지통에 같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다', () => {
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    mkdirSync(join(trash, '.orch/queue'), { recursive: true })
    writeFileSync(join(trash, '.orch/queue/q.out'), 'older')
    ok(['--apply'])
    assert.equal(readFileSync(join(trash, '.orch/queue/q.out'), 'utf8'), 'older')
    assert.equal(readFileSync(join(trash, '.orch/queue/q.out.2'), 'utf8'), 'QUEUE-DONE\n')
  })

  test('휴지통에 q.out 과 q.out.2 가 있으면 q.out.3 으로 옮긴다', () => {
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    mkdirSync(join(trash, '.orch/queue'), { recursive: true })
    writeFileSync(join(trash, '.orch/queue/q.out'), 'first')
    writeFileSync(join(trash, '.orch/queue/q.out.2'), 'second')
    ok(['--apply'])
    assert.equal(readFileSync(join(trash, '.orch/queue/q.out'), 'utf8'), 'first')
    assert.equal(readFileSync(join(trash, '.orch/queue/q.out.2'), 'utf8'), 'second')
    assert.equal(readFileSync(join(trash, '.orch/queue/q.out.3'), 'utf8'), 'QUEUE-DONE\n')
  })

  test('.keep 에 이름이 앞부분만 같은 줄이 있어도 그 폴더는 옮긴다', () => {
    make('.orch/old-report', null, 4)
    make('.orch/.keep', 'old-report2\nold\n', 9)
    for (const dir of ['bin', 'queue', 'specs', 'state']) age(join(orch, dir), 9)
    ok(['--apply'])
    assert.equal(existsSync(join(trash, '.orch/old-report')), true)
  })

  test('후보 줄은 지시서 줄까지 깊이 순으로 낸다', () => {
    make('.orch/raw.csv', 'a,b\n', 2)
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    const finished = make('.orch/specs/spec-finished.md', spec('feat/finished', 'item-done'))
    make('.orch/zz/raw.csv', 'a,b\n', 2)
    const lines = ok(['--folder-days', '100']).stdout.split('\n').filter((line) => line)
    assert.deepEqual(lines, ['후보 .orch/raw.csv', '후보 .orch/queue/q.out', `지시서를 휴지통으로 옮길 것 ${finished}`, '후보 .orch/zz/raw.csv'])
  })

  test('휴지통 폴더 줄은 --trash 로 준 상대경로를 그대로 낸다', () => {
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    const done = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--board', 'board.json', '--trash', 'rel-trash', '--apply'],
      { env, cwd: tmp, encoding: 'utf8' },
    )
    assert.equal(done.status, 0, done.stderr)
    assert.match(done.stdout, /^휴지통 폴더: rel-trash$/m)
    assert.equal(existsSync(join(tmp, 'rel-trash/.orch/queue/q.out')), true)
  })

  test('옵션이 경로와 기준을 정하고 설정 파일은 명령줄보다 약하다', () => {
    make('previews/mid.html', '<html>', 2)
    ok(['--apply', '--folder-days', '1', '--previews', 'previews'])
    assert.equal(existsSync(join(trash, 'previews/mid.html')), true)

    make('previews/cfg.html', '<html>', 2)
    const second = join(tmp, 'trash2')
    writeFileSync(join(orch, 'config.json'), JSON.stringify({ cleanup: { folder_days: 1, previews: 'previews', trash: second }, finish: { run: 'r' } }))
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--board', 'board.json', '--apply'], { env, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.equal(existsSync(join(second, 'previews/cfg.html')), true)

    make('previews/cli.html', '<html>', 2)
    const third = join(tmp, 'trash3')
    const cli = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, '--board', 'board.json', '--trash', third, '--apply'], { env, encoding: 'utf8' })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(existsSync(join(third, 'previews/cli.html')), true)
  })

  test('ORCH_DIR 이 orch 작업 폴더를 옮긴다', () => {
    make('work/orch/queue/q.out', 'QUEUE-DONE\n', 2)
    assert.deepEqual(ok([], { ORCH_DIR: 'work/orch' }).stdout.split('\n').filter((line) => line), ['후보 orch/queue/q.out'])
  })

  test('설정 파일의 모르는 키는 사용법 오류다', () => {
    const cfg = join(tmp, 'bad.json')
    writeFileSync(cfg, JSON.stringify({ cleanup: { typo_key: 1 } }))
    const r = clean(['--config', cfg], {}, { noBoard: true })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /typo_key/)
  })

  test('후보가 없으면 아무것도 내지 않고 0 으로 끝난다', () => {
    const r = clean()
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
  })

  test('옛 .py 경로는 같은 결과를 내는 shim 이다', () => {
    make('.orch/queue/q.out', 'QUEUE-DONE\n', 2)
    // shim 은 PATH 의 node 를 부른다. 이 테스트를 도는 node 를 앞에 둔다
    const shimEnv = { ...env, PATH: [dirname(process.execPath), env.PATH ?? ''].join(delimiter) }
    const done = spawnSync('python3', [SHIM, '--repo', repo, '--trash', trash, '--board', 'board.json'], { env: shimEnv, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.match(done.stderr, /DEPRECATED/)
    assert.match(done.stdout, /^후보 \.orch\/queue\/q\.out$/m)
  })
})
