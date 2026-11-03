import { test, expect } from 'claude-code/testing'
import { START_PROMPT, DECIDE_PROMPT, REFRESH_PROMPT } from '../hooks/register.js'

const BOARD = JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
  { id: 'a', title: '단계 항목', status: 'doing', owner: 'worker', pr: '#9', worktree: 'wt-a',
    next: '✓ 1. 구현\n2. 리뷰\n3. 머지\n참고: 머지 뒤 갱신' },
  { id: 'b', title: '옛 항목', status: 'doing' },
  { id: 'c', title: '대기 항목', status: 'wait', details: [{ text: '1 a', done: true }, { text: '2 b', done: false }] },
] })

const PANE = {
  plugin: 'fos-skills',
  component: 'Pane',
  requestId: 'work-board',
  props: { title: '작업 현황', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

async function start($, on, processResult = (_argv) => ({ exitCode: 1, stdout: '', stderr: '없음' }), board = BOARD, commands = [], now = Date.parse('2026-10-22T10:05:00+09:00')) {
  on('command.register', (_, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => ({ value: e.argv[0] === 'git'
    ? { exitCode: 0, stdout: '/repo/.git\n', stderr: '' }
    : processResult(e.argv) }))
  on('fs.exists', (_, e) => ({ value: e.path === '/repo/.omc/board.json' }))
  on('fs.read', () => ({ value: board }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

}

test('창 맨 위에 전체 진행률을, 항목 제목 아래 줄에 막대나 「진행률 없음」 을 그린다', async ($, on) => {
  await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^전체 진행률$/ }))?.text).toBe('전체 진행률')
    expect((await ui.find({ type: 'Text', text: /1\/3 \(33%\)/ }))?.text).toContain('█')
    expect((await ui.find({ type: 'Text', text: /진행률 없는 항목 1/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^진행률 없음$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1\/2 \(50%\)/ }))).toBeTruthy()
    await ui.unmount()
  }
})

// 항목 Box 의 자식 수가 줄 수다(좁은 창에서 줄바꿈되는 것은 빼고)
const lines = async (ui, id) => ((await ui.find({ type: 'Box', key: 'item-' + id }))?.children ?? []).length

// 그린 트리의 한 요소가 보이는 글. find 는 Text 의 key 를 남기지 않아 단계 줄은 그 줄의 Box 로 찾는다
type Drawn = { type: string; props: Record<string, unknown>; children: (Drawn | string)[] }
const textOf = (node: Drawn | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('')
// 단계 줄 Box 를 표시 칸, 본문의 첫 Text 로 나눈다
const stepParts = (row) => {
  const [mark, body] = row.children as Drawn[]
  return { row: row.props, mark, markText: textOf(mark), body: (body.children as Drawn[])[0], bodyText: textOf(body) }
}

const LONG_TITLE = '제목이 아주 길어서 좁은 창에서는 여러 줄로 줄바꿈되는 진행 중 항목의 제목 '.repeat(3)
const BAR_BOARD = JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
  { id: 's', title: '짧은', status: 'doing', owner: 'worker', pr: '#1', details: [{ text: '1 a', done: true }, { text: '2 b', done: false }] },
  { id: 'l', title: LONG_TITLE, status: 'doing', details: [{ text: '1 a', done: true }, { text: '2 b', done: false }] },
  { id: 'n', title: '진행률 없는 항목', status: 'doing' },
  { id: 'd', title: '끝난 항목', status: 'done', details: [{ text: '1 a', done: true }] },
] })

// 항목 Box 의 자식 key 를 위에서 아래로
const keys = async (ui, id) => ((await ui.find({ type: 'Box', key: 'item-' + id }))?.children as Drawn[]).map((child) => child.props.key)

test('막대는 제목이 짧든 길든 제목 바로 아래 줄에 그리고, 완료 항목에는 그리지 않는다', async ($, on) => {
  await start($, on, undefined, BAR_BOARD)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 40 } })
  for (const id of ['s', 'l', 'n']) {
    const [head, bar] = await keys(ui, id)
    expect([head, bar]).toEqual(['head', 'bar'])
    const item = await ui.find({ type: 'Box', key: 'item-' + id })
    const [headBox, barBox] = item.children as Drawn[]
    expect(textOf(headBox)).not.toMatch(/█|░|진행률 없음/)
    expect(barBox.props.paddingLeft).toBe(2)
  }
  expect(textOf((await ui.find({ type: 'Box', key: 'item-n' })).children[1])).toBe('진행률 없음')
  // 펼친 보기에서도 막대가 담당·PR 줄보다 앞이고, 완료 항목에는 막대가 없다. 완료 칸은 펼쳐야 보인다
  await ui.press({ key: 'toggle-done' })
  expect((await keys(ui, 's')).slice(0, 3)).toEqual(['head', 'bar', 'meta'])
  expect((await keys(ui, 'd')).includes('bar')).toBe(false)
  expect((await keys(ui, 'd'))[0]).toBe('head')
  await ui.unmount()
})

