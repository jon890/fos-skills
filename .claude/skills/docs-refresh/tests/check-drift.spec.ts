// check-drift.ts 의 대조 규칙과 install-hook.ts 의 덮어쓰기 규칙을 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { tempDir } from '../../../../modules/testkit/temp.ts'
import {
  boardHotkeys,
  checkBoardHotkeys,
  checkConfig,
  checkEvents,
  checkOrchCommands,
  checkPaths,
  checkReadmeOutline,
  README_OUTLINE,
  checkSkillList,
  pathBases,
  targetDocs,
  eventSpecs,
  sectionTable,
  splitRow,
} from '../scripts/check-drift.ts'
import { install } from '../scripts/install-hook.ts'

const ROOT = join(import.meta.dirname, '../../../..')
const SCRIPT = join(import.meta.dirname, '../scripts/check-drift.ts')

describe('표 읽기', () => {
  test('칸 안의 \\| 는 나누지 않는다', () => assert.deepEqual(splitRow('| a | b \\| c |'), ['a', 'b | c']))

  test('절의 첫 표에서 머리와 구분선을 뺀다', () => {
    const t = sectionTable('# x\n## 표\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c |\n', '표')
    assert.deepEqual(t, { headingLine: 2, rows: [{ line: 6, cells: ['1', '2'] }] })
  })
})

describe('스킬 목록', () => {
  const readme = '## 스킬 목록\n\n| 스킬 | 하는 일 |\n| --- | --- |\n| [`a`](skills/a/README.md) | x |\n| [`b`](skills/b/README.md) | y |\n'

  test('매니페스트와 같으면 어긋남이 없다', () => assert.deepEqual(checkSkillList(readme, ['./skills/a', './skills/b']), []))

  test('빠진 스킬과 남는 행을 모두 알린다', () => {
    const out = checkSkillList(readme, ['./skills/a', './skills/c'])
    assert.deepEqual(out.map((d) => d.line), [1, 6])
    assert.match(out[0].message, /skills\/c/)
    assert.match(out[1].message, /skills\/b/)
  })
})

describe('보드 단축키', () => {
  const keys = boardHotkeys("Button({ hotkey: 's' }), Button({ hotkey: 'q' }), Button({ hotkey: String(index + 1) })")

  test('register.js 의 글자 hotkey 만 모은다', () => assert.deepEqual([...keys], ['s', 'q']))

  test('표에 없는 키와 본문의 없는 키를 알린다', () => {
    const readme = '`c` 를 누르면 번호가 붙어요.\n## 단축키\n\n| 키 | 하는 일 |\n| --- | --- |\n| `s` | 시작 |\n'
    assert.deepEqual(
      checkBoardHotkeys(readme, keys).map((d) => [d.line, d.message.slice(0, 12)]),
      [[2, '단축키 표에 `q` 가'], [1, '`c` 키가 regis']],
    )
  })
})

describe('orch 명령', () => {
  const table = {
    groups: ['worker', 'doctor'],
    resolve: (argv: string[]) =>
      argv[0] === 'doctor' ? { command: {} }
      : argv[1] === 'launch' ? { command: {} }
      : argv[1] === 'nudge' ? { command: { retired: { since: 'x', doc: 'waiting.md' } } }
      : argv[1] === undefined ? { error: '동작이 없다' }
      : { error: `모르는 동작이다: ${argv[1]}` },
  }

  test('모르는 동작과 물러난 명령만 알리고 묶음 이름만 쓴 것은 둔다', () => {
    const md = '`orch worker launch`\n`orch worker spawn`\n`orch worker nudge`\n`orch worker` 묶음\n`orch doctor --run`\n`orch 루트`\n'
    assert.deepEqual(checkOrchCommands(md, table).map((d) => d.line), [2, 3])
  })

  test('코드로 적은 명령의 모르는 묶음을 알리고 본문의 말은 둔다', () => {
    const md = '`orch wroker launch`\norch 루트와 orch wroker 는 본문이다\n```bash\norch slto heavy\n```\n'
    assert.deepEqual(checkOrchCommands(md, table).map((d) => [d.line, d.message]), [
      [1, '`orch wroker` 의 묶음 wroker 가 orch 명령 표에 없다'],
      [4, '`orch slto` 의 묶음 slto 가 orch 명령 표에 없다'],
    ])
  })
})

describe('이벤트 목록', () => {
  const events = eventSpecs("export const EVENTS = Object.freeze({\n  'before-merge': spec(true, LONG),\n  tick: spec(false),\n})\n")

  test('events.ts 의 이름과 거부 여부를 읽는다', () => assert.deepEqual([...events], [['before-merge', true], ['tick', false]]))

  test('없는 이벤트, 틀린 거부 칸, 빠진 이벤트를 알린다', () => {
    const flow = '### 이벤트 목록\n\n| 이벤트 | 명령 | 시점 | 거부 |\n| --- | --- | --- | --- |\n| `before-merge` | m | t | 아니오 |\n| `gone` | m | t | 예 |\n'
    assert.deepEqual(checkEvents(flow, events).map((d) => d.line), [5, 6, 1])
  })
})

