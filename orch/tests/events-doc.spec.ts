// 이벤트 이름의 원본(lib/events.ts 의 EVENTS)이 이름을 적은 세 곳과 같은지 본다.
// 세 곳은 docs/flow.md 「이벤트 목록」 표의 첫 열, lib/events.ts 머리 주석 「이벤트별 필드」 블록, orch/references/hooks.md 「이벤트 고르기」 표의 둘째 열이다.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { EVENTS } from '../scripts/lib/events.ts'

const ORCH = fileURLToPath(new URL('..', import.meta.url))
const FLOW = join(ORCH, '..', 'docs', 'flow.md')
const EVENTS_TS = join(ORCH, 'scripts', 'lib', 'events.ts')
const HOOKS = join(ORCH, 'references', 'hooks.md')

const NAME = /`([a-z][a-z-]*)`/g

// 제목 줄 바로 아래부터 다음 제목 전까지의 줄. 제목은 `### 이벤트 목록` 처럼 그대로 준다.
function section(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `${heading} 절이 없다`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#{1,6} /.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

// 표의 데이터 행에서 cell 번째 칸(0 부터)의 백틱 낱말을 모은다. 머리와 구분 행은 백틱 낱말이 없어 저절로 빠진다.
function tableNames(lines: string[], cell: number): string[] {
  const names: string[] = []
  for (const line of lines) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1)
    for (const match of (cells[cell] ?? '').matchAll(NAME)) names.push(match[1])
  }
  return names
}

export function flowNames(file: string): string[] {
  return tableNames(section(readFileSync(file, 'utf8'), '### 이벤트 목록'), 0)
}

export function hooksNames(file: string): string[] {
  return tableNames(section(readFileSync(file, 'utf8'), '## 이벤트 고르기'), 1)
}

// `// 이벤트별 필드` 줄 다음부터 빈 `//` 줄 전까지의 행에서 첫 칸의 이름을 모은다.
// 행은 `//` 뒤 세 칸으로 시작하고, 더 깊게 들여 쓴 줄은 앞 행의 이어지는 줄이라 건너뛴다.
export function headerNames(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.indexOf('// 이벤트별 필드')
  assert.notEqual(start, -1, `${file} 에 「이벤트별 필드」 블록이 없다`)
  const names: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '//' || !line.startsWith('//')) break
    const row = /^\/\/ {3}(\S.*)$/.exec(line)
    if (!row) continue
    const first = row[1].split(/ {2,}/)[0]
    for (const name of first.split(', ')) names.push(name.trim())
  }
  return names
}

// 원본에 있는데 문서에 없는 이름(missing)과, 문서에만 있는 이름(extra)을 정렬해 돌려준다.
export function compare(source: Iterable<string>, documented: string[]): { missing: string[]; extra: string[] } {
  const want = new Set(source)
  const have = new Set(documented)
  return {
    missing: [...want].filter((name) => !have.has(name)).sort(),
    extra: [...have].filter((name) => !want.has(name)).sort(),
  }
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'events-doc-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function copyWith(file: string, edit: (text: string) => string): string {
  const out = join(tmp, 'copy.txt')
  writeFileSync(out, edit(readFileSync(file, 'utf8')))
  return out
}

describe('이벤트 이름 대조', () => {
  test('docs/flow.md 「이벤트 목록」 표가 EVENTS 와 같다', () => {
    assert.deepEqual(compare(Object.keys(EVENTS), flowNames(FLOW)), { missing: [], extra: [] })
  })

  test('lib/events.ts 머리 주석 「이벤트별 필드」 가 EVENTS 와 같다', () => {
    assert.deepEqual(compare(Object.keys(EVENTS), headerNames(EVENTS_TS)), { missing: [], extra: [] })
  })

  test('hooks.md 「이벤트 고르기」 표가 EVENTS 와 같다', () => {
    assert.deepEqual(compare(Object.keys(EVENTS), hooksNames(HOOKS)), { missing: [], extra: [] })
  })

  test('hooks.md 표에서 ci-missing 을 지우면 빠진 이름으로 낸다', () => {
    const file = copyWith(HOOKS, (text) =>
      text
        .split('\n')
        .filter((line) => !(line.startsWith('|') && line.includes('`ci-missing`')))
        .join('\n'),
    )
    assert.deepEqual(compare(Object.keys(EVENTS), hooksNames(file)), { missing: ['ci-missing'], extra: [] })
  })

  test('flow.md 표에 없는 이름을 더하면 남는 이름으로 낸다', () => {
    const file = copyWith(FLOW, (text) =>
      text.replace(/^(\| `tick` .*)$/m, '$1\n| `not-an-event` | `orch-loop` | 시점 | 아니오 | 없음 | 없음 |'),
    )
    assert.deepEqual(compare(Object.keys(EVENTS), flowNames(file)), { missing: [], extra: ['not-an-event'] })
  })

  test('머리 주석의 이어지는 줄에 있는 이벤트 이름 같은 낱말은 이름으로 읽지 않는다', () => {
    const file = join(tmp, 'header.ts')
    writeFileSync(
      file,
      ['// 앞 설명', '//', '// 이벤트별 필드', '//   tick  tick, open_prs', '//       pr 은 번호이고 session-resume 과 무관하다', '//   worker-lost, worker-done  worker', '//', '//   after-merge  이 행은 블록 밖이다', ''].join('\n'),
    )
    assert.deepEqual(headerNames(file), ['tick', 'worker-lost', 'worker-done'])
  })
})
