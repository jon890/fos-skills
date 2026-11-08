// 명령 경계로 관측되지 않는 내부 함수 테스트. Python 표준 라이브러리 동작을 옮긴 helper 와 공용 모듈의 판정을 본다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { Sandbox, write } from './helpers.ts'
import { parseCli, UsageError, type Spec } from '../scripts/cli.ts'
import { gapBytes, parseDuBytes, parseTrimBytes, parseUsedBytes, shouldRetry, trimUntilDone, type Measure } from '../scripts/colima_trim.ts'
import { classifyImage, normalizeImage, rmiTarget, shortId } from '../scripts/docker_images.ts'
import { classifyKind, classifyVolume, parseCreated, parseSize, peekCount, pickPeekImage, summarizeKinds } from '../scripts/docker_volumes.ts'
import { readFirstLines } from '../scripts/io.ts'
import { abspath, basename, dirname, dumpJson, expanduser, fromIsoFormat, loadJson, mktimeLocal, normpath, parsePyFloat, PyFloat, pyFixed, pyFloatRepr, pyFloorDiv, pyG, pyRound, splitWhitespace } from '../scripts/pylike.ts'
import { classifyBranch, classifyWorktree, judgePr, parseBranches, parseStashBranches, parseWorktrees } from '../scripts/survey_git.ts'
import { ancestors, groupHelpers, isAgent, orphanBuckets, parseEtime, parseLsofCwd, parsePs } from '../scripts/survey_sessions.ts'
import { ageDays, appName, codexReleaseRows, commandsUsing, formatMiseRow, groupByTool, humanKb, isUpdaterDir, miseAliases, miseDataDir, miseVersionRows, newestMtime, parseDuKb, parseMisePrunable, parseVmStat, pendingMarks, rssByApp, topDirs, updaterVerdict } from '../scripts/survey_system.ts'

describe('pylike: 서식', () => {
  test('{x:.Nf} 는 정확히 반인 값을 짝수로 반올림한다', () => {
    assert.deepEqual([0.5, 1.5, 2.5, 3.5, -0.5, 0.25, 0.75, 1.25].map((x) => pyFixed(x, 0)), ['0', '2', '2', '4', '-0', '0', '1', '1'])
    assert.deepEqual([0.125, 0.375, 1.25, 1.75, 2.675, 0.05, 0.15].map((x) => pyFixed(x, 2)), ['0.12', '0.38', '1.25', '1.75', '2.67', '0.05', '0.15'])
    assert.deepEqual([1.25, 1.75, 0.25, 12.5].map((x) => pyFixed(x, 1)), ['1.2', '1.8', '0.2', '12.5'])
  })

  test('음수 0 과 반올림해 0 이 되는 음수는 부호를 남긴다', () => {
    assert.equal(pyFixed(-0, 1), '-0.0')
    assert.equal(pyFixed(-0.04, 1), '-0.0')
    assert.equal(pyFixed(-2.5, 0), '-2')
  })

  test('nan 과 inf', () => {
    assert.deepEqual([NaN, Infinity, -Infinity].map((x) => pyFixed(x, 1)), ['nan', 'inf', '-inf'])
    assert.deepEqual([NaN, Infinity, -Infinity].map(pyG), ['nan', 'inf', '-inf'])
  })

  test('큰 값과 아주 작은 값도 정확한 자릿수다', () => {
    assert.equal(pyFixed(1e21, 1), '1000000000000000000000.0')
    assert.equal(pyFixed(5e-324, 2), '0.00')
    assert.equal(pyFixed(123456789.123, 2), '123456789.12')
  })

  test('{x:g} 는 유효숫자 6자리와 지수 꼴 경계를 따른다', () => {
    assert.deepEqual([14, 0.5, 14.123456789, 100000, 123456, 1234567, 1e6, 1e16, 0.0001, 0.00001234, 1e-7, 24, 76.5, 0.1 + 0.2, 999999.5, 1 / 3].map(pyG), ['14', '0.5', '14.1235', '100000', '123456', '1.23457e+06', '1e+06', '1e+16', '0.0001', '1.234e-05', '1e-07', '24', '76.5', '0.3', '1e+06', '0.333333'])
    assert.equal(pyG(0), '0')
    assert.equal(pyG(-0), '-0')
    assert.equal(pyG(-14.5), '-14.5')
  })

  test('repr(float) 는 정수 값도 .0 을 붙이고 지수 경계는 16 이다', () => {
    assert.deepEqual([24, 51.07, 0, 1e15, 1e16, 1e-4, 1e-5, 123456789012345680000, 0.1 + 0.2, -3].map(pyFloatRepr), ['24.0', '51.07', '0.0', '1000000000000000.0', '1e+16', '0.0001', '1e-05', '1.2345678901234568e+20', '0.30000000000000004', '-3.0'])
    assert.equal(pyFloatRepr(-0), '-0.0')
    assert.deepEqual([NaN, Infinity, -Infinity].map(pyFloatRepr), ['NaN', 'Infinity', '-Infinity'])
  })

  test('round(x, 2) 는 정확한 십진 값을 짝수 쪽으로 반올림한다', () => {
    assert.deepEqual([0.125, 2.675, 76.5, 51.068055, 0.0083333].map((x) => pyRound(x, 2)), [0.12, 2.67, 76.5, 51.07, 0.01])
  })

  test('float 의 // 는 fmod 로 보정한다', () => {
    assert.deepEqual([pyFloorDiv(100, 7), pyFloorDiv(-100, 7), pyFloorDiv(7776000, 86400), pyFloorDiv(0.5, 1), pyFloorDiv(86399.9999999, 86400)], [14, -15, 90, 0, 0])
  })
})

