// 루프 부모의 하루 한 번 모델 감지(scripts/loop/model-watch.ts). 실제 codex 와 gh 는 부르지 않는다.
// codex 는 CODEX_BIN 의 가짜 실행 파일, git 은 임시 저장소와 임시 origin 이다. 루프는 표를 고치거나 PR 을 열지 않는다.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { copyRepo, git, gitEnv } from '../../../modules/testkit/git.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { run } from '../scripts/lib/proc.ts'
import type { RunOptions } from '../scripts/lib/proc.ts'
import { BOARD_SKIPPED, boardWriter, FIRST_COMPARE, newModels, olderList, readWatch, TABLE_PATH, WATCH_MS, watchModels, type Notice } from '../scripts/loop/model-watch.ts'

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

  // 2026-11-22 이 머신의 감지 기록을 덮은 목록이다. codex-cli 0.166.0 이 서버 목록을 받지 못할 때 내는 실행 파일의 기본 목록과 같다
  const BUILT_IN_0166 = [
    entry('gpt-6-astra', 'Frontier intelligence for the most demanding work.'),
    entry('gpt-6.1-sol', 'Latest workhorse model for coding.'),
    entry('gpt-6.1-terra', 'GPT-6.1 Terra Codex model.'),
    entry('gpt-6-sol', 'Previous generation workhorse model.'),
    entry('gpt-6-luna', 'Fast and affordable model for easier tasks.'),
    entry('gpt-daybreak-blue-latest', 'Latest frontier agentic coding model.'),
    entry('gpt-5.5', 'Legacy coding model.'),
  ]

  test('이미 본 세대보다 낡은 목록은 저장된 목록을 덮지 않고 MODEL-LIST-OLDER 로 한 번 알린다', () => {
    const repo = join(tmp, 'other')
    mkdirSync(repo)
    const file = join(tmp, 'machine', 'model-watch.json')
    codexList(TODAY)
    const t0 = Date.parse('2026-11-20T00:00:00Z')
    watch(repo, t0, file)
    codexList(BUILT_IN_0166)
    const notices = watch(repo, t0 + DAY, file)
    assert.deepEqual(notices.map(n => n.kind), ['MODEL-LIST-OLDER'])
    assert.match(notices[0].text, /gpt-6\.2-(sol|astra) 에서 gpt-6(\.1)?-(sol|astra) 로 낮아진/)
    const kept = readWatch(file)
    assert.equal(kept.checked_at, t0 + DAY, '읽은 시각은 써서 하루 한 번을 지킨다')
    assert.deepEqual(kept.models!.map(m => m.slug), TODAY.map(m => m.slug))
    // 24시간 안에는 다시 알리지 않고, 다음 날 지금 목록을 읽으면 그대로 덮는다
    assert.deepEqual(watch(repo, t0 + DAY + 1, file), [])
    codexList([...TODAY, entry('gpt-6.3-sol', 'Next sol.')])
    assert.deepEqual(watch(repo, t0 + 2 * DAY, file).filter(n => n.kind === 'MODEL-LIST-OLDER'), [])
    assert.ok(readWatch(file).models!.some(m => m.slug === 'gpt-6.3-sol'))
  })

  test('감지 기록이 이미 낡은 목록이어도 기준점과 found 의 세대보다 낮으면 막는다. 목록에서 사라진 계열은 보지 않는다', () => {
    const models = (list: ReturnType<typeof entry>[]) => list.map(m => ({ slug: m.slug, visibility: m.visibility, description: m.description, efforts: ['medium'] }))
    // 이 머신의 기록: 기준점에 gpt-6.2-sol, found 에 gpt-6.2-astra, models 는 이미 0.166.0 의 기본 목록
    const machine = { checked_at: 1, baseline: ['gpt-6.2-sol', 'gpt-6.1-sol'], models: models(BUILT_IN_0166), found: ['gpt-6.2-astra'], repos: {} }
    assert.match(olderList(machine, models(BUILT_IN_0166)) ?? '', /gpt-6\.2-/)
    assert.equal(olderList(machine, models(TODAY)), null)
    // 높은 세대가 Previous generation 으로만 남고 현재 세대가 낮아진 목록도 낡은 목록이다(직접 선택 판정과 같은 isCurrent 기준)
    const demoted = [entry('gpt-6.2-sol', 'Previous generation model.'), entry('gpt-6.1-sol', 'Latest workhorse.'), entry('gpt-6.2-astra', 'Most capable.')]
    assert.match(olderList({ ...machine, models: models(TODAY) }, models(demoted)) ?? '', /gpt-6\.2-sol 에서 gpt-6\.1-sol 로 낮아진/)
    // sol 만 남은 목록: astra 계열이 없어진 것은 낡은 목록의 근거로 삼지 않는다
    assert.equal(olderList(machine, models([entry('gpt-6.2-sol', 'Fast.')])), null)
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
    assert.equal(boardWriter(bare, exec)('x', 'y'), BOARD_SKIPPED)
  })

})

describe('보드 다시 쓰기', () => {
  test('보드 쓰기에 실패한 모델은 다음에 목록을 읽을 때 보드 쓰기만 다시 한다', () => {
    const a = join(tmp, 'a')
    mkdirSync(a)
    codexList(TODAY)
    const written: string[] = []
    let fail = true
    const board = (id: string) => { if (fail) return 'locked'; written.push(id); return null }
    assert.deepEqual(watch(a, 0, undefined, board).map(n => n.kind), ['MODEL-NEW', 'MODEL-BOARD-FAIL'])
    fail = false
    assert.deepEqual(watch(a, DAY, undefined, board), [])
    assert.deepEqual(written, ['model-new-gpt-6-2-astra'])
    assert.deepEqual(watch(a, 2 * DAY, undefined, board), [])
    assert.deepEqual(written, ['model-new-gpt-6-2-astra'])
  })
})

