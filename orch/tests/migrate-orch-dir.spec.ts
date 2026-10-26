// migrate-orch-dir.ts 를 옛 구조를 만든 임시 저장소에서 미리보기와 --apply 로 돌린다. --hooks 는 만든 핸들러를 lib/events.ts 의 fire 로 돌려 본다.
//
// orca 와 pgrep 은 가짜를 쓴다. 가짜 orca 는 FAKE_TASKS, FAKE_WORKERS 로 살아 있는 dispatch 와 worker 를 주고
// (worker-list 는 모든 Run 의 목록인 scope.source all 로 낸다), FAKE_ORCA_FAILS=1 이면 실패한다.
// 가짜 pgrep 은 pgrep -f 처럼 마지막 인자의 정규식을 FAKE_PS 의 줄(`<pid> <명령줄>`)에 맞춰 맞는 줄을 낸다.
// 그래서 명령이 넘긴 정규식이 실제로 어떤 명령줄을 잡는지 본다. FAKE_PGREP_FAILS=1 이면 종료 코드 3 이다.
// Orca 와 GitHub, 사용자 저장소에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fire } from '../scripts/lib/events.ts'
import { spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/migrate-orch-dir.ts', import.meta.url))
const ORCH_PATHS = fileURLToPath(new URL('../scripts/orch_paths.py', import.meta.url))

const FAKE_ORCA = `const fs = require('node:fs')
if (process.env.FAKE_ORCA_FAILS === '1') process.exit(1)
const say = (value) => fs.writeSync(1, JSON.stringify(value) + '\\n')
if (process.argv.includes('task-list')) say({ ok: true, result: { tasks: JSON.parse(process.env.FAKE_TASKS || '[]') } })
else say({ ok: true, result: { workers: JSON.parse(process.env.FAKE_WORKERS || '[]'), scope: { source: 'all' } } })
`
const FAKE_PGREP = `const fs = require('node:fs')
if (process.env.FAKE_PGREP_FAILS === '1') process.exit(3)
const pattern = new RegExp(process.argv[process.argv.length - 1])
const lines = (process.env.FAKE_PS || '').split('\\n').filter((line) => line && pattern.test(line))
for (const line of lines) fs.writeSync(1, line + '\\n')
process.exit(lines.length > 0 ? 0 : 1)
`

// 이 파일의 fire 가 쓰는 ORCH_DIR 을 비워 임시 저장소의 .orch 를 보게 한다
const savedOrchDir = process.env.ORCH_DIR
let bin = ''
before(() => {
  delete process.env.ORCH_DIR
  bin = realpathSync(mkdtempSync(join(tmpdir(), 'migrate-orch-dir-bin-')))
  writeNodeBin(bin, 'orca', FAKE_ORCA)
  writeNodeBin(bin, 'pgrep', FAKE_PGREP)
})
after(() => {
  if (savedOrchDir !== undefined) process.env.ORCH_DIR = savedOrchDir
  rmSync(bin, { recursive: true, force: true })
})

type Ctx = {
  tmp: string
  repo: string
  env: NodeJS.ProcessEnv
  sh: (...cmd: string[]) => string
  write: (rel: string, text: string) => string
  migrate: (args: string[], opts?: { code?: number; env?: Record<string, string>; repo?: string }) => Promise<Done>
}

function setup(t: TestContext): Ctx {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'migrate-orch-dir-')))
  t.after(() => {
    // 실패한 이동 테스트가 권한을 바꾼 폴더도 지울 수 있게 되돌린다
    spawnSync('chmod', ['-R', 'u+rwx', tmp])
    rmSync(tmp, { recursive: true, force: true })
  })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    ORCA: join(bin, 'orca'),
    PGREP: join(bin, 'pgrep'),
  }
  for (const key of ['ORCH_DIR', 'GIT', 'FAKE_TASKS', 'FAKE_WORKERS', 'FAKE_ORCA_FAILS', 'FAKE_PS', 'FAKE_PGREP_FAILS']) delete env[key]
  const sh = (...cmd: string[]): string => {
    const done = spawnSync(cmd[0], cmd.slice(1), { env, encoding: 'utf8' })
    assert.equal(done.status, 0, `${cmd.join(' ')} 가 실패했다: ${done.stderr}`)
    return done.stdout.trim()
  }
  const repo = join(tmp, 'repo')
  sh('git', 'init', '-q', '-b', 'main', repo)
  sh('git', '-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const write = (rel: string, text: string): string => {
    const target = join(repo, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    return target
  }
  const migrate = async (args: string[], opts: { code?: number; env?: Record<string, string>; repo?: string } = {}): Promise<Done> => {
    const done = await spawnDone([process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT, '--repo', opts.repo ?? repo, ...args], {
      env: { ...env, ...(opts.env ?? {}) },
    })
    assert.equal(done.code, opts.code ?? 0, `종료 코드가 다르다\n${done.stdout}${done.stderr}`)
    return done
  }
  return { tmp, repo, env, sh, write, migrate }
}

