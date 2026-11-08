// delete_sessions 의 명령 경계 테스트. 임시 projects 폴더의 하위 폴더만 지운다.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'

const DAY = 86400

function setup() {
  const box = new Sandbox()
  const base = join(box.root, 'projects')
  mkdirSync(base)
  const now = Math.floor(Date.now() / 1000)
  const age = (path: string, days: number) => utimesSync(path, now - days * DAY, now - days * DAY)
  // 폴더 하나와 그 안의 기록 파일 하나. 수정 시각은 정수 초라 JSON 에 그대로 적힌다
  const session = (name: string, cwd: string, days = 20, size = 100) => {
    const folder = join(base, name)
    const file = write(join(folder, 'a.jsonl'), `${JSON.stringify({ type: 'user', cwd })}\n${'x'.repeat(size)}`)
    age(file, days)
    return folder
  }
  const item = (folder: string, cwd: string, days = 20, size = 100 + JSON.stringify({ type: 'user', cwd }).length + 1) => ({ path: folder, cwd, newest_mtime: now - days * DAY, size_bytes: size })
  const input = (items: object[], b = base) => write(join(box.root, 'o.json'), JSON.stringify({ base: b, orphans: items }))
  const run = (items: object[], args: string[], b = base) => box.run('delete_sessions', [input(items, b), ...args])
  return { box, base, now, session, item, input, run, age }
}

describe('dry-run 과 --apply', () => {
  test('dry-run 은 지우지 않고 삭제 예정만 보인다', () => {
    const { box, base, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const folder = session('a', gone)
    const done = run([item(folder, gone, 20, 196)], ['--older-than-days', '14'])
    assert.equal(done.code, 0, done.stderr)
    assert.equal(done.stdout, `## dry-run (변경 없음, 실제 삭제는 --apply)\n기준: 14일 넘은 폴더\n[삭제 예정]    196.0B  ${join(base, 'a')}  ${gone}\n\n## 합계\n   1개    196.0B  삭제 예정\n`)
    assert.ok(existsSync(folder))
  })

  test('크기 서식은 정확히 반인 값을 짝수로 반올림한다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const folder = session('a', gone)
    // 1280 / 1024 = 1.25 → 1.2, 1792 / 1024 = 1.75 → 1.8, 2.5 MiB 는 정확히 2.5
    const rows = [1280, 1792, 1024 * 1024 * 2.5, 0, 1023, 1024].map((size) => ({ ...item(folder, gone, 20, size) }))
    const done = run(rows, ['--older-than-days', '14'])
    const sizes = done.stdout.split('\n').filter((l) => l.startsWith('[')).map((l) => /^\[삭제 예정\]\s+(\S+)/.exec(l)![1])
    assert.deepEqual(sizes, ['1.2KB', '1.8KB', '2.5MB', '0.0B', '1023.0B', '1.0KB'])
    assert.ok(done.stdout.includes('\n   6개'))
  })

  test('--apply 는 오래된 폴더만 지우고 젊은 폴더는 남긴다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const old = session('old', gone, 20)
    const young = session('young', gone, 2)
    const done = run([item(old, gone, 20), item(young, gone, 2)], ['--older-than-days', '14', '--apply'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('## 실행\n기준: 14일 넘은 폴더\n[삭제] '))
    assert.ok(done.stdout.includes(`  ${gone}\n`))
    assert.ok(done.stdout.includes('  14일 이내 수정\n'))
    assert.ok(done.stdout.includes('\n## 합계\n   1개'))
    assert.ok(!existsSync(old) && existsSync(young))
  })

  test('기준 일수는 소수와 지수 꼴도 받고 출력은 %g 꼴이다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const folder = session('a', gone, 20)
    const half = run([item(folder, gone, 20)], ['--older-than-days', '0.5'])
    assert.ok(half.stdout.includes('기준: 0.5일 넘은 폴더\n'))
    const exp = run([item(folder, gone, 20)], ['--older-than-days', '1e1'])
    assert.ok(exp.stdout.includes('기준: 10일 넘은 폴더\n'))
    const big = run([item(folder, gone, 20)], ['--older-than-days=1e16'])
    assert.ok(big.stdout.includes('기준: 1e+16일 넘은 폴더\n'), big.stdout)
    const frac = run([item(folder, gone, 20)], ['--older-than-days', '14.123456789'])
    assert.ok(frac.stdout.includes('기준: 14.1235일 넘은 폴더\n'), frac.stdout)
  })

  test('합계는 상태 이름순이고 개수와 크기를 센다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const a = session('a', gone, 20, 2000)
    const b = session('b', gone, 3, 3000)
    const done = run([item(a, gone, 20, 2048), item(b, gone, 3, 3072)], ['--older-than-days', '14'])
    assert.ok(done.stdout.includes('\n## 합계\n   1개     2.0KB  삭제 예정\n   1개     3.0KB  유지\n'), done.stdout)
  })
})

