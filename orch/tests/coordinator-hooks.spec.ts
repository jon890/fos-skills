// cd 뒤 git 쓰기, worker 터미널 직접 send, spec-line 이 아닌 --spec 을 hook 이 거부하는지 본다.
//
// 각 hook 의 오탐 기준(머리 주석의 「오탐을 피하는 기준」)마다 통과 사례를 둔다.
// worker 터미널 send hook 은 머리 주석의 「worker 판정 범위」 단계마다, 그리고 조회 실패와 시간 한도마다 사례를 둔다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url))

let root: string
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-hooks-')))
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

type HookRun = { code: number | null; stdout: string; stderr: string; ms: number }

// 가짜 orca 의 #! 줄이 PATH 의 node 를 고르므로 PATH 맨 앞에 이 테스트의 node 폴더를 둔다.
function runHook(hook: string, input: string, env: Record<string, string> = {}): HookRun {
  const merged: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
  delete merged.ORCH_SEND_HOOK_BUDGET_MS
  Object.assign(merged, env)
  const started = Date.now()
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(HOOKS, hook)], {
    input,
    env: merged,
    encoding: 'utf8',
    timeout: 20_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr, ms: Date.now() - started }
}

function verdict(hook: string, command: string, env: Record<string, string> = {}, tool = 'Bash') {
  const r = runHook(hook, JSON.stringify({ tool_name: tool, tool_input: { command } }), env)
  assert.equal(r.code, 0, `종료 코드 ${r.code}: ${r.stderr}`)
  if (!r.stdout.trim()) return { decision: 'pass', reason: '', ms: r.ms }
  const out = JSON.parse(r.stdout).hookSpecificOutput
  return { decision: out.permissionDecision as string, reason: out.permissionDecisionReason as string, ms: r.ms }
}

function decide(hook: string, command: string, env: Record<string, string> = {}, tool = 'Bash'): string {
  return verdict(hook, command, env, tool).decision
}

describe('block-git-after-cd', () => {
  const HOOK = 'block-git-after-cd.ts'

  test('; 나 줄바꿈 뒤 cd 다음의 git 쓰기는 거부한다', () => {
    for (const command of [
      'cd worktrees/x; git merge origin/main',
      'cd worktrees/x\ngit commit -m wip',
      'cd /repo && git fetch; git push -u origin HEAD',
      'cd /repo || true; git reset --hard origin/main',
      'cd /repo & git rebase origin/main',
      'cd /repo; git -c core.editor=true rebase --continue',
      'cd /r; (git commit -m x)',
      'for d in a b; do cd $d; git commit -m x; done',
      'pushd /r; git push',
      'cd /r; git commit -m x; set -e',
      'cd /r && make; git push',
    ]) {
      assert.equal(decide(HOOK, command), 'deny', command)
    }
  })

  test('안전한 꼴은 통과한다', () => {
    for (const command of [
      'cd /repo && git merge origin/main && git push',
      'git -C /repo merge origin/main; git -C /repo push',
      'cd /repo || exit 1; git commit -m x',
      'cd /repo || return\ngit push',
      'set -euo pipefail\ncd /repo\ngit commit -m x',
      '(cd /repo && git commit -m x); ls',
      'cd /repo; git status; git log --oneline -3',
      "git commit -m 'cd x; git push 를 고친다'",
      'git commit -m "$(cat <<\'EOF\'\nfix: cd a\ngit push\nEOF\n)"',
      "cat > /tmp/x.sh <<'EOF'\ncd /repo\ngit push\nEOF",
      'git push origin HEAD',
      // 리뷰에서 재현한 오탐: 리다이렉션의 &, 연산자 뒤 줄바꿈, subshell, 중괄호 가드, 읽기 명령, 주석
      'cd /r && make 2>&1 && git commit -m x',
      'cd /r && npm test >/dev/null 2>&1 && git push',
      'cd /r && make &> log && git commit -m x',
      'cd /r &&\n  git add . &&\n  git commit -m x',
      '(cd /r && make); git commit -m x',
      '(cd /r && make)\ngit push',
      'cd /r || { echo fail; exit 1; }\ngit commit -m x',
      'cd /r || { exit 1; }\ngit push',
      'cd /r; git merge-base --is-ancestor a b',
      'cd /r; git merge-tree --write-tree a b',
      'set -o errexit\ncd /r\ngit commit -m x',
      'cd /r && git status  # check; git push later',
      'cd "$WT" && git commit -m "$(cat <<\'EOF\'\nfix: x\nEOF\n)"',
      'x=$((1<<2)); git -C /r push',
    ]) {
      assert.equal(decide(HOOK, command), 'pass', command)
    }
  })

  test('here-string 과 시프트는 뒤 명령을 가리지 않는다', () => {
    for (const command of ['echo $((1<<2))\ncd /r; git push', 'grep x <<< word\ncd /r; git push']) {
      assert.equal(decide(HOOK, command), 'deny', command)
    }
  })

  test('다른 도구와 읽지 못한 입력은 통과한다', () => {
    assert.equal(decide(HOOK, 'cd x; git push', {}, 'Read'), 'pass')
    const r = runHook(HOOK, 'not json')
    assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: '' })
  })
})