test('접힌 보기는 제목 줄, 지금 단계 줄, worker 줄만 그리고 끝낸 단계와 남은 단계는 수로 접는다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await lines(ui, 'a')).toBe(4)
  const now = stepParts(await ui.find({ type: 'Box', key: 'steps' }))
  expect(now.markText).toBe('▶')
  expect(now.bodyText).toBe('2. 리뷰  ✓\u00a01개  ·  남은\u00a0단계\u00a01개')
  expect(now.body.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: /구현/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /참고: 머지 뒤 갱신/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /worker 없음 \(wt-a\)/ })).toBeTruthy()
  // 진행률이 없는 옛 항목은 제목 줄과 「진행률 없음」 줄이다
  expect(await lines(ui, 'b')).toBe(2)
  await ui.unmount()
})

test('d 로 펼치면 모든 줄을 적힌 순서대로, 같은 표시 칸과 본문 열에 맞춰 그리고 끝낸 줄에 취소선을 긋는다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-done' })
  expect(await lines(ui, 'a')).toBe(8)
  const rows = []
  for (const key of ['s-0', 's-1', 's-2', 's-3']) rows.push(stepParts(await ui.find({ type: 'Box', key })))
  expect(rows.map((row) => [row.markText, row.bodyText])).toEqual([
    ['✓', '1. 구현'], ['▶', '2. 리뷰'], [' ', '3. 머지'], [' ', '참고: 머지 뒤 갱신'],
  ])
  // 정렬: 모든 줄이 같은 왼쪽 여백과 같은 폭의 표시 칸을 갖고, 표시 칸은 줄지 않는다.
  // 본문은 표시 칸 옆의 Text 하나라 줄바꿈된 뒷줄도 본문 열에서 시작한다
  for (const row of rows) {
    expect(row.row).toMatchObject({ flexDirection: 'row', paddingLeft: 2 })
    expect(row.mark.props).toMatchObject({ width: 2, flexShrink: 0 })
    expect(row.body.type).toBe('Text')
  }
  expect(rows[0].body.props).toMatchObject({ strikethrough: true, dimColor: true })
  expect(rows[1].body.props.bold).toBe(true)
  expect(rows[1].body.props.strikethrough).toBeUndefined()
  expect(rows[2].body.props ?? {}).toEqual({})
  expect(rows[3].body.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /worker  ·  \[PR #9\]/ })).toBeTruthy()
  // details 의 끝낸 단계도 같은 모양이다
  const wait = await ui.find({ type: 'Box', key: 'item-c' })
  const first = stepParts((wait.children as Drawn[]).find((child) => child.props.key === 's-0'))
  expect([first.markText, first.bodyText]).toEqual(['✓', '1 a'])
  expect(first.body.props.strikethrough).toBe(true)
  // 다시 누르면 접힌 보기로 돌아간다
  await ui.press({ key: 'toggle-done' })
  expect(await lines(ui, 'a')).toBe(4)
  await ui.unmount()
})

