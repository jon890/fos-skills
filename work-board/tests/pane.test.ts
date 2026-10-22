import { test, expect } from 'claude-code/testing'

const BOARD = JSON.stringify({ updatedAt: '2026-10-22T10:00:00+09:00', items: [
  { id: 'a', title: '단계 항목', status: 'doing', next: '✓ 1. 구현\n2. 리뷰\n3. 머지' },
  { id: 'b', title: '옛 항목', status: 'doing' },
  { id: 'c', title: '대기 항목', status: 'wait', details: ['[x] 1 a', '2 b'] },
] })

const PANE = {
  plugin: 'fos-skills',
  component: 'Pane',
  requestId: 'work-board',
  props: { title: '작업 현황', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

test('창 맨 위에 전체 진행률을, 항목마다 막대나 「진행률 없음」 을 그린다', async ($, on) => {
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
  on('ui.invalidate', () => ({ value: undefined }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^전체 진행률$/ }))?.text).toBe('전체 진행률')
    expect((await ui.find({ type: 'Text', text: /1\/3 \(33%\)/ }))?.text).toContain('█')
    expect((await ui.find({ type: 'Text', text: /진행률 없는 항목 1/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^  진행률 없음$/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1\/2 \(50%\)/ }))).toBeTruthy()
    await ui.unmount()
  }
})
