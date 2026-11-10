// 보드 창의 승인 대기 상자와 버튼을 그려 눌러 본다. 승인 파일은 가짜 fs 가 주고, 창 전용 스크립트(bin/approvals.ts)는 가짜 process.run 이 대신한다.
import { test, expect } from 'claude-code/testing'

const APPROVALS = '/repo/.orch/state/approvals.json'
const NOW = Date.parse('2026-11-10T12:00:00+09:00')
const PANE = {
  plugin: 'fos-skills',
  component: 'Pane',
  requestId: 'work-board',
  props: { title: '작업 현황', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const entry = (over: Record<string, unknown>) => ({
  id: 'post-1', version: 3, kind: 'post', title: '361 마무리 댓글 등록', state: 'open', run: 'R', terminal: 'term_c',
  preview: { path: '/p/361.html', sha256: 'x' }, item: null, step: null, then: '두레이 361 에 댓글 등록', real: null, command: null,
  createdAt: '2026-11-10T11:30:00+09:00', closedAt: null, press: null, note: null, reason: null, ...over,
})
const file = (...entries: unknown[]) => JSON.stringify({ seq: 9, entries })

type Calls = { argv: string[] }[]
async function start($, on, opts: { approvals?: string; self?: { terminal: string | null; worker: boolean | null }; press?: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } } = {}) {
  const calls: Calls = []
  const filled: string[] = []
  const toasts: string[] = []
  const statuses: string[] = []
  const state = { approvals: opts.approvals ?? file(entry({})) }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv })
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } }
    const script = e.argv.find((a) => a.endsWith('bin/approvals.ts'))
    if (script) {
      const verb = e.argv[e.argv.indexOf(script) + 1]
      if (verb === 'where') return { value: { exitCode: 0, stdout: APPROVALS + '\n', stderr: '' } }
      if (verb === 'self') return { value: { exitCode: 0, stdout: JSON.stringify(opts.self ?? { terminal: 'term_c', worker: false }) + '\n', stderr: '' } }
      if (verb === 'press') return { value: (opts.press ?? (() => ({ exitCode: 0, stdout: 'PRESS-OK msg_1\n', stderr: '' })))(e.argv) }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '없음' } }
  })
  on('fs.exists', (_, e) => ({ value: e.path === APPROVALS }))
  on('fs.read', (_, e) => ({ value: e.path === APPROVALS ? state.approvals : '' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('prompt.fill', (_, e) => { filled.push(e.text); return { isFilled: true } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return { calls, filled, toasts, statuses, state }
}
const presses = (calls: Calls) => calls.filter((c) => c.argv.includes('press')).map((c) => c.argv.slice(c.argv.findIndex((a) => a === 'press')))

test('열린 대기가 있으면 상자와 상태 줄에 보이고 24시간 넘은 대기의 시간은 노랑이다', async ($, on) => {
  const h = await start($, on, { approvals: file(entry({}), entry({ id: 'old', version: 4, createdAt: '2026-11-09T09:00:00+09:00' }), entry({ id: 'done', version: 5, state: 'approved' })) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^승인 대기  2$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /361 마무리 댓글 등록/ })).toBeTruthy()
  expect(h.statuses.some((s) => s.includes('승인 2'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^1일$/ })).props.color).toBe('yellow')
  expect((await ui.find({ type: 'Text', text: /^30분$/ })).props.color).toBeUndefined()
  await ui.unmount()
})

test('열린 대기가 없으면 상자도 상태 줄의 「승인 n」 도 없다', async ($, on) => {
  const h = await start($, on, { approvals: file(entry({ state: 'used' })) })
  expect(h.statuses.some((s) => s.includes('승인'))).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /승인 대기/ })).toBeFalsy()
  await ui.unmount()
})

test('worker 가 아닌 창은 「승인」, 「고쳐 달라」 를 그리고 worker 창은 버튼 없이 안내만 보인다', async ($, on) => {
  await start($, on, { self: { terminal: 'term_c', worker: false } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'approval:post-1:3:approve' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'approval:post-1:3:revise' })).toBeTruthy()
  await ui.unmount()
})

for (const self of [{ terminal: 'term_w', worker: true }, { terminal: 'term_w', worker: null }]) {
  test(`worker ${self.worker === null ? '여부를 모르는' : '터미널의'} 창은 승인 대기와 안내만 보이고 버튼이 없다`, async ($, on) => {
    const h = await start($, on, { self })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /361 마무리 댓글 등록/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /코디네이터 창이나 다른 창에서 누르세요/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'approval:post-1:3:approve' })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'approval:post-1:3:revise' })).toBeFalsy()
    expect(presses(h.calls)).toEqual([])
    await ui.unmount()
  })
}