test('열린 PR 에 작성자를 붙이고, a 로 한 작성자의 PR 만 거른다', async ($, on) => {
  const list = JSON.stringify([
    { number: 7, title: '하나', headRefName: 'x', author: { login: 'bifos' }, statusCheckRollup: [] },
    { number: 8, title: '둘', headRefName: 'y', author: { login: 'kim' }, statusCheckRollup: [] },
  ])
  await start($, on, (argv) => argv[0] === 'gh' && argv[1] === 'pr'
    ? { exitCode: 0, stdout: list, stderr: '' }
    : argv[0] === 'gh' && argv[1] === 'repo'
      ? { exitCode: 0, stdout: 'https://github.com/o/r\n', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: '없음' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let pr7
  for (let i = 0; i < 50 && !pr7; i++) pr7 = await ui.find({ type: 'Box', key: 'pr-7' })
  expect(textOf(pr7 as Drawn)).toContain('@bifos')
  let linkedPr
  for (let i = 0; i < 50 && !linkedPr; i++) linkedPr = await ui.find({ type: 'Link', text: '[PR #7]' })
  expect(linkedPr?.props.href).toBe('https://github.com/o/r/pull/7')
  expect(await ui.find({ type: 'Button', text: /PR 작성자: 전체/ })).toBeTruthy()
  await ui.press({ key: 'pr-author' })
  expect(await ui.find({ type: 'Box', key: 'pr-7' })).toBeTruthy()
  expect(await ui.find({ type: 'Box', key: 'pr-8' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /작성자 @bifos/ })).toBeTruthy()
  await ui.press({ key: 'pr-author' })
  expect(await ui.find({ type: 'Box', key: 'pr-7' })).toBeFalsy()
  expect(await ui.find({ type: 'Box', key: 'pr-8' })).toBeTruthy()
  await ui.press({ key: 'pr-author' })
  expect(await ui.find({ type: 'Box', key: 'pr-7' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /PR 작성자: 전체/ })).toBeTruthy()
  await ui.unmount()
})

test('업무 주소가 있으면 제목의 업무 번호에, 저장소 주소를 읽었으면 PR 번호에 밑줄 친 링크를 건다', async ($, on) => {
  const task = 'https://nhnent.dooray.com/project/tasks/4455909338652535899'
  const board = JSON.stringify({ items: [
    { id: 't', title: '#342 감지상황 잇기', status: 'wait', pr: 877, task },
    { id: 'n', title: '#343 주소 없는 업무', status: 'wait' },
  ] })
  const repo = (argv) => argv[0] === 'gh' && argv[1] === 'repo'
    ? { exitCode: 0, stdout: 'https://github.com/o/r\n', stderr: '' }
    : { exitCode: 1, stdout: '', stderr: '없음' }
  await start($, on, repo, board)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-done' })
  // 저장소 주소는 실제 상태를 읽을 때 채워지므로 PR 링크가 그려질 때까지 기다린다
  let prLink
  for (let i = 0; i < 50 && !prLink; i++) prLink = await ui.find({ type: 'Link', text: '[PR #877]' })
  expect(prLink?.props.href).toBe('https://github.com/o/r/pull/877')
  const taskLink = await ui.find({ type: 'Link', text: '[두레이 #342]' })
  expect(taskLink?.props.href).toBe(task)
  expect(((taskLink as Drawn).children[0] as Drawn).props).toMatchObject({ underline: true, color: 'cyan' })
  expect(((prLink as Drawn).children[0] as Drawn).props).toMatchObject({ underline: true, color: 'magenta' })
  expect(await ui.find({ type: 'Link', text: /#343/ })).toBeFalsy()
  // 업무와 PR 을 머리말로 가린다
  const title = textOf(await ui.find({ type: 'Box', key: 'item-t' }) as Drawn)
  expect(title).toContain('[두레이 #342] 감지상황 잇기')
  expect(title).toContain('[PR #877]')
  await ui.unmount()
})

test('새로 읽기 버튼은 없고 오늘 시작, 정할 것 묻기, 펼치기 버튼을 보인다', async ($, on) => {
  await start($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /새로 읽기|읽는 중/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /오늘 시작/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /정할 것 묻기/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /펼치기/ })).toBeTruthy()
  await ui.unmount()
})

test('명령은 /board 만 등록한다', async ($, on) => {
  const commands = []
  await start($, on, undefined, BOARD, commands)
  expect(commands).toEqual(['board'])
})

for (const [key, hotkey, prompt] of [
  ['start-today', 's', START_PROMPT],
  ['ask-decisions', 'q', DECIDE_PROMPT],
  ['refresh-board', 'u', REFRESH_PROMPT],
] as const) {
  test(key + ' 버튼은 보내지 않고 입력란에 요청문을 채운다', async ($, on) => {
    const filled = []
    const submitted = []
    const toasts = []
    on('prompt.fill', (_, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    on('prompt.submit', (_, e) => {
      submitted.push(e.text)
      return { drop: '테스트에서 요청만 확인' }
    })
    on('ui.toast', (_, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await start($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key })).props.hotkey).toBe(hotkey)
    await ui.press({ key })
    expect(filled).toEqual([prompt])
    expect(submitted).toEqual([])
    expect(toasts.join('\n')).toContain('Enter 를 누르면')
    await ui.unmount()
  })
}

test('질문 조회 실패를 결정 필요 0 대신 확인 불가로 표시한다', async ($, on) => {
  await start($, on, (argv) => argv.includes('run-current')
    ? { exitCode: 0, stdout: JSON.stringify({ result: { run: { id: 'r' } } }), stderr: '' }
    : { exitCode: 1, stdout: '', stderr: 'offline' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /결정 필요  확인 불가/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /읽지 못했어요: offline/ })).toBeTruthy()
  await ui.unmount()
})

test('최근 질문 상한이면 답변이 모두 끝났어도 조회 범위를 표시한다', async ($, on) => {
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d' }
  await start($, on, (argv) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ result:
    argv.includes('run-current') ? { run: { id: 'r' } }
      : argv.includes('check') ? { messages: Array(100).fill(q) }
        : argv.includes('inbox') ? { messages: [{ id: 'answer', thread_id: 'q', run_id: 'r', from_handle: 'run:r', to_handle: 'dispatch:d' }] }
          : { workers: [{ dispatchId: 'd', dispatchStatus: 'dispatched', workerState: 'ready' }] },
  }) }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^결정 필요  0$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /최근 질문 100건과 읽지 않은 질문/ })).toBeTruthy()
  await ui.unmount()
})