describe('pylike: 변환', () => {
  test('float(str)', () => {
    const ok: [string, number][] = [['1', 1], ['1.5', 1.5], [' 3 ', 3], ['1_0', 10], ['+.5', 0.5], ['5.', 5], ['1e1', 10], ['1E-2', 0.01], ['١٢', 12], ['inf', Infinity], ['-Infinity', -Infinity], ['1e400', Infinity], ['1_0.0_1', 10.01]]
    for (const [text, value] of ok) assert.equal(parsePyFloat(text), value, text)
    assert.ok(Number.isNaN(parsePyFloat('NaN')))
    for (const bad of ['', '1__0', '_1', '1_', '0x10', '1e', '--5', 'infinit', '1.2.3', ' ', '.', 'e1']) assert.throws(() => parsePyFloat(bad), undefined, bad)
  })

  test('fromisoformat 은 오프셋, Z, 소수 초, 날짜만, 기본 꼴을 읽는다', () => {
    assert.equal(fromIsoFormat('2026-10-14T22:14:51+09:00'), Date.parse('2026-10-14T13:14:51Z') / 1000)
    assert.equal(fromIsoFormat('2026-10-14T13:14:51Z'), Date.parse('2026-10-14T13:14:51Z') / 1000)
    assert.equal(fromIsoFormat('2026-10-14 13:14:51.5+00:00'), Date.parse('2026-10-14T13:14:51.5Z') / 1000)
    assert.equal(fromIsoFormat('20261014T131451+0000'), Date.parse('2026-10-14T13:14:51Z') / 1000)
    assert.equal(fromIsoFormat('2026-10-14T13:14:51.123456789Z'), Date.parse('2026-10-14T13:14:51.123Z') / 1000 + 0.000456)
    assert.equal(fromIsoFormat('2026-10-14'), new Date(2026, 9, 14).getTime() / 1000)
    assert.equal(fromIsoFormat('2026-10-14T13'), new Date(2026, 9, 14, 13).getTime() / 1000)
    for (const bad of ['not a date', '', null, undefined, 5, '2026-13-01', '2026-02-30', '2026-10-14T25:00:00', '2026-10-14T13:14:51+25:00']) assert.equal(fromIsoFormat(bad), null, String(bad))
  })

  test('strptime + mktime 은 형식이 다르면 던지고 윤년을 안다', () => {
    assert.equal(mktimeLocal('2026-10-14T13:14:51'), new Date(2026, 9, 14, 13, 14, 51).getTime() / 1000)
    assert.equal(mktimeLocal('2024-02-29T00:00:00'), new Date(2024, 1, 29).getTime() / 1000)
    for (const bad of ['2026-10-14', '2026-10-14T13:14', '2026-02-29T00:00:00', '2026-10-14T24:00:00', '2026-10-14 13:14:51', '']) assert.throws(() => mktimeLocal(bad), undefined, bad)
  })

  test('str.split(None, n) 은 남은 뒷부분을 앞 공백만 지워 둔다', () => {
    assert.deepEqual(splitWhitespace('  a  b   c d  ', 2), ['a', 'b', 'c d  '])
    assert.deepEqual(splitWhitespace('a b'), ['a', 'b'])
    assert.deepEqual(splitWhitespace(''), [])
    assert.deepEqual(splitWhitespace('a\u00a0b\u3000c'), ['a', 'b', 'c'])
    assert.deepEqual(splitWhitespace('x\ufeffy'), ['x\ufeffy'])
  })
})

describe('pylike: 경로', () => {
  test('normpath 는 os.path.normpath 와 같다', () => {
    const cases: [string, string][] = [['', '.'], ['/', '/'], ['//', '//'], ['///a', '/a'], ['a/../..', '..'], ['/a/b/../c/', '/a/c'], ['//a//b/./c', '//a/b/c'], ['a/', 'a'], ['../a', '../a'], ['/..', '/']]
    for (const [input, expected] of cases) assert.equal(normpath(input), expected, JSON.stringify(input))
  })

  test('dirname 과 basename 은 끝 슬래시를 정리하지 않는다', () => {
    assert.deepEqual(['/a/b', '/a/b/', 'a', '/', '//a', 'a//b'].map(dirname), ['/a', '/a/b', '', '/', '//', 'a'])
    assert.deepEqual(['/a/b', '/a/b/', 'a', '/', ''].map(basename), ['b', '', 'a', '', ''])
  })

  test('abspath 는 현재 폴더에 이어 .. 를 글자로 줄인다', () => {
    assert.equal(abspath('/a/b/../c'), '/a/c')
    assert.equal(abspath('x/../y'), join(process.cwd(), 'y'))
  })

  test('expanduser 는 ~ 와 ~/ 만 홈으로 푼다', () => {
    const home = (process.env.HOME as string).replace(/\/+$/, '')
    assert.equal(expanduser('~'), home)
    assert.equal(expanduser('~/x'), `${home}/x`)
    assert.equal(expanduser('~x/y'), '~x/y')
    assert.equal(expanduser('a~/b'), 'a~/b')
  })
})

