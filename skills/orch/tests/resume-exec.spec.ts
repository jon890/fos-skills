// 실행기를 자식 프로세스로 돌려 found.json, 출발 신호 대기, launch.sh 를 검증한다. 가짜 기록 폴더만 쓴다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { claudeProjectDir, writeRequest } from '../scripts/lib/resume.ts'
import type { ResumeRequest } from '../scripts/lib/resume.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/resume-exec.ts', import.meta.url))
let root: string, worktree: string, dir: string, view: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'resume-exec-')))
  worktree = join(root, 'wt'); mkdirSync(worktree)
  dir = join(root, 'req'); mkdirSync(dir)
  view = join(root, 'agent view', 'orca-agent-view'); mkdirSync(view, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const orcaEnv = (): Record<string, string> => ({ ORCA_USER_DATA_PATH: join(root, 'orca'), ORCA_WORKSPACE_ID: 'ws::/w', ORCA_WORKTREE_ID: 'ws::/w', ORCA_PANE_KEY: 'pane', ORCA_TERMINAL_HANDLE: 'term_new' })

// 호스트가 Orca 터미널이어도 결과가 같게 ORCA_* 와 기록 폴더 변수를 지운 환경
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('ORCA_') && key !== 'CLAUDE_CONFIG_DIR' && key !== 'CODEX_HOME') env[key] = value
  return { ...env, HOME: join(root, 'home'), ...extra }
}

function request(agent: 'claude' | 'codex', deadlineMs = 10_000, pluginDir: string | null = null): void {
  const req: ResumeRequest = { dispatch: 'ctx_target', worktree, agent, model: 'm1', effort: 'low', pluginDir, goDeadline: Date.now() + deadlineMs, nonce: 'n1' }
  writeRequest(dir, req)
}

function claudeHome(): string {
  const home = join(root, 'claude')
  mkdirSync(claudeProjectDir(home, worktree), { recursive: true })
  writeFileSync(join(claudeProjectDir(home, worktree), 'sess-1.jsonl'), `${JSON.stringify({ cwd: worktree, text: 'Dispatch ID is: ctx_target' })}\n`)
  return home
}

function codexHome(): string {
  const home = join(root, 'codex')
  const now = new Date()
  const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-a.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-9', cwd: worktree } })}\n{"text":"ctx_target"}\n`)
  return home
}

// 실행기를 띄우고 found.json 이 생기면 onFound 를 부른다. 끝나면 종료 코드를 낸다
function exec(env: NodeJS.ProcessEnv, onFound?: () => void): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, dir], { env })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setInterval(() => {
      if (onFound && existsSync(join(dir, 'found.json'))) {
        const fire = onFound
        onFound = undefined
        fire()
      }
    }, 50)
    child.on('exit', (code) => { clearInterval(timer); done({ code, stderr }) })
  })
}

const found = () => JSON.parse(readFileSync(join(dir, 'found.json'), 'utf8'))
const launch = () => readFileSync(join(dir, 'launch.sh'), 'utf8')

test('Claude 세션을 찾고 go 뒤에 claude --resume 줄을 쓴다', async () => {
  request('claude')
  let beforeGo = true
  const r = await exec(cleanEnv({ CLAUDE_CONFIG_DIR: claudeHome(), ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: view, ORCA_TERMINAL_HANDLE: 'term_new' }), () => {
    beforeGo = !existsSync(join(dir, 'launch.sh'))
    writeFileSync(join(dir, 'go'), 'n1')
  })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(beforeGo, 'go 전에 launch.sh 가 있었다')
  assert.deepEqual(found(), { ok: true, session: 'sess-1', home: join(root, 'claude'), terminal: 'term_new' })
  assert.ok(launch().startsWith(`exec 'claude' '--plugin-dir' '${view}'`), launch())
  assert.match(launch(), /'--resume' 'sess-1'\n$/)
})

test('Codex 세션을 찾고 go 뒤에 codex resume 줄을 쓴다. ORCA_* 가 빠지면 3', async () => {
  request('codex')
  const r = await exec(cleanEnv({ CODEX_HOME: codexHome(), ...orcaEnv() }), () => writeFileSync(join(dir, 'go'), 'n1'))
  assert.equal(r.code, 0, r.stderr)
  assert.ok(launch().startsWith("exec 'codex' 'resume' 'thread-9'"), launch())
  rmSync(join(dir, 'launch.sh')); rmSync(join(dir, 'go'))
  const partial: Record<string, string> = { ...orcaEnv() }
  delete partial.ORCA_PANE_KEY
  const missing = await exec(cleanEnv({ CODEX_HOME: codexHome(), ...partial }))
  assert.equal(missing.code, 3)
  assert.equal(found().ok, false)
  assert.ok(!existsSync(join(dir, 'launch.sh')))
})

test('request.json 을 읽지 못하면 2 이고 이유를 found.json 에 남긴다', async () => {
  writeFileSync(join(dir, 'request.json'), '{broken')
  const r = await exec(cleanEnv({}))
  assert.equal(r.code, 2)
  assert.equal(found().ok, false)
  assert.match(found().reason, /요청을 읽지 못했다/)
})

test('세션이 없으면 3 이고 launch.sh 를 쓰지 않는다', async () => {
  request('claude')
  const r = await exec(cleanEnv({ CLAUDE_CONFIG_DIR: join(root, 'empty'), ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: view }))
  assert.equal(r.code, 3)
  assert.equal(found().ok, false)
  assert.match(found().reason, /세션 기록이 없다/)
  assert.ok(!existsSync(join(dir, 'launch.sh')))
})

test('출발 신호 시한이 지나면 4 이고, 다른 실행의 nonce 가 든 go 로는 출발하지 않는다', async () => {
  request('claude', 600)
  const r = await exec(cleanEnv({ CLAUDE_CONFIG_DIR: claudeHome(), ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: view }), () => writeFileSync(join(dir, 'go'), 'other-run'))
  assert.equal(r.code, 4)
  assert.equal(found().ok, true)
  assert.ok(!existsSync(join(dir, 'launch.sh')))
})

test('--plugin-dir 을 정하지 못하면 3, 요청의 값이 있으면 그것을 쓴다', async () => {
  request('claude')
  const r = await exec(cleanEnv({ CLAUDE_CONFIG_DIR: claudeHome() }))
  assert.equal(r.code, 3)
  assert.match(found().reason, /--plugin-dir/)
  rmSync(join(dir, 'found.json'))
  request('claude', 10_000, view)
  const ok = await exec(cleanEnv({ CLAUDE_CONFIG_DIR: claudeHome() }), () => writeFileSync(join(dir, 'go'), 'n1'))
  assert.equal(ok.code, 0, ok.stderr)
  assert.ok(launch().includes(`'--plugin-dir' '${view}'`))
})
