// 창이 Claude 를 띄운 폴더(시작 폴더)의 저장소를 보이는지 본다(docs/features/board-session-root/spec.md).
// 세션은 /a 에서 떴고 명령이 /b 로 cd 했다. $.session.root() 는 /a, $.session.cwd() 는 /b 다.
import { test, expect } from 'claude-code/testing'

const PANE = {
  plugin: 'fos-skills',
  component: 'Pane',
  requestId: 'work-board',
  props: { title: '작업 현황', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const board = (title: string) => JSON.stringify({ updatedAt: '2026-11-26T10:00:00+09:00', items: [{ id: 'x', title, status: 'doing' }] })
// 폴더마다 보드 파일 하나. /a-wt 는 /a 의 워크트리, /c 는 git 밖 폴더다
const BOARDS: Record<string, string> = {
  '/a/.orch/board.json': board('A 항목'),
  '/a/.omc/board.json': board('A 옛 항목'),
  '/b/.omc/board.json': board('B 항목'),
  '/c/.omc/board.json': board('C 옛 항목'),
  '/home/.orch/board.json': board('홈 항목'),
}
const COMMON: Record<string, string> = { '/a': '/a/.git', '/a-wt': '/a/.git', '/b': '/b/.git' }

type Seen = { runs: { argv: string[]; cwd?: string }[]; reads: string[]; statuses: string[]; toasts: string[] }
async function start($, on, launch: string, moved: string) {
  const seen: Seen = { runs: [], reads: [], statuses: [], toasts: [] }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: launch }))
  on('session.cwd', () => ({ value: moved }))
  on('process.run', (_, e) => {
    seen.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    if (e.argv[0] === 'git' && e.argv.includes('--git-common-dir')) {
      const common = COMMON[e.init?.cwd ?? moved]
      return { value: common ? { exitCode: 0, stdout: common + '\n', stderr: '' } : { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
    }
    if (e.argv[0] === 'node' && e.argv.includes('require("node:os").homedir()')) {
      return { value: { exitCode: 0, stdout: '/home\n', stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '없음' } }
  })
  on('fs.exists', (_, e) => { seen.reads.push(e.path); return { value: Object.hasOwn(BOARDS, e.path) } })
  on('fs.read', (_, e) => { seen.reads.push(e.path); return { value: BOARDS[e.path] ?? '' } })
  on('clock.now', () => ({ value: Date.parse('2026-11-26T10:05:00+09:00') }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.status', (_, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { seen.toasts.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: moved, surface: 'terminal', isInteractive: true })
  return seen
}

const title = async ($, text: string) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = await ui.find({ type: 'Text', text: new RegExp(text) })
  await ui.unmount()
  return found
}

test('REQ1: 다른 저장소로 cd 해도 시작 저장소의 보드를 보이고, 명령은 모두 시작 폴더에서 돈다', async ($, on) => {
  const seen = await start($, on, '/a', '/b')
  expect(await title($, 'A 항목')).toBeTruthy()
  expect(await title($, 'A 옛 항목')).toBeUndefined()
  expect(await title($, 'B 항목')).toBeUndefined()
  expect(seen.reads.filter((path) => path.startsWith('/b/'))).toEqual([])
  expect(seen.runs.length).toBeGreaterThan(0)
  expect(seen.runs.filter((run) => run.cwd !== '/a')).toEqual([])
})

test('REQ2: 시작 폴더가 같은 저장소의 워크트리면 주 checkout 의 보드를 보인다', async ($, on) => {
  const seen = await start($, on, '/a-wt', '/b')
  expect(await title($, 'A 항목')).toBeTruthy()
  expect(seen.reads.filter((path) => path.startsWith('/b/'))).toEqual([])
})

test('git 밖에서 띄운 세션은 홈 보드를 보이고 cd 한 저장소를 읽지 않는다', async ($, on) => {
  const seen = await start($, on, '/c', '/b')
  expect(await title($, '홈 항목')).toBeTruthy()
  expect(await title($, 'C 옛 항목')).toBeUndefined()
  expect(seen.reads.filter((path) => path.startsWith('/b/'))).toEqual([])
})

test('REQ6: 옮겨 가도 상태 줄과 알림에 옮김 문구가 생기지 않는다', async ($, on) => {
  const moved = await start($, on, '/a', '/b')
  const texts = [...moved.statuses, ...moved.toasts].join('\n')
  expect(texts).not.toMatch(/\/b(\/|\s|$)|옮|다른 저장소/)
})
