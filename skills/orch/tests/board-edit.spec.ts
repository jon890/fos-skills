// 실제 orch 진입점과 board.ts 를 임시 저장소에서 함께 실행한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))
const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))
let repo: string
let file: string
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'board-edit-')))
  file = join(repo, '.omc/board.json')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

function save(items: unknown[], target = file) {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify({ items }, null, 1))
}
function item(extra: Record<string, unknown> = {}) {
  return { id: 'x', status: 'doing', title: '작업', details: [{ text: '1. 구현', done: true }, { text: '9) 리뷰', done: false }, { text: '참고', done: false }], ...extra }
}
function orch(args: string[], cwd = repo) {
  const env: NodeJS.ProcessEnv = { ...process.env, ORCH_SCRIPTS_DIR: SCRIPTS, ORCA: join(repo, 'no-orca'), CLAUDE_CONFIG_DIR: join(repo, 'no-profile') }
  for (const key of ['ORCH_DIR', 'ORCH_CONTEXT', 'ORCH_OUTPUT', 'ORCH_ENTRY_HOP', 'BOARD_BIN']) delete env[key]
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'board', ...args], { cwd, env, encoding: 'utf8', timeout: 15_000 })
  assert.ifError(done.error)
  return { code: done.status, out: done.stdout, err: done.stderr }
}
function ok(args: string[], output: string, cwd = repo) {
  const result = orch(args, cwd)
  assert.equal(result.code, 0, result.err)
  assert.equal(result.out, output + '\n')
  return result
}
function refused(args: string[], reason: RegExp, code = 1) {
  const before = readFileSync(file, 'utf8')
  const result = orch(args)
  assert.equal(result.code, code, JSON.stringify(result))
  assert.equal(result.out, '')
  assert.match(result.err, reason)
  assert.equal(readFileSync(file, 'utf8'), before)
}
function git(...args: string[]) {
  const done = spawnSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
}
function config(board: unknown) {
  mkdirSync(join(repo, '.orch'), { recursive: true })
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board } }))
}

test('도움말과 명령 표가 새 명령을 보이고 사용법 오류는 2 다', () => {
  save([item()])
  const help = orch(['--help'])
  assert.equal(help.code, 0, help.err)
  for (const verb of ['set', 'step', 'add-step', 'show']) assert.match(help.out, new RegExp(`orch board ${verb}`))
  for (const args of [['set', 'x'], ['set', 'x', 'done', 'extra'], ['show'], ['show', 'x', 'extra'], ['step', 'x', 'one', 'done'], ['step', 'x', '9', 'text'], ['step', 'x', '9', 'done', '--on', '1 merge'], ['step', 'x', '9', 'auto', '조건'], ['step', 'x', '9', 'ask', '--on', '1 merge'], ['step', 'x', '9', 'plain', '조건'], ['step', 'x', '9', 'Auto'], ['step', 'x', '9', 'wait', 'a', 'b'], ['step', 'x', '9', 'wait', '조건', '--on', '1 merge'], ['add-step', 'x'], ['show', 'x', '--bad']]) {
    refused(args, /사용법/, 2)
  }
})
test('- 로 시작하는 글은 번호를 붙여 다시 쓸 수 있게 안내한다', () => {
  save([item()])
  refused(['add-step', 'x', '- 하위 항목'], /단계 번호를 앞에 붙인다/, 2)
  ok(['add-step', 'x', '10. - 하위 항목'], 'BOARD-STEP-ADD x 10')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].details.at(-1).text, '10. - 하위 항목')
})