const decided = (lines) => JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
  { id: 'd', title: '모음 결정', status: 'decide', details: lines },
] })

test('줄이 모두 끝난 decide 항목만 있으면 결정 필요 상자를 그리지 않는다', async ($, on) => {
  await start($, on, undefined, decided([{ text: 'A 를 고를지', done: true }, { text: 'B 를 고를지', done: true }]))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', key: 'live-decide' })).toBeUndefined()
  await ui.unmount()
})

test('decide 항목에 남은 줄이 있으면 결정 필요 상자에 그 수를 보인다', async ($, on) => {
  await start($, on, undefined, decided([{ text: 'A 를 고를지', done: true }, { text: 'B 를 고를지', done: false }]))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', key: 'live-decide' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^결정 필요  1$/ })).toBeTruthy()
  await ui.unmount()
})

// 미답변 질문 하나를 주고 창을 mount 한다
async function mountWithQuestion($, on, body) {
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d', body }
  await start($, on, (argv) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ result:
    argv.includes('run-current') ? { run: { id: 'r' } }
      : argv.includes('check') ? { messages: [q] }
        : argv.includes('inbox') ? { messages: [] }
          : { workers: [{ dispatchId: 'd', dispatchStatus: 'dispatched', workerState: 'ready' }] },
  }) }))
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('결정 형식의 질문은 제목을 굵게, 권장안을 그 아래 줄로 보인다', async ($, on) => {
  const ui = await mountWithQuestion($, on,
    '결정: 저장 형식을 바꿀까요\n배경: 마이그레이션이 필요해요\n선택지:\n- 바꾼다: 빠르다\n- 둔다: 안전하다\n권장: 둔다. 사용자 데이터가 있다')
  const box = await ui.find({ type: 'Box', key: 'q-q' })
  const [, title, recommend, ...rest] = box.children as Drawn[]
  expect(textOf(title)).toBe('  저장 형식을 바꿀까요')
  expect(title.props.bold).toBe(true)
  expect(textOf(recommend)).toBe('  권장: 둔다. 사용자 데이터가 있다')
  expect(rest).toEqual([])
  expect(await ui.find({ type: 'Text', text: /마이그레이션이 필요해요/ })).toBeUndefined()
  await ui.unmount()
})

test('결정 형식이 없는 질문은 본문 앞부분을 그대로 보인다', async ($, on) => {
  const ui = await mountWithQuestion($, on, 'A 와 B 중 무엇으로 할까요?')
  const box = await ui.find({ type: 'Box', key: 'q-q' })
  const [, body, ...rest] = box.children as Drawn[]
  expect(textOf(body)).toBe('  A 와 B 중 무엇으로 할까요?')
  expect(body.props.bold).toBeUndefined()
  expect(rest).toEqual([])
  await ui.unmount()
})

