// 명령 경계로 관측되지 않는 내부 함수 테스트. Python 표준 라이브러리 동작을 옮긴 helper 와 공용 모듈의 판정을 본다.
// 명령 경계 테스트(*.spec.ts)가 두 구현에서 같은 결과를 내는지 보고, 이 파일은 TypeScript 구현의 내부를 본다.

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { write } from './helpers.ts'
import { parseCli, UsageError } from '../scripts/cli.ts'
import { isRelativeTo, parsePyInt, pathName, pathParents, pathStem, pathSuffix, pjoin, pyPath, pyRepr, pyResolve, pyre, relativeTo, walk } from '../scripts/pylike.ts'
import { DateError, defaultProjectsDir, isSubagent, parseSince, redact, sessionId, shortId } from '../scripts/session_log.ts'
import { countScripts, isTarget, iterTargets, resolveScope, takeScope } from '../scripts/target_files.ts'

describe('pylike', () => {
  test('pyre 는 \\s 를 Python 의 공백 집합으로 바꾼다', () => {
    const re = pyre(/^a\sb$/u)
    for (const sp of [' ', '\t', ' ', '　', '\x1f', '\x85']) assert.ok(re.test(`a${sp}b`), JSON.stringify(sp))
    assert.ok(!re.test('a﻿b'))
    assert.ok(pyre(/\S+/u).test('x'))
    assert.ok(!pyre(/^\S$/u).test('\x1f'))
  })

  test('경로 helper 는 pathlib 의 이름, 확장자, 부모를 따른다', () => {
    assert.equal(pyPath('a//b/./c/'), 'a/b/c')
    assert.equal(pyPath(''), '.')
    assert.equal(pyPath('/'), '/')
    assert.equal(pathName('/a/b.tar.gz'), 'b.tar.gz')
    assert.equal(pathSuffix('/a/b.tar.gz'), '.gz')
    assert.equal(pathSuffix('/a/.md'), '')
    assert.equal(pathSuffix('/a/x.'), '.')
    assert.equal(pathStem('/a/x.jsonl'), 'x')
    assert.deepEqual(pathParents('/a/b/c'), ['/a/b', '/a', '/'])
    assert.equal(relativeTo('/a/b', '/a'), 'b')
    assert.equal(relativeTo('/a', '/a'), '.')
    assert.ok(isRelativeTo('/a/b', '/a') && !isRelativeTo('/ab', '/a') && isRelativeTo('/a', '/a') && isRelativeTo('/x', '/'))
    assert.equal(pjoin('/a', 'b', '/c', 'd'), '/c/d')
    assert.equal(pjoin('/a', ''), '/a')
  })

  test('pyResolve 는 링크를 따라간 뒤 .. 를 처리하고 없는 뒷부분을 붙인다', () => {
    const root = tempDir('hc-int-')
    mkdirSync(join(root, 'real/inner'), { recursive: true })
    symlinkSync('real/inner', join(root, 'ln'))
    assert.equal(pyResolve(`${root}/ln/..`), join(root, 'real'))
    assert.equal(pyResolve(`${root}/nope/x/../y`), join(root, 'nope/y'))
    assert.equal(pyResolve(join(root, 'ln/missing')), join(root, 'real/inner/missing'))
  })

  test('walk 는 디렉터리 링크를 내려가지 않고 가지치기를 따른다', () => {
    const root = tempDir('hc-int-')
    write(join(root, 'a/f.txt'))
    write(join(root, 'skip/f.txt'))
    symlinkSync(join(root, 'a'), join(root, 'link'))
    symlinkSync(join(root, 'a/f.txt'), join(root, 'file-link'))
    const seen: string[] = []
    for (const step of walk(root)) {
      step.directories.splice(0, step.directories.length, ...step.directories.filter((d) => d !== 'skip'))
      seen.push(`${step.current.slice(root.length)}|${[...step.directories].sort().join(',')}|${[...step.filenames].sort().join(',')}`)
    }
    assert.deepEqual(seen.sort(), ['/a||f.txt', '|a,link|file-link'].sort())
  })

  test('parsePyInt 는 int() 가 받는 꼴만 받는다', () => {
    for (const [text, value] of [['5', 5], [' 5 ', 5], ['+5', 5], ['-5', -5], ['1_0', 10], ['٥', 5], ['０５', 5]] as const) assert.equal(parsePyInt(text), value, text)
    for (const text of ['', 'x', '1.5', '1__0', '_1', '1_', '- 1', '5x']) assert.throws(() => parsePyInt(text), Error, text)
  })

  test('pyRepr 는 따옴표를 Python 처럼 고른다', () => {
    assert.equal(pyRepr('abc'), "'abc'")
    assert.equal(pyRepr("it's"), '"it\'s"')
    assert.equal(pyRepr('a"b\'c'), "'a\"b\\'c'")
    assert.equal(pyRepr('a\nb'), "'a\\nb'")
  })
})