test('set 은 상태만 바꾸고 없는 항목과 진행률 없는 doing 을 거절한다', () => {
  save([item(), item({ id: 'empty', status: 'wait', details: [] })])
  for (const state of ['goal', 'decide', 'wait', 'done', 'doing']) ok(['set', 'x', state], `BOARD-SET x ${state}`)
  refused(['set', 'x', 'bad'], /goal.*decide.*doing.*wait.*done/)
  refused(['set', 'x', ''], /goal.*decide.*doing.*wait.*done/)
  refused(['set', 'missing', 'wait'], /항목이 없다/)
  refused(['set', '99', 'wait'], /항목이 없다/)
  refused(['set', 'empty', 'doing'], /진행률|단계/)
  const saved = readFileSync(file, 'utf8')
  assert.equal(saved, JSON.stringify(JSON.parse(saved), null, 1))
  assert.equal(JSON.parse(saved).items[0].title, '작업')
})
test('step 은 번호로 끝내기·되돌리기·글 수정을 하고 자동 상태 전환을 보인다', () => {
  save([item({ status: 'decide', details: [{ text: '1. 구현', done: true }, { text: '9) 리뷰', done: false }] })])
  ok(['step', 'x', '9', 'done'], 'BOARD-STEP x 9 done status=done')
  ok(['step', 'x', '9', 'undo'], 'BOARD-STEP x 9 undo')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].status, 'done')
  ok(['step', 'x', '1', 'text', '1. 바꾼 구현'], 'BOARD-STEP x 1 text')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].details[0].done, true)
  refused(['step', 'x', '4', 'done'], /4 번 단계가 없다.*1 9/)
  refused(['step', 'x', '9', 'text', '10. 다른 번호'], /9/)
  save([item({ details: ['9. 첫 줄', '9) 둘째 줄'] })])
  refused(['step', 'x', '9', 'done'], /둘 이상/)
  save([item({ details: ['9.붙임', '2 단계'] })])
  refused(['step', 'x', '9', 'done'], /있는 번호: 2/)
  ok(['step', 'x', '2', 'text', '2 바꾼 단계'], 'BOARD-STEP x 2 text')
})
test('step 은 번호 뒤 자동 진행 표시만 바꾸고 사건 단계와 끝냄 상태를 지킨다', () => {
  save([item({ details: [{ text: '1. [merge] 머지', done: false }, { text: '2. [auto] PR4 API (계획: x)', done: true }, { text: '3. 기획 답 (#665 merge)', done: false }] })])
  ok(['step', 'x', '2', 'ask'], 'BOARD-STEP x 2 ask')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items[0].details[1], { text: '2. [ask] PR4 API (계획: x)', done: true })
  ok(['step', 'x', '3', 'wait', '2026-11-10 19:00'], 'BOARD-STEP x 3 wait')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].details[2].text, '3. [wait: 2026-11-10 19:00] 기획 답 (#665 merge)')
  ok(['step', 'x', '3', 'plain'], 'BOARD-STEP x 3 plain')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].details[2].text, '3. 기획 답 (#665 merge)')
  ok(['step', 'x', '2', 'ask', '--full'], 'BOARD-STEP x 2 ask\n1. [merge] 머지\n✓ 2. [ask] PR4 API (계획: x)\n3. 기획 답 (#665 merge)')
  refused(['step', 'x', '1', 'auto'], /사건 단계/)
  refused(['step', 'x', '9', 'auto'], /9 번 단계가 없다.*1 2 3/)
  ok(['step', 'x', '3', 'wait'], 'BOARD-STEP x 3 wait')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].details[2].text, '3. [wait] 기획 답 (#665 merge)')
  refused(['step', 'x', '3', 'wait', ''], /조건/)
  refused(['step', 'x', '3', 'wait', 'x] [Auto'], /조건/)
  save([item({ details: ['1. 구현', '2. 머지'], stages: 'pr=1,merge=2' })])
  refused(['step', 'x', '2', 'auto'], /사건 단계/)
})
test('워크트리에서 부른 표시 변경도 주 checkout 의 보드를 고친다', () => {
  git('init', '-q')
  git('commit', '--allow-empty', '-qm', 'init')
  const wt = join(repo, 'wt')
  git('worktree', 'add', '-q', wt, '-b', 'wt-branch')
  save([item({ details: ['1. [auto] 구현 (계획: x)'] })])
  ok(['step', 'x', '1', 'ask'], 'BOARD-STEP x 1 ask', wt)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].details[0].text, '1. [ask] 구현 (계획: x)')
  assert.equal(existsSync(join(wt, '.omc/board.json')), false)
})
test('next 단계의 글과 추가를 같은 쪽에 반영하고 최대 번호 다음을 고른다', () => {
  save([item({ details: ['참고'], next: '1. 구현\n9. 머지' })])
  ok(['step', 'x', '9', 'text', '9. 머지 확인'], 'BOARD-STEP x 9 text')
  ok(['add-step', 'x', '리뷰 반영'], 'BOARD-STEP-ADD x 10')
  ok(['add-step', 'x', '12. 수동 번호'], 'BOARD-STEP-ADD x 12')
  const row = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.deepEqual(row.details, [{ text: '참고', done: false }])
  assert.equal(row.next.at(-1).text, '12. 수동 번호')
  refused(['add-step', 'x', '9. 중복'], /9/)
  ok(['set', 'x', 'done'], 'BOARD-SET x done')
  refused(['add-step', 'x', '추가'], /done/)
})
test('--on 꼬리표를 붙이고 교체하며 잘못된 값과 꼬리표 삭제를 거절한다', () => {
  save([item()])
  ok(['add-step', 'x', '머지', '--on', '#1455 merge'], 'BOARD-STEP-ADD x 10')
  ok(['step', 'x', '10', 'text', '10. 배포 (#1455 merge)', '--on', '1456 deploy'], 'BOARD-STEP x 10 text')
  let row = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(row.details.at(-1).text, '10. 배포 (#1456 deploy)')
  refused(['step', 'x', '10', 'text', '10. 꼬리표 없음'], /꼬리표/)
  for (const event of ['abc merge', '1 bad', '0 merge', '01 merge']) refused(['add-step', 'x', '오류', '--on', event], /사건|PR|꼬리표/)
  save([item({ details: ['1. [merge] 머지'] })])
  refused(['step', 'x', '1', 'text', '1. 머지'], /꼬리표/)
  save([item({ progress: '1/3', stages: 'pr=1,merge=9' })])
  const warned = ok(['add-step', 'x', '배포', '--on', '2 deploy'], 'BOARD-STEP-ADD x 10')
  assert.match(warned.err, /progress/)
  assert.match(warned.err, /progress 값을 지우면 단계 수로 센다/)
  assert.match(warned.err, /stages/)
  row = JSON.parse(readFileSync(file, 'utf8')).items[0]
  assert.equal(row.details.at(-1).done, false)
})
test('show 와 --full 은 진행률과 단계·참고 줄을 내고 보드를 쓰지 않는다', () => {
  save([item(), item({ id: 'empty', status: 'wait', details: [] }), item({ id: 'progress', progress: '7/8' })])
  const before = readFileSync(file, 'utf8')
  ok(['show', 'x'], 'BOARD x doing 1/2\n9) 리뷰')
  ok(['show', 'x', '--full'], 'BOARD x doing 1/2\n✓ 1. 구현\n9) 리뷰\n참고')
  ok(['show', 'empty'], 'BOARD empty wait 진행률 없음')
  ok(['show', 'progress'], 'BOARD progress doing 7/8\n9) 리뷰')
  refused(['show', 'missing'], /항목이 없다/)
  assert.equal(readFileSync(file, 'utf8'), before)
  ok(['step', 'x', '9', 'done', '--full'], 'BOARD-STEP x 9 done\n✓ 1. 구현\n✓ 9) 리뷰\n참고')
})
test('보드 파일이 없거나 숫자 id 항목이어도 없는 문자열 id 는 만들지 않는다', () => {
  const result = orch(['set', '99', 'wait'])
  assert.equal(result.code, 1, result.err)
  assert.match(result.err, /항목이 없다/)
  assert.equal(existsSync(file), false)
  save([item({ id: 99 })])
  refused(['show', '99'], /항목이 없다/)
})
test('워크트리 기본은 주 checkout, 명시 repo 는 그 작업 트리, 상대 board 는 주 checkout 이다', () => {
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(repo, 'worktree')
  git('worktree', 'add', '-q', '-b', 'feat/test', wt)
  save([item()])
  ok(['set', 'x', 'wait'], 'BOARD-SET x wait', wt)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].status, 'wait')
  assert.equal(existsSync(join(wt, '.omc')), false)
  save([item()], join(wt, '.omc/board.json'))
  ok(['set', 'x', 'done', '--repo', wt], 'BOARD-SET x done', wt)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].status, 'wait')
  save([item()], join(repo, 'explicit.json'))
  ok(['set', 'x', 'goal', '--board', 'explicit.json'], 'BOARD-SET x goal', wt)
  assert.equal(JSON.parse(readFileSync(join(repo, 'explicit.json'), 'utf8')).items[0].status, 'goal')
  config('chosen.json')
  save([item()], join(repo, 'chosen.json'))
  ok(['set', 'x', 'decide'], 'BOARD-SET x decide', wt)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].status, 'wait')
  assert.equal(JSON.parse(readFileSync(join(repo, 'chosen.json'), 'utf8')).items[0].status, 'decide')
})
test('깨진 설정은 기본 보드를 쓰지 않고 명시 보드는 설정보다 앞선다', () => {
  save([item()])
  config(42)
  refused(['set', 'x', 'wait'], /finish.board/, 2)
  ok(['set', 'x', 'wait', '--board', file], 'BOARD-SET x wait')
  writeFileSync(join(repo, '.orch/config.json'), '{broken')
  refused(['set', 'x', 'done'], /config|설정|JSON/, 2)
})