// 창을 연 뒤 s, q, d 는 포커스가 있을 때 hotkey 로 눌린다. 시험 환경의 ui.key 는 Client 전용이라
// hotkey 경로를 직접 칠 수 없어, 상자 안 Button 이 hotkey 를 갖는지와 key 로 누른 동작을 확인한다.
for (const [name, boardAt, liveAt] of [
  ['실시간 조회가 늦음', '2026-10-22T10:00:00+09:00', Date.parse('2026-10-22T10:05:00+09:00')],
  ['보드 파일이 늦음', '2026-10-22T10:10:00+09:00', Date.parse('2026-10-22T10:05:00+09:00')],
  ['둘 다 없음', '', 0],
] as const) {
  test('머리 줄은 갱신 시각 하나와 단축키 상자를 보인다: ' + name, async ($, on) => {
    const runId = 'run-visible-id-must-be-hidden'
    await start($, on, (argv) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ result:
      argv.includes('run-current') ? { run: { id: runId } }
        : argv.includes('worker-list') ? { workers: [] } : { messages: [] },
    }) }), JSON.stringify({ updatedAt: boardAt, items: [] }), [], liveAt)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const timestamp = Math.max(Date.parse(boardAt) || 0, liveAt)
    const date = new Date(timestamp)
    const label = timestamp
      ? String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ' 업데이트'
      : '읽는 중'
    expect(await ui.find({ type: 'Text', text: new RegExp('^' + label + '  ·  $') })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /run-visible-id-must-be-hidden|수동|자동|실제 상태/ })).toBeUndefined()
    const shortcuts = await ui.find({ type: 'Box', key: 'shortcuts' })
    expect(shortcuts.props.borderStyle).toBe('round')
    expect(await ui.find({ type: 'Text', text: /^단축키$/ })).toBeTruthy()
    const buttons = (shortcuts.children as Drawn[])[1].children as Drawn[]
    expect(buttons.map((button) => button.props.hotkey)).toEqual(['s', 'u', 'q', 'a', 'd'])
    await ui.unmount()
  })
}

// 업무 알림 상자. inbox.ts board --json 의 출력을 가짜 process.run 이 돌려준다
const INBOX_ITEMS = [
  { id: 'dooray:task:comment:c1', adapter: 'dooray', source: 'task', kind: 'mention', title: '어드민개발/81 어드민 권한 정리',
    url: 'https://nhnent.dooray.com/project/tasks/p81', scope: [], from: { id: '1', name: '김철수' }, at: '2026-10-22T09:53:00+09:00',
    excerpt: '운영 계정도 같은 권한이 필요한지', target: {}, state: 'new' },
  { id: 'dooray:task:post:p342', adapter: 'dooray', source: 'task', kind: 'assigned', title: 'AI-스마트홈-AI/342 배포 일정 조율',
    url: '', scope: [], from: { id: '2', name: '이영희' }, at: '2026-10-22T09:00:00+09:00', excerpt: '', target: {}, state: 'new' },
  { id: 'dooray:messenger:ch:l1', adapter: 'dooray', source: 'messenger', kind: 'mention', title: '스마트홈 개발',
    url: '', scope: [], from: { id: '3', name: '박민수' }, at: '2026-10-22T08:00:00+09:00', excerpt: '리뷰 부탁해요', target: {}, state: 'answered' },
]
const inboxOutput = (value) => (argv) => String(argv[2] || '').endsWith('/inbox/scripts/inbox.ts')
  ? { exitCode: 0, stdout: JSON.stringify(value), stderr: '' }
  : { exitCode: 1, stdout: '', stderr: '없음' }

test('알림 상자는 새 알림 수, 항목 줄, 출처별 오류, 미분류 수를 보인다', async ($, on) => {
  await start($, on, inboxOutput({ enabled: true, fetchedAt: '2026-10-22T10:03:00+09:00', newCount: 2, unclassified: 4, isDefault: false,
    errors: { 'dooray:messenger': '429' }, items: INBOX_ITEMS }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 시각은 실행 환경의 시간대로 그린다(CI 는 UTC)
  expect(await ui.find({ type: 'Text', text: /^알림  2  ·  \d{2}:03 확인$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /두레이 메신저 확인 불가: 429/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /미분류 알림 4/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /김철수 · 멘션 · 12분 전/ })).toBeTruthy()
  // 답한 알림은 목록에서 빼고 수만 흐리게 보인다
  expect(await ui.find({ type: 'Text', text: /박민수 · 멘션/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'inbox-reply-dooray:messenger:ch:l1' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^답함 1$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /「운영 계정도 같은 권한이 필요한지」/ })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'inbox-reply-dooray:task:comment:c1' })).props.hotkey).toBe('1')
  expect((await ui.find({ type: 'Button', key: 'inbox-all' })).props.hotkey).toBe('i')
  await ui.unmount()
})

test('알림 설정이 없으면 알림 상자와 i 단축키를 그리지 않는다', async ($, on) => {
  await start($, on, inboxOutput({ enabled: false }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^알림  / })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'inbox-all' })).toBeFalsy()
  await ui.unmount()
})