describe('session_log', () => {
  test('parseSince 는 strptime 의 날짜 형식을 UTC 자정으로 바꾼다', () => {
    assert.equal(parseSince('2026-10-01'), Date.UTC(2026, 9, 1) / 1000)
    assert.equal(parseSince('2026-1-5'), Date.UTC(2026, 0, 5) / 1000)
    assert.equal(parseSince(''), null)
    assert.equal(parseSince(undefined), null)
    assert.equal(parseSince('2024-02-29'), Date.UTC(2024, 1, 29) / 1000)
    for (const bad of ['2026/10/01', '2026-13-01', '26-10-01', '2026-10', 'abc', '2026-10-01x', '2026-02-30', '2025-02-29', '0000-01-01']) assert.throws(() => parseSince(bad), DateError, bad)
  })

  test('redact 는 토큰과 키=값 꼴을 가린다', () => {
    assert.equal(redact('a ghp_abcdefghijklmnopqrstuvwxyz b'), 'a [가림] b')
    assert.equal(redact('BEARER abcdefghijklmnop1234'), '[가림]')
    assert.equal(redact('Token: abc def'), '[가림] def')
    assert.equal(redact('password：x'), 'password：x')
  })

  test('세션 id 는 기록의 sessionId, 하위 에이전트의 상위 폴더, 파일 이름 순이다', () => {
    assert.equal(sessionId('/p/-r/a.jsonl', { sessionId: 'S1' }), 'S1')
    assert.equal(sessionId('/p/-r/S2/subagents/agent-1.jsonl', {}), 'S2')
    assert.equal(sessionId('/p/-r/S3.jsonl'), 'S3')
    assert.ok(isSubagent('/p/-r/S2/subagents/agent-1.jsonl') && !isSubagent('/p/-r/S3.jsonl'))
    assert.equal(shortId('abcdefghij'), 'abcdefgh')
    assert.equal(shortId('가나다라마바사아자'), '가나다라마바사아')
  })

  test('대화 기록 폴더는 CLAUDE_CONFIG_DIR 이 먼저이고 비어 있으면 홈의 .claude 다', () => {
    const saved = { ...process.env }
    try {
      process.env.CLAUDE_CONFIG_DIR = '/cfg//dir/'
      assert.equal(defaultProjectsDir(), '/cfg/dir/projects')
      process.env.CLAUDE_CONFIG_DIR = ''
      process.env.HOME = '/home/x'
      assert.equal(defaultProjectsDir(), '/home/x/.claude/projects')
    } finally {
      process.env = saved
    }
  })
})

