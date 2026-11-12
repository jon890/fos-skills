// 진입 스크립트가 명령 묶음과 같은 폴더(scripts/<묶음>/)에 있고, 저장소 안에 옛 배치(scripts/<파일>.ts)를 가리키는 경로가 남지 않는지 본다.
// 스펙: docs/features/orch-cli/spec.md 의 REQ9, DECISION6. 다른 저장소의 직접 경로 호출은 doctor 의 DIRECT-PATH 가 본다.
//
// 기록 문서(ADR, 기능 문서, 변경 이력과 조각)는 그때의 배치를 적은 것이라 보지 않는다. tests/ 아래 파일은 옛 경로를 판정하는 입력을 갖고 있어 보지 않는다.
// 절 참조 검사는 ADR 의 「적용 범위」 줄도 본다. 이 줄은 현재 규칙의 원본을 가리킨다.
// 호환을 설명하는 줄은 그 줄이나 바로 윗줄의 orch-compat 표지로 뺀다(doctor 와 같은 표지).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
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

// 절은 맨 위의 연속된 // 주석에서만 찾는다. 본문이나 옮긴 곳을 안내하는 문장으로 통과시키지 않는다.
function headerSections(text: string): string[] {
  const rows = text.replace(/^#![^\n]*\n/, '').split('\n')
  const header: string[] = []
  for (const row of rows) {
    if (!row.startsWith('//')) break
    header.push(row.replace(/^\/\/\s*(?:-\s+)?/, ''))
  }
  return header
}

function hasSection(text: string, section: string): boolean {
  return headerSections(text).some((row) => row.startsWith(section)
    && /^(?:[:：(]|\s{2,}|$)/.test(row.slice(section.length)))
}

function headerPointerErrors(source: string, text: string, scripts: Map<string, string>): string[] {
  const errors: string[] = []
  const pointer = /(?:`([^`\s]+\.ts)`|([\w./-]+\.ts))\s+머리 주석의\s+((?:「[^」]+」)(?:\s*(?:와|과|,)\s*「[^」]+」)*)/g
  // 줄바꿈은 남겨 매치가 시작한 원래 줄을 알린다. 주석 기호만 빼야 다음 줄의 절도 읽힌다.
  const content = text.split('\n').map((row) => row.replace(/^\s*\/\/[^\S\n]*/, '')).join('\n')
  for (const match of content.matchAll(pointer)) {
    const line = content.slice(0, match.index).split('\n').length
    const target = match[1] ?? match[2]
    const local = relative(ROOT, resolve(dirname(join(ROOT, source)), target))
    const candidates = [...scripts.keys()].filter((file) => file === target || file.endsWith(`/${target}`))
    const file = scripts.has(local) ? local : candidates.length === 1 ? candidates[0] : undefined
    for (const section of match[3].matchAll(/「([^」]+)」/g)) {
      if (!file || !hasSection(scripts.get(file)!, section[1])) {
        errors.push(`${source}:${line}: ${target} 의 「${section[1]}」 절을 파일 맨 위 설명에서 찾을 수 없다`)
      }
    }
  }
  return errors
}

describe('스크립트 폴더', () => {
  test('명령 표의 모든 스크립트가 그 행의 묶음 폴더에 있다', () => {
    for (const c of COMMANDS) {
      assert.equal(dirname(c.script), c.group, c.script)
      assert.ok(existsSync(join(SCRIPTS, c.script)), c.script)
    }
  })

  test('scripts 바로 아래에는 .ts 가 없고 폴더는 묶음, core, lib, handlers 뿐이다', () => {
    const entries = readdirSync(SCRIPTS)
    assert.deepEqual(entries.filter((n) => n.endsWith('.ts')), [])
    // __pycache__ 는 python3 이 orch-doctor.py 를 돌릴 때 남기는 캐시다(git 이 무시한다)
    const dirs = entries.filter((n) => n !== '__pycache__' && statSync(join(SCRIPTS, n)).isDirectory()).sort()
    assert.deepEqual(dirs, [...GROUPS, 'core', 'handlers', 'lib'].sort())
  })

  test('묶음 폴더의 .ts 는 명령 표의 스크립트이거나 그 스크립트가 부르는 보조 스크립트다', () => {
    // 명령 표에 넣지 않는 보조 스크립트와 그 이유
    const helpers: Record<string, string> = {
      'cleanup/legacy-notices.ts': 'cleanup-sweep 가 옛 알림을 이전할 때 부르는 단계다. 직접 실행하지 않는다',
      'loop/completion-watch.ts': 'orch-loop 가 완료 보고를 확인할 때 부르는 단계다. 직접 실행하지 않는다',
      'loop/lifecycle.ts': 'orch-loop 가 부르는 루프의 시작·멈춤·잠금과 틱 자식을 띄우는 부모다. 직접 실행하지 않는다',
      'worker/resume-exec.ts': 'worker/resume-worker.ts 가 연 새 터미널의 셸이 부르는 실행기다. 코디네이터가 직접 부르지 않는다',
    }
    const found = GROUPS.flatMap((g) => readdirSync(join(SCRIPTS, g)).filter((n) => n.endsWith('.ts')).map((n) => `${g}/${n}`)).sort()
    assert.deepEqual(found, [...FILES, ...Object.keys(helpers)].sort())
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

  test('파일 맨 위 설명의 절을 가리키는 코드와 문서의 참조가 유효하다', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    const scripts = new Map(tracked.filter((f) => /^skills\/orch\/scripts\/.*\.ts$/.test(f))
      .map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
    const sources = tracked.filter((f) => (!SKIP.some((re) => re.test(f)) || f.startsWith('docs/adr/'))
      && (/^skills\/orch\/(?:scripts|references)\//.test(f) || f.startsWith('docs/'))
      && /\.(?:md|ts|js|py|sh)$/.test(f))
    const errors = sources.flatMap((f) => {
      const raw = readFileSync(join(ROOT, f), 'utf8')
      const text = f.startsWith('docs/adr/')
        ? raw.split('\n').map((row) => row.includes('**적용 범위**') ? row : '').join('\n') : raw
      // 스크립트에서는 주석만 본다. 문자열 입력은 참조가 아니다.
      const comments = f.endsWith('.md') ? text : text.split('\n').map((row) => /^\s*\/\//.test(row) ? row : '').join('\n')
      return headerPointerErrors(f, comments, scripts)
    })
    assert.deepEqual(errors, [])
  })

  test('절 검사에서 본문과 참조 문장은 제외하고 파일과 줄을 알린다', () => {
    const scripts = new Map([
      ['skills/orch/scripts/lib/sample.ts', '// 실제 절: 설명\n//   - 세부 함수  설명\n\n// 사라진 절: 본문\n'],
      ['skills/orch/scripts/core/sample.ts', '// 옮긴 곳의 설명이다. 「사라진 절」 을 참조한다\n'],
    ])
    const source = 'skills/orch/scripts/lib/caller.ts'
    const text = '// sample.ts 머리 주석의 「실제 절」 와 「세부 함수」\n// lib/sample.ts 머리 주석의 「사라진 절」\n// `missing.ts` 머리 주석의 「없는 절」\n// `../lib/sample.ts` 머리 주석의 「실제 절」'
    assert.deepEqual(headerPointerErrors(source, text, scripts), [
      `${source}:2: lib/sample.ts 의 「사라진 절」 절을 파일 맨 위 설명에서 찾을 수 없다`,
      `${source}:3: missing.ts 의 「없는 절」 절을 파일 맨 위 설명에서 찾을 수 없다`,
    ])
    assert.equal(hasSection(scripts.get('skills/orch/scripts/core/sample.ts')!, '사라진 절'), false)
    assert.equal(hasSection('// 기록 형식은 다른 파일을 따른다\n', '기록'), false)
    assert.equal(hasSection('#!/usr/bin/env node\n// 기록: 설명\n', '기록'), true)
  })

  test('줄이 나뉜 코드 주석과 문서 참조도 시작 줄을 알린다', () => {
    const scripts = new Map([['skills/orch/scripts/lib/sample.ts', '// 실제 절: 설명\n']])
    for (const prefix of ['// ', '']) {
      const text = `${prefix}설명\n${prefix}lib/sample.ts 머리 주석의\n${prefix}「없는 절」 와\n${prefix}「실제 절」`
      assert.deepEqual(headerPointerErrors('docs/example.md', text, scripts), [
        'docs/example.md:2: lib/sample.ts 의 「없는 절」 절을 파일 맨 위 설명에서 찾을 수 없다',
      ])
    }
  })

})
