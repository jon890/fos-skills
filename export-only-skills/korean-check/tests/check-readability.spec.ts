// check-readability 명령 경계 테스트. 옵션, stdout, 종료 코드, 훅 모드 JSON 의 바이트를 본다.
// 검사마다 경고가 나는 표본과 나지 않는 표본을 함께 둔다. 이 검사기는 실패로 막지 않는다. 경고가 있어도 종료 코드는 0 이다.
// 허용 예외(목록과 표의 이름-설명 엠대시, 이스케이프한 물결표)가 중심이다. 예외를 넓히는 변경은 조용히 통과하므로 표본으로 고정한다.
// 명령 경로는 helpers.ts 의 READABILITY 상수 하나다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { READABILITY, SCRIPTS_DIR, cleanEnv, findingsByLine, lineOf, run, sampleFile, tempDir, write } from './helpers.ts'
import { realpathSync, symlinkSync } from 'node:fs'

const read = (args: string[], opts: { cwd?: string; input?: string } = {}) => run(READABILITY, { ...opts, args })
const on = (text: string, name = 'a.md') => {
  const path = write(join(tempDir(), name), text)
  return { path, ...read([path]) }
}

const MSG = {
  NEST: '괄호 2겹 중첩: 별도 문장으로 나눈다',
  SECT: '§ 대신 섹션이나 장, 또는 번호를 쓴다',
  TILDE: '한 단락에 물결표가 2개 이상이다: 취소선으로 렌더될 수 있어 이스케이프하거나 표현을 바꾼다',
  DASH_HEAD: '제목의 엠대시: 부제를 떼고 한 문장으로 쓴다',
  DASH: '평문의 엠대시: 콜론이나 접속사로 바꾼다',
}

// 표본마다 한 단락씩 담아 한 번에 검사한다. 표본 i 의 경고는 lineOf(i) 줄에 있다
function batch(samples: string[], code: string, expectWarning: boolean) {
  const result = read([sampleFile(tempDir(), samples)])
  assert.equal(result.code, 0, `경고가 실패로 올라갔다: ${result.stdout}`)
  const found = findingsByLine(result.stdout)
  samples.forEach((sample, i) => {
    const has = (found.get(lineOf(i)) ?? []).some((row) => row.includes(`경고 [${code}]`))
    assert.equal(has, expectWarning, expectWarning ? `경고가 나야 하는 표본이 조용했다: ${JSON.stringify(sample)}` : `경고가 나면 안 되는 표본에서 경고가 났다: ${JSON.stringify(sample)}`)
  })
}
const warned = (samples: string[], code: string) => batch(samples, code, true)
const quiet = (samples: string[], code: string) => batch(samples, code, false)

function assertCaught(text: string, code: string) {
  const done = on(text)
  assert.equal(done.code, 0, done.stdout)
  assert.ok(done.stdout.includes(`경고 [${code}]`), `경고가 나야 하는 표본이 조용했다: ${JSON.stringify(text)}`)
}
function assertPassed(text: string) {
  const done = on(text)
  assert.equal(done.code, 0, done.stdout)
  assert.equal(done.stdout, '', `경고가 나면 안 되는 표본에서 경고가 났다: ${done.stdout}`)
}

describe('NEST', () => {
  test('괄호 2겹 중첩을 잡는다', () => warned(['값을 범위로 제한한다 (하한 (0) 과 상한).'], 'NEST'))
  test('나란한 괄호는 잡지 않는다', () => quiet(['값을 (하한) 과 (상한) 으로 제한한다.'], 'NEST'))
  test('코드 스팬과 링크 안의 괄호는 센다 안 센다: 링크와 코드 스팬은 지운 뒤 본다', () => {
    quiet(['`f(g(x))` 를 부른다.', '[문구 (설명)](https://example.com/a(b)) 를 본다.'], 'NEST')
  })
  test('줄마다 따로 센다', () => quiet(['첫째 (하나', '둘째 하나) 끝.'].map((s) => s), 'NEST'))
  test('경고 줄의 꼴', () => {
    const done = on('값을 범위로 제한한다 (하한 (0) 과 상한).\n')
    assert.equal(done.stdout, `${done.path}:1  경고 [NEST] ${MSG.NEST}\n`)
  })
})

describe('SECT', () => {
  test('§ 를 잡는다', () => {
    warned(['자세한 것은 §3 에 있다.'], 'SECT')
    quiet(['자세한 것은 3장에 있다.'], 'SECT')
    const done = on('자세한 것은 §3 에 있다.\n')
    assert.equal(done.stdout, `${done.path}:1  경고 [SECT] ${MSG.SECT}\n`)
  })
})