// 가짜 orca 응답. worker-list 는 scope 와 page 를 함께 낸다.
const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
const workerList = (rows: { handle: string; dispatch?: string }[], source: string, next?: string) =>
  envelope({
    workers: rows.map((r) => ({ agentTerminalHandle: r.handle, dispatchId: r.dispatch ?? null, terminalState: 'active' })),
    scope: { source },
    page: next ? { nextCursor: next } : { nextCursor: null },
  })
const terminalShow = (agentIdentity: string | null) => envelope({ terminal: { handle: 'term_x', agentIdentity } })
const runList = (ids: string[], next?: string) =>
  envelope({ runs: ids.map((id, i) => ({ id, updated_at: `2026-10-2${i}T00:00:00Z` })), nextCursor: next ?? null })

const WORKER = { handle: 'term_worker-1', dispatch: 'ctx_1' }
// 묶인 Run 에 term_worker-1 이 있고, 다른 터미널은 에이전트가 없는 셸이다
const BASE_RULES: FakeRule[] = [
  { args: ['terminal', 'show'], stdout: terminalShow(null) },
  { args: ['worker-list'], stdout: workerList([WORKER], 'bound') },
]

function fakeOrca(rules: FakeRule[]): FakeBin {
  const dir = mkdtempSync(join(root, 'orca-'))
  return fakeBin(dir, 'orca', rules, { recordEnv: ['ORCA_TERMINAL_HANDLE'] })
}

// 부를 때마다 잠드는 가짜. ignoreTerm 이면 TERM 을 무시한다(exec 한 sleep 도 무시를 물려받는다).
// 잠은 아래 단언의 5초보다 길다. hook 이 자식을 기다리면 단언이 실패한다. 남은 sleep 은 pid 파일로 찾아 끈다.
function sleepingOrca(ignoreTerm: boolean): { bin: string; kill: () => void } {
  const dir = mkdtempSync(join(root, 'sleep-'))
  const bin = join(dir, 'orca')
  const pids = join(dir, 'pids')
  writeFileSync(bin, `#!/bin/sh\n${ignoreTerm ? "trap '' TERM\n" : ''}echo $$ >> '${pids}'\nexec sleep 8\n`)
  chmodSync(bin, 0o755)
  const kill = () => {
    if (!existsSync(pids)) return
    for (const pid of readFileSync(pids, 'utf8').split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // 이미 끝났다
      }
    }
  }
  return { bin, kill }
}

const sendEnv = (orca: string, extra: Record<string, string> = {}) => ({ ORCA: orca, ORCA_TERMINAL_HANDLE: 'term_coordinator', ...extra })
const argvs = (fake: FakeBin) => fake.calls().map((c) => c.argv.join(' '))

