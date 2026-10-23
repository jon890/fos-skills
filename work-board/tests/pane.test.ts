import { test, expect } from 'claude-code/testing'

const BOARD = JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
  { id: 'a', title: '단계 항목', status: 'doing', owner: 'worker', pr: '#9', worktree: 'wt-a',
    next: '✓ 1. 구현\n2. 리뷰\n3. 머지\n참고: 머지 뒤 갱신' },
  { id: 'b', title: '옛 항목', status: 'doing' },
  { id: 'c', title: '대기 항목', status: 'wait', details: ['[x] 1 a', '2 b'] },
] })

const PANE = {
  plugin: 'fos-skills',
  component: 'Pane',
  requestId: 'work-board',
  props: { title: '작업 현황', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

async function start($, on) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => ({ value: e.argv[0] === 'git'
    ? { exitCode: 0, stdout: '/repo/.git\n', stderr: '' }
    : { exitCode: 1, stdout: '', stderr: '없음' } }))
  on('fs.exists', (_, e) => ({ value: e.path === '/repo/.omc/board.json' }))
  on('fs.read', () => ({ value: BOARD }))
  on('clock.now', () => ({ value: Date.parse('2026-10-22T10:05:00+09:00') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

}

test('창 맨 위에 전체 진행률을, 항목 제목 줄 끝에 막대나 「진행률 없음」 을 그린다', async ($, on) => {
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

test('접힌 보기는 제목 줄, 지금 단계 줄, worker 줄만 그리고 끝낸 단계와 남은 단계는 수로 접는다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await lines(ui, 'a')).toBe(3)
  const now = stepParts(await ui.find({ type: 'Box', key: 'steps' }))
  expect(now.markText).toBe('▶')
  expect(now.bodyText).toBe('2. 리뷰  ✓\u00a01개  ·  남은\u00a0단계\u00a01개')
  expect(now.body.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: /구현/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /참고: 머지 뒤 갱신/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /worker 없음 \(wt-a\)/ })).toBeTruthy()
  // 진행률이 없는 옛 항목은 제목 줄 하나다
  expect(await lines(ui, 'b')).toBe(1)
  await ui.unmount()
})

test('d 로 펼치면 모든 줄을 적힌 순서대로, 같은 표시 칸과 본문 열에 맞춰 그리고 끝낸 줄에 취소선을 긋는다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-done' })
  expect(await lines(ui, 'a')).toBe(7)
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
  expect(await lines(ui, 'a')).toBe(3)
  await ui.unmount()
})

test('새로 읽기 버튼은 없고 오늘 시작과 펼치기 버튼만 남는다', async ($, on) => {
  await start($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /새로 읽기|읽는 중/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', text: /오늘 시작/ })).toBeTruthy()
  await ui.unmount()
})
