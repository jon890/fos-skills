// 루프 부모의 하루 한 번 모델 감지(scripts/loop/model-watch.ts). 실제 codex 와 gh 는 부르지 않는다.
// codex 는 CODEX_BIN 의 가짜 실행 파일, gh 는 GH 의 가짜 실행 파일, git 은 임시 저장소와 임시 origin 이다.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { copyRepo, git, gitEnv } from '../../../modules/testkit/git.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { run } from '../scripts/lib/proc.ts'
import type { RunOptions } from '../scripts/lib/proc.ts'
import { boardWriter, FIRST_COMPARE, newModels, readWatch, TABLE_PATH, WATCH_MS, watchModels, type Notice } from '../scripts/loop/model-watch.ts'

const DAY = WATCH_MS
const entry = (slug: string, description: string, visibility = 'list') => ({ slug, visibility, description, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] })
// 2026-11-20 의 목록 모양. gpt-6.2-astra 는 기준점에 넣지 않는 첫 비교 대상이다
const TODAY = [
  entry('gpt-6.2-sol', 'Fast, go-to model for coding and everyday work.'),
  entry('gpt-6.2-astra', 'Our most capable model for complex coding and professional work.'),
  entry('gpt-6.1-terra', 'Efficient model that excels at visual understanding and computer use.'),
  entry('gpt-6.1-sol', 'Previous generation model for coding and everyday work.'),
  entry('gpt-6-sol', 'Legacy model for coding and everyday work.'),
  entry('gpt-6-luna', 'Fast and affordable model for easier tasks.'),
  entry('gpt-reserve', 'Hidden.', 'hide'),
]

let tmp: string
let saved: NodeJS.ProcessEnv

beforeEach(() => {
  tmp = tempDir('model-watch-')
  saved = { ...process.env }
})
afterEach(() => {
  process.env = saved
})

function codexList(models: unknown[], code = 0): void {
  process.env.CODEX_BIN = linkBin(tmp, 'codex', `console.log(${JSON.stringify(JSON.stringify({ models }))}); process.exit(${code})`)
}

const exec = (argv: string[], opts: RunOptions = {}) => run(argv, { ...opts, env: { ...(gitEnv() as Record<string, string>), ...opts.env } })

function watch(repo: string, now: number, file = join(tmp, 'machine', 'model-watch.json'), board?: (id: string, title: string) => string | null): Notice[] {
  const notices: Notice[] = []
  watchModels(repo, { stateFile: file, now, exec, notify: (n) => notices.push(n), ...(board ? { board } : {}) })
  return notices
}

describe('새 모델', () => {
  test('첫 목록을 기준점으로 두고 FIRST_COMPARE 만 새 모델로 알린다', () => {
    const state = newModels({ checked_at: null, baseline: null, models: null, found: [], repos: {} }, TODAY.map(m => ({ slug: m.slug, visibility: m.visibility, description: m.description, efforts: ['low'] })))
    assert.deepEqual(FIRST_COMPARE, ['gpt-6.2-astra'])
    assert.ok(!state.baseline!.includes('gpt-6.2-astra'))
    assert.ok(state.baseline!.includes('gpt-6.2-sol'))
    assert.ok(!state.baseline!.includes('gpt-reserve'))
    assert.deepEqual(state.found, ['gpt-6.2-astra'])
  })

  test('하루 한 번 보고, 같은 모델은 한 번만 알리고, 그 뒤 나타난 현재 세대만 알린다', () => {
    const repo = join(tmp, 'other')
    mkdirSync(repo)
    codexList(TODAY)
    const t0 = Date.parse('2026-11-20T00:00:00Z')
    assert.deepEqual(watch(repo, t0).map(n => n.kind), ['MODEL-NEW'])
    // 24시간 안에는 목록을 다시 읽지 않는다
    codexList([...TODAY, entry('gpt-6.2-nova', 'New family.')])
    assert.deepEqual(watch(repo, t0 + DAY - 1), [])
    const next = watch(repo, t0 + DAY)
    assert.deepEqual(next, [{ kind: 'MODEL-NEW', text: 'gpt-6.2-nova New family.' }])
    // 옛 세대로 표시된 모델과 숨긴 모델은 새 모델이 아니다
    codexList([...TODAY, entry('gpt-6.2-nova', 'New family.'), entry('gpt-5-old', 'Legacy model.'), entry('gpt-x', 'Hidden.', 'hide')])
    assert.deepEqual(watch(repo, t0 + 2 * DAY), [])
  })

  test('codex 가 없거나 실패해도 알리지 않고 다음 날 다시 본다', () => {
    const repo = join(tmp, 'other')
    mkdirSync(repo)
    process.env.CODEX_BIN = join(tmp, 'missing-codex')
    const file = join(tmp, 'machine', 'model-watch.json')
    assert.deepEqual(watch(repo, 1000, file), [])
    assert.equal(readWatch(file).checked_at, 1000)
    assert.equal(readWatch(file).baseline, null)
    codexList(TODAY)
    assert.deepEqual(watch(repo, 2000, file), [])
    assert.deepEqual(watch(repo, 1000 + DAY, file).map(n => n.kind), ['MODEL-NEW'])
  })
})