describe('낡은 표 행', () => {
  const NEXT = [...TODAY, entry('gpt-6.3-sol', 'Fast, go-to model for coding.')]
  const SOL_ROWS = (readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8').split('\n## 모델\n')[1].split('\n#')[0])
    .split('\n').filter(line => line.startsWith('| `') && line.includes('`gpt-6.2-sol`')).map(line => line.split('|')[1].trim().replace(/`/g, ''))

  test('옛 세대를 가리키는 행마다 MODEL-TABLE-STALE 을 한 번 보내고 새 세대마다 보드 항목 하나를 더한다', () => {
    const repo = join(tmp, 'other')
    mkdirSync(repo)
    codexList(NEXT)
    const written: string[] = []
    const board = (id: string, title: string) => { written.push(`${id} ${title}`); return null }
    const stale = watch(repo, 0, undefined, board).filter(n => n.kind === 'MODEL-TABLE-STALE')
    assert.ok(SOL_ROWS.length > 0)
    assert.deepEqual(stale.map(n => n.text), SOL_ROWS.map(row => `${row} gpt-6.2-sol → gpt-6.3-sol`))
    assert.deepEqual(written.filter(w => w.startsWith('model-table-')), ['model-table-gpt-6-3-sol 모델 표를 gpt-6.3-sol 로 바꿀 때'])
    // 같은 내용은 다시 알리지 않는다
    assert.deepEqual(watch(repo, DAY, undefined, board), [])
    assert.equal(written.length, 2)
  })

  test('표 문서가 있는 저장소는 표를 고치지 않고, 다른 체크아웃이 기본 브랜치에 더한 옛 세대 행도 받아 알린다', () => {
    const { dir: repo, origin } = copyRepo(join(tmp, 'fos'))
    mkdirSync(join(repo, 'skills/orch/references'), { recursive: true })
    writeFileSync(join(repo, TABLE_PATH), readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8'))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'table'])
    git(repo, ['push', '-q', 'origin', 'main'])
    codexList(NEXT)
    const head = git(origin, ['rev-parse', 'main'])
    assert.equal(watch(repo, 0, undefined, () => null).filter(n => n.kind === 'MODEL-TABLE-STALE').length, SOL_ROWS.length)
    // 루프는 브랜치를 만들거나 올리지 않는다
    assert.equal(git(origin, ['rev-parse', 'main']), head)
    assert.equal(git(origin, ['branch', '--list']).split('\n').filter(Boolean).length, 1)
    // 다른 체크아웃이 옛 세대를 쓰는 행을 더했다
    const other = join(tmp, 'other-checkout')
    git(tmp, ['clone', '-q', origin, other])
    const file = join(other, TABLE_PATH)
    const text = readFileSync(file, 'utf8')
    const row = text.split('\n').find(line => line.startsWith('| `impl-explore` |'))!
    writeFileSync(file, text.replace(row, `${row}\n${row.replace('`impl-explore`', '`impl-new`')}`))
    git(other, ['commit', '-qam', 'new row'])
    git(other, ['push', '-q', 'origin', 'main'])
    assert.deepEqual(watch(repo, DAY, undefined, () => null), [{ kind: 'MODEL-TABLE-STALE', text: 'impl-new gpt-6.2-sol → gpt-6.3-sol' }])
  })

  test('작업 브랜치만 받은 체크아웃도 기본 브랜치를 받아 그 표를 본다', () => {
    const { dir: repo, origin } = copyRepo(join(tmp, 'fos'))
    mkdirSync(join(repo, 'skills/orch/references'), { recursive: true })
    writeFileSync(join(repo, TABLE_PATH), readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8'))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'table'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['push', '-q', 'origin', 'main:work'])
    const single = join(tmp, 'single')
    git(tmp, ['clone', '-q', '--single-branch', '--branch', 'work', origin, single])
    // 기본 브랜치에만 옛 세대 행이 더해졌다
    const file = join(repo, TABLE_PATH)
    const text = readFileSync(file, 'utf8')
    const row = text.split('\n').find(line => line.startsWith('| `impl-explore` |'))!
    writeFileSync(file, text.replace(row, `${row}\n${row.replace('`impl-explore`', '`impl-new`')}`))
    git(repo, ['commit', '-qam', 'new row'])
    git(repo, ['push', '-q', 'origin', 'main'])
    codexList(NEXT)
    const stale = watch(single, 0, undefined, () => null).filter(n => n.kind === 'MODEL-TABLE-STALE').map(n => n.text)
    assert.ok(stale.includes('impl-new gpt-6.2-sol → gpt-6.3-sol'))
  })

  test('보드가 없어 건너뛴 항목은 기록하지 않아, 보드를 나중에 만들면 다음에 목록을 읽을 때 더한다. Run 알림은 한 번이다', () => {
    const repo = join(tmp, 'other')
    mkdirSync(repo)
    codexList(NEXT)
    const written: string[] = []
    let ready = false
    const board = (id: string) => { if (!ready) return BOARD_SKIPPED; written.push(id); return null }
    assert.ok(watch(repo, 0, undefined, board).some(n => n.kind === 'MODEL-TABLE-STALE'))
    assert.deepEqual(written, [])
    ready = true
    assert.deepEqual(watch(repo, DAY, undefined, board), [])
    assert.deepEqual(written.sort(), ['model-new-gpt-6-2-astra', 'model-table-gpt-6-3-sol'])
  })
})