// 오버레이와 설정은 .claude, 지시서와 큐는 .omc/handoffs 에 둔 옛 구조
function handoffsLayout(c: Ctx): void {
  c.write('.claude/orch-overlay.md', '- 지시서: `.omc/handoffs/specs/`\n- 큐: `.omc/handoffs/queue/q.out`\n')
  c.write(
    '.claude/orch-finish.json',
    JSON.stringify({ finish: { run: 'run_x', board: '.omc/handoffs/board.json', specs_dir: '.omc/handoffs/specs' }, cleanup: { omc: '.omc' } }),
  )
  c.write('.omc/handoffs/specs/spec-common.md', '공통\n')
  c.write('.omc/handoffs/specs/spec-a.md', `먼저 \`${c.repo}/.omc/handoffs/specs/spec-common.md\` 를 읽는다.\n`)
  c.write('.omc/handoffs/queue/q.out', 'QUEUE-DONE\n')
  c.write('.omc/handoffs/board.json', '{}')
  c.write('.omc/handoffs/bin/merge.sh', 'echo "$R/.omc/handoffs/queue"\n')
  c.write('.omc/state/wait-important-lost.json', '{}')
  c.write('.omc/state/session.json', '{}')
  c.write('.omc/previews/a.html', '<html>')
}

function listing(root: string): string[] {
  const found = spawnSync('find', [root, '-not', '-path', '*/.git*'], { encoding: 'utf8' }).stdout
  return found.split('\n').filter((line) => line).sort()
}

function readJson(target: string): unknown {
  return JSON.parse(readFileSync(target, 'utf8'))
}