test('「승인」 을 누르면 press 를 부르고 성공하면 상자에서 빠진다', async ($, on) => {
  let h: Awaited<ReturnType<typeof start>>
  h = await start($, on, { press: () => { h.state.approvals = file(entry({ state: 'approved' })); return { exitCode: 0, stdout: 'PRESS-OK msg_1\n', stderr: '' } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approval:post-1:3:approve' })
  expect(presses(h.calls)).toEqual([['press', 'post-1', '3', 'approve', '--origin', 'engine', '--repo', '/repo']])
  expect(h.toasts).toContain('승인을 보내는 중이에요: 361 마무리 댓글 등록')
  expect(h.toasts).toContain('승인을 보냈어요: 361 마무리 댓글 등록')
  expect(await ui.find({ type: 'Button', key: 'approval:post-1:3:approve' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /승인 대기/ })).toBeFalsy()
  await ui.unmount()
})

test('예전 화면의 버튼은 스크립트가 거절하고 toast 가 스펙 문구이며 상자는 그대로다', async ($, on) => {
  const h = await start($, on, { press: () => ({ exitCode: 1, stdout: '', stderr: '내용이 바뀌었어요\n' }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approval:post-1:3:approve' })
  expect(h.toasts).toContain('내용이 바뀌었어요. 새 미리보기를 확인하세요')
  expect(await ui.find({ type: 'Button', key: 'approval:post-1:3:approve' })).toBeTruthy()
  await ui.unmount()
})

test('real 대기는 대상 환경, 바꿀 것, 되돌리는 법을 빨강으로 보이고 두 번 눌러야 신호가 간다', async ($, on) => {
  const h = await start($, on, { approvals: file(entry({ id: 'real-1', kind: 'real', real: { target: 'real DB', change: '컬럼 추가', rollback: '컬럼 삭제' } })) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const text of [/대상 환경: real DB/, /바꿀 것: 컬럼 추가/, /되돌리는 법: 컬럼 삭제/]) expect((await ui.find({ type: 'Text', text })).props.color).toBe('red')
  await ui.press({ key: 'approval:real-1:3:approve' })
  expect(presses(h.calls)).toEqual([])
  expect(h.toasts.some((t) => t.startsWith('real 에 씁니다. 10초 안에 승인을 한 번 더 누르세요'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /10초 안에 「승인」 을 한 번 더 누르세요/ })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'approval:real-1:3:approve' })).props.label).toBe('⚠ 한 번 더 누르세요')
  await ui.press({ key: 'approval:real-1:3:approve' })
  expect(presses(h.calls)).toHaveLength(1)
  expect(presses(h.calls)[0].slice(0, 4)).toEqual(['press', 'real-1', '3', 'approve'])
  await ui.unmount()
})

test('「고쳐 달라」 는 글칸을 열고, 빈 글은 아무것도 부르지 않고 글을 적으면 --note 로 부른다', async ($, on) => {
  const h = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Input' })).toBeFalsy()
  await ui.press({ key: 'approval:post-1:3:revise' })
  // 「고쳐 달라」 버튼은 글칸만 열고 승인이든 고쳐 달라든 press 를 부르지 않는다
  expect(presses(h.calls)).toEqual([])
  const input = await ui.find({ type: 'Input', key: 'approval-note:post-1:3' })
  expect(input.props.label).toBe('고칠 내용')
  await ui.input({ key: 'approval-note:post-1:3', text: '   ' })
  expect(presses(h.calls)).toEqual([])
  expect(await ui.find({ type: 'Input', key: 'approval-note:post-1:3' })).toBeTruthy()
  await ui.input({ key: 'approval-note:post-1:3', text: '제목을 짧게' })
  expect(presses(h.calls)).toEqual([['press', 'post-1', '3', 'revise', '--origin', 'engine', '--repo', '/repo', '--note=제목을 짧게']])
  expect(h.toasts).toContain('고쳐 달라를 보냈어요: 361 마무리 댓글 등록')
  await ui.unmount()
})

const COMMAND = entry({ id: 'cmd-1', kind: 'command', preview: null, command: 'orch ship --approve', then: null })

test('command 대기는 올린 터미널의 창에서 명령 채우기를 그리고 누르면 입력란에 ! 명령을 채운다', async ($, on) => {
  const h = await start($, on, { approvals: file(COMMAND), self: { terminal: 'term_c', worker: false } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'approval:cmd-1:3:approve' })).toBeFalsy()
  await ui.press({ key: 'approval:cmd-1:3:fill' })
  expect(h.filled).toEqual(['! orch ship --approve'])
  expect(presses(h.calls)).toEqual([])
  await ui.unmount()
})

test('command 대기는 다른 터미널의 창에 명령 글만 보이고 버튼이 없다', async ($, on) => {
  const h = await start($, on, { approvals: file(COMMAND), self: { terminal: 'term_other', worker: false } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'approval:cmd-1:3:fill' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /orch ship --approve/ })).toBeTruthy()
  expect(h.filled).toEqual([])
  await ui.unmount()
})

test('미리보기 열기는 open 으로 그 파일을 연다', async ($, on) => {
  const h = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approval:post-1:3:open' })
  const open = h.calls.find((c) => c.argv[0] === 'sh')
  expect(open?.argv.slice(-2)).toEqual(['sh', '/p/361.html'])
  await ui.unmount()
})
