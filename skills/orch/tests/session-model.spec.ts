// 띄운 worker 의 Claude 세션에서 실제 모델 ID 를 읽는다(scripts/lib/session-tokens.ts 의 claudeModelOf).
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { claudeModelOf, claudeProjectName } from '../scripts/lib/session-tokens.ts'

let tmp: string
let saved: NodeJS.ProcessEnv
let project: string
let worktree: string
const since = Date.parse('2026-11-20T10:00:00Z')
const at = (ms: number) => new Date(since + ms).toISOString()

beforeEach(() => {
  tmp = tempDir('session-model-')
  saved = { ...process.env }
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'home')
  process.env.ORCA_CLAUDE_PROFILES = join(tmp, 'no-profiles')
  worktree = join(tmp, 'wt')
  mkdirSync(worktree)
  project = join(tmp, 'home', 'projects', claudeProjectName(worktree))
  mkdirSync(project, { recursive: true })
})
afterEach(() => { process.env = saved })

function session(name: string, start: number, model: string, answered = start + 1000): void {
  const file = join(project, `${name}.jsonl`)
  writeFileSync(file, [JSON.stringify({ type: 'user', timestamp: at(start) }), JSON.stringify({ type: 'assistant', timestamp: at(answered), message: { model } })].join('\n') + '\n')
  const touched = new Date(since + 120_000)
  utimesSync(file, touched, touched)
}

test('띄우기 뒤에 시작한 세션의 모델을 읽고, 띄우기 뒤에 갱신된 옛 세션은 보지 않는다', () => {
  // 옛 세션은 한 시간 전에 시작했고 띄우기 뒤에 Opus 5.5 응답이 더해졌다
  session('old', -3_600_000, 'claude-opus-5-5', 30_000)
  session('new', 10_000, 'claude-opus-5-6')
  assert.equal(claudeModelOf(worktree, since), 'claude-opus-5-6')
})

test('띄우기 뒤에 시작한 세션이 둘이면 어느 것이 이 worker 인지 몰라 null 이다', () => {
  session('a', 10_000, 'claude-opus-5-6')
  session('b', 20_000, 'claude-opus-5-5')
  assert.equal(claudeModelOf(worktree, since), null)
})

test('응답이 아직 없거나 가짜 응답만 있으면 null 이다', () => {
  session('new', 10_000, '<synthetic>')
  assert.equal(claudeModelOf(worktree, since), null)
})