describe('migrate-orch-dir 폴더 옮기기', { concurrency: 4 }, () => {
  test('미리보기는 옮길 것과 참조를 보이고 아무것도 바꾸지 않는다', async (t) => {
    const c = setup(t)
    handoffsLayout(c)
    const before = listing(c.repo)
    const { stdout } = await c.migrate([])
    for (const line of [
      '옮길 것 .claude/orch-overlay.md -> .orch/overlay.md',
      '옮길 것 .claude/orch-finish.json -> .orch/config.json',
      '옮길 것 .omc/handoffs/specs -> .orch/specs',
      '옮길 것 .omc/handoffs/queue -> .orch/queue',
      '옮길 것 .omc/state/wait-important-lost.json -> .orch/state/wait-important-lost.json',
      '바꿀 옛 경로 .omc/handoffs/specs/spec-a.md:1:',
      '옛 경로 참조(스크립트. 옛 폴더를 다시 만들 수 있어 옮긴 뒤 고친다) .omc/handoffs/bin/merge.sh:1:',
    ]) {
      assert.ok(stdout.includes(line), `${line} 이 출력에 없다\n${stdout}`)
    }
    assert.ok(!stdout.includes('session.json'), stdout)
    assert.ok(!stdout.includes('q.out:'), stdout)
    assert.deepEqual(listing(c.repo), before)
  })

  test('--apply 는 옮기고 옛 경로를 바꾸며 다른 도구의 파일은 남긴다', async (t) => {
    const c = setup(t)
    handoffsLayout(c)
    const { stdout } = await c.migrate(['--apply'])
    const orch = join(c.repo, '.orch')
    assert.equal(readFileSync(join(orch, 'specs/spec-a.md'), 'utf8'), `먼저 \`${orch}/specs/spec-common.md\` 를 읽는다.\n`)
    assert.equal(readFileSync(join(orch, 'overlay.md'), 'utf8'), '- 지시서: `.orch/specs/`\n- 큐: `.orch/queue/q.out`\n')
    const config = readJson(join(orch, 'config.json')) as { finish: Record<string, string>; cleanup: Record<string, string> }
    assert.equal(config.finish.specs_dir, '.orch/specs')
    assert.equal(config.finish.board, '.omc/handoffs/board.json')
    assert.deepEqual(config.cleanup, { previews: '.omc/previews' })
    assert.ok(existsSync(join(orch, 'queue/q.out')))
    assert.ok(existsSync(join(orch, 'state/wait-important-lost.json')))
    for (const rel of ['.omc/handoffs/board.json', '.omc/handoffs/bin/merge.sh', '.omc/state/session.json', '.omc/previews/a.html']) {
      assert.ok(existsSync(join(c.repo, rel)), `${rel} 이 남아야 한다`)
    }
    assert.ok(!existsSync(join(c.repo, '.claude/orch-overlay.md')))
    assert.ok(readFileSync(join(c.repo, '.git/info/exclude'), 'utf8').split('\n').includes('/.orch/'))
    assert.equal(c.sh('git', '-C', c.repo, 'status', '--porcelain', '--', '.orch'), '')
    assert.ok(stdout.includes('설정 cleanup.omc 를 지운다'), stdout)

    const again = await c.migrate(['--apply'])
    assert.equal(again.stdout.trim().split('\n').at(-1), '옮길 것이 없다')
  })

  test('.omc/orch 구조는 스크립트를 bin 으로, 나머지를 루트로 옮긴다', async (t) => {
    const c = setup(t)
    c.write('.omc/orch/scripts/slot.sh', 'SCRIPT_DIR=.omc/orch/scripts\n')
    c.write('.omc/orch/specs/spec-common.md', '공통\n')
    c.write('.omc/orch/queue-env.sh', 'x\n')
    c.write('.omc/orch/wait.json', '{}')
    c.write('.omc/orch/pr-feat-a.md', '본문 `.omc/orch/specs/spec-common.md`\n')
    c.write('.omc/state/notify-conflicts.json', '{}')
    c.write('.omc/board.json', '{}')
    await c.migrate(['--apply'])
    const orch = join(c.repo, '.orch')
    assert.equal(readFileSync(join(orch, 'bin/slot.sh'), 'utf8'), 'SCRIPT_DIR=.omc/orch/scripts\n')
    assert.equal(readFileSync(join(orch, 'pr-feat-a.md'), 'utf8'), '본문 `.orch/specs/spec-common.md`\n')
    for (const rel of ['specs/spec-common.md', 'queue-env.sh', 'wait.json', 'state/notify-conflicts.json']) {
      assert.ok(existsSync(join(orch, rel)), rel)
    }
    assert.ok(!existsSync(join(c.repo, '.omc/orch')))
    assert.ok(existsSync(join(c.repo, '.omc/board.json')))
  })

  test('앞 단계가 만든 대상 폴더에 합치고 orch 폴더를 중첩하지 않는다', async (t) => {
    const c = setup(t)
    c.write('.claude/orch-overlay.md', '오버레이\n')
    c.write('.omc/orch/specs/spec-a.md', '지시서\n')
    c.write('.omc/orch/queue/q.out', '로그\n')
    symlinkSync('specs/spec-a.md', join(c.repo, '.omc/orch/alias.md'))
    assert.ok(!existsSync(join(c.repo, '.orch')))
    await c.migrate(['--apply'])
    assert.equal(readFileSync(join(c.repo, '.orch/overlay.md'), 'utf8'), '오버레이\n')
    assert.equal(readFileSync(join(c.repo, '.orch/specs/spec-a.md'), 'utf8'), '지시서\n')
    assert.equal(readFileSync(join(c.repo, '.orch/queue/q.out'), 'utf8'), '로그\n')
    assert.equal(readFileSync(join(c.repo, '.orch/alias.md'), 'utf8'), '지시서\n')
    assert.equal(readlinkSync(join(c.repo, '.orch/alias.md')), 'specs/spec-a.md')
    assert.ok(!existsSync(join(c.repo, '.orch/orch')))
    assert.ok(!existsSync(join(c.repo, '.omc/orch')))
  })

  test('더한 쌍은 있는 폴더에 합치고 보드는 옮기지 않는다', async (t) => {
    const c = setup(t)
    c.write('.orch/specs/spec-new.md', '새\n')
    c.write('.omc/handoffs/specs/spec-old.md', '옛\n')
    c.write('.omc/handoffs/bin/merge.sh', 'x\n')
    c.write('.omc/handoffs/report/a.md', '조사\n')
    c.write('.omc/handoffs/board.json', '{}')
    const { stdout } = await c.migrate(['--move', '.omc/handoffs/bin=.orch/bin', '--move', '.omc/handoffs=.orch/notes', '--apply'])
    for (const rel of ['.orch/specs/spec-new.md', '.orch/specs/spec-old.md', '.orch/bin/merge.sh', '.orch/notes/report/a.md', '.omc/handoffs/board.json']) {
      assert.ok(existsSync(join(c.repo, rel)), rel)
    }
    assert.ok(stdout.includes('남김 .omc/handoffs/board.json'), stdout)
  })

  test('겹침이 있으면 아무것도 옮기지 않는다', async (t) => {
    const c = setup(t)
    c.write('.orch/specs/spec-a.md', '새\n')
    c.write('.omc/handoffs/specs/spec-a.md', '옛\n')
    c.write('.omc/handoffs/queue/q.out', 'x\n')
    const { stdout, stderr } = await c.migrate(['--apply'], { code: 1 })
    assert.ok(stdout.includes('겹침 .omc/handoffs/specs/spec-a.md -> .orch/specs/spec-a.md'), stdout)
    assert.ok(stderr.includes('아무것도 옮기지 않았다'), stderr)
    assert.ok(existsSync(join(c.repo, '.omc/handoffs/queue/q.out')))
    assert.equal(readFileSync(join(c.repo, '.orch/specs/spec-a.md'), 'utf8'), '새\n')
  })

  test('추적 파일은 git mv 명령을 보이고 나머지는 옮긴다', async (t) => {
    const c = setup(t)
    c.write('.claude/orch-overlay.md', '# 오버레이\n')
    c.sh('git', '-C', c.repo, 'add', '.claude/orch-overlay.md')
    c.sh('git', '-C', c.repo, 'commit', '-q', '-m', 'overlay')
    c.write('.omc/handoffs/specs/spec-a.md', 'x\n')
    const { stdout } = await c.migrate(['--apply'], { code: 1 })
    const command = `mkdir -p ${join(c.repo, '.orch')} && git -C ${c.repo} mv .claude/orch-overlay.md .orch/overlay.md`
    assert.ok(stdout.includes(`추적 파일 ${command}`), stdout)
    assert.ok(existsSync(join(c.repo, '.claude/orch-overlay.md')))
    assert.ok(existsSync(join(c.repo, '.orch/specs/spec-a.md')))
    assert.equal(c.sh('git', '-C', c.repo, 'status', '--porcelain'), '')
    c.sh('bash', '-c', command)
    assert.ok(c.sh('git', '-C', c.repo, 'status', '--porcelain').includes('R  .claude/orch-overlay.md -> .orch/overlay.md'))
  })

  test('추적 파일만 있으면 대상 폴더만 만들어 명령이 돌게 한다', async (t) => {
    const c = setup(t)
    c.write('.claude/orch-overlay.md', '# 오버레이\n')
    c.sh('git', '-C', c.repo, 'add', '.claude/orch-overlay.md')
    c.sh('git', '-C', c.repo, 'commit', '-q', '-m', 'overlay')
    await c.migrate(['--apply'], { code: 1 })
    assert.ok(existsSync(join(c.repo, '.orch')))
    c.sh('git', '-C', c.repo, 'mv', '.claude/orch-overlay.md', '.orch/overlay.md')
  })

  test('살아 있는 일이 있으면 --apply 를 막는다', async (t) => {
    const c = setup(t)
    const spec = c.write('.omc/handoffs/specs/spec-a.md', 'x\n')
    const tasks = JSON.stringify([{ id: 't1', status: 'running', spec: `지시서 ${spec} 를 끝까지 읽고 수행한다.` }])
    const owned = (id: string, tree: string) => ({
      dispatchId: id,
      dispatchStatus: 'completed',
      terminalState: 'active',
      resource: { ownershipState: 'owned', worktreeId: `wt::${tree}` },
    })
    const cases: [Record<string, string>, string][] = [
      [{ FAKE_TASKS: tasks }, '살아 있는 dispatch'],
      [{ FAKE_WORKERS: JSON.stringify([owned('ctx_1', c.repo)]) }, '터미널을 쥔 worker 가 있다: ctx_1'],
      [{ FAKE_ORCA_FAILS: '1' }, 'orca 로 살아 있는 dispatch 와 worker 를 읽지 못했다'],
      [{ FAKE_PS: '123 python3 merge-with-finish.py 1' }, '머지 큐나 마무리가 돌고 있다'],
    ]
    for (const [env, reason] of cases) {
      const { stderr } = await c.migrate(['--apply'], { code: 3, env })
      assert.ok(stderr.includes(reason), `${reason} 이 stderr 에 없다\n${stderr}`)
      assert.ok(existsSync(spec), reason)
    }
    await c.migrate(['--apply'], { env: { FAKE_WORKERS: JSON.stringify([owned('ctx_2', join(c.tmp, 'other'))]) } })
    assert.ok(existsSync(join(c.repo, '.orch/specs/spec-a.md')))
  })

  test('다른 저장소의 살아 있는 지시서는 옮기기를 막지 않는다', async (t) => {
    const c = setup(t)
    c.write('.omc/orch/specs/spec-a.md', 'x\n')
    const other = join(c.tmp, 'repo-other/.omc/orch/specs/spec-a.md')
    mkdirSync(dirname(other), { recursive: true })
    writeFileSync(other, '다른 저장소\n')
    await c.migrate(['--apply'], {
      env: { FAKE_TASKS: JSON.stringify([{ id: 't1', status: 'running', spec: `지시서 ${other} 를 읽는다.` }]) },
    })
    assert.ok(existsSync(join(c.repo, '.orch/specs/spec-a.md')))
    assert.equal(readFileSync(other, 'utf8'), '다른 저장소\n')
  })

  test('주 checkout 과 연결된 워크트리의 새 경로와 옛 경로 지시서는 막는다', async (t) => {
    const c = setup(t)
    c.write('.omc/orch/specs/spec-a.md', 'x\n')
    const wt = join(c.tmp, 'linked')
    c.sh('git', '-C', c.repo, 'worktree', 'add', '-q', '-b', 'linked', wt)
    for (const tree of [c.repo, wt]) {
      for (const rel of ['.orch/specs/spec-new.md', '.omc/orch/specs/spec-orch.md', '.omc/handoffs/specs/spec-handoffs.md']) {
        const spec = join(tree, rel)
        mkdirSync(dirname(spec), { recursive: true })
        writeFileSync(spec, '살아 있음\n')
        const { stderr } = await c.migrate(['--apply'], {
          code: 3,
          env: { FAKE_TASKS: JSON.stringify([{ id: 't1', status: 'running', spec: `지시서 ${spec} 를 읽는다.` }]) },
        })
        assert.ok(stderr.includes('살아 있는 dispatch 가 지시서 1개를 쓰고 있다'), stderr)
        assert.ok(existsSync(join(c.repo, '.omc/orch/specs/spec-a.md')))
      }
    }
  })

  test('옮긴 명령의 .ts 명령줄도 막고, 이름만 비슷한 명령줄은 막지 않는다', async (t) => {
    const c = setup(t)
    const spec = c.write('.omc/handoffs/specs/spec-a.md', 'x\n')
    const busy = [
      '11 node --disable-warning=ExperimentalWarning /skill/scripts/merge_queue.ts 101',
      '12 node --disable-warning=ExperimentalWarning /skill/scripts/merge-with-finish.ts 101!',
      '13 node --disable-warning=ExperimentalWarning /skill/scripts/finish-pr.ts 101',
      '14 bash /skill/scripts/merge-queue.sh 101',
      '15 python3 /skill/scripts/finish-pr.py 101',
    ]
    for (const line of busy) {
      const { stderr } = await c.migrate(['--apply'], { code: 3, env: { FAKE_PS: line } })
      assert.ok(stderr.includes(`머지 큐나 마무리가 돌고 있다: ${line}`), `${line} 을 막지 않았다\n${stderr}`)
    }
    assert.ok(existsSync(spec))
    await c.migrate(['--apply'], { env: { FAKE_PS: '21 node --test orch/tests/merge-queue.spec.ts\n22 vim finish-pr.md' } })
    assert.ok(existsSync(join(c.repo, '.orch/specs/spec-a.md')))
  })

  test('추적 문서의 옛 경로는 알리기만 하고 바꾸지 않는다', async (t) => {
    const c = setup(t)
    const doc = c.write('docs/plan.md', 'bash .omc/orch/scripts/gate.sh\n')
    c.sh('git', '-C', c.repo, 'add', 'docs/plan.md')
    c.sh('git', '-C', c.repo, 'commit', '-q', '-m', 'doc')
    c.write('.omc/orch/scripts/gate.sh', 'x\n')
    const { stdout } = await c.migrate(['--apply'])
    assert.ok(stdout.includes('옛 경로 참조 docs/plan.md:1: bash .omc/orch/scripts/gate.sh'), stdout)
    assert.equal(readFileSync(doc, 'utf8'), 'bash .omc/orch/scripts/gate.sh\n')
  })

  test('빈 옛 폴더는 지우고 새 폴더를 만들지 않는다', async (t) => {
    const c = setup(t)
    mkdirSync(join(c.repo, '.omc/orch/specs'), { recursive: true })
    mkdirSync(join(c.repo, '.omc/handoffs/queue'), { recursive: true })
    const { stdout } = await c.migrate([])
    assert.ok(stdout.includes('지울 빈 폴더 .omc/orch/specs'), stdout)
    await c.migrate(['--apply'])
    assert.ok(!existsSync(join(c.repo, '.omc/orch')))
    assert.ok(!existsSync(join(c.repo, '.omc/handoffs/queue')))
    assert.ok(!existsSync(join(c.repo, '.orch')))
    const again = await c.migrate(['--apply'])
    assert.equal(again.stdout, '옮길 것이 없다\n')
  })

  test('.orch 옆의 빈 옛 폴더는 막지 않고 지운다', async (t) => {
    const c = setup(t)
    c.write('.orch/specs/spec-a.md', 'x\n')
    mkdirSync(join(c.repo, '.omc/orch'), { recursive: true })
    await c.migrate(['--apply'])
    assert.ok(!existsSync(join(c.repo, '.omc/orch')))
    const done = spawnSync('python3', [ORCH_PATHS, '--repo', c.repo, 'check'], { env: c.env, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
  })

  test('미리보기 폴더만 있으면 그 정리를 잇는 설정을 만든다', async (t) => {
    const c = setup(t)
    c.write('.omc/previews/a.html', '<html>')
    const { stdout } = await c.migrate(['--apply'])
    assert.deepEqual(readJson(join(c.repo, '.orch/config.json')), { cleanup: { previews: '.omc/previews' } })
    assert.ok(stdout.includes('설정 파일을 새로 만든다'), stdout)
  })

  test('옮기다 실패하면 멈추고 다시 돌리면 남은 것을 옮긴다', { skip: process.getuid?.() === 0 && 'root 는 권한 검사를 받지 않는다' }, async (t) => {
    const c = setup(t)
    c.write('.omc/handoffs/specs/spec-a.md', '`.omc/handoffs/queue/q.out` 를 본다\n')
    c.write('.omc/handoffs/queue/q.out', 'x\n')
    c.write('.omc/state/wait-important-lost.json', '{}')
    const state = join(c.repo, '.omc/state')
    chmodSync(state, 0o500)
    let stderr: string
    try {
      stderr = (await c.migrate(['--apply'], { code: 1 })).stderr
    } finally {
      chmodSync(state, 0o700)
    }
    assert.ok(stderr.includes('옮기다 실패했다 .omc/state/wait-important-lost.json'), stderr)
    assert.ok(existsSync(join(c.repo, '.orch/specs/spec-a.md')))
    assert.ok(readFileSync(join(c.repo, '.orch/specs/spec-a.md'), 'utf8').includes('.omc/handoffs/queue'))
    await c.migrate(['--apply'])
    assert.equal(readFileSync(join(c.repo, '.orch/specs/spec-a.md'), 'utf8'), '`.orch/queue/q.out` 를 본다\n')
    assert.ok(existsSync(join(c.repo, '.orch/state/wait-important-lost.json')))
  })

  test('워크트리를 --repo 로 주어도 주 checkout 을 옮긴다', async (t) => {
    const c = setup(t)
    c.write('.omc/handoffs/specs/spec-a.md', 'x\n')
    const wt = join(c.tmp, 'wt')
    c.sh('git', '-C', c.repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
    await c.migrate(['--apply'], { repo: wt })
    assert.ok(existsSync(join(c.repo, '.orch/specs/spec-a.md')))
    assert.ok(!existsSync(join(wt, '.orch')))
  })

  test('상대경로 심볼릭 링크는 같은 대상을 가리킨다', async (t) => {
    const c = setup(t)
    c.write('docs/shared.md', '공유\n')
    c.write('.omc/orch/specs/spec-a.md', 'x\n')
    symlinkSync('../../../docs/shared.md', join(c.repo, '.omc/orch/specs/shared.md'))
    symlinkSync('spec-a.md', join(c.repo, '.omc/orch/specs/alias.md'))
    await c.migrate(['--apply'])
    assert.equal(readFileSync(join(c.repo, '.orch/specs/shared.md'), 'utf8'), '공유\n')
    assert.equal(readFileSync(join(c.repo, '.orch/specs/alias.md'), 'utf8'), 'x\n')
    assert.equal(readlinkSync(join(c.repo, '.orch/specs/alias.md')), 'spec-a.md')
  })

  test('추적하지 않는 .claude 파일은 알리고 worktrees 아래는 보지 않는다', async (t) => {
    const c = setup(t)
    c.write('.claude/settings.local.json', '{"allow": ["Bash(.omc/orch/scripts/gate.sh)"]}')
    c.write('.claude/worktrees/x/notes.md', '.omc/orch/scripts/gate.sh\n')
    c.write('.omc/orch/scripts/gate.sh', 'x\n')
    const { stdout } = await c.migrate([])
    assert.ok(stdout.includes('옛 경로 참조 .claude/settings.local.json:1:'), stdout)
    assert.ok(!stdout.includes('worktrees'), stdout)
  })

  test('pgrep 을 돌리지 못하면 --apply 를 막는다', async (t) => {
    const c = setup(t)
    c.write('.omc/handoffs/specs/spec-a.md', 'x\n')
    const { stderr } = await c.migrate(['--apply'], { code: 3, env: { FAKE_PGREP_FAILS: '1' } })
    assert.ok(stderr.includes('pgrep 으로 머지 큐와 마무리 프로세스를 확인하지 못했다'), stderr)
  })

  test('orch 작업 폴더가 옛 위치 안이면 거부한다', async (t) => {
    const c = setup(t)
    c.write('.omc/orch/specs/spec-a.md', 'x\n')
    const { stderr } = await c.migrate(['--apply'], { code: 2, env: { ORCH_DIR: '.omc/orch/new' } })
    assert.ok(stderr.includes('옛 위치 .omc/orch 안이다'), stderr)
  })

  test('옮길 것이 없다', async (t) => {
    const c = setup(t)
    const { stdout } = await c.migrate([])
    assert.equal(stdout, '옮길 것이 없다\n')
  })

  test('틀린 --move 쌍은 사용법 오류다', async (t) => {
    const c = setup(t)
    for (const pair of ['no-equals', '/abs=.orch/x', '.git/x=.orch/x', '.=.orch/x', '.omc/a=.omc/a/b', ' =.orch/x']) {
      await c.migrate(['--move', pair], { code: 2 })
    }
  })
})

// ---- --hooks ------------------------------------------------------------------------------------------

function writeConfig(c: Ctx, config: unknown): string {
  return c.write('.orch/config.json', `${JSON.stringify(config, null, 2)}\n`)
}

function hookPath(c: Ctx, event: string): string {
  return join(c.repo, '.orch/hooks', `${event}.ts`)
}

// 받은 인자를 log 에 JSON 한 줄로 적는 업무 완료 명령. 핸들러가 환경을 바꾸지 않아도 되게 기록 경로를 파일에 박는다
function taskCli(c: Ctx): { path: string; calls: () => string[][] } {
  const log = join(c.tmp, 'task-cli.jsonl')
  const path = writeNodeBin(c.tmp, 'task-cli', `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`)
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line)
          .map((line) => JSON.parse(line) as string[])
      : []
  return { path, calls }
}

const PR = {
  number: 101,
  title: '[PROJ-123] 기능',
  branch: 'feat/x',
  head: 'a'.repeat(40),
  author: 'me',
  draft: false,
  url: 'https://github.example.com/owner/repo/pull/101',
}

async function fireIn(c: Ctx, event: string, input: Record<string, unknown>, cwd?: string) {
  const lines: string[] = []
  const result = await fire(event, input, { repo: c.repo, base: 'main', run: null, cwd, out: (line) => lines.push(line) })
  return { result, lines }
}

describe('migrate-orch-dir --hooks', { concurrency: 4 }, () => {
  test('미리보기는 핸들러를 쓰지 않고 설정을 바꾸지 않는다', async (t) => {
    const c = setup(t)
    const config = writeConfig(c, { queue: { before: 'echo hi', after_merged: './bin/deploy.sh' } })
    const before = readFileSync(config, 'utf8')
    const { stdout } = await c.migrate(['--hooks'])
    assert.ok(stdout.includes('만들 핸들러 .orch/hooks/before-merge.ts <- queue.before'), stdout)
    assert.ok(stdout.includes('만들 핸들러 .orch/hooks/after-queue.ts <- queue.after_merged'), stdout)
    assert.ok(stdout.includes('설정에서 지울 키 queue.before'), stdout)
    assert.equal(readFileSync(config, 'utf8'), before)
    assert.ok(!existsSync(join(c.repo, '.orch/hooks')))
  })

  test('queue.before 를 옮긴 before-merge.ts 는 옛 명령에 PR 과 BRANCH 를 넘기고 설정에서 그 키를 지운다', async (t) => {
    const c = setup(t)
    const got = join(c.tmp, 'before.txt')
    const command = `printf '%s|%s|%s|%s|%s\\n' "$PR" "$BRANCH" "$OWNER" "$REPO" "$GH_HOST" > '${got}'`
    const config = writeConfig(c, { queue: { required: ['test'], before: command, verify_merged_when: 'code' }, finish: { run: 'run_x' } })
    const { stdout } = await c.migrate(['--hooks', '--apply'])
    assert.ok(stdout.includes('핸들러를 만듦 .orch/hooks/before-merge.ts <- queue.before'), stdout)
    assert.ok(readFileSync(hookPath(c, 'before-merge'), 'utf8').startsWith('// migrate-orch-dir --hooks 가 `queue.before` 에서 만들었다.'))
    assert.deepEqual(readJson(config), { queue: { required: ['test'], verify_merged_when: 'code' }, finish: { run: 'run_x' } })

    const { result } = await fireIn(c, 'before-merge', { pr: PR, owner: 'owner', name: 'repo', last_of_task: false })
    assert.equal(result.result, 'pass', result.reason)
    assert.equal(readFileSync(got, 'utf8'), '101|feat/x|owner|repo|github.example.com\n')
  })

  test('만든 핸들러는 연결된 워크트리를 repo 로 받으면 옛 명령을 그 워크트리에서 부른다', async (t) => {
    const c = setup(t)
    const wt = join(c.tmp, 'wt')
    c.sh('git', '-C', c.repo, 'worktree', 'add', '-q', '-b', 'wt', wt)
    const before = join(c.tmp, 'before.txt')
    const after = join(c.tmp, 'after.txt')
    const deploy = join(c.tmp, 'deploy.txt')
    // 업무 완료 명령은 셸 없이 돌아 pwd 를 쓸 수 없다. 작업 디렉터리를 적는 명령으로 본다
    const cwdCli = writeNodeBin(c.tmp, 'cwd-cli', `require('node:fs').writeFileSync(${JSON.stringify(deploy)}, process.cwd())\n`)
    writeConfig(c, {
      queue: { before: `pwd -P > '${before}'`, after_merged: `pwd -P > '${after}'` },
      finish: { task_pattern: '(PROJ-[0-9]+)', complete_cmd: `${cwdCli} {number}` },
    })
    await c.migrate(['--hooks', '--apply'])
    // 핸들러는 주 checkout 의 .orch/hooks 에 있다. 머지 큐와 finish-pr 이 --repo 로 받은 워크트리를 repo 로 넘기는 경우다
    const fireWt = (event: string, input: Record<string, unknown>) => fire(event, input, { repo: wt, base: 'main', run: null, out: () => {} })
    assert.equal((await fireWt('before-merge', { pr: PR, owner: 'owner', name: 'repo', last_of_task: false })).result, 'pass')
    assert.equal((await fireWt('after-queue', { merged_prs: [101], code_prs: [101], held_prs: [] })).result, 'pass')
    assert.equal((await fireWt('after-deploy', { pr: PR, merge_commit: 'c'.repeat(40), deploy: 'success', last_of_task: true })).result, 'pass')
    assert.equal(readFileSync(before, 'utf8').trim(), wt)
    assert.equal(readFileSync(after, 'utf8').trim(), wt)
    assert.equal(readFileSync(deploy, 'utf8'), wt)
  })

  test('옛 명령이 stdin 을 읽지 않고 끝나도 그 종료 코드로 끝난다', async (t) => {
    const c = setup(t)
    writeConfig(c, { queue: { before: 'exit 0' } })
    await c.migrate(['--hooks', '--apply'])
    // 입력이 파이프 버퍼보다 커서 옛 명령이 먼저 끝나면 핸들러의 쓰기가 반드시 EPIPE 를 만난다
    const pr = { ...PR, title: 'x'.repeat(1 << 20) }
    const { result } = await fireIn(c, 'before-merge', { pr, owner: 'owner', name: 'repo', last_of_task: false })
    assert.equal(result.result, 'pass', result.reason)
  })

  test('옛 명령의 종료 코드를 그대로 낸다', async (t) => {
    const c = setup(t)
    writeConfig(c, { queue: { before: 'echo 백업할 DB 가 없다; exit 10' } })
    await c.migrate(['--hooks', '--apply'])
    const { result, lines } = await fireIn(c, 'before-merge', { pr: PR, owner: 'owner', name: 'repo', last_of_task: false })
    assert.equal(result.result, 'reject')
    assert.ok(lines.includes('HOOK-REJECT before-merge 백업할 DB 가 없다'), lines.join('\n'))
  })

  test('verify-merged.ts 는 사본에서 사본 경로와 파일 목록을 받고, after-queue.ts 는 머지한 PR 을 받는다', async (t) => {
    const c = setup(t)
    const got = join(c.tmp, 'verify.txt')
    const queued = join(c.tmp, 'after.txt')
    writeConfig(c, {
      queue: {
        verify_merged: `{ printf '%s\\n' "$1" "$MERGE_COPY" "$PWD" "$PR_HEAD" "$BASE_HEAD" "$CHANGED_FILES" "$OVERLAP_FILES"; } > '${got}'`,
        after_merged: `printf '%s|%s\\n' "$MERGED_PRS" "$CODE_PRS" > '${queued}'`,
      },
    })
    await c.migrate(['--hooks', '--apply'])
    const copy = join(c.tmp, 'copy')
    mkdirSync(copy)
    const input = { pr: PR, copy, base_head: 'b'.repeat(40), changed_files: ['a.ts', 'b.ts'], overlap_files: ['a.ts'] }
    const verify = await fireIn(c, 'verify-merged', input, copy)
    assert.equal(verify.result.result, 'pass')
    assert.equal(readFileSync(got, 'utf8'), [copy, copy, copy, 'a'.repeat(40), 'b'.repeat(40), 'a.ts', 'b.ts', 'a.ts', ''].join('\n'))
    const queue = await fireIn(c, 'after-queue', { merged_prs: [101, 102], code_prs: [102], held_prs: [] })
    assert.equal(queue.result.result, 'pass')
    assert.equal(readFileSync(queued, 'utf8'), '101 102|102\n')
  })

  test('after-deploy.ts 는 마지막 PR 의 배포가 성공했을 때만 번호를 바꾼 인자로 옛 명령을 부른다', async (t) => {
    const c = setup(t)
    const cli = taskCli(c)
    const config = writeConfig(c, { finish: { run: 'run_x', task_pattern: '(?P<n>PROJ-[0-9]+)', complete_cmd: `${cli.path} complete {number} 'note {number}'` } })
    await c.migrate(['--hooks', '--apply'])
    assert.deepEqual(readJson(config), { finish: { run: 'run_x' } })

    const done = await fireIn(c, 'after-deploy', { pr: PR, merge_commit: 'c'.repeat(40), deploy: 'success', last_of_task: true })
    assert.equal(done.result.result, 'pass')
    assert.deepEqual(cli.calls(), [['complete', 'PROJ-123', 'note PROJ-123']])

    const failed = await fireIn(c, 'after-deploy', { pr: PR, merge_commit: 'c'.repeat(40), deploy: 'failure', last_of_task: true })
    assert.equal(failed.result.result, 'pass')
    const middle = await fireIn(c, 'after-deploy', { pr: PR, merge_commit: 'c'.repeat(40), deploy: 'none', last_of_task: false })
    assert.equal(middle.result.result, 'pass')
    assert.equal(cli.calls().length, 1, '배포 실패와 중간 PR 에서는 부르지 않아야 한다')
  })

  test('after-deploy.ts 는 번호가 없거나 안전하지 않으면 부르지 않고 1 로 끝난다', async (t) => {
    const c = setup(t)
    const cli = taskCli(c)
    writeConfig(c, { finish: { task_pattern: '(PROJ-\\S+)', complete_cmd: `${cli.path} complete {number}` } })
    await c.migrate(['--hooks', '--apply'])
    for (const title of ['PROJ-1;rm 기능', '번호 없는 제목']) {
      const { result, lines } = await fireIn(c, 'after-deploy', { pr: { ...PR, title }, merge_commit: null, deploy: 'none', last_of_task: true })
      assert.equal(result.result, 'fail', title)
      assert.equal(result.code, 1, title)
      assert.ok(lines.includes('HOOK-FAIL after-deploy 1'), lines.join('\n'))
    }
    assert.deepEqual(cli.calls(), [])
  })

  test('JS 정규식으로 바꿀 수 없는 task_pattern 은 옮기지 않고 설정에 남긴다', async (t) => {
    const c = setup(t)
    const finish = { task_pattern: '(?i)proj-(\\d+)', complete_cmd: 'task-cli complete {number}' }
    const config = writeConfig(c, { queue: { before: 'echo hi' }, finish })
    const { stdout } = await c.migrate(['--hooks', '--apply'], { code: 1 })
    assert.ok(stdout.includes('옮기지 못함 finish.complete_cmd, finish.task_pattern'), stdout)
    assert.ok(stdout.includes('"(?i)proj-(\\\\d+)"'), stdout)
    assert.ok(stdout.includes('JS 정규식으로 고쳐 task_pattern 에 다시 적고 다시 돌린다'), stdout)
    assert.ok(!existsSync(hookPath(c, 'after-deploy')))
    assert.deepEqual(readJson(config), { queue: {}, finish })
    assert.ok(existsSync(hookPath(c, 'before-merge')), '옮길 수 있는 칸은 옮긴다')
  })

  test('핸들러 파일이 이미 있으면 덮지 않고 1 이다', async (t) => {
    const c = setup(t)
    const config = writeConfig(c, { queue: { before: 'echo hi' } })
    const mine = c.write('.orch/hooks/before-merge.ts', '// 저장소가 쓴 핸들러\n')
    const { stdout } = await c.migrate(['--hooks', '--apply'], { code: 1 })
    assert.ok(stdout.includes('겹침 .orch/hooks/before-merge.ts 이 이미 있다. queue.before 를 옮기지 않았다'), stdout)
    assert.equal(readFileSync(mine, 'utf8'), '// 저장소가 쓴 핸들러\n')
    assert.deepEqual(readJson(config), { queue: { before: 'echo hi' } })
  })

  test('옛 위치에 설정이 남아 있으면 아무것도 쓰지 않고 2 다', async (t) => {
    const c = setup(t)
    c.write('.claude/orch-finish.json', JSON.stringify({ queue: { before: 'echo hi' } }))
    const config = writeConfig(c, { queue: { before: 'echo hi' } })
    const { stderr } = await c.migrate(['--hooks', '--apply'], { code: 2 })
    assert.ok(stderr.includes('먼저 --hooks 없이 --apply 로 폴더를 옮긴다'), stderr)
    assert.ok(!existsSync(join(c.repo, '.orch/hooks')))
    assert.deepEqual(readJson(config), { queue: { before: 'echo hi' } })
  })

  test('머지 큐가 돌면 --hooks --apply 도 막는다', async (t) => {
    const c = setup(t)
    const config = writeConfig(c, { queue: { before: 'echo hi' } })
    const line = '11 node --disable-warning=ExperimentalWarning /skill/scripts/merge_queue.ts 101'
    const { stderr } = await c.migrate(['--hooks', '--apply'], { code: 3, env: { FAKE_PS: line } })
    assert.ok(stderr.includes(`막음 머지 큐나 마무리가 돌고 있다: ${line}`), stderr)
    assert.ok(!existsSync(hookPath(c, 'before-merge')))
    assert.deepEqual(readJson(config), { queue: { before: 'echo hi' } })
  })

  test('설정이나 hooks 를 git 이 추적하면 git add -f 명령을 보인다', async (t) => {
    const c = setup(t)
    writeConfig(c, { queue: { after_merged: './bin/deploy.sh' } })
    c.sh('git', '-C', c.repo, 'add', '-f', '.orch/config.json')
    c.sh('git', '-C', c.repo, 'commit', '-q', '-m', 'config')
    const { stdout } = await c.migrate(['--hooks', '--apply'])
    assert.ok(stdout.includes(`추적 파일 git -C ${c.repo} add -f .orch/hooks/after-queue.ts .orch/config.json`), stdout)
    assert.ok(!c.sh('git', '-C', c.repo, 'status', '--porcelain').includes('A '), '스테이징하지 않아야 한다')
  })

  test('옮길 칸이 없으면 0 이다', async (t) => {
    const c = setup(t)
    assert.equal((await c.migrate(['--hooks'])).stdout, '옮길 칸이 없다\n')
    writeConfig(c, { queue: { required: ['test'], verify_merged_when: 'code' } })
    assert.equal((await c.migrate(['--hooks', '--apply'])).stdout, '옮길 칸이 없다\n')
  })

  test('--move 와 함께 주면 사용법 오류다', async (t) => {
    const c = setup(t)
    await c.migrate(['--hooks', '--move', '.omc/x=.orch/x'], { code: 2 })
  })
})
