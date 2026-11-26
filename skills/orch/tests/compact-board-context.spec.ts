import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyAdd, emptyFile } from '../scripts/core/approvals.ts'
import { fakeBin, linkBin } from '../../../modules/testkit/fake-bin.ts'
import { git } from '../../../modules/testkit/git.ts'

const hook = fileURLToPath(new URL('../hooks/compact-board-context.ts', import.meta.url))
const run = 'run_test'
const coordinator = 'term_coord'
const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
const current = { args: ['run-current'], stdout: envelope({ run: { id: run, coordinator_handle: coordinator } }) }

function fixture(t: TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'compact-board-context-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, ['init', '-q'])
  const state = join(repo, '.orch', 'state')
  mkdirSync(state, { recursive: true })
  const boardFile = join(repo, '.orch', 'board.json')
  const orca = fakeBin(repo, 'orca', [current])

  function invoke(options: { handle?: string; source?: string; orcaBin?: string } = {}) {
    const env = {
      ...process.env, ORCA: options.orcaBin ?? orca.path, ORCA_TERMINAL_HANDLE: options.handle ?? coordinator,
      ORCA_PANE_KEY: '', ORCH_DIR: join(repo, '.orch'), ORCH_MACHINE_DIR: join(repo, 'machine'),
    }
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: options.source ?? 'compact', cwd: repo }),
      encoding: 'utf8', env, timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr || String(result.error ?? ''))
    assert.equal(result.stderr, '')
    return result.stdout
  }

  return { repo, state, boardFile, orca, invoke }
}

test('compact 이벤트를 코디네이터 문맥에 연결한다', () => {
  const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const entry = config.hooks.SessionStart.find((group: { matcher: string }) => group.matcher === 'compact')
  assert.ok(entry?.hooks.some((handler: { command: string }) => handler.command.includes('compact-board-context.ts')))
})

test('코디네이터에게 남은 단계와 대기 조건, PR, worker, 미답변, 열린 승인을 보여 준다', (t) => {
  const f = fixture(t)
  writeFileSync(f.boardFile, JSON.stringify({ items: [
    { id: 'work', status: 'doing', title: '리뷰 반영', pr: '#321', details: ['✓ 1. 구현 완료', '2. 리뷰 반영'],
      workers: [{ role: 'review', worktree: 'review-tree', dispatch: 'ctx_review', pr: 322, status: 'working' }] },
    { id: 'paused', status: 'wait', title: '배포 확인', worktree: 'legacy-tree', next: [{ text: '1. [wait: 배포 알림 수신] 배포 상태 확인', done: false }] },
    { id: 'done', status: 'done', title: '끝난 항목' },
    { id: 'decide', status: 'decide', title: '다른 상태' },
  ] }))
  const now = new Date()
  const approval = (id: string, targetRun: string) => ({ id, title: '승인 제목', kind: 'command' as const, run: targetRun,
    terminal: coordinator, command: '검증 명령', preview: null, item: null, step: null, then: null, real: null })
  const first = applyAdd(emptyFile(), approval('open-approval', run), now)
  const second = applyAdd(first.file, approval('foreign-approval', 'other-run'), now)
  writeFileSync(join(f.state, 'approvals.json'), JSON.stringify(second.file))

  const old = new Date(Date.now() - 601_000).toISOString()
  const question = (id: string, body: string, created = old) => ({ id, body, type: 'question', created_at: created,
    run_id: run, from_handle: `term_${id}`, to_handle: `run:${run}` })
  const pending = question('q-open', '의존성 질문\n두 번째 줄')
  const answered = question('q-answered', '답한 질문')
  const finished = { ...question('q-finished', '끝난 worker 질문'), dispatch_id: 'ctx_done' }
  f.orca.setRules([
    current,
    { args: ['worker-list'], stdout: envelope({ workers: [{ dispatchId: 'ctx_done', dispatchStatus: 'completed' }] }) },
    { args: ['check', 'worker_done'], stdout: envelope({ messages: [] }) },
    { args: ['check', '--all'], stdout: envelope({ messages: [pending, answered, finished, question('q-new', '새 질문', now.toISOString()), question('q-decision', '결정: 배포 시점')] }) },
    { args: ['inbox', 'term_q-answered'], stdout: envelope({ messages: [{ id: 'answer', run_id: run, thread_id: answered.id, to_handle: answered.from_handle }] }) },
    { stdout: envelope({ messages: [] }) },
  ])

  const result = JSON.parse(f.invoke()).hookSpecificOutput
  assert.equal(result.hookEventName, 'SessionStart')
  const context: string = result.additionalContext
  assert.match(context, /work \[doing\] 리뷰 반영\n  남은 단계: 2\. 리뷰 반영/)
  assert.match(context, /PR: #321 \/ #322 · worker: review review-tree ctx_review working/)
  assert.match(context, /대기 조건: 배포 알림 수신/)
  assert.match(context, /worker: legacy-tree/)
  assert.match(context, /q-open 의존성 질문 두 번째 줄/)
  assert.match(context, /open-approval v\d+ \[command\] 승인 제목/)
  assert.doesNotMatch(context, /구현 완료|끝난 항목|다른 상태|foreign-approval|q-answered|q-finished|q-new|q-decision/)
  assert.ok(f.orca.calls().filter(call => call.argv.includes('check')).every(call => call.argv.includes('--peek') || call.argv.includes('--all')))
})

test('보드 항목이 길면 일부를 생략하고 전체 목록 명령을 표시한다', (t) => {
  const f = fixture(t)
  writeFileSync(f.boardFile, JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}`, status: 'doing' })) }))
  const context: string = JSON.parse(f.invoke()).hookSpecificOutput.additionalContext
  const shown = [...context.matchAll(/^- item-\d+ /gm)].length
  assert.ok(shown > 0 && shown < 50)
  assert.ok(context.includes(`${50 - shown}개 더, \`orch board list\``))
})