test('보드 읽기 명령은 값과 목록 및 JSON 을 출력한다', () => {
  save([item({ branch: 'feat/test', pr: 555 }), { id: 'blank', status: 'done', title: '' }])
  const before = readFileSync(file, 'utf8')
  ok(['get', 'x', 'branch'], 'feat/test')
  ok(['get', 'x', 'progress'], '1/2')
  assert.equal(orch(['get', 'blank', 'title']).code, 4)
  assert.equal(JSON.parse(orch(['get', 'blank', 'title', '--json']).out).value, null)
  assert.equal(JSON.parse(orch(['get', 'x', 'step', '9', '--json']).out).number, 9)
  ok(['list', '--status', 'done'], 'BOARD blank done 진행률 없음')
  assert.equal(JSON.parse(orch(['list', '--json']).out).length, 2)
  assert.deepEqual(JSON.parse(orch(['show', 'x', '--json']).out).unmatched, [])
  for (const args of [['get', 'x', 'foo'], ['get', 'x', 'step'], ['list', 'extra'], ['set', 'x', 'done', '--json']]) refused(args, /사용법/, 2)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('보드 삭제는 끝난 항목만 지우고 강제 삭제와 사본을 지원한다', () => {
  save([item(), { id: 'done', status: 'done' }, { id: 99, status: 'done' }])
  const before = readFileSync(file, 'utf8')
  refused(['del', 'x'], /지금 doing.*--force/)
  refused(['del', ''], /id 가 필요하다/)
  ok(['del', '--done'], 'BOARD-DEL done\nBOARD-DEL 99')
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), before)
  ok(['del', '--done'], 'BOARD-NONE')
  ok(['del', 'x', '--force'], 'BOARD-DEL x')
  for (const args of [['del'], ['del', 'x', '--done'], ['del', '--done', '--force'], ['del', 'x', '--json']]) refused(args, /사용법/, 2)
})