describe('pylike: JSON', () => {
  test('들여쓴 JSON 은 빈 목록과 빈 객체를 한 줄로 쓰고 실수는 PyFloat 만 .0 이다', () => {
    const text = dumpJson({ a: [], b: {}, c: new PyFloat(2), d: 2, e: null, f: [{ g: '한글"\n' }], h: true })
    assert.equal(text, '{\n  "a": [],\n  "b": {},\n  "c": 2.0,\n  "d": 2,\n  "e": null,\n  "f": [\n    {\n      "g": "한글\\"\\n"\n    }\n  ],\n  "h": true\n}')
  })

  test('json.loads 는 NaN 과 Infinity 도 받는다', () => {
    assert.deepEqual(loadJson('{"cwd": "/x", "v": NaN, "w": -Infinity}'), { cwd: '/x', v: null, w: null })
    assert.deepEqual(loadJson('{"s": "NaN Infinity"}'), { s: 'NaN Infinity' })
    assert.throws(() => loadJson('{"a": nope}'))
    assert.throws(() => loadJson(''))
  })
})

describe('cli: nargs=+ 와 extend', () => {
  const spec: Spec = {
    options: [
      { name: 'only', value: true, plus: true, choices: ['a', 'b'] },
      { name: 'kind', value: true, plus: true, extend: true, choices: ['x', 'y'] },
      { name: 'n', value: true, int: true },
      { name: 'f', value: true, float: true },
      { name: 'flag', value: false },
    ],
    positionals: [{ name: 'file', nargs: 1 }],
  }
  const parse = (...argv: string[]) => parseCli(argv, spec)

  test('뒤따르는 낱말을 모두 먹고 옵션과 -- 에서 끊는다', () => {
    assert.deepEqual(parse('F', '--only', 'a', 'b').options.only, ['a', 'b'])
    assert.deepEqual(parse('F', '--only', 'a', '--flag').options.only, ['a'])
    assert.equal(parse('--only', 'a', '--', 'F').positionals.file, 'F')
  })

  test('거듭 주면 plus 는 마지막, extend 는 이어 붙인다', () => {
    assert.deepEqual(parse('F', '--only', 'a', '--only', 'b').options.only, ['b'])
    assert.deepEqual(parse('F', '--kind', 'x', '--kind', 'y', 'x').options.kind, ['x', 'y', 'x'])
  })

  test('=값은 값 하나다', () => {
    assert.deepEqual(parse('F', '--only=a').options.only, ['a'])
    assert.throws(() => parse('F', '--only=a', 'b'), UsageError)
  })

  test('값 누락과 잘못된 값은 사용법 오류다', () => {
    for (const argv of [['F', '--only'], ['F', '--only', '--flag'], ['--only', 'a', 'F'], ['F', '--only', 'a', 'z'], ['F', '--n', '1.5'], ['F', '--f', 'x'], ['F', '--n', '--', '1'], ['F', '--kind', 'x', '--', 'y']]) assert.throws(() => parse(...argv), UsageError, argv.join(' '))
    assert.throws(() => parse('F', '--only'), /expected at least one argument/)
    assert.throws(() => parse('F', '--only', 'z'), /invalid choice: 'z' \(choose from 'a', 'b'\)/)
    assert.throws(() => parse('F', '--f', 'x'), /invalid float value: 'x'/)
  })

  test('음수와 공백이 든 값은 위치 인자 꼴이라 값으로 먹는다', () => {
    assert.equal(parse('F', '--n', '-5').options.n, '-5')
    assert.equal(parse('F', '--f', '-1.5').options.f, '-1.5')
    assert.throws(() => parse('F', '--f', '-inf'), UsageError)
  })
})