describe('block-worker-terminal-send', () => {
  const HOOK = 'block-worker-terminal-send.ts'

  test('묶인 Run 의 worker 터미널로 보내면 거부하고 send-to-worker 를 안내한다', () => {
    const fake = fakeOrca(BASE_RULES)
    for (const command of [
      'orca terminal send --terminal term_worker-1 --text "main 을 합쳐라" --enter',
      'orca terminal send --terminal=term_worker-1 --text x',
    ]) {
      const v = verdict(HOOK, command, sendEnv(fake.path))
      assert.equal(v.decision, 'deny', command)
      assert.match(v.reason, /term_worker-1/)
      assert.match(v.reason, /send-to-worker/)
      assert.match(v.reason, /nudge-worker/)
    }
    // 범위를 바꾸려고 ORCA_TERMINAL_HANDLE 을 빼지 않는다
    const handles = fake.calls().map((c) => c.env.ORCA_TERMINAL_HANDLE)
    assert.ok(handles.length > 0)
    assert.deepEqual(new Set(handles), new Set(['term_coordinator']))
  })

  test('worker 가 아닌 터미널과 send 가 아닌 명령은 통과한다', () => {
    const fake = fakeOrca(BASE_RULES)
    for (const command of [
      "orca terminal send --terminal term_dev-server --text 'npm run dev' --enter",
      'orca terminal read --terminal term_worker-1',
      'python3 "$SKILL_DIR/scripts/send-to-worker.py" --dispatch ctx_1 --body x',
      'orca terminal read --terminal term_worker-1 --lines 20 && orca terminal send --terminal term_dev --text hi',
      'orca terminal send --terminal term_dev --text "see --terminal term_worker-1"',
    ]) {
      assert.equal(decide(HOOK, command, sendEnv(fake.path)), 'pass', command)
    }
  })

  test('따옴표 안의 문구는 orca 를 조회하지 않고 통과한다', () => {
    const fake = fakeOrca(BASE_RULES)
    assert.equal(decide(HOOK, "git commit -m 'orca terminal send --terminal term_worker-1'", sendEnv(fake.path)), 'pass')
    assert.deepEqual(argvs(fake), [])
  })

  test('대상이 변수나 명령 치환이면 조회 없이 거부한다', () => {
    const fake = fakeOrca(BASE_RULES)
    for (const command of [
      'orca terminal send --terminal "$T" --text x',
      'orca terminal send --terminal $(cat handle) --text x',
      'orca terminal send --terminal "term_$X" --text x',
      'orca terminal send --terminal "$T" --enter',
    ]) {
      const v = verdict(HOOK, command, sendEnv(fake.path))
      assert.equal(v.decision, 'deny', command)
      assert.match(v.reason, /handle 을 그대로 적어 다시 부른다/)
      assert.match(v.reason, /첫 화면 승인/)
    }
    assert.deepEqual(argvs(fake), [])
  })

  test('--terminal 이 없으면 거부한다', () => {
    const fake = fakeOrca(BASE_RULES)
    const v = verdict(HOOK, 'orca terminal send --text x --enter', sendEnv(fake.path))
    assert.equal(v.decision, 'deny')
    assert.match(v.reason, /--terminal/)
  })

  test('--environment 나 --pairing-code 로 원격에 보내면 거부한다', () => {
    const fake = fakeOrca(BASE_RULES)
    for (const command of [
      'orca terminal send --environment srv --terminal term_abc --text x',
      "orca terminal send --pairing-code 'orca://pair?x' --terminal term_abc --text x",
    ]) {
      const v = verdict(HOOK, command, sendEnv(fake.path))
      assert.equal(v.decision, 'deny', command)
      assert.match(v.reason, /원격 서버/)
      assert.match(v.reason, /그 서버의 셸/)
    }
  })

  test('조회 응답이 잘못되면 거부한다', () => {
    for (const [name, rule] of [
      ['workers 가 null', { args: ['worker-list'], stdout: envelope({ workers: null, scope: { source: 'all' } }) }],
      ['JSON 이 아니고 종료 코드 1', { args: ['worker-list'], stdout: 'not json', code: 1 }],
      ['JSON 이 아니고 종료 코드 0', { args: ['worker-list'], stdout: 'not json' }],
    ] as const) {
      const fake = fakeOrca([rule])
      const v = verdict(HOOK, 'orca terminal send --terminal term_worker-1 --text x', sendEnv(fake.path))
      assert.equal(v.decision, 'deny', name)
      assert.match(v.reason, /조회가 실패했다/, name)
      assert.match(v.reason, /handle 을 그대로 적어 다시 부른다/, name)
    }
  })

  test('scope 가 all 이면 worker-list 다음 페이지까지 읽고 run-list 는 부르지 않는다', () => {
    const fake = fakeOrca([
      { args: ['worker-list', '--cursor', 'w2'], stdout: workerList([{ handle: 'term_far', dispatch: 'ctx_9' }], 'all') },
      { args: ['worker-list'], stdout: workerList([WORKER], 'all', 'w2') },
      { args: ['run-list'], stdout: runList(['run_a']) },
    ])
    assert.equal(decide(HOOK, 'orca terminal send --terminal term_far --text x', sendEnv(fake.path)), 'deny')
    assert.ok(argvs(fake).some((a) => a.includes('worker-list') && a.includes('--cursor w2')), argvs(fake).join('\n'))
    assert.ok(!argvs(fake).some((a) => a.includes('run-list')), argvs(fake).join('\n'))
    // all 범위에 없는 터미널은 worker 가 아니다. terminal show 도 부르지 않는다
    const other = fakeOrca([{ args: ['worker-list'], stdout: workerList([WORKER], 'all') }])
    assert.equal(decide(HOOK, 'orca terminal send --terminal term_dev --text x', sendEnv(other.path)), 'pass')
    assert.deepEqual(argvs(other).filter((a) => !a.includes('worker-list')), [])
  })

  test('bound 범위에 없고 에이전트가 없는 셸이면 run-list 없이 통과한다', () => {
    const fake = fakeOrca([
      { args: ['terminal', 'show'], stdout: terminalShow(null) },
      { args: ['worker-list'], stdout: workerList([], 'bound') },
      { args: ['run-list'], stdout: runList(['run_a']) },
    ])
    assert.equal(decide(HOOK, 'orca terminal send --terminal term_shell --text ls --enter', sendEnv(fake.path)), 'pass')
    assert.ok(argvs(fake).includes('terminal show --terminal term_shell --json'), argvs(fake).join('\n'))
    assert.ok(!argvs(fake).some((a) => a.includes('run-list')), argvs(fake).join('\n'))
  })

  test('bound 범위에 없고 에이전트 터미널이면 run-list 둘째 페이지의 Run 까지 찾아 거부한다', () => {
    const fake = fakeOrca([
      { args: ['terminal', 'show'], stdout: terminalShow('claude') },
      { args: ['run-list', '--cursor', 'r2'], stdout: runList(['run_b']) },
      { args: ['run-list'], stdout: runList(['run_a'], 'r2') },
      { args: ['worker-list', '--run', 'run_b'], stdout: workerList([{ handle: 'term_other', dispatch: 'ctx_b' }], 'flag') },
      { args: ['worker-list', '--run', 'run_a'], stdout: workerList([], 'flag') },
      { args: ['worker-list'], stdout: workerList([], 'bound') },
    ])
    const v = verdict(HOOK, 'orca terminal send --terminal term_other --text x', sendEnv(fake.path))
    assert.equal(v.decision, 'deny')
    assert.match(v.reason, /term_other/)
    const calls = argvs(fake)
    assert.ok(calls.some((a) => a.includes('run-list') && a.includes('--cursor r2')), calls.join('\n'))
    assert.ok(calls.some((a) => a.includes('worker-list --run run_b')), calls.join('\n'))
  })

  test('에이전트 터미널이지만 어느 Run 에도 없으면 통과한다', () => {
    const fake = fakeOrca([
      { args: ['terminal', 'show'], stdout: terminalShow('claude') },
      { args: ['run-list'], stdout: runList(['run_a', 'run_b']) },
      { args: ['worker-list', '--run'], stdout: workerList([{ handle: 'term_someone' }], 'flag') },
      { args: ['worker-list'], stdout: workerList([], 'bound') },
    ])
    assert.equal(decide(HOOK, 'orca terminal send --terminal term_me --text x', sendEnv(fake.path)), 'pass')
    const calls = argvs(fake)
    for (const run of ['run_a', 'run_b']) assert.ok(calls.some((a) => a.includes(`--run ${run}`)), calls.join('\n'))
  })

  test('terminal show 나 run-list 가 실패하면 거부한다', () => {
    for (const [name, rules] of [
      [
        'terminal show 종료 코드 1',
        [
          { args: ['terminal', 'show'], stdout: '', code: 1 },
          { args: ['worker-list'], stdout: workerList([], 'bound') },
        ],
      ],
      [
        'run-list 종료 코드 1',
        [
          { args: ['terminal', 'show'], stdout: terminalShow('codex') },
          { args: ['run-list'], stdout: '', code: 1 },
          { args: ['worker-list'], stdout: workerList([], 'bound') },
        ],
      ],
    ] as const) {
      const fake = fakeOrca([...rules])
      const v = verdict(HOOK, 'orca terminal send --terminal term_x --text x', sendEnv(fake.path))
      assert.equal(v.decision, 'deny', name)
      assert.match(v.reason, /조회가 실패했다/, name)
    }
  })

  test('조회가 시간 한도를 넘기면 거부하고 TERM 을 무시하는 자식도 기다리지 않는다', () => {
    for (const ignoreTerm of [false, true]) {
      const orca = sleepingOrca(ignoreTerm)
      try {
        const v = verdict(HOOK, 'orca terminal send --terminal term_x --text x', sendEnv(orca.bin, { ORCH_SEND_HOOK_BUDGET_MS: '500' }))
        assert.equal(v.decision, 'deny', `ignoreTerm=${ignoreTerm}`)
        assert.match(v.reason, /시간 초과/)
        // 한도 500ms 에 node 기동을 더해도 5초에 못 미친다. 잠든 자식이나 KILL 유예(10초)를 기다리면 넘는다
        assert.ok(v.ms < 5_000, `ignoreTerm=${ignoreTerm}: hook 이 ${v.ms}ms 걸렸다`)
      } finally {
        orca.kill()
      }
    }
  })

  test('남은 시간이 0 이면 orca 를 부르지 않고 거부한다', () => {
    const fake = fakeOrca(BASE_RULES)
    const v = verdict(HOOK, 'orca terminal send --terminal term_worker-1 --text x', sendEnv(fake.path, { ORCH_SEND_HOOK_BUDGET_MS: '0' }))
    assert.equal(v.decision, 'deny')
    assert.match(v.reason, /시간 초과/)
    assert.deepEqual(argvs(fake), [])
  })

  test('다른 도구와 읽지 못한 입력은 통과한다', () => {
    const fake = fakeOrca(BASE_RULES)
    assert.equal(decide(HOOK, 'orca terminal send --terminal term_worker-1 --text x', sendEnv(fake.path), 'Read'), 'pass')
    const r = runHook(HOOK, 'not json', sendEnv(fake.path))
    assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: '' })
  })
})