test('상태 없이 업무 칸을 넣고 고치고 지운다', () => {
  save([item({ status: 'wait' })])
  mkdirSync(join(repo, '.orch'), { recursive: true })
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ board: { task: { adapter: 'dooray', web_url: 'https://x.dooray.com', project: 'P' } } }))
  const row = () => JSON.parse(readFileSync(file, 'utf8')).items[0]
  ok(['set', 'x', '--task-ref', '458'], 'BOARD-SET x wait'); assert.equal(row()['task-ref'], 'P/458')
  ok(['set', 'x', '--task', 'https://x/1'], 'BOARD-SET x wait'); assert.equal(row().task, 'https://x/1')
  ok(['set', 'x', '--task', ''], 'BOARD-SET x wait'); assert.equal(row().task, undefined); assert.equal(row()['task-ref'], 'P/458')
  ok(['set', 'x', 'done', '--task', 'https://x/2', '--task-ref', 'X/2'], 'BOARD-SET x done')
  refused(['set', 'missing', '--task', 'https://x/1'], /항목이 없다/)
  refused(['set', 'x', '--task', 'ftp://x'], /http/)
  refused(['show', 'x', '--task-ref', '1'], /사용법/, 2)
  writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ board: { task: {} } }))
  refused(['set', 'x', '--task-ref', '1'], /board.task/, 2)
})