describe('colima_trim', () => {
  const GIB = 1024 ** 3

  test('파싱', () => {
    assert.equal(parseTrimBytes('/a: 1 GiB (1073741824 bytes) trimmed\n/b: 1 GiB (1073741824 bytes) trimmed\n'), 2 * GIB)
    assert.equal(parseTrimBytes('error'), 0)
    assert.equal(parseTrimBytes(null), 0)
    assert.equal(parseUsedBytes('       Used\n25769803776\n'), 25769803776)
    assert.equal(parseUsedBytes('Used\n'), null)
    assert.equal(parseUsedBytes(''), null)
    assert.equal(parseDuBytes('42572800\t/x/datadisk\n'), 42572800 * 1024)
    assert.equal(parseDuBytes('du: no such file'), null)
    assert.equal(parseDuBytes(''), null)
  })

  test('재시도 판정은 차이, 횟수, 시간 상한을 모두 본다', () => {
    assert.equal(gapBytes(40 * GIB, 24 * GIB), 16 * GIB)
    assert.equal(shouldRetry(16 * GIB, 4 * GIB, 1, 4), true)
    assert.equal(shouldRetry(4 * GIB, 4 * GIB, 1, 4), false)
    assert.equal(shouldRetry(16 * GIB, 4 * GIB, 4, 4), false)
    assert.equal(shouldRetry(-1 * GIB, 4 * GIB, 1, 4), false)
    assert.equal(shouldRetry(16 * GIB, 4 * GIB, 1, 4, 30, 60, 20, 100), false)
    assert.equal(shouldRetry(16 * GIB, 4 * GIB, 1, 4, 10, 60, 10, 100), true)
    assert.equal(shouldRetry(16 * GIB, 4 * GIB, 1, 4, 999, 60, 999, null), true)
  })

  const loop = (gaps: number[], opts: { maxAttempts?: number; interval?: number; maxSeconds?: number; step?: number } = {}) => {
    const { maxAttempts = 4, interval = 60, maxSeconds = 100, step = 10 } = opts
    let now = 0
    const sleeps: number[] = []
    const measures = gaps.map((g): Measure => [g * GIB + 10 * GIB, 10 * GIB, 0])
    let at = 0
    const result = trimUntilDone(() => ((now += step), 0), () => measures[Math.min(at++, measures.length - 1)], 4 * GIB, maxAttempts, interval, maxSeconds, {
      clock: () => now,
      sleep: (sec) => {
        sleeps.push(sec)
        now += sec
      },
      out: () => {},
    })
    return { result, sleeps, elapsed: now }
  }

  test('차이가 닫히면 멈춘다', () => {
    const { result, sleeps } = loop([16, 0])
    assert.deepEqual([result[0], sleeps], [2, [60]])
  })

  test('시간 상한이 횟수 상한보다 먼저 멈춘다', () => {
    const { result, sleeps, elapsed } = loop([16, 16, 16, 16])
    assert.deepEqual([result[0], sleeps], [2, [60]])
    assert.ok(elapsed <= 100)
    assert.ok(gapBytes(result[1][0], result[1][1]) > 4 * GIB)
  })

  test('횟수 상한', () => {
    const { result, sleeps } = loop([16, 16, 16, 16, 16], { maxAttempts: 3, interval: 1, maxSeconds: 1000 })
    assert.deepEqual([result[0], sleeps], [3, [1, 1]])
  })
})

describe('docker_volumes', () => {
  const NOW = 1_800_000_000
  const HOUR = 3600

  test('크기와 생성 시각 읽기', () => {
    assert.deepEqual(['256.6MB', '0B', '12kB', '1.5GB', 'N/A', null, '1 GB', ' 3MB '].map((s) => parseSize(s)), [256_600_000, 0, 12_000, 1_500_000_000, null, null, 1_000_000_000, 3_000_000])
    assert.equal(parseCreated('2026-10-14T22:14:51+09:00'), parseCreated('2026-10-14T13:14:51+00:00'))
    assert.equal(parseCreated('not a date'), null)
    assert.equal(parseCreated(null), null)
  })

  test('최근 판정은 기준 시간 경계를 따르고 모르면 최근이다', () => {
    assert.equal(classifyVolume({ created_ts: NOW - 23 * HOUR }, NOW, 24), '최근')
    assert.equal(classifyVolume({ created_ts: NOW - 25 * HOUR }, NOW, 24), '후보')
    assert.equal(classifyVolume({ created_ts: null }, NOW, 24), '최근')
  })

  test('종류 판정과 합계', () => {
    assert.deepEqual([['PG_VERSION', 'base'], ['ibdata1', 'mysql'], ['#innodb_redo'], ['auto.cnf'], ['SOUL.md'], ['gersang.db'], []].map(classifyKind), ['postgres', 'mysql', 'mysql', 'mysql', 'other', 'other', 'other'])
    const items = [
      { name: 'a', created_ts: 0, class: '후보', kind: 'postgres', size_bytes: 10 },
      { name: 'b', created_ts: 0, class: '후보', kind: 'postgres', size_bytes: 5 },
      { name: 'c', created_ts: 0, class: '후보', kind: 'other', size_bytes: null },
      { name: 'd', created_ts: 0, class: '후보', kind: null, size_bytes: 99 },
      { name: 'e', created_ts: 0, class: '최근', kind: 'mysql', size_bytes: 7 },
    ]
    assert.deepEqual(summarizeKinds(items), { postgres: { count: 2, size_bytes: 15 }, other: { count: 1, size_bytes: 0 } })
  })

  test('--peek 값과 이미지 선호', () => {
    assert.deepEqual(['3', 'all', ' 4 ', '1_0', 'many', '1.5', ''].map(peekCount), [3, Infinity, 4, 10, null, null, null])
    assert.equal(pickPeekImage(['mysql:8.4', 'debian:bookworm-slim', 'alpine:3']), 'alpine:3')
    assert.equal(pickPeekImage(['mysql:8.4', 'library/busybox:latest']), 'library/busybox:latest')
    assert.equal(pickPeekImage(['mysql:8.4', 'alpine:<none>']), null)
  })
})

