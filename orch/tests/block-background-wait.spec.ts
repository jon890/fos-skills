// check --wait 를 셸의 & 나 nohup 으로 띄우는 Bash 호출을 hook 이 거부하는지 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../hooks/block-background-wait.ts', import.meta.url))
const HOOKS_JSON = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url))
const PLUGIN = fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url))

function runHook(input: string) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK], { input, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function decide(command: string, tool = 'Bash'): string {
  const r = runHook(JSON.stringify({ tool_name: tool, tool_input: { command } }))
  assert.equal(r.code, 0, r.stderr)
  if (!r.stdout.trim()) return 'pass'
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision
}

describe('block-background-wait', () => {
  test('셸의 & 나 nohup 으로 띄운 대기는 거부한다', () => {
    for (const command of [
      'orca orchestration check --run "$RUN_ID" --wait --timeout-ms 7000000 --json 2>&1 | grep -v _keepalive &',
      'nohup orca orchestration check --wait --json > /tmp/w.log 2>&1',
      '(orca orchestration check --wait --json > out.json) &',
      'orca orchestration check \\\n  --wait --json &',
      'orca orchestration check --wait --json & disown',
      'python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID" > /tmp/w.out 2>&1 &',
      'nohup python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID"',
      'node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-important.ts" --run r &',
      '"$SKILL_DIR/bin/orch.ts" wait-important --run "$RUN_ID" --loop-repo "$REPO" > /tmp/w.out 2>&1 &',
      'nohup "$SKILL_DIR/bin/orch.ts" wait-important --run "$RUN_ID"',
    ]) {
      assert.equal(decide(command), 'deny', command)
    }
  })

  test('거부 이유는 확장자 없는 명령 이름을 쓴다', () => {
    const r = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'wait-important --run r &' } }))
    const reason: string = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    assert.match(reason, /`wait-important`/)
    assert.doesNotMatch(reason, /wait-important\.py/)
  })

  test('앞에서 기다리거나 하네스 백그라운드로 도는 대기는 통과한다', () => {
    for (const command of [
      'orca orchestration check --run "$RUN_ID" --ack "$D" --wait --types "worker_done" --timeout-ms 7000000 --json 2>&1 | grep -v _keepalive',
      'orca orchestration check --wait --json >/tmp/x 2>&1 && echo done',
      'orca orchestration check --terminal T --json &',
      'echo "orchestration check --wait &"',
      'sleep 5 &',
      'python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID" --ack "$DELIVERY_ID"',
      'python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID" 2>/dev/null && echo woke',
      '"$SKILL_DIR/bin/orch.ts" wait-important --run "$RUN_ID" --ack "$DELIVERY_ID" --loop-repo "$REPO"',
      // heredoc 본문은 명령이 아니다. 문서를 고치는 스크립트에 이 문구가 든 일이 있었다
      "python3 - <<'EOF'\ntext = 'check --wait 를 셸의 & 나 nohup 으로 띄우는 호출'\norchestration check --wait &\nEOF",
    ]) {
      assert.equal(decide(command), 'pass', command)
    }
  })

  test('다른 도구와 읽지 못한 입력은 통과한다', () => {
    assert.equal(decide('orca orchestration check --wait &', 'Write'), 'pass')
    for (const input of ['not json', '']) {
      const r = runHook(input)
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: '' }, `입력 ${JSON.stringify(input)}`)
    }
  })

  test('플러그인 매니페스트가 hooks.json 을 싣고 hooks.json 이 이 hook 을 node 로 부른다', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN, 'utf8'))
    assert.ok(manifest.hooks.includes('./orch/hooks/hooks.json'), JSON.stringify(manifest.hooks))
    const entries = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')).hooks.PreToolUse
    const commands: string[] = entries
      .filter((e: { matcher: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command))
    assert.ok(
      commands.includes('node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/orch/hooks/block-background-wait.ts"'),
      commands.join('\n'),
    )
  })
})