test('숫자 단축키는 그 항목의 답변 요청문을 입력란에 채운다', async ($, on) => {
  const filled = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($, on, inboxOutput({ enabled: true, fetchedAt: null, newCount: 2, unclassified: 0, isDefault: true, errors: {}, items: INBOX_ITEMS }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'inbox-reply-dooray:task:post:p342' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('inbox.ts context dooray:task:post:p342')
  expect(filled[0]).toContain('확인 전에는 등록하지 마')
  await ui.unmount()
})

// x 를 누르면 숫자 단축키가 답변 요청문 대신 그 알림을 넘긴다. 넘긴 알림은 바로 빠지고 z 로 되돌린다
test('x 다음 숫자는 알림을 inbox.ts dismiss 로 넘기고 z 는 되돌린다', async ($, on) => {
  const filled = []
  const toasts = []
  const calls = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const dismissed = new Set()
  await start($, on, (argv) => {
    if (!String(argv[2] || '').endsWith('/inbox/scripts/inbox.ts')) return { exitCode: 1, stdout: '', stderr: '없음' }
    calls.push(argv.slice(3))
    if (argv[3] === 'dismiss') {
      if (argv.includes('--undo')) dismissed.delete(argv[4])
      else dismissed.add(argv[4])
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const items = INBOX_ITEMS.filter((item) => !dismissed.has(item.id))
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ enabled: true, fetchedAt: null, unclassified: 0, isDefault: true, errors: {},
      newCount: items.filter((item) => item.state === 'new').length, items }) }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'inbox-dismiss' })).props.hotkey).toBe('x')
  expect(await ui.find({ type: 'Button', key: 'inbox-undo' })).toBeFalsy()

  await ui.press({ key: 'inbox-dismiss' })
  expect(await ui.find({ type: 'Text', text: /넘길 알림의 번호를 누르세요/ })).toBeTruthy()
  await ui.press({ key: 'inbox-reply-dooray:task:comment:c1' })
  expect(filled).toEqual([])
  expect(calls).toContainEqual(['dismiss', 'dooray:task:comment:c1'])
  expect(await ui.find({ type: 'Button', key: 'inbox-reply-dooray:task:comment:c1' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^알림  1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /넘길 알림의 번호를 누르세요/ })).toBeFalsy()
  expect((await ui.find({ type: 'Button', key: 'inbox-reply-dooray:task:post:p342' })).props.hotkey).toBe('1')
  expect(toasts.join('\n')).toContain('z 를 누르면')

  // 넘기기 모드는 한 번 넘기면 꺼진다. 다시 누르면 답변 요청문을 채운다
  await ui.press({ key: 'inbox-reply-dooray:task:post:p342' })
  expect(filled).toHaveLength(1)

  expect((await ui.find({ type: 'Button', key: 'inbox-undo' })).props.hotkey).toBe('z')
  await ui.press({ key: 'inbox-undo' })
  expect(calls).toContainEqual(['dismiss', 'dooray:task:comment:c1', '--undo'])
  expect(await ui.find({ type: 'Button', key: 'inbox-reply-dooray:task:comment:c1' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'inbox-undo' })).toBeFalsy()
  await ui.unmount()
})

test('넘기기에 실패하면 알림을 남기고 이유를 toast 로 보인다', async ($, on) => {
  const toasts = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await start($, on, (argv) => !String(argv[2] || '').endsWith('/inbox/scripts/inbox.ts')
    ? { exitCode: 1, stdout: '', stderr: '없음' }
    : argv[3] === 'dismiss'
      ? { exitCode: 1, stdout: '', stderr: '쓰기 실패' }
      : { exitCode: 0, stderr: '', stdout: JSON.stringify({ enabled: true, fetchedAt: null, newCount: 2, unclassified: 0, isDefault: true, errors: {}, items: INBOX_ITEMS }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'inbox-dismiss' })
  await ui.press({ key: 'inbox-reply-dooray:task:comment:c1' })
  expect(toasts.join('\n')).toContain('알림 넘기기 실패: 쓰기 실패')
  expect(await ui.find({ type: 'Button', key: 'inbox-reply-dooray:task:comment:c1' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'inbox-undo' })).toBeFalsy()
  await ui.unmount()
})

test('알림함이 켜진 적 없이 inbox 명령이 실패하면 알림 상자를 그리지 않는다 (R6)', async ($, on) => {
  await start($, on, (argv) => String(argv[2] || '').endsWith('/inbox/scripts/inbox.ts')
    ? { exitCode: 1, stdout: '', stderr: 'node 를 찾지 못했다' }
    : { exitCode: 1, stdout: '', stderr: '없음' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /알림함 확인 불가/ })).toBeFalsy()
  await ui.unmount()
})