test('현재 Run 응답에 터미널이 없으면 Run 상세에서 코디네이터를 확인한다', (t) => {
  const f = fixture(t)
  writeFileSync(f.boardFile, JSON.stringify({ items: { work: { id: 'work', status: 'goal' } } }))
  f.orca.setRules([
    { args: ['run-current'], stdout: envelope({ runId: run }) },
    { args: ['run-show', run], stdout: envelope({ run: { id: run, coordinator_handle: coordinator } }) },
  ])
  assert.match(JSON.parse(f.invoke()).hookSpecificOutput.additionalContext, /work \[doing\]/)
  assert.equal(f.invoke({ handle: 'term_worker' }), '')
})

test('worker, Run을 모르는 세션, 압축 이외의 시작에는 출력을 내지 않는다', (t) => {
  const f = fixture(t)
  writeFileSync(f.boardFile, JSON.stringify({ items: [{ id: 'work', status: 'doing' }] }))
  assert.equal(f.invoke({ handle: 'term_worker' }), '')
  assert.deepEqual(f.orca.calls().map(call => call.argv[1]), ['run-current'])
  assert.equal(f.invoke({ handle: '' }), '')
  assert.equal(f.invoke({ source: 'startup' }), '')
  assert.equal(f.orca.calls().length, 1)
  f.orca.setRules([{ args: ['run-current'], stdout: envelope({ run: null }) }])
  assert.equal(f.invoke(), '')
})

test('보드가 없거나 깨져도 빈 출력과 종료 코드 0을 반환한다', (t) => {
  const f = fixture(t)
  assert.equal(f.invoke(), '')
  for (const broken of ['{', '{"items":42}', '{"items":[null]}']) {
    writeFileSync(f.boardFile, broken)
    assert.equal(f.invoke(), '')
  }
})

test('Orca 조회가 멈추면 훅 제한 시간 안에 빈 출력으로 끝난다', (t) => {
  const f = fixture(t)
  const hanging = linkBin(f.repo, 'orca-hanging', 'setInterval(() => {}, 1000)')
  assert.equal(f.invoke({ orcaBin: hanging }), '')
})