describe('새 세대와 표 문서', () => {
  const NEXT = [...TODAY, entry('gpt-6.3-sol', 'Fast, go-to model for coding.')]

  test('표 문서가 없는 저장소는 번들 표와 비교해 MODEL-GENERATION 만 한 번 보낸다', () => {
    const repo = join(tmp, 'other')
    mkdirSync(repo)
    codexList(NEXT)
    const notices = watch(repo, 0)
    assert.deepEqual(notices.filter(n => n.kind === 'MODEL-GENERATION'), [{ kind: 'MODEL-GENERATION', text: 'gpt-6.2-sol gpt-6.3-sol' }])
    assert.deepEqual(watch(repo, DAY).filter(n => n.kind === 'MODEL-GENERATION'), [])
  })

  test('표 문서가 있는 저장소는 표를 새 세대로 바꾸는 PR 을 열고 같은 바꿈은 다시 열지 않는다', () => {
    const { dir: repo, origin } = copyRepo(join(tmp, 'fos'))
    const table = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
    mkdirSync(join(repo, 'skills/orch/references'), { recursive: true })
    writeFileSync(join(repo, TABLE_PATH), table)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'table'])
    git(repo, ['push', '-q', 'origin', 'main'])
    const calls = join(tmp, 'gh-calls')
    process.env.GH = linkBin(tmp, 'gh', `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('https://github.com/o/r/pull/9')`)
    codexList(NEXT)
    const notices = watch(repo, 0)
    assert.deepEqual(notices.filter(n => n.kind.startsWith('MODEL-TABLE')), [{ kind: 'MODEL-TABLE-PR', text: 'https://github.com/o/r/pull/9 gpt-6.2-sol>gpt-6.3-sol' }])
    const branch = 'orch/model-table-gpt-6.3-sol'
    const pushed = git(origin, ['show', `${branch}:${TABLE_PATH}`])
    assert.match(pushed, /\| `impl-explore` \| [^|]+\| `codex` \| `gpt-6\.3-sol` \| `medium` \|/)
    assert.doesNotMatch(pushed.split('### 새 모델과 새 세대')[0], /`gpt-6\.2-sol`/)
    assert.match(git(origin, ['show', `${branch}:skills/orch/changes/model-table-gpt-6.3-sol.patch.md`]), /모델 표의 `gpt-6\.2-sol` 을 `gpt-6\.3-sol` 로 바꿨다/)
    const gh = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(gh[0].slice(0, 6), ['pr', 'create', '--base', 'main', '--head', branch])
    // 임시 워크트리와 로컬 브랜치는 남기지 않는다
    assert.equal(git(repo, ['worktree', 'list']).split('\n').length, 1)
    assert.equal(git(repo, ['branch', '--list', branch]), '')
    // 다음 날은 같은 바꿈을 다시 하지 않는다
    assert.deepEqual(watch(repo, DAY).filter(n => n.kind.startsWith('MODEL-TABLE')), [])
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1)
  })

  test('PR 을 열지 못하면 MODEL-TABLE-FAIL 을 보내고 기록하지 않는다', () => {
    const { dir: repo } = copyRepo(join(tmp, 'fos'))
    mkdirSync(join(repo, 'skills/orch/references'), { recursive: true })
    writeFileSync(join(repo, TABLE_PATH), readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8'))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'table'])
    git(repo, ['push', '-q', 'origin', 'main'])
    process.env.GH = linkBin(tmp, 'gh', `console.error('auth required'); process.exit(1)`)
    codexList(NEXT)
    const file = join(tmp, 'machine', 'model-watch.json')
    const notices = watch(repo, 0, file)
    assert.deepEqual(notices.filter(n => n.kind.startsWith('MODEL-TABLE')), [{ kind: 'MODEL-TABLE-FAIL', text: 'gpt-6.2-sol>gpt-6.3-sol: gh pr create 실패: auth required' }])
    assert.deepEqual(readWatch(file).repos[repo].tables, {})
  })
})

