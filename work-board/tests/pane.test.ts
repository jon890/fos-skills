import { test, expect } from 'claude-code/testing'
import { START_COMMAND, DECIDE_COMMAND } from '../hooks/register.js'

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
  expect(await ui.find({ type: 'Text', text: /worker  ·  #9/ })).toBeTruthy()
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

test('새로 읽기 버튼은 없고 오늘 시작, 정할 것 묻기, 펼치기 버튼을 보인다', async ($, on) => {
  await start($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /새로 읽기|읽는 중/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /오늘 시작/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /정할 것 묻기/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /펼치기/ })).toBeTruthy()
  await ui.unmount()
})

test('명령은 /board 만 등록한다. board-start 와 board-decide 는 스킬이 맡는다', async ($, on) => {
  const commands = []
  await start($, on, undefined, BOARD, commands)
  expect(commands).toEqual(['board'])
})

for (const [key, hotkey, command] of [
  ['start-today', 's', START_COMMAND],
  ['ask-decisions', 'q', DECIDE_COMMAND],
] as const) {
  test(key + ' 버튼은 요청을 보내지 않고 입력란에 스킬 명령을 채운다', async ($, on) => {
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
    expect(filled).toEqual([command])
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
    expect(await ui.find({ type: 'Text', text: new RegExp('^' + label + '$') })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /run-visible-id-must-be-hidden|수동|자동|실제 상태/ })).toBeUndefined()
    const shortcuts = await ui.find({ type: 'Box', key: 'shortcuts' })
    expect(shortcuts.props.borderStyle).toBe('round')
    expect(await ui.find({ type: 'Text', text: /^단축키$/ })).toBeTruthy()
    const buttons = (shortcuts.children as Drawn[])[1].children as Drawn[]
    expect(buttons.map((button) => button.props.hotkey)).toEqual(['s', 'q', 'd'])
    await ui.unmount()
  })
}