describe('지우기 직전 재확인', () => {
  test('조사 뒤 수정 시각이 바뀌면 남긴다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const folder = session('a', gone)
    const it = item(folder, gone)
    write(join(folder, 'new.jsonl'), '{}')
    const done = run([it], ['--older-than-days', '14', '--apply'])
    assert.ok(done.stdout.includes('  조사 뒤 수정 시각이 바뀌었다(세션이 기록을 이었다)\n'))
    assert.ok(existsSync(folder))
  })

  test('cwd 가 다시 생기면 남긴다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const folder = session('a', gone)
    const it = item(folder, gone)
    mkdirSync(gone)
    const done = run([it], ['--older-than-days', '14', '--apply'])
    assert.ok(done.stdout.includes(`  cwd 가 다시 생겼다: ${gone}\n`))
    assert.ok(existsSync(folder))
  })

  test('기록 안의 cwd 가 조사 때와 다르면 남긴다', () => {
    const { box, session, item, run } = setup()
    const folder = session('a', join(box.root, 'other'))
    const done = run([item(folder, join(box.root, 'gone'))], ['--older-than-days', '14', '--apply'])
    assert.ok(done.stdout.includes(`  cwd 가 조사 때와 다르다: ${join(box.root, 'other')}\n`))
    assert.ok(existsSync(folder))
  })

  test('cwd 를 읽을 수 없으면 남긴다', () => {
    const { box, base, item, run, age } = setup()
    const folder = join(base, 'a')
    age(write(join(folder, 'a.jsonl'), 'not json\n'), 20)
    const done = run([item(folder, join(box.root, 'gone'))], ['--older-than-days', '14', '--apply'])
    assert.ok(done.stdout.includes('  cwd 를 읽을 수 없다\n'))
    assert.ok(existsSync(folder))
  })

  test('기록 폴더 밖과 한 단계 더 깊은 폴더는 남긴다', () => {
    const { box, session, item, run, age } = setup()
    const gone = join(box.root, 'gone')
    const outside = join(box.root, 'outside')
    age(write(join(outside, 'a.jsonl'), `${JSON.stringify({ cwd: gone })}\n`), 20)
    const out = run([item(outside, gone)], ['--older-than-days', '14', '--apply'])
    assert.ok(out.stdout.includes('  기록 폴더 바로 아래가 아니다\n'))
    assert.ok(existsSync(outside))
    const folder = session('a', gone)
    const nested = join(folder, 'deeper')
    age(write(join(nested, 'a.jsonl'), `${JSON.stringify({ cwd: gone })}\n`), 20)
    const deep = run([item(nested, gone)], ['--older-than-days', '14', '--apply'])
    assert.ok(deep.stdout.includes('  기록 폴더 바로 아래가 아니다\n'))
    assert.ok(existsSync(nested))
  })

  test('심볼릭 링크는 따라가지 않고 남긴다', () => {
    const { box, base, run } = setup()
    const gone = join(box.root, 'gone')
    const target = join(box.root, 'target')
    write(join(target, 'a.jsonl'), `${JSON.stringify({ cwd: gone })}\n`)
    symlinkSync(target, join(base, 'link'))
    const done = run([{ path: join(base, 'link'), cwd: gone, newest_mtime: 0, size_bytes: 1 }], ['--older-than-days', '14', '--apply'])
    assert.ok(done.stdout.includes('  실제 폴더가 아니거나 이미 없다\n'))
    assert.ok(existsSync(join(target, 'a.jsonl')))
  })

  test('기록 폴더 이름이 projects 가 아니면 남긴다', () => {
    const { box, now, run, age } = setup()
    const other = join(box.root, 'elsewhere')
    const gone = join(box.root, 'gone')
    const folder = join(other, 'a')
    age(write(join(folder, 'a.jsonl'), `${JSON.stringify({ cwd: gone })}\n`), 20)
    const done = run([{ path: folder, cwd: gone, newest_mtime: now - 20 * DAY, size_bytes: 5 }], ['--older-than-days', '14', '--apply'], other)
    assert.ok(done.stdout.includes('  기록 폴더가 projects 가 아니다\n'))
    assert.ok(existsSync(folder))
  })

  test('이미 없는 폴더는 남긴다고 보인다', () => {
    const { box, base, now, run } = setup()
    const done = run([{ path: join(base, 'gone'), cwd: join(box.root, 'x'), newest_mtime: now - 20 * DAY, size_bytes: 5 }], ['--older-than-days', '14', '--apply'])
    assert.ok(done.stdout.includes('  실제 폴더가 아니거나 이미 없다\n'))
    assert.equal(done.code, 0)
  })

  test('폴더 안의 링크는 따라가지 않고 링크만 지운다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const keep = join(box.root, 'keep')
    write(join(keep, 'precious'), 'data')
    const folder = session('a', gone)
    symlinkSync(keep, join(folder, 'link'))
    const it = item(folder, gone)
    // 링크가 든 폴더의 크기와 수정 시각은 조사 때와 같게 JSON 을 만든다
    const done = run([it], ['--older-than-days', '14', '--apply'])
    assert.equal(done.code, 0, done.stdout)
    assert.ok(!existsSync(folder))
    assert.ok(existsSync(join(keep, 'precious')))
  })
})