describe('block-worker-terminal-send 의 첫 화면 승인', () => {
  const HOOK = 'block-worker-terminal-send.ts'
  const ENTER = 'orca terminal send --terminal term_worker-1 --enter'

  const withShow = (show: string, code = 0) =>
    fakeOrca([{ args: ['worker-show'], stdout: show, code }, { args: ['worker-list'], stdout: workerList([WORKER], 'bound') }])

  test('첫 화면 대기에서 --enter 만 보내면 통과한다', () => {
    for (const show of [
      envelope({ observation: { agentWait: { reason: 'agent-trust-workspace' } } }),
      envelope({ projection: { stage: { detail: 'agent-trust-workspace' } } }),
    ]) {
      const fake = withShow(show)
      assert.equal(decide(HOOK, ENTER, sendEnv(fake.path)), 'pass', show)
      assert.equal(decide(HOOK, 'orca terminal send --enter --terminal=term_worker-1', sendEnv(fake.path)), 'pass', show)
      assert.ok(argvs(fake).includes('orchestration worker-show --dispatch ctx_1 --json'), argvs(fake).join('\n'))
    }
  })

  test('첫 화면이어도 본문을 보내면 거부한다', () => {
    const fake = withShow(envelope({ observation: { agentWait: { reason: 'agent-trust-workspace' } } }))
    for (const command of [
      'orca terminal send --terminal term_worker-1 --text "1" --enter',
      'orca terminal send --terminal term_worker-1 --interrupt --enter',
      'orca terminal send --terminal term_worker-1 --enter && orca terminal send --terminal term_worker-1 --text x',
    ]) {
      assert.equal(decide(HOOK, command, sendEnv(fake.path)), 'deny', command)
    }
  })

  test('일하는 단계이거나 단계를 읽지 못하면 거부한다', () => {
    for (const [show, code] of [
      [envelope({ observation: { agentWait: null }, projection: { stage: { detail: 'input_accepted' } } }), 0],
      [envelope({ observation: { status: 'live' } }), 0],
      ['not json', 1],
      [JSON.stringify({ result: null }), 0],
    ] as const) {
      const v = verdict(HOOK, ENTER, sendEnv(withShow(show, code).path))
      assert.equal(v.decision, 'deny', show)
      assert.match(v.reason, /첫 화면 승인이면 handle 을 그대로 적어 다시 부른다/, show)
    }
  })
})