// c 를 누르면 진행 중·대기 항목 앞에 번호가 붙고, 번호는 그 항목의 상태 확인 요청문을 채운다 (docs/features/board-item-check)
test('c 다음 번호는 그 항목의 상태 확인 요청문을 채우고 모드를 끈다 (REQ1, REQ2)', async ($, on) => {
  const filled = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'item-check' })).props.hotkey).toBe('c')
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBeUndefined()

  await ui.press({ key: 'item-check' })
  expect(await ui.find({ type: 'Text', text: /상태를 확인할 항목의 번호를 누르세요/ })).toBeTruthy()
  // 화면 순서: 진행 중 a, b 다음 대기 c
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBe('1')
  expect((await ui.find({ type: 'Button', key: 'check-b' })).props.hotkey).toBe('2')
  expect((await ui.find({ type: 'Button', key: 'check-c' })).props.hotkey).toBe('3')

  await ui.press({ key: 'check-a' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('보드 항목 a ')
  expect(filled[0]).toContain('(단계 항목)')
  expect(filled[0]).toContain('끝나지 않은 단계: 2. 리뷰 / 3. 머지')
  expect(filled[0]).toContain('worker: 없음 (워크트리 wt-a)')
  expect(filled[0]).toContain('PR: #9')
  expect(filled[0]).toContain('멈춰 있으면 다음 단계를 진행하거나 내가 정할 것을 물어 줘')
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /상태를 확인할 항목의 번호를 누르세요/ })).toBeFalsy()
  await ui.unmount()
})

// Esc 는 ui.close 로 온다. 테스트 키트의 $ 는 ui.close 를 부르지 못해, 훅은 check.spec.ts 가 onPaneClose 로 직접 부른다
test('c 를 다시 누르면 번호가 사라진다 (REQ1)', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'item-check' })
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBe('1')
  expect((await ui.find({ type: 'Button', key: 'item-check' })).props.label).toBe('확인 그만')
  await ui.press({ key: 'item-check' })
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /상태를 확인할 항목의 번호를 누르세요/ })).toBeFalsy()
  await ui.unmount()
})

test('진행 중·대기 항목이 없으면 c 가 없다 (REQ4)', async ($, on) => {
  await start($, on, undefined, JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
    { id: 'd', title: '끝난 항목', status: 'done' },
    { id: 'q', title: '결정', status: 'decide' },
  ] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'item-check' })).toBeFalsy()
  await ui.unmount()
})

test('확인 모드에서 알림 번호는 그대로 보이고 숫자 단축키는 항목만 쓴다. x 와 c 는 함께 켜지지 않는다', async ($, on) => {
  const filled = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($, on, inboxOutput({ enabled: true, fetchedAt: null, newCount: 2, unclassified: 0, isDefault: true, errors: {}, items: INBOX_ITEMS }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const reply = 'inbox-reply-dooray:task:comment:c1'
  expect((await ui.find({ type: 'Button', key: reply })).props.hotkey).toBe('1')

  await ui.press({ key: 'item-check' })
  const inboxButton = await ui.find({ type: 'Button', key: reply })
  expect(inboxButton.props.hotkey).toBeUndefined()
  expect(textOf(inboxButton)).toMatch(/^1: ● 어드민개발\/81/)
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((button) => button.props.hotkey).filter(Boolean)
  expect(hotkeys.filter((key) => key === '1')).toHaveLength(1)
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBe('1')
  // 확인 모드 동안 알림 버튼은 클릭이나 Enter 로도 요청문을 채우지 않는다
  await ui.press({ key: reply })
  expect(filled).toEqual([])

  // x 를 켜면 c 가 꺼지고 알림 번호가 돌아온다
  await ui.press({ key: 'inbox-dismiss' })
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: reply })).props.hotkey).toBe('1')
  expect(await ui.find({ type: 'Text', text: /넘길 알림의 번호를 누르세요/ })).toBeTruthy()
  // c 를 켜면 x 가 꺼진다
  await ui.press({ key: 'item-check' })
  expect(await ui.find({ type: 'Text', text: /넘길 알림의 번호를 누르세요/ })).toBeFalsy()
  expect((await ui.find({ type: 'Button', key: 'check-a' })).props.hotkey).toBe('1')
  await ui.unmount()
})