describe('docker_images', () => {
  test('이미지 이름 맞추기', () => {
    assert.deepEqual(['alpine', 'mysql:8.4', 'localhost:5000/app', 'a/b@sha256:ff'].map(normalizeImage), ['alpine:latest', 'mysql:8.4', 'localhost:5000/app:latest', 'a/b@sha256:ff'])
  })

  test('분류', () => {
    const now = Date.now() / 1000
    const old = now - 10 * 86400
    const used = new Set(['alpine:latest'])
    assert.equal(classifyImage({ ref: 'alpine:latest', id: 'x', created_ts: old }, used, new Set(), now, 24), '사용 중')
    assert.equal(classifyImage({ ref: 'other:1', id: 'x', created_ts: old }, used, new Set(['x']), now, 24), '사용 중')
    assert.equal(classifyImage({ ref: 'other:1', id: 'y', created_ts: now - 3600 }, used, new Set(), now, 24), '확인 필요(최근 생성)')
    assert.equal(classifyImage({ ref: 'other:1', id: 'y', created_ts: old }, used, new Set(), now, 24), '미사용')
  })

  test('rmi 대상', () => {
    const sha = (c: string) => `sha256:${c.repeat(64)}`
    assert.equal(rmiTarget('gersang-lab', 'latest', sha('a')), 'gersang-lab:latest')
    assert.equal(rmiTarget('traefik', '<none>', sha('b')), 'b'.repeat(12))
    assert.equal(rmiTarget('<none>', '<none>', sha('c')), 'c'.repeat(12))
    assert.equal(rmiTarget('ghcr.io/actions/actions-runner', '2.338.0', sha('e'), false), 'e'.repeat(12))
    assert.equal(shortId('d'.repeat(64)), 'd'.repeat(12))
  })
})

describe('survey_git 분류', () => {
  const wt = (extra: object = {}) => ({ prunable: false, merged: false, dirty: 0, stash: 0, in_use: false, upstream_gone: false, ...extra })
  const br = (name: string, extra: object = {}) => ({ name, merged: false, upstream_gone: false, ...extra })

  test('워크트리', () => {
    assert.equal(classifyWorktree(wt({ merged: true })), '제거 후보')
    assert.deepEqual([{ dirty: 1 }, { stash: 1 }, { in_use: true }].map((e) => classifyWorktree(wt({ merged: true, ...e }))), ['유지', '유지', '유지'])
    assert.equal(classifyWorktree(wt({ prunable: true })), '기록만 남음')
    assert.equal(classifyWorktree(wt({ upstream_gone: true })), 'PR 확인 필요')
    assert.equal(classifyWorktree(wt()), '유지')
    assert.equal(classifyWorktree(wt(), 'merged'), '제거 후보(PR 머지됨)')
    assert.equal(classifyWorktree(wt({ dirty: 2 }), 'merged'), '유지')
    assert.equal(classifyWorktree(wt(), 'diverged'), 'PR 확인 필요')
    assert.equal(classifyWorktree(wt(), 'error'), '유지')
    assert.equal(classifyWorktree(wt({ upstream_gone: true }), 'error'), 'PR 확인 필요')
  })

  test('브랜치', () => {
    assert.equal(classifyBranch(br('feat/a', { merged: true }), 'main', new Set()), '삭제 후보(-d)')
    assert.equal(classifyBranch(br('feat/a', { merged: true }), 'main', new Set(['feat/a'])), '유지')
    assert.equal(classifyBranch(br('main', { merged: true }), 'main', new Set()), '유지')
    assert.equal(classifyBranch(br('release/1.0', { merged: true }), 'main', new Set()), '유지')
    assert.equal(classifyBranch(br('feat/b', { upstream_gone: true }), 'main', new Set()), 'PR 확인 필요(-D)')
    assert.equal(classifyBranch(br('feat/c'), 'main', new Set()), '유지')
    assert.equal(classifyBranch(br('feat/a'), 'main', new Set(), 'merged'), 'PR 머지됨(-D)')
    assert.equal(classifyBranch(br('feat/a'), 'main', new Set(['feat/a']), 'merged'), '유지')
    assert.equal(classifyBranch(br('feat/a'), 'main', new Set(), 'diverged'), 'PR 확인 필요(-D)')
    assert.equal(classifyBranch(br('feat/a'), 'main', new Set(), 'error'), '유지')
    assert.equal(classifyBranch(br('feat/a', { merged: true }), 'main', new Set(), 'error'), '삭제 후보(-d)')
  })

  test('기본 브랜치 이름과 배포 브랜치는 기준과 무관하게 유지한다', () => {
    for (const name of ['main', 'master', 'develop']) for (const base of ['develop', 'main']) assert.equal(classifyBranch(br(name, { merged: true }), base, new Set()), '유지')
    assert.equal(classifyBranch(br('feat/a', { merged: true }), 'develop', new Set()), '삭제 후보(-d)')
    for (const name of ['alpha', 'beta']) assert.equal(classifyBranch(br(name, { upstream_gone: true }), 'main', new Set(), 'diverged'), '유지')
  })

  test('judgePr', () => {
    const prs = [{ number: 1, headRefOid: 'aaa' }, { number: 2, headRefOid: 'bbb' }]
    assert.deepEqual([judgePr('bbb', prs), judgePr('ccc', prs), judgePr('ccc', []), judgePr('aaa', null)], ['merged', 'diverged', null, 'error'])
  })

  test('파싱', () => {
    const rows = parseBranches('a\t\t1\t\torigin/a\tdeadbeef\nb\t\t2\t\t\n')
    assert.equal(rows[0].tip, 'deadbeef')
    assert.equal(rows[1].tip, null)
    assert.deepEqual(parseBranches('a\t[gone]\t100\t\nb\t\t200\t/w\n').map((r) => [r.upstream_gone, r.worktreepath, r.has_upstream]), [[true, '', false], [false, '/w', false]])
    assert.equal(parseBranches('a\t\t1\t\torigin/a\n')[0].has_upstream, true)
    assert.equal(parseBranches('a\t\tx\t\n')[0].commit_ts, 0)
    assert.deepEqual(parseBranches('short\t\t1\n\n\t\t1\t\n'), [])
    assert.deepEqual(parseStashBranches('WIP on feat/x: abc msg\nOn feat/x: manual\nWIP on main: def other\nOn (no branch): z\nweird\n'), new Map([['feat/x', 2], ['main', 1]]))
    const items = parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/w\nHEAD def\nbranch refs/heads/feat/x\nprunable gone\n\nworktree /r/d\nHEAD 123\ndetached\n')
    assert.deepEqual(items.map((i) => [i.path, i.head, i.branch, i.prunable, i.detached]), [['/r', 'abc', 'main', false, false], ['/r/w', 'def', 'feat/x', true, false], ['/r/d', '123', null, false, true]])
  })
})