describe('TILDE', () => {
  test('한 단락의 물결표 둘을 잡는다', () => {
    warned(['범위는 3~5 이고 다른 것은 7~9 다.'], 'TILDE')
    quiet(['범위는 3~5 다.'], 'TILDE')
  })
  test('이스케이프한 물결표는 세지 않는다', () => quiet(['범위는 3\\~5 이고 다른 것은 7\\~9 다.'], 'TILDE'))
  test('단락이 다르면 따로 센다', () => quiet(['범위는 3~5 다.\n\n다른 것은 7~9 다.'], 'TILDE'))
  test('이어진 줄은 한 단락이고 경고는 단락의 첫 줄 번호로 낸다', () => {
    const done = on('# 제목\n\n범위는 3~5 이고\n다른 것은 7~9 다.\n')
    assert.equal(done.stdout, `${done.path}:3  경고 [TILDE] ${MSG.TILDE}\n`)
  })
  test('홈 경로의 물결표는 범위 표기가 아니다: 경로 글자는 한글과 숫자를 포함한다', () => {
    quiet(['설정은 ~/.claude/scripts 에 있고 범위는 3~5 다.', '홈은 ~/문서/설정 이고 범위는 3~5 다.', '홈은 ~/자료2/파일_a 이고 범위는 3~5 다.'], 'TILDE')
    warned(['범위는 3~5 이고 ~ 다음 말이다.'], 'TILDE')
  })
  test('코드 스팬과 링크만 있는 줄은 빈 줄처럼 단락을 끊는다', () => {
    quiet(['범위는 3~5 다.\n`code`\n다른 것은 7~9 다.', '범위는 3~5 다.\n[링크](https://example.com)\n다른 것은 7~9 다.'], 'TILDE')
  })
  test('코드 블록은 단락을 끊고 안의 물결표는 세지 않는다', () => {
    assertPassed('범위는 3~5 다.\n```\n7~9 와 1~2\n```\n다른 것은 7~9 다.\n')
  })
  test('표 행은 건너뛰고 단락을 끊지 않는다', () => {
    assert.ok(on('범위는 3~5 다.\n| a~b | c |\n다른 것은 7~9 다.\n').stdout.includes('[TILDE]'))
  })
  test('인용 표시 뒤의 글을 한 단락으로 본다', () => assertCaught('> 범위는 3~5 이고\n> 다른 것은 7~9 다.\n', 'TILDE'))
})

describe('DASH', () => {
  test('평문과 제목의 엠대시를 잡는다', () => {
    warned(['검사기를 고쳤다 — 제목이 빠져 있었다.'], 'DASH')
    assert.equal(on('## 검사 범위 — 제목까지\n').stdout.includes(MSG.DASH_HEAD), true)
    assert.equal(on('검사기를 고쳤다 — 제목이 빠져 있었다.\n').stdout.includes(MSG.DASH), true)
  })
  test('목록 항목의 이름과 설명을 나누는 엠대시는 허용한다', () => {
    quiet(['- `check.sh` — 검사기 둘을 함께 돌린다', '* 항목 — 설명', '+ 항목 — 설명', '1. 항목 — 설명', '> - 인용 안의 목록 — 설명'], 'DASH')
  })
  test('목록 표시는 뒤에 공백이 있어야 한다', () => warned(['-항목 — 설명', '1.항목 — 설명'], 'DASH'))
  test('표 행의 엠대시는 허용한다', () => assertPassed('| `check.sh` — 묶음 | 둘을 돌린다 |\n| --- | --- |\n'))
  test('목록 표시의 숫자는 유니코드 십진수도 센다', () => quiet(['١. 항목 — 설명'], 'DASH'))
  test('코드 스팬 안의 엠대시는 지운 뒤 본다', () => quiet(['`a — b` 를 부른다.'], 'DASH'))
})

describe('제외 대상', () => {
  test('코드 블록과 코드 스팬은 건너뛴다', () => {
    assertPassed('```\nvalue = f(g(x))\n```\n')
    assertPassed('`f(g(x))` 를 부른다.\n')
  })
  test('frontmatter 는 건너뛴다', () => {
    assertPassed('---\ndescription: 예시 (트리거 (하나) — 둘) §1\n---\n\n본문이다.\n')
  })
  test('닫지 않은 frontmatter 는 끝까지 건너뛴다', () => assertPassed('---\n값 (a (b)) — c\n'))
  test('첫 줄이 아닌 --- 는 frontmatter 가 아니다', () => assertCaught('본문이다.\n---\n값 (a (b)).\n---\n', 'NEST'))
  test('들여쓰고 공백이 붙은 코드 펜스도 토글한다', () => assertPassed('- 목록\n\n  ```\n  값 (a (b)) — c\n  ```\n'))
  test('BOM 이 앞에 오면 frontmatter 로 읽지 않는다', () => assertCaught('\ufeff---\nx (a (b)).\n---\n', 'NEST'))
})