// 알림처럼 진행 중·대기 항목의 제목 줄도 클릭이나 Enter 로 누를 수 있다 (REQ5)
test('c 없이 진행 중·대기 항목의 제목 줄을 누르면 상태 확인 요청문을 채운다 (REQ5)', async ($, on) => {
  const filled = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($, on, undefined, JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
    { id: 'a', title: '단계 항목', status: 'doing', next: '✓ 1. 구현\n2. 리뷰' },
    { id: 'w', title: '대기 항목', status: 'wait' },
    { id: 'd', title: '끝난 항목', status: 'done' },
    { id: 'q', title: '결정 항목', status: 'decide' },
  ] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const head = await ui.find({ type: 'Button', key: 'check-a' })
  expect(head.props.hotkey).toBeUndefined()
  expect(textOf(head)).toBe('▶ 단계 항목')
  // 완료와 결정 항목은 누를 대상이 아니다
  expect(await ui.find({ type: 'Button', key: 'check-d' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'check-q' })).toBeFalsy()

  await ui.press({ key: 'check-w' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('보드 항목 w ')
  await ui.press({ key: 'check-a' })
  expect(filled[1]).toContain('끝나지 않은 단계: 2. 리뷰')

  // 펼친 보기에서도 머리 줄만 Button 이고 상세 줄은 Button 이 아니다
  await ui.press({ key: 'toggle-done' })
  expect((await ui.findAll({ type: 'Button' })).map((b) => b.props.key).filter((k) => String(k).startsWith('check-')).sort())
    .toEqual(['check-a', 'check-w'])
  await ui.unmount()
})

// 대기 항목은 접힌 보기, 대기 칸, 9개를 넘는 자리에서도 제목 줄을 눌러 재개 요청문을 채운다
test('대기 항목의 제목 줄은 9개를 넘어도 눌리고 재개 요청문을 채운다', async ($, on) => {
  const filled = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  const doing = Array.from({ length: 9 }, (_, i) => ({ id: 'd' + i, title: '진행 ' + i, status: 'doing', next: '1. 구현' }))
  await start($, on, undefined, JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
    { id: 'w', title: '기획 답을 기다리는 항목', status: 'wait', pr: 41, task: 'https://tasks.example.com/task/7',
      details: [{ text: '1. 구현', done: true }, { text: '기획 답 대기', done: false }] },
    ...doing,
  ] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const head = await ui.find({ type: 'Button', key: 'check-w' })
  expect(textOf(head)).toBe('◇ 기획 답을 기다리는 항목')

  // 확인 모드에서 대기 항목은 진행 중 9개 뒤라 번호가 없지만 클릭은 된다
  await ui.press({ key: 'item-check' })
  expect((await ui.find({ type: 'Button', key: 'check-d8' })).props.hotkey).toBe('9')
  expect((await ui.find({ type: 'Button', key: 'check-w' })).props.hotkey).toBeUndefined()
  await ui.press({ key: 'check-w' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('보드 항목 w 의 대기 사유를 다시 확인하고 조사를 재개해 줘. (기획 답을 기다리는 항목)')
  expect(filled[0]).toContain('- 대기 사유: 기획 답 대기')
  expect(filled[0]).toContain('- 업무: https://tasks.example.com/task/7')
  expect(filled[0]).toContain('- PR: #41')
  expect(filled[0]).toContain('재촉하거나 우회할 방법')
  // 진행 중 항목은 그대로 상태 확인 요청문이다
  await ui.press({ key: 'check-d0' })
  expect(filled[1]).toContain('보드 항목 d0 의 지금 상태를 확인하고 다음 단계를 이어 가 줘.')

  // 펼친 보기에서도 대기 항목의 제목 줄은 눌린다
  await ui.press({ key: 'toggle-done' })
  await ui.press({ key: 'check-w' })
  expect(filled[2]).toContain('대기 사유를 다시 확인하고 조사를 재개해 줘')
  await ui.unmount()
})

test('넘기기(x) 모드에서는 항목 제목 줄을 눌러도 요청문을 채우지 않는다 (REQ5)', async ($, on) => {
  const filled = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($, on, inboxOutput({ enabled: true, fetchedAt: null, newCount: 2, unclassified: 0, isDefault: true, errors: {}, items: INBOX_ITEMS }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'inbox-dismiss' })
  await ui.press({ key: 'check-a' })
  expect(filled).toEqual([])
  expect(await ui.find({ type: 'Text', text: /넘길 알림의 번호를 누르세요/ })).toBeTruthy()
  await ui.unmount()
})

test('제목에 업무 링크가 있으면 링크는 Button 밖에 그리고 제목 글은 이어진다 (REQ5)', async ($, on) => {
  await start($, on, undefined, JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
    { id: 't', title: '배포 #342 정리', status: 'doing', task: 'https://nhnent.dooray.com/task/342' },
  ] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const head = await ui.find({ type: 'Box', key: 'head' })
  const [button, link, tail] = head.children as Drawn[]
  expect(button.type).toBe('Button')
  expect(textOf(button)).toBe('▶ 배포 ')
  expect(link.type).toBe('Link')
  expect(textOf(link)).toBe('[두레이 #342]')
  expect(textOf(tail)).toBe(' 정리')
  await ui.unmount()
})