describe('survey_sessions 내부', () => {
  test('etime 꼴', () => {
    assert.ok(Math.abs(parseEtime('05:30') - 5.5 / 60) < 1e-12)
    assert.equal(parseEtime('02:00:00'), 2)
    assert.equal(parseEtime('3-04:30:00'), 76.5)
    assert.throws(() => parseEtime('1:2:3:4'))
    assert.throws(() => parseEtime('x'))
  })

  test('조상은 PID 1 에서 멈추고 순환에도 끝난다', () => {
    assert.deepEqual(ancestors(30, new Map([[30, 20], [20, 10], [10, 1], [1, 0]])), new Set([30, 20, 10, 1]))
    assert.deepEqual(ancestors(5, new Map([[5, 6], [6, 5]])), new Set([5, 6]))
  })

  test('에이전트 판정은 실행 파일 이름이다', () => {
    assert.equal(isAgent('/Users/x/.local/bin/claude --resume'), true)
    assert.equal(isAgent('codex'), true)
    assert.equal(isAgent('/usr/bin/vim claude.md'), false)
    assert.equal(isAgent('   '), false)
  })

  test('helper 묶음 기준', () => {
    const rows = [...Array.from({ length: 10 }, () => ({ command: 'node oxide-helper.js', rss_kb: 100 })), ...Array.from({ length: 9 }, () => ({ command: 'other', rss_kb: 5 }))]
    assert.deepEqual(groupHelpers(rows), [{ command: 'node oxide-helper.js', count: 10, rss_kb: 1000 }])
  })

  test('lsof 와 ps 읽기', () => {
    assert.deepEqual(parseLsofCwd('p12\nn/a/b\np13\nn/c\n'), new Map([[12, '/a/b'], [13, '/c']]))
    const rows = parsePs('  10     1 01:00:00 ttys001  2048  1.5 /bin/claude --x\nbad line\n')
    assert.deepEqual([rows.length, rows[0].pid, rows[0].hours, rows[0].command], [1, 10, 1, '/bin/claude --x'])
  })

  test('묶음은 누적이다', () => {
    const now = 1_000_000_000
    const day = 86400
    const orphans = [{ newest_mtime: now - day, size_bytes: 1 }, { newest_mtime: now - 5 * day, size_bytes: 10 }, { newest_mtime: now - 10 * day, size_bytes: 100 }, { newest_mtime: now - 40 * day, size_bytes: 1000 }]
    assert.deepEqual(orphanBuckets(orphans, now), new Map([[3, [3, 1110]], [7, [2, 1100]], [14, [1, 1000]], [30, [1, 1000]]]))
  })

  test('첫 50줄만 읽고 줄바꿈은 \\n, \\r, \\r\\n 이다', () => {
    const dir = tempDir('mc-int-')
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, `a\r\nb\rc\nd${'\ne'.repeat(100)}`)
    assert.deepEqual(readFirstLines(path, 5), ['a', 'b', 'c', 'd', 'e'])
    writeFileSync(path, 'x\n')
    assert.deepEqual(readFirstLines(path, 50), ['x'])
    writeFileSync(path, '')
    assert.deepEqual(readFirstLines(path, 50), [])
    writeFileSync(path, Buffer.from([0x61, 0xff, 0x62, 0x0a]))
    assert.deepEqual(readFirstLines(path, 50), ['a\ufffdb'])
  })
})