describe('줄 나누기', () => {
  test('CR 과 CRLF 는 줄 하나로 센다', () => {
    const done = on('문제 없다.\r\n값 (a (b)).\r셋째.\r\n')
    assert.equal(done.stdout, `${done.path}:2  경고 [NEST] ${MSG.NEST}\n`)
  })
  test('줄 경계는 Python 과 같다: FF, VT, FS, NEL, U+2028', () => {
    for (const sep of ['\f', '\v', '\x1c', '\x85', '\u2028']) {
      const done = on(`문제 없다.${sep}값 (a (b)).\n`)
      assert.equal(done.stdout, `${done.path}:2  경고 [NEST] ${MSG.NEST}\n`, JSON.stringify(sep))
    }
  })
  test('줄 앞뒤의 공백은 Python 의 공백 정의로 지운다: 0xa0 과 0x85 가 아닌 NBSP', () => {
    // 줄 머리의 NBSP 는 strip 이 지우므로 빈 줄이 되어 단락을 끊는다
    assertPassed('범위는 3~5 다.\n\xa0\n다른 것은 7~9 다.\n')
  })
})

describe('문자열 모드', () => {
  test('경고를 알리고 0 으로 끝난다', () => {
    const done = read(['--text', '검사기를 고쳤다 — 제목이 빠져 있었다'])
    assert.deepEqual([done.code, done.stdout], [0, `(문자열)  경고 [DASH] ${MSG.DASH}\n`])
  })
  test('깨끗한 문자열은 출력이 없다', () => {
    assert.deepEqual(Object.values(read(['--text', 'fix(korean-check): 제목을 검사 대상에 넣는다'])).slice(0, 2), [0, ''])
  })
  test('여러 인자는 공백으로 이어 한 문자열로 본다', () => {
    const done = read(['--text', '값을', '(a (b))', '쓴다'])
    assert.equal(done.stdout, `(문자열)  경고 [NEST] ${MSG.NEST}\n`)
  })
  test('인자가 없거나 빈 문자열이면 경고가 없다', () => {
    assert.deepEqual(read(['--text']).stdout, '')
    assert.deepEqual(read(['--text', '']).code, 0)
  })
  test('옵션처럼 보이는 글도 문자열로 본다', () => assert.equal(read(['--text', '--bogus 값 (a (b))']).stdout, `(문자열)  경고 [NEST] ${MSG.NEST}\n`))
  test('물결표는 문자열 안의 모든 줄을 한 단락으로 본다', () => assert.equal(read(['--text', '3~5 와 7~9']).stdout, `(문자열)  경고 [TILDE] ${MSG.TILDE}\n`))
})

describe('여러 파일과 종료 코드', () => {
  test('인자가 없으면 사용법과 2 다', () => {
    const done = read([])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('사용법'))
  })
  test('다루지 않는 옵션은 2 다', () => {
    const path = write(join(tempDir(), 'a.md'), '문제가 없는 문장이다.\n')
    for (const args of [['--bogus', path], [path, '--hook'], ['-'], ['--']]) {
      const done = read(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.ok(done.stderr.includes('다루지 않는 옵션이다'), done.stderr)
    }
  })
  test('없는 경로는 2 이고 앞 파일의 경고는 그대로 낸다', () => {
    const dir = tempDir()
    const gone = read([join(dir, '없다.md')])
    assert.equal(gone.code, 2)
    assert.ok(gone.stderr.includes('파일이 없다'))
    const both = read([write(join(dir, 'a.md'), '제목 — 설명\n'), join(dir, '없다.md')])
    assert.equal(both.code, 2)
    assert.ok(both.stdout.includes('[DASH]'))
  })
  test('디렉터리를 넘기면 파일이 없다는 2 다', () => assert.equal(read([tempDir()]).code, 2))
  test('여러 파일은 넘긴 순서대로 낸다', () => {
    const dir = tempDir()
    const a = write(join(dir, 'a.md'), '값 (a (b)).\n')
    const b = write(join(dir, 'b.md'), '자세한 것은 §3 에 있다.\n')
    const done = read([b, a])
    assert.deepEqual(done.stdout.split('\n').filter(Boolean), [`${b}:1  경고 [SECT] ${MSG.SECT}`, `${a}:1  경고 [NEST] ${MSG.NEST}`])
  })
  test('한 줄의 경고는 NEST, SECT, DASH 순서다', () => {
    const done = on('값 (a (b)) §1 — c.\n')
    assert.deepEqual(done.stdout.split('\n').filter(Boolean).map((row) => /\[(\w+)\]/.exec(row)?.[1]), ['NEST', 'SECT', 'DASH'])
  })
  test('확장자와 상관없이 직접 넘긴 파일을 검사한다', () => assert.ok(on('값 (a (b)).\n', 'a.txt').stdout.includes('[NEST]')))
})