describe('보드와 여러 저장소', () => {
  test('새 모델을 보드에 「새 모델 <이름>」 decide 항목으로 더하고 저장소마다 한 번 알린다', () => {
    const a = join(tmp, 'a')
    const b = join(tmp, 'b')
    mkdirSync(a)
    mkdirSync(b)
    codexList(TODAY)
    const written: string[] = []
    const board = (id: string, title: string) => { written.push(`${id} ${title}`); return null }
    assert.deepEqual(watch(a, 0, undefined, board).map(n => n.kind), ['MODEL-NEW'])
    // 다른 저장소의 루프는 목록을 다시 읽지 않고 저장된 목록으로 자기 보드에 알린다
    process.env.CODEX_BIN = join(tmp, 'missing-codex')
    assert.deepEqual(watch(b, 1000, undefined, board).map(n => n.kind), ['MODEL-NEW'])
    assert.deepEqual(written, ['model-new-gpt-6-2-astra 새 모델 gpt-6.2-astra', 'model-new-gpt-6-2-astra 새 모델 gpt-6.2-astra'])
    assert.deepEqual(watch(a, 2000, undefined, board), [])
    assert.equal(written.length, 2)
  })

  test('보드에 쓰지 못하면 MODEL-BOARD-FAIL 로 알린다', () => {
    const a = join(tmp, 'a')
    mkdirSync(a)
    codexList(TODAY)
    const notices = watch(a, 0, undefined, () => 'locked')
    assert.deepEqual(notices.map(n => n.kind), ['MODEL-NEW', 'MODEL-BOARD-FAIL'])
    assert.equal(notices[1].text, 'gpt-6.2-astra: locked')
  })

  test('기본 보드 기록은 그 저장소의 보드 파일에 항목을 더한다. 보드 파일이 없으면 건너뛴다', () => {
    const { dir: repo } = copyRepo(join(tmp, 'boarded'))
    const file = join(repo, '.omc', 'board.json')
    mkdirSync(join(repo, '.omc'))
    writeFileSync(file, JSON.stringify({ updatedAt: new Date(0).toISOString(), items: [] }))
    assert.equal(boardWriter(repo, exec)('model-new-gpt-6-3-sol', '새 모델 gpt-6.3-sol'), null)
    const item = JSON.parse(readFileSync(file, 'utf8')).items.find((i: { id: string }) => i.id === 'model-new-gpt-6-3-sol')
    assert.deepEqual([item?.status, item?.title], ['decide', '새 모델 gpt-6.3-sol'])
    const bare = join(tmp, 'bare')
    mkdirSync(bare)
    assert.equal(boardWriter(bare, exec)('x', 'y'), null)
  })

  test('다른 저장소의 루프가 먼저 목록을 읽어도 fos-skills 의 루프가 그 목록으로 표 PR 을 연다', () => {
    const other = join(tmp, 'other')
    mkdirSync(other)
    const { dir: repo } = copyRepo(join(tmp, 'fos'))
    mkdirSync(join(repo, 'skills/orch/references'), { recursive: true })
    writeFileSync(join(repo, TABLE_PATH), readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8'))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'table'])
    git(repo, ['push', '-q', 'origin', 'main'])
    process.env.GH = linkBin(tmp, 'gh', `console.log('https://github.com/o/r/pull/10')`)
    codexList([...TODAY, entry('gpt-6.3-sol', 'Fast, go-to model.')])
    assert.deepEqual(watch(other, 0).filter(n => n.kind.startsWith('MODEL-TABLE')), [])
    const notices = watch(repo, 1000)
    assert.deepEqual(notices.filter(n => n.kind.startsWith('MODEL-TABLE')), [{ kind: 'MODEL-TABLE-PR', text: 'https://github.com/o/r/pull/10 gpt-6.2-sol>gpt-6.3-sol' }])
  })
})