describe('cli', () => {
  const spec = { help: false, options: [{ name: 'skill', value: true, append: true }, { name: 'n', value: true, int: true }, { name: 'flag', value: false }], positionals: [] }

  test('append 옵션은 값을 모두 모으고 접두로 줄여 쓸 수 있다', () => {
    assert.deepEqual(parseCli(['--sk', 'a', '--skill=b', '--skill', 'c'], spec).options.skill, ['a', 'b', 'c'])
  })

  test('int 옵션은 정수가 아니면 사용법 오류다', () => {
    assert.throws(() => parseCli(['--n', 'x'], spec), new UsageError("argument --n: invalid int value: 'x'"))
    assert.equal(parseCli(['--n', ' 7'], spec).options.n, ' 7')
  })

  test('help 를 끄면 -h 는 모르는 옵션이다', () => {
    assert.throws(() => parseCli(['-h'], spec), UsageError)
    assert.throws(() => parseCli(['--help'], spec), UsageError)
    assert.equal(parseCli(['-h'], { ...spec, help: true }).help, true)
  })
})

describe('target_files', () => {
  const root = '/repo'

  test('저장소 오버레이는 대상이고 같은 이름의 다른 파일은 아니다', () => {
    assert.ok(isTarget(`${root}/.orch/overlay.md`, root))
    assert.ok(isTarget(`${root}/.claude/plan-overlay.md`, root))
    assert.ok(!isTarget(`${root}/skills/orch/references/overlay.md`, root))
    assert.ok(!isTarget(`${root}/.orch/specs/spec-a.md`, root))
  })

  test('README 는 includeReadme 일 때 루트의 것만 대상이다', () => {
    assert.ok(!isTarget(`${root}/README.md`, root))
    assert.ok(isTarget(`${root}/README.md`, root, true))
    assert.ok(!isTarget(`${root}/docs/README.md`, root, true))
  })

  test('경로 위쪽의 .claude 도 오버레이 판정에 든다', () => {
    assert.ok(isTarget('/home/u/.claude/x/plan-overlay.md', '/home/u/.claude/x'))
  })

  test('takeScope 는 위치 인자의 자리를 바꾸지 않고 --scope 를 뗀다', () => {
    assert.deepEqual(takeScope(['a', '--scope', 'x', 'b']), [['a', 'b'], 'x'])
    assert.deepEqual(takeScope(['--scope=y=z', 'a']), [['a'], 'y=z'])
    assert.deepEqual(takeScope(['--scope', '--scope', 'a']), [['a'], '--scope'])
    assert.throws(() => takeScope(['a', '--scope']), /--scope 에 경로가 없다/)
  })

  test('countScripts 와 iterTargets 는 같은 폴더를 건너뛴다', () => {
    const dir = tempDir('hc-int-')
    for (const f of ['a.py', 'b.sh', 'c.bash', 'd.zsh', 'e.ts', 'node_modules/x.py', 'tasks/y.sh', 'sub/z.py']) write(join(dir, f))
    assert.equal(countScripts(dir), 5)
    assert.equal(countScripts(join(dir, 'a.py')), 1)
    assert.equal(countScripts(join(dir, 'e.ts')), 0)
    write(join(dir, 'AGENTS.md'), 'x')
    write(join(dir, 'tasks/AGENTS.md'), 'x')
    assert.deepEqual(iterTargets(dir).map((p) => relativeTo(p, dir)), ['AGENTS.md'])
  })

  test('resolveScope 는 링크로 저장소 밖을 가리키는 범위를 거부한다', () => {
    const dir = tempDir('hc-int-')
    const other = tempDir('hc-int-')
    symlinkSync(other, join(dir, 'esc'))
    mkdirSync(join(dir, 'ok'))
    assert.equal(resolveScope(dir, null), null)
    assert.equal(resolveScope(dir, 'ok'), join(dir, 'ok'))
    assert.equal(resolveScope(dir, '.'), dir)
    assert.throws(() => resolveScope(dir, 'esc'), /범위가 저장소 밖을 가리킨다: esc/)
    assert.throws(() => resolveScope(dir, 'none'), /범위 경로가 없다: none/)
  })
})
