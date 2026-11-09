// 문서의 표·목록이 코드의 원본과 같은지 본다.
//   - waiting.md 종료 코드 7 의 LOOP-EVENT kind 목록과 코드가 알림 파일에 쓰는 kind
//   - gh-call-budget.md 「공유 캐시」 TTL 표와 lib/gh-budget.ts 의 기본 TTL
// 문서만 고치거나 코드만 고치면 코디네이터가 모르는 알림이 오거나 문서와 다른 시간 동안 캐시가 남는다.

import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readTtl } from '../scripts/lib/gh-budget.ts'

const ORCH = fileURLToPath(new URL('..', import.meta.url))
const read = (...parts: string[]) => readFileSync(join(ORCH, ...parts), 'utf8')

// `## 제목` 줄 아래부터 다음 같은 단계 제목 전까지
function section(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `${heading} 절이 없다`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#{1,2} /.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

test('waiting.md 의 LOOP-EVENT kind 는 코드가 알림 파일에 쓰는 kind 와 같다', () => {
  const doc = new Set<string>()
  let inside = false
  for (const line of read('references', 'waiting.md').split('\n')) {
    if (line.startsWith('- 종료 코드 7')) inside = true
    else if (inside && line.startsWith('- ')) break
    else if (inside) {
      const item = /^ {2}- ((?:`[A-Z][A-Z-]+`(?:, )?)+):/.exec(line)
      if (item) for (const m of item[1].matchAll(/`([A-Z][A-Z-]+)`/g)) doc.add(m[1])
    }
  }
  assert.ok(doc.size > 0, '종료 코드 7 의 kind 목록을 읽지 못했다')

  // 코드가 쓰는 kind: appendEvent, notifyAutoMerge 의 둘째 인자와 report 의 kind 옵션. 줄 머리 주석은 센다
  const code = new Set<string>(['GAP']) // GAP 은 wait-important.ts 가 읽을 때 만든다. 알림 파일에는 쓰지 않는다
  const write = /(?:appendEvent|notifyAutoMerge)\([^,]+,\s*'([A-Z][A-Z-]+)'|\bkind: '([A-Z][A-Z-]+)'/g
  for (const file of globSync('scripts/**/*.ts', { cwd: ORCH })) {
    for (const m of read(file).matchAll(write)) code.add(m[1] ?? m[2])
  }
  assert.ok(code.size > 1, '코드의 kind 를 찾지 못했다')
  assert.match(read('scripts', 'wait', 'wait-important.ts'), /`LOOP-EVENT GAP - /)

  // REMINDER 는 lib/questions.ts 가 줄을 만들고 루프가 알림 파일에 쓴다. 위 정규식이 둘째 인자로 잡는다
  assert.deepEqual([...doc].filter((k) => !code.has(k)).sort(), [], 'waiting.md 에 있고 코드에 없는 kind')
  assert.deepEqual([...code].filter((k) => !doc.has(k)).sort(), [], '코드에 있고 waiting.md 에 없는 kind')
})

test('gh-call-budget.md 의 TTL 표는 gh-budget.ts 의 기본 TTL 과 같다', () => {
  const rows = section(read('references', 'gh-call-budget.md'), '## 공유 캐시').filter((line) => /^\| .*\| \d+초 \|/.test(line))
  const ttl = new Map(rows.map((line) => {
    const cells = line.split('|').map((c) => c.trim())
    return [cells[1], Number(/^(\d+)초$/.exec(cells[2])![1])] as const
  }))
  assert.equal(ttl.size, rows.length, '같은 조회가 표에 두 번 있다')

  const saved = { cache: process.env.ORCH_GH_CACHE, ttl: process.env.ORCH_GH_CACHE_TTL_SECONDS }
  delete process.env.ORCH_GH_CACHE
  delete process.env.ORCH_GH_CACHE_TTL_SECONDS
  try {
    const pick = (prefix: string) => [...ttl].find(([name]) => name.startsWith(prefix))![1]
    // 표 행마다 대표 호출 하나를 코드에 물어 같은 시간인지 본다
    const probes: [string, string[]][] = [
      ['표시·목록용', ['pr', 'view', '1']],
      ['표시·목록용', ['pr', 'list']],
      ['표시·목록용', ['pr', 'checks', '1']],
      ['표시·목록용', ['run', 'list']],
      ['표시·목록용', ['run', 'view', '1']],
      ['표시용 REST GET', ['api', 'repos/o/r/pulls']],
      ['표시용 REST GET', ['api', 'graphql', '-f', 'query=query { viewer { login } }']],
      ['표시용 브랜치 규칙 GET', ['api', 'repos/o/r/rules/branches/main']],
      ['`repo view`', ['repo', 'view']],
    ]
    for (const [row, args] of probes) assert.equal(readTtl(args), pick(row), `${args.join(' ')} 의 TTL 이 표 「${row}」 행과 다르다`)
  } finally {
    for (const [key, value] of [['ORCH_GH_CACHE', saved.cache], ['ORCH_GH_CACHE_TTL_SECONDS', saved.ttl]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