describe('survey_system 내부', () => {
  test('크기 서식', () => {
    assert.deepEqual([512, 1536, 20 * 1024, 5 * 1024 * 1024, 1, 1792, 1024 * 10].map(humanKb), ['512K', '1.5M', '20M', '5.0G', '1K', '1.8M', '10M'])
  })

  test('du 파싱과 정렬', () => {
    assert.deepEqual(parseDuKb('100\t/a/b c\nnot a row\n\n7\t/a/d\n'), [[100, '/a/b c'], [7, '/a/d']])
    assert.deepEqual(topDirs([[5, '/b'], [9, '/a'], [5, '/a2'], [1, '/z']], 3), [[9, '/a'], [5, '/a2'], [5, '/b']])
    assert.deepEqual(topDirs(parseDuKb('10\t/h/.cache\n20\t/h/proj\n'), 5).map((r) => r[1]), ['/h/proj', '/h/.cache'])
  })

  test('앱 이름과 RSS 합계', () => {
    assert.equal(appName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --x'), 'Google Chrome')
    assert.equal(appName('/usr/bin/python3 script.py'), 'python3')
    assert.equal(appName(''), '?')
    assert.deepEqual(rssByApp('100 /A/Foo.app/Contents/x\n 50 /A/Foo.app/Contents/y\n  7 /bin/zsh -l\nbad row\n12\n'), new Map([['Foo', 150], ['zsh', 7]]))
  })

  test('vm_stat', () => {
    assert.deepEqual(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor:                 123456.\n'), [16384, 123456])
    assert.deepEqual(parseVmStat(''), [null, null])
  })

  test('updater 판정', () => {
    for (const name of ['orca-updater', 'com.stablyai.orca.ShipIt', 'x-updater']) assert.equal(isUpdaterDir(name), true, name)
    for (const name of ['com.google.GoogleUpdater', 'updater-cache', 'ShipIt.old', 'orca']) assert.equal(isUpdaterDir(name), false, name)
    assert.deepEqual(pendingMarks(['update.zip', 'pending', 'other.log']), ['pending', 'update.zip'])
    assert.deepEqual(pendingMarks(['ShipIt_stderr.log']), [])
    assert.ok(updaterVerdict([]).startsWith('안전'))
    assert.ok(updaterVerdict(['pending']).startsWith('유지'))
  })

  const OUT = 'mise pruned configuration links [dryrun]\nmise gradle@9.5.0 is prunable: no tracked config or tool stub requires gradle\nmise gradle@9.5.0 [dryrun]   uninstall\nmise gradle@9.7.1 is prunable: no tracked config or tool stub requires gradle\nmise maven@3.9.11 is prunable: maven is required at 3.9.15 by ~/.config/mise/config.toml\nmise node@20.1.0 is prunable: x\ngarbage line\n'

  test('mise prune 파싱', () => {
    const rows = parseMisePrunable(OUT)
    assert.deepEqual(rows.map(([t, v]) => [t, v]), [['gradle', '9.5.0'], ['gradle', '9.7.1'], ['maven', '3.9.11'], ['node', '20.1.0']])
    assert.ok(rows[2][2].startsWith('maven is required at 3.9.15'))
    assert.deepEqual([...groupByTool(rows)], [['gradle', ['9.5.0', '9.7.1']], ['maven', ['3.9.11']], ['node', ['20.1.0']]])
    assert.deepEqual(parseMisePrunable('mise scanning tracked configs ✓ done\n'), [])
  })

  const D = '/h/.local/share/mise'

  test('실행중 판정은 설치 경로 뒤 / 까지 본다', () => {
    const grouped = new Map([['node', ['22.23.4', '24.15.0']]])
    const sizes = new Map([[`${D}/installs/node/24.15.0`, 3 * 1024 * 1024], [`${D}/installs/node/22.23.4`, 208 * 1024]])
    const rows = miseVersionRows(grouped, D, sizes, `${D}/installs/node/24.15.0/bin/node /h/.claude/hud/omc-hud.mjs\n`)
    assert.deepEqual(rows.map((r) => [r.version, r.running]), [['22.23.4', false], ['24.15.0', true]])
    assert.deepEqual(rows.map(formatMiseRow), ['  208M  node 22.23.4', '  3.0G  node 24.15.0  실행중'])
    assert.equal(miseVersionRows(new Map([['node', ['24.15.0']]]), D, new Map(), `${D}/installs/node/24.15.01/bin/node x\n`)[0].running, false)
    assert.equal(formatMiseRow(miseVersionRows(new Map([['gradle', ['9.8.0']]]), D, new Map(), '')[0]), '    없음  gradle 9.8.0')
  })

  test('별칭 링크 경로로 도는 프로세스도 실행중이다', () => {
    const v = `${D}/installs/node/24.15.0`
    const ps = `${D}/installs/node/24.15/bin/node /h/hud.mjs\n`
    assert.equal(miseVersionRows(new Map([['node', ['24.15.0']]]), D, new Map(), ps, new Map([[v, [`${D}/installs/node/24.15`]]]))[0].running, true)
    assert.equal(miseVersionRows(new Map([['node', ['24.15.0']]]), D, new Map(), ps)[0].running, false)
    const rows = miseVersionRows(new Map([['node', ['24.15.0', '24.22.1']]]), D, new Map(), `${D}/installs/node/24/bin/node x\n`, new Map([[`${D}/installs/node/24.22.1`, [`${D}/installs/node/24`]]]))
    assert.deepEqual(rows.map((r) => [r.version, r.running]), [['24.15.0', false], ['24.22.1', true]])
  })

  test('별칭 링크는 설치 폴더 안의 심볼릭 링크에서 읽는다', () => {
    const dir = tempDir('mc-mise-')
    const tool = join(dir, 'installs', 'node')
    mkdirSync(join(tool, '24.15.0'), { recursive: true })
    mkdirSync(join(tool, '24.22.1'))
    symlinkSync('./24.15.0', join(tool, '24.15'))
    symlinkSync('./24.22.1', join(tool, '24'))
    assert.deepEqual(miseAliases(dir, new Map([['node', ['24.15.0']]])), new Map([[join(tool, '24.15.0'), [join(tool, '24.15')]]]))
    assert.equal(miseDataDir({ MISE_DATA_DIR: '/x/mise' }), '/x/mise')
    assert.ok(miseDataDir({}).endsWith('/.local/share/mise'))
  })

  test('프로세스 줄 검사', () => {
    const ps = '/Applications/Cursor.app/Contents/MacOS/Cursor --x\n/bin/zsh -l\nnode /home/u/.cache/puppeteer/chrome/run\n'
    assert.equal(commandsUsing(ps, '/home/u/.cache/puppeteer'), 1)
    assert.equal(commandsUsing(ps, '/home/u/.cache/other'), 0)
  })

  test('Codex 릴리스 행', () => {
    const base = '/h/.codex/packages/standalone/releases'
    const rows = codexReleaseRows(new Map([[`${base}/0.3`, 300], [`${base}/0.1`, 100], [`${base}/0.2`, 200]]), `${base}/0.3`, `${base}/0.2/bin/codex serve\n/other/path/0.3/bin/codex\n`)
    assert.deepEqual(rows.map((r) => [r.path.split('/').at(-1), r.current, r.running]), [['0.1', false, false], ['0.2', false, true], ['0.3', true, false]])
    assert.deepEqual(codexReleaseRows(new Map([['/r/a', 1]]), null, '').map((r) => [r.current, r.running]), [[false, false]])
  })

  test('경과 일수와 가장 늦은 수정 시각', () => {
    assert.equal(ageDays(1000, 1000 + 86400 * 90 + 5), 90)
    assert.equal(ageDays(2000, 1000), 0)
    assert.equal(ageDays(null, 1000), null)
    const dir = tempDir('mc-mtime-')
    const root = join(dir, 'c')
    mkdirSync(join(root, 'sub'), { recursive: true })
    const old = 1_000_000_000
    const recent = 1_600_000_000
    writeFileSync(join(root, 'a.txt'), 'x')
    writeFileSync(join(root, 'sub', 'b.txt'), 'y')
    utimesSync(join(root, 'a.txt'), old, old)
    utimesSync(join(root, 'sub', 'b.txt'), recent, recent)
    utimesSync(join(root, 'sub'), old, old)
    utimesSync(root, old, old)
    assert.equal(newestMtime(root), recent)
    assert.equal(newestMtime(join(dir, 'none')), null)
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}`), 'x')
    assert.notEqual(newestMtime(dir, 2), null)
  })
})

// 옛 구현과 다른 한 곳. 옛 셸 스크립트는 버전 이름을 읽지 못한 dists 폴더가 있으면 버전이 빈 후보를 만들어
// `~/.gradle/caches/` 와 `~/.gradle/daemon/` 폴더 전체를 지우는 rm -rf 줄을 냈다
describe('survey_gradle', () => {
  test('버전 이름을 읽지 못한 dists 폴더는 후보와 표에 올리지 않는다', () => {
    const box = new Sandbox('mc-gradle-', ['mktemp', 'find', 'grep', 'head', 'sort', 'awk', 'du', 'basename', 'rm', 'cat'])
    const root = join(box.root, 'projects')
    mkdirSync(root)
    write(join(box.home, '.gradle/wrapper/dists/gradle-abc-bin/f'), 'x')
    write(join(box.home, '.gradle/caches/8.1.0/f'), 'x')
    write(join(box.home, '.gradle/caches/modules-2/f'), 'x')
    write(join(box.home, '.gradle/daemon/8.1.0/f'), 'x')
    box.fake('pgrep', [{ stdout: '' }])
    const out = box.run('survey_gradle', [root]).stdout
    assert.ok(out.includes('rm -rf ~/.gradle/caches/8.1.0 ~/.gradle/daemon/8.1.0\n'), out)
    assert.ok(!/~\/\.gradle\/(caches|daemon)\/( |\n)/.test(out), out)
    assert.ok(!/\n {8,}dists /.test(out), out)
  })
})

// 옛 구현은 앞 항목을 지운 뒤 틀린 항목에서 멈췄다. 새 구현은 지우기 전에 모든 항목을 검사한다
describe('delete_sessions 입력 검사', () => {
  test('올바른 항목이 함께 있어도 틀린 항목이 있으면 모두 남기고 2 로 끝난다', () => {
    const box = new Sandbox('mc-ds-')
    const base = join(box.root, 'projects')
    const gone = join(box.root, 'gone')
    const old = join(base, 'old')
    const file = write(join(old, 'a.jsonl'), `${JSON.stringify({ cwd: gone })}\n`)
    const t = Math.floor(Date.now() / 1000) - 30 * 86400
    utimesSync(file, t, t)
    const input = write(join(box.root, 'o.json'), JSON.stringify({ base, orphans: [{ path: old, cwd: gone, newest_mtime: t, size_bytes: 1 }, { path: old, cwd: gone, newest_mtime: 'x' }] }))
    const done = box.run('delete_sessions', [input, '--older-than-days', '14', '--apply'])
    assert.equal(done.code, 2)
    assert.ok(existsSync(old))
  })
})
