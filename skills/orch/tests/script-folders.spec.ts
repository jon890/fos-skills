// 진입 스크립트가 명령 묶음과 같은 폴더(scripts/<묶음>/)에 있고, 저장소 안에 옛 배치(scripts/<파일>.ts)를 가리키는 경로가 남지 않는지 본다.
// 스펙: docs/features/orch-cli/spec.md 의 REQ9, DECISION6. 다른 저장소의 직접 경로 호출은 doctor 의 DIRECT-PATH 가 본다.
//
// 기록 문서(ADR, 기능 문서, 변경 이력과 조각)는 그때의 배치를 적은 것이라 보지 않는다. tests/ 아래 파일은 옛 경로를 판정하는 입력을 갖고 있어 보지 않는다.
// 호환을 설명하는 줄은 그 줄이나 바로 윗줄의 orch-compat 표지로 뺀다(doctor 와 같은 표지).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMMANDS, GROUPS } from '../scripts/lib/commands.ts'

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url)).replace(/\/$/, '')
const ROOT = resolve(SCRIPTS, '..', '..', '..')
const FILES = [...new Set(COMMANDS.map((c) => c.script))].sort()
const SKIP = [/^docs\/adr\//, /^docs\/features\//, /(^|\/)CHANGELOG\.md$/, /(^|\/)changes\//, /(^|\/)tests\//]

function marked(rows: string[], i: number): boolean {
  return rows[i].includes('orch-compat') || (i > 0 && rows[i - 1].includes('orch-compat'))
}

describe('스크립트 폴더', () => {
  test('명령 표의 모든 스크립트가 그 행의 묶음 폴더에 있다', () => {
    for (const c of COMMANDS) {
      assert.equal(dirname(c.script), c.group, c.script)
      assert.ok(existsSync(join(SCRIPTS, c.script)), c.script)
    }
  })

  test('scripts 바로 아래에는 .ts 가 없고 폴더는 묶음, lib, handlers 뿐이다', () => {
    const entries = readdirSync(SCRIPTS)
    assert.deepEqual(entries.filter((n) => n.endsWith('.ts')), [])
    // __pycache__ 는 python3 이 orch-doctor.py 를 돌릴 때 남기는 캐시다(git 이 무시한다)
    const dirs = entries.filter((n) => n !== '__pycache__' && statSync(join(SCRIPTS, n)).isDirectory()).sort()
    assert.deepEqual(dirs, [...GROUPS, 'handlers', 'lib'].sort())
  })

  test('묶음 폴더의 .ts 는 모두 명령 표의 스크립트다', () => {
    const found = GROUPS.flatMap((g) => readdirSync(join(SCRIPTS, g)).filter((n) => n.endsWith('.ts')).map((n) => `${g}/${n}`)).sort()
    assert.deepEqual(found, FILES)
  })

  test('옮긴 스크립트가 자기 위치 기준으로 적은 파일 경로가 모두 있다', () => {
    // 테스트는 다른 스크립트 경로를 환경 변수로 덮어 이 경로를 실행하지 않는다. 묶음이 다른 스크립트와 다른 스킬 파일을 여기서 본다
    const forms = [
      /\$\{HERE\}\/([^`'"\s]+)/g,
      /resolve\(HERE,\s*'([^']+)'\)/g,
      /new URL\('(\.[^']+)',\s*import\.meta\.url\)/g,
      /^import [^'\n]*'(\.\.?\/[^']+)'/gm,
      // join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', …) 처럼 조각을 나열한 꼴
      /(?:join|resolve)\(dirname\(fileURLToPath\(import\.meta\.url\)\),\s*((?:'[^']+'\s*,?\s*)+)\)/g,
    ]
    const missing: string[] = []
    for (const file of [...FILES, ...readdirSync(join(SCRIPTS, 'handlers')).map((n) => `handlers/${n}`)]) {
      const text = readFileSync(join(SCRIPTS, file), 'utf8')
      for (const form of forms) {
        for (const m of text.matchAll(form)) {
          const rel = m[1].startsWith("'") ? join(...[...m[1].matchAll(/'([^']+)'/g)].map((p) => p[1])) : m[1]
          if (!existsSync(resolve(SCRIPTS, dirname(file), rel))) missing.push(`${file}: ${m[1]}`)
        }
      }
    }
    assert.deepEqual(missing, [])
  })

  test('저장소의 코드와 문서가 옛 배치 경로(scripts/<파일>.ts)를 가리키지 않는다', () => {
    const names = [...new Set(FILES.map((f) => basename(f, '.ts')))].sort((a, b) => b.length - a.length)
    // scripts/<이름>.ts 와 $ORCH_SCRIPTS/<이름>.ts, join(ORCH_SCRIPTS, '<이름>.ts') 꼴
    const old = new RegExp(`(?:(?<![\\w-])scripts/|ORCH_SCRIPTS\\}?/|ORCH_SCRIPTS\\s*,\\s*['"])(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\.ts\\b`)
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    const found: string[] = []
    for (const rel of tracked) {
      if (SKIP.some((re) => re.test(rel)) || !/\.(?:md|ts|js|json|py|sh|ya?ml)$/.test(rel)) continue
      let text: string
      try {
        text = readFileSync(join(ROOT, rel), 'utf8')
      } catch {
        continue
      }
      const rows = text.split('\n')
      rows.forEach((row, i) => {
        if (old.test(row) && !marked(rows, i)) found.push(`${rel}:${i + 1}`)
      })
    }
    assert.deepEqual(found, [], '스크립트는 scripts/<묶음>/<파일>.ts 에 있다. 호환 설명이면 그 줄이나 윗줄에 orch-compat 를 둔다')
  })
})