describe('config 절', () => {
  test('표의 모르는 키와 표에 없는 키를 알린다', () => {
    const md = '## config.json 에 더하는 절\n\n| 절 | 키 |\n| --- | --- |\n| `board` | `steps`, `old` |\n'
    const out = checkConfig(md, new Map([['board', ['steps', 'task']]]))
    assert.deepEqual(out.map((d) => d.message), ['키 board.old 가 core/config.ts 에 없다', '표에 board.task 가 없다(core/config.ts 에 있다)'])
  })
})

describe('경로', () => {
  const have = new Set(['skills/a/references/x.md', 'skills/orch/scripts/lib/y.ts'])
  const exists = (p: string) => have.has(p)

  test('루트, 문서 폴더, 스킬 폴더 가운데 한 곳에 있으면 둔다', () => {
    const md = '`references/x.md` `scripts/lib/y.ts` `tools/` `skills/<이름>/` `tools/browser-driver` `.claude/z.md`\n```\n`tools/`\n```\n'
    assert.deepEqual(checkPaths(md, ['', 'skills/a', 'skills/orch'], exists).map((d) => d.message), ['경로 tools/ 가 없다'])
  })

  test('스킬 README 는 자기 폴더 기준으로만 풀어 다른 스킬의 같은 경로로 통과하지 않는다', () => {
    const components = ['skills/orch', 'skills/spec']
    const bases = pathBases('skills/spec/README.md', components)
    assert.deepEqual(bases, ['', 'skills/spec'])
    const only = (p: string) => p === 'skills/orch/references/board.md'
    assert.deepEqual(checkPaths('`references/board.md`\n', bases, only).map((d) => d.line), [1])
    assert.deepEqual(pathBases('docs/flow.md', components), ['', 'skills/orch', 'skills/spec'])
  })

  test('README 에서 옮긴 기여 문서도 대조 대상이다', (t) => {
    const root = tempDir('docs-refresh-', t)
    for (const d of ['README.md', 'docs/contributing.md', 'docs/flow.md', 'skills/a/README.md']) {
      mkdirSync(join(root, d, '..'), { recursive: true })
      writeFileSync(join(root, d), '# x\n')
    }
    assert.deepEqual(targetDocs(root), ['README.md', 'docs/contributing.md', 'docs/flow.md', 'skills/a/README.md'])
  })
})

describe('README 뼈대', () => {
  const ok = README_OUTLINE.map((t) => `## ${t}\n\n본문\n`).join('\n')

  test('뼈대대로면 어긋남이 없고 코드 펜스 안의 제목은 보지 않는다', () => {
    assert.deepEqual(checkReadmeOutline(`# x\n\n${ok}\n\`\`\`md\n### 예시\n\`\`\`\n`), [])
  })

  test('하위 절, 뼈대 밖 절, 빠진 절을 알린다', () => {
    const md = ok.replace('## 화면\n', '## 만든 이유\n').replace('## 기여\n\n본문\n', '## 기여\n\n### 고치는 동안\n')
    assert.deepEqual(checkReadmeOutline(md).map((d) => d.message), [
      '하위 절 「고치는 동안」 을 두지 않는다. 상세는 docs/ 로 옮긴다',
      '절 「만든 이유」 이 README 뼈대에 없다. 상세는 docs/ 로 옮긴다',
      'README 뼈대의 절 「화면」 이 없다',
    ])
  })

  test('순서가 다르면 알린다', () => {
    const md = README_OUTLINE.slice().reverse().map((t) => `## ${t}\n`).join('')
    assert.deepEqual(checkReadmeOutline(md).map((d) => d.line), [1])
  })
})

describe('명령', () => {
  test('저장소에 돌면 줄 형식을 지키고 종료 코드가 0 이나 1 이다', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', ROOT], { encoding: 'utf8' })
    assert.ok(r.status === 0 || r.status === 1, r.stderr)
    for (const line of r.stdout.trim().split('\n').filter(Boolean)) assert.match(line, /^DOCS-DRIFT \S+:\d+ \S/)
    assert.equal(r.status === 1, r.stdout.trim() !== '')
  })

  test('모르는 옵션은 2 다', () => assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2))
})

describe('핸들러 설치', () => {
  const source = join(import.meta.dirname, '../hooks/session-resume.ts')

  test('없으면 만들고, 같으면 그대로 두고, 다른 핸들러는 덮지 않는다', (t) => {
    const dir = tempDir('docs-refresh-', t)
    assert.match(install(dir, source).line, /^INSTALLED /)
    assert.match(install(dir, source).line, /^UP-TO-DATE /)
    const target = join(dir, 'hooks', 'session-resume.ts')
    writeFileSync(target, '// 다른 핸들러\n')
    assert.deepEqual(install(dir, source).code, 2)
    assert.equal(readFileSync(target, 'utf8'), '// 다른 핸들러\n')
  })

  test('옛 내용의 자기 핸들러는 새 내용으로 덮는다', (t) => {
    const dir = tempDir('docs-refresh-', t)
    mkdirSync(join(dir, 'hooks'))
    const body = readFileSync(source, 'utf8')
    writeFileSync(join(dir, 'hooks', 'session-resume.ts'), `${body.split('\n')[0]}\n// 옛 내용\n`)
    assert.match(install(dir, source).line, /^INSTALLED /)
    assert.equal(readFileSync(join(dir, 'hooks', 'session-resume.ts'), 'utf8'), body)
  })
})