describe('훅 모드', () => {
  const hook = (payload: unknown) => read(['--hook'], { input: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  const intro = '마크다운 가독성 경고 — 방금 편집한 파일에서 발견했다. 문맥을 보고 고칠지 판단한다.\n'

  test('경고가 있어도 0 이고 JSON 한 줄을 낸다', () => {
    const path = write(join(tempDir(), 'a.md'), '고쳤다 — 빠져 있었다.\n')
    const done = hook({ tool_input: { file_path: path } })
    assert.equal(done.code, 0)
    const ctx = `${intro}${path}:1  경고 [DASH] ${MSG.DASH}`
    assert.equal(done.stdout, `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": ${JSON.stringify(ctx)}}}\n`)
  })
  test('경고 여럿은 줄바꿈으로 잇는다', () => {
    const path = write(join(tempDir(), 'a.md'), '값 (a (b)).\n\n§ 자세히.\n')
    const out = JSON.parse(hook({ tool_input: { file_path: path } }).stdout)
    assert.deepEqual(out.hookSpecificOutput.additionalContext.split('\n').slice(1), [`${path}:1  경고 [NEST] ${MSG.NEST}`, `${path}:3  경고 [SECT] ${MSG.SECT}`])
  })
  test('경로의 한글과 기호는 \\u 로 이스케이프하지 않는다', () => {
    const path = write(join(tempDir(), '“인용” ☃ 😀.md'), '고쳤다 — 빠졌다.\n')
    const done = hook({ tool_input: { file_path: path } })
    assert.ok(!done.stdout.includes('\\u') && done.stdout.includes('“인용” ☃ 😀.md'), done.stdout)
  })
  test('tool_response.filePath 도 읽고 tool_input 이 먼저다', () => {
    const dir = tempDir()
    const a = write(join(dir, 'a.md'), '고쳤다 — 빠졌다.\n')
    const b = write(join(dir, 'b.md'), '문제 없다.\n')
    assert.ok(hook({ tool_response: { filePath: a } }).stdout.includes('DASH'))
    assert.equal(hook({ tool_input: { file_path: b }, tool_response: { filePath: a } }).stdout, '')
  })
  test('깨끗한 파일과 .md 가 아닌 파일은 출력이 없다', () => {
    const dir = tempDir()
    for (const file_path of [write(join(dir, 'a.md'), '문제가 없는 문장이다.\n'), write(join(dir, 'a.txt'), '고쳤다 — 빠졌다.\n')]) {
      const done = hook({ tool_input: { file_path } })
      assert.deepEqual([done.code, done.stdout], [0, ''], file_path)
    }
  })
  test('깨진 입력과 맞지 않는 모양은 0 이고 출력이 없다', () => {
    for (const payload of ['', '{', '{}', '{"tool_input": {}}', '{"tool_input": {"file_path": ""}}']) {
      const done = hook(payload)
      assert.deepEqual([done.code, done.stdout], [0, ''], payload)
    }
  })
  test('없는 .md 는 0 이고 stdout 이 없다', () => {
    const done = hook({ tool_input: { file_path: join(tempDir(), '없다.md') } })
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })
})

describe('링크로 부르기', () => {
  // 사용자 훅이 ~/.claude/scripts/check-readability.ts 링크로 --hook 을 부른다
  const link = () => {
    const path = join(tempDir(), 'check-readability.ts')
    symlinkSync(realpathSync(join(SCRIPTS_DIR, 'check-readability.ts')), path)
    return path
  }
  test('일반 모드의 stdout 과 종료 코드가 같다', () => {
    const path = write(join(tempDir(), 'a.md'), '고쳤다 — 빠졌다.\n\n값 (a (b)).\n')
    const direct = read([path])
    const viaLink = spawnSync(link(), [path], { env: cleanEnv(), encoding: 'utf8' })
    assert.deepEqual([viaLink.status, viaLink.stdout], [direct.code, direct.stdout])
  })
  test('훅 모드는 경고를 additionalContext 에 담고 경고가 없으면 출력이 없다', () => {
    const dir = tempDir()
    const bad = write(join(dir, 'a.md'), '고쳤다 — 빠졌다.\n')
    const good = write(join(dir, 'b.md'), '문제 없다.\n')
    const call = (file_path: string) => spawnSync(link(), ['--hook'], { env: cleanEnv(), input: JSON.stringify({ tool_input: { file_path } }), encoding: 'utf8' })
    const hit = call(bad)
    assert.equal(hit.status, 0)
    assert.ok(JSON.parse(hit.stdout).hookSpecificOutput.additionalContext.includes(`${bad}:1  경고 [DASH]`))
    assert.deepEqual([call(good).status, call(good).stdout], [0, ''])
  })
})