describe('require-spec-line', () => {
  const HOOK = 'require-spec-line.ts'
  const LINE = '지시서 /repo/.orch/specs/spec-a.md 를 끝까지 읽고 수행한다. push 는 허락했다. 못 읽으면 escalation 으로 알린다.'

  test('글자 그대로 넣은 지시 본문은 거부한다', () => {
    for (const command of [
      'orca orchestration worker-start --task t1 --spec "a.ts 를 고치고 PR 을 연다"',
      'orca orchestration worker-start --task t1 --spec /repo/.orch/specs/spec-a.md',
      "orca orchestration worker-start --task t1 --spec '지시서 /repo/spec-a.md 를 읽는다'",
    ]) {
      assert.equal(decide(HOOK, command), 'deny', command)
    }
  })

  test('spec-line 꼴과 실행해야 알 수 있는 값은 통과한다', () => {
    for (const command of [
      `orca orchestration worker-start --task t1 --spec "${LINE}"`,
      `orca orchestration worker-start --task t1 --spec='${LINE}'`,
      'orca orchestration worker-start --task t1 --spec "$LINE"',
      'orca orchestration worker-start --task t1 --spec "$(python3 "$SKILL_DIR/scripts/spec-line.py" "$SPEC")"',
      'python3 "$SKILL_DIR/scripts/launch-worker.py" --spec "$SPEC" --repo /repo --name a -- --task t1',
      'orca orchestration task-create --spec "본문"',
      "git commit -m 'orchestration worker-start --spec 본문 금지'",
      "git commit -F - <<'EOF'\norchestration worker-start --spec 값을 검사한다\nEOF",
      "rg -n 'orchestration worker-start' orch/ | grep -- '--spec x'",
    ]) {
      assert.equal(decide(HOOK, command), 'pass', command)
    }
  })
})

describe('hooks.json', () => {
  test('모든 hook 을 node 로 부르고 timeout 은 10초다', () => {
    const config = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'))
    const hooks: { command: string; timeout: number }[] = config.hooks.PreToolUse.flatMap((e: { hooks: unknown[] }) => e.hooks)
    const scripts = readdirSync(HOOKS).filter((f) => f.endsWith('.ts') && f !== 'shell-text.ts')
    assert.ok(scripts.length > 0)
    for (const script of scripts) {
      const command = `node --disable-warning=ExperimentalWarning "\${CLAUDE_PLUGIN_ROOT}/orch/hooks/${script}"`
      const entry = hooks.find((h) => h.command === command)
      assert.ok(entry, `${script} 를 부르는 명령이 없다: ${hooks.map((h) => h.command).join('\n')}`)
      assert.equal(entry.timeout, 10, script)
    }
    for (const h of hooks) {
      const file = h.command.match(/orch\/hooks\/([^"]+)"/)?.[1] ?? ''
      assert.ok(existsSync(join(HOOKS, file)), `${h.command} 의 파일이 없다`)
    }
  })
})
