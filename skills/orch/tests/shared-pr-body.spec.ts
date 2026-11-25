import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOK = new URL('../hooks/block-shared-pr-body.ts', import.meta.url)
const ORCH = new URL('../bin/orch.ts', import.meta.url)
const SCRIPTS = new URL('../scripts/', import.meta.url)

test('orch paths tmp 는 호출마다 다른 폴더를 만든다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orch-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const create = () => {
    const r = spawnSync(process.execPath, [fileURLToPath(ORCH), 'paths', 'tmp'], {
      cwd: root, env: { ...process.env, TMPDIR: root, ORCH_SCRIPTS_DIR: fileURLToPath(SCRIPTS) }, encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    const directory = r.stdout.trim()
    assert.equal(dirname(directory), root)
    assert.ok(statSync(directory).isDirectory())
    assert.equal(statSync(directory).mode & 0o077, 0)
    return directory
  }
  assert.notEqual(create(), create())
})

test('Bash 훅은 공유 임시 폴더 바로 아래의 PR 본문만 막는다', () => {
  const invoke = (command: string) => {
    const r = spawnSync(process.execPath, [fileURLToPath(HOOK)], {
      env: { ...process.env, TMPDIR: '/tmp/shared temp' }, encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  for (const command of [
    'gh pr create --body-file "$TMPDIR/pr-body.md"',
    'git status && gh pr edit 42 --body-file="${TMPDIR}"/body.md',
    'gh pr edit -F "/tmp/shared temp/pr-body.md"',
    'gh pr create -F/tmp/body.md',
    'gh pr edit 42 -F"$TMPDIR/pr-body.md"',
    'gh pr create --body-file /tmp/body.md',
    ...(process.platform === 'darwin' ? ['gh pr create --body-file /private/tmp/body.md'] : []),
    'gh pr create \\\n --body-file /tmp/body.md',
  ]) {
    const output = JSON.parse(invoke(command)).hookSpecificOutput
    assert.equal(output.permissionDecision, 'deny', command)
    assert.match(output.permissionDecisionReason, /orch paths tmp/)
  }
  for (const command of [
    'gh pr create --body-file "$scratch/pr-body.md"',
    'gh pr create -F"$TMPDIR/orch-abcdef/pr-body.md"',
    'gh pr edit --body-file "$TMPDIR/orch-abcdef/pr-body.md"',
    'gh pr create --body-file -',
    'gh pr edit --base main',
    'gh pr create --title "사용법 --body-file /tmp/body.md"',
    'echo "gh pr edit --body-file /tmp/body.md"',
    "gh pr create --body-file '\$TMPDIR/body.md'",
    'orca orchestration send --body-file /tmp/body.md',
  ]) assert.equal(invoke(command), '', command)
})

test('PR 본문 검사를 Bash 훅에 등록한다', () => {
  const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  assert.ok(config.hooks.PreToolUse.some((entry) =>
    entry.matcher === 'Bash' && entry.hooks.some((hook) => hook.command.includes('block-shared-pr-body.ts'))))
})