describe('입력 오류와 옵션', () => {
  test('--older-than-days 가 없으면 사용법 오류 2 다', () => {
    const { input, box } = setup()
    const done = box.run('delete_sessions', [input([])])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('the following arguments are required: --older-than-days'), done.stderr)
  })

  test('실수가 아닌 기준 일수는 사용법 오류 2 다', () => {
    const { input, box } = setup()
    const done = box.run('delete_sessions', [input([]), '--older-than-days', 'x'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes("argument --older-than-days: invalid float value: 'x'"), done.stderr)
  })

  test('float 로 읽히는 여러 꼴을 받는다', () => {
    const { input, box } = setup()
    for (const v of [' 3 ', '1_0', '+.5', '5.', 'inf', '1E2', '-1']) assert.equal(box.run('delete_sessions', [input([]), '--older-than-days', v]).code, 0, v)
    for (const v of ['', '1__0', '_1', '1_', '0x10', '1e', '--5', 'infinit']) assert.equal(box.run('delete_sessions', [input([]), `--older-than-days=${v}`]).code, 2, v)
  })

  test('nan 은 모든 폴더를 젊지 않다고 본다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const folder = session('a', gone, 20)
    const done = run([item(folder, gone)], ['--older-than-days', 'nan'])
    assert.ok(done.stdout.includes('기준: nan일 넘은 폴더\n'))
    assert.ok(done.stdout.includes('삭제 예정'))
  })

  test('입력 JSON 이 형식과 다르면 2 다', () => {
    const { box } = setup()
    for (const body of ['{}', '[]', '{"base": 1, "orphans": []}', '{"base": "x", "orphans": [{"path": "p"}]}', 'nope']) {
      const done = box.run('delete_sessions', [write(join(box.root, 'bad.json'), body), '--older-than-days', '1'])
      assert.equal(done.code, 2, body)
      assert.ok(done.stderr.startsWith('입력을 읽을 수 없다: '), body)
    }
    assert.equal(box.run('delete_sessions', [join(box.root, 'none.json'), '--older-than-days', '1']).code, 2)
  })

  test('- 는 표준 입력에서 읽는다', () => {
    const { box, base } = setup()
    const done = box.run('delete_sessions', ['-', '--older-than-days', '1'], { input: JSON.stringify({ base, orphans: [] }) })
    assert.equal(done.code, 0)
    assert.ok(done.stdout.endsWith('\n## 합계\n'))
  })

  test('옵션은 줄여 쓰고 =로 값을 줄 수 있다', () => {
    const { box, input } = setup()
    assert.equal(box.run('delete_sessions', [input([]), '--older=3']).code, 0)
    assert.equal(box.run('delete_sessions', [input([]), '--o', '3', '--ap']).code, 0)
  })
})

describe('수정 시각이 숫자가 아닌 항목', () => {
  test('하나라도 틀리면 아무것도 지우지 않고 실패로 끝난다', () => {
    const { box, session, item, run } = setup()
    const gone = join(box.root, 'gone')
    const folder = session('a', gone, 2)
    for (const bad of ['not-a-time', null, '123']) {
      const done = run([{ ...item(folder, gone, 2), newest_mtime: bad }], ['--older-than-days', '14', '--apply'])
      assert.notEqual(done.code, 0, String(bad))
      assert.ok(existsSync(folder), String(bad))
    }
  })
})

