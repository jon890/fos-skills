// korean-style-check 명령 경계 테스트. 옵션, stdout, 종료 코드, 훅 모드 JSON 의 바이트를 본다.
// 검사마다 걸리는 표본과 걸리지 않는 표본을 함께 둔다. 걸리는 쪽만 두면 모든 것을 잡는 검사기도 통과한다.
// 제외 규칙(제목, 코드 스팬, 표 행, frontmatter, 들여쓴 코드 블록, 링크 대상)이 중심이다. 제외를 넓히는 변경은 조용히 통과하므로 표본으로 고정한다.
// 명령 경로는 helpers.ts 의 STYLE 상수 하나다. 구현을 바꿔도 이 파일의 사례는 고치지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { RULES, SCRIPTS_DIR, STYLE, cleanEnv, findingsByLine, git, initRepo, lineOf, run, sampleFile, tempDir, write } from './helpers.ts'

const style = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) => run(STYLE, { ...opts, args })

// 파일 하나에 text 를 쓰고 검사한다
function on(text: string, name = 'a.md', env?: NodeJS.ProcessEnv) {
  const path = write(join(tempDir(), name), text)
  return { path, ...style([path], { env }) }
}

// 표본마다 한 줄씩 담아 한 번에 검사한다. 표본 i 의 발견은 lineOf(i) 줄에 있다
function caught(samples: string[], term?: string | ((i: number) => string)) {
  const dir = tempDir()
  const result = style([sampleFile(dir, samples.map((s) => s))])
  const found = findingsByLine(result.stdout)
  samples.forEach((sample, i) => {
    const rows = (found.get(lineOf(i)) ?? []).filter((row) => row.includes('금지어'))
    assert.ok(rows.length > 0, `통과하면 안 되는 표본이 통과했다: ${JSON.stringify(sample)}`)
    const want = typeof term === 'function' ? term(i) : term
    if (want) assert.ok(rows.some((row) => row.includes(want)), `${JSON.stringify(sample)} 의 발견에 ${want} 가 없다: ${rows.join(' | ')}`)
  })
  assert.equal(result.code, 1)
}

function passed(samples: string[]) {
  const result = style([sampleFile(tempDir(), samples)])
  assert.equal(result.code, 0, `걸리면 안 되는 표본이 걸렸다: ${result.stdout}`)
}

function assertCaught(text: string, term?: string, name = 'a.md') {
  const done = on(text, name)
  assert.equal(done.code, 1, `통과하면 안 되는 표본이 통과했다: ${JSON.stringify(text)}`)
  if (term) assert.ok(done.stdout.includes(term), done.stdout)
}

function assertPassed(text: string, name = 'a.md') {
  const done = on(text, name)
  assert.equal(done.code, 0, `걸리면 안 되는 표본이 걸렸다: ${done.stdout}`)
}

describe('제목과 제외 규칙', () => {
  test('제목은 검사 대상이다', () => {
    assertCaught('# 장애를 트리아지한다\n', '트리아지')
    assertCaught('#### 트리아지 순서\n', '트리아지')
  })
  test('코드 블록 안의 제목은 건너뛴다', () => assertPassed('```\n# 트리아지\n```\n'))
  test('코드 스팬은 건너뛴다', () => assertPassed('본문에서 `트리아지` 는 코드 스팬이라 제외된다.\n'))
  test('표 행은 건너뛴다', () => assertPassed('| 트리아지 | 분류 |\n| --- | --- |\n'))
  test('frontmatter 는 건너뛴다', () => assertPassed('---\ntriggers: 트리아지\n---\n\n본문이다.\n'))
  test('frontmatter 시작 줄 뒤의 공백은 허용하고 둘째 줄부터의 시작 표시는 본문이다', () => {
    assertPassed('---  \ntriggers: 트리아지\n---\t\n본문이다.\n')
    assertCaught('본문이다.\n---\n트리아지\n---\n', '트리아지')
  })
  test('BOM 이 앞에 오면 frontmatter 로 읽지 않는다', () => assertCaught('\ufeff---\ntriggers: 트리아지\n---\n', '트리아지'))
  test('들여쓴 코드 블록도 건너뛴다', () => assertPassed('- 목록\n\n  ```\n  트리아지\n  ```\n'))
  test('링크 대상 URL 은 건너뛰고 링크 문구는 검사한다', () => {
    assertPassed('[문구](https://example.com/트리아지)\n')
    assertCaught('[트리아지](https://example.com/a)\n', '트리아지')
  })
  test('괄호가 중첩된 링크 대상은 짝이 맞는 괄호까지 지운다', () => {
    assertPassed('[문구](https://example.com/a_(트리아지)) 본문이다.\n')
    assertCaught('[문구](https://example.com/a_(b)) 트리아지 본문이다.\n', '트리아지')
  })
  test('꺾쇠로 감싼 링크 대상 안의 괄호는 세지 않는다', () => assertPassed('[문구](<https://example.com/a)트리아지>) 본문이다.\n'))
  test('짝이 맞지 않는 링크 대상은 그 뒤를 그대로 검사한다', () => assertCaught('[문구](https://example.com/트리아지\n', '트리아지'))
  test('링크 정의 줄은 건너뛴다', () => assertPassed('[ref]: https://example.com/트리아지\n'))
  test('자동 링크 URL 은 건너뛰고 둘레 글은 검사한다', () => {
    assertPassed('<https://example.com/트리아지>\n')
    assertCaught('트리아지 <https://example.com/a>\n', '트리아지')
  })
})

describe('줄 나누기', () => {
  test('CRLF 와 CR 만 쓴 파일의 줄 번호', () => {
    const done = on('문제 없다.\r\n장애를 트리아지한다.\r셋째 줄이다.\r\n')
    assert.match(done.stdout, /a\.md:2: 금지어 "트리아지"/)
  })
  test('줄 경계는 Python str.splitlines 와 같다: U+2028, FF, VT, FS, NEL 에서 나뉜다', () => {
    for (const sep of ['\u2028', '\f', '\v', '\x1c', '\x85']) {
      const done = on(`문제 없다.${sep}장애를 트리아지한다.\n`)
      assert.match(done.stdout, /a\.md:2: 금지어 "트리아지"/, JSON.stringify(sep))
    }
  })
  test('끝 줄바꿈이 없는 마지막 줄도 검사한다', () => assert.equal(on('장애를 트리아지한다.').code, 1))
  test('빈 파일은 통과다', () => assert.deepEqual([on('').code, on('').stdout], [0, '']))
})

describe('등록한 형태', () => {
  test('기계는 조사가 붙은 형태만 막는다', () => {
    for (const form of ['기계가', '기계로', '기계적']) assertCaught(`${form} 판정한다.\n`, form)
    assertPassed('기계 학습 모델과 기계 번역을 쓴다.\n')
  })
  test('시험이 걸린다', () => assertCaught('시험이 실패한다.\n', '시험'))
  test('시험적은 허용하지만 같은 줄의 맨 시험은 잡는다', () => {
    assertPassed('새 설정을 시험적으로 도입한다.\n')
    assertCaught('시험적으로 도입하고 시험을 돌린다.\n', '시험')
  })
  test('문턱 계열은 조사와 합성어 형태까지 막고 권장어는 통과한다', () => {
    for (const form of ['문턱값', '문턱으로', '문턱을']) assertCaught(`${form} 넘는다.\n`, '문턱')
    assertPassed('임계값을 넘으면 기준값으로 되돌린다.\n')
  })
})

describe('DB 문맥의 표와 칸', () => {
  test('DB 의 표와 칸으로 쓴 말을 막는다', () => {
    caught(['DB 표를 만든다.', '`sensor` DB 표 `raw_recipient` 를 본다.', '`orders` 표에 행을 넣는다.', '`care.registry` 칸을 바꾼다.', '`status` 칸은 null 이다.'], '금지어')
  })
  test('문서의 표를 가리키는 말은 막지 않는다', () => {
    passed(['아래 표를 본다.', '결과를 표로 정리한다.', '표의 열을 맞춘다.', '표를 만들어 비교한다.', 'DB 표준을 따른다.', 'DB 표시 방식을 바꾼다.', '`a.md` 파일의 표시를 바꾼다.', 'plan 디렉터리의 `remote.md` 표', '`run.py` 칸을 본다.', '빈 칸을 채운다.', '`orders` 테이블의 `status` 컬럼을 바꾼다.'])
  })
  test('뒤에 오는 글자는 Python 의 공백 정의를 따른다: US(0x1f)는 공백이고 U+FEFF 는 아니다', () => {
    // 0x1f 는 줄 경계가 아니면서 정규식 \s 에는 든다
    assertCaught('DB 표\x1f다음 말이다.\n', 'DB 표')
    assertPassed('DB 표\ufeff다음 말이다.\n')
  })
  test('이름이 같은 코드 스팬 안의 글자는 열 계산에서 건너뛴다', () => {
    const done = on('`x-` 칸을 채운다.\n')
    assert.ok(done.stdout.includes('금지어 "`식별자` 칸" (열 1, 걸린 글자 "`x-` 칸")'), done.stdout)
  })
})

describe('갈음', () => {
  test('갈음은 막고 대신한다는 막지 않는다', () => {
    caught(['CI 결과로 갈음한다.', '검사를 갈음하지 않는다.'], '금지어')
    passed(['CI 결과로 대신한다.', '검사를 대신하지 않는다.'])
  })
})

describe('원천', () => {
  test('데이터가 어디 있는지를 원천으로 뭉뚱그린 말은 막고 다른 뜻의 합성어는 막지 않는다', () => {
    caught(['원천에만 있다.', '표 열 원천을 적는다.', '값의 원천을 확인한다.'], '금지어')
    passed(['통합어드민에 있고 우리는 저장하지 않는다.', '데이터를 가진 곳을 적는다.', '원천징수 영수증을 받는다.', '원천적으로 막는다.', '원천 기술을 쓴다.', '원천기술을 쓴다.', '원천봉쇄를 한다.'])
  })
})

describe('서다 비유와 자리 표현', () => {
  test('생기다를 서다로 비유한 말은 막고 평범한 말은 막지 않는다', () => {
    caught(['위험 카드가 선다.', '티켓이 서지 않는다.', '카드가 서야 한다.', '표시가 서야 통과다.', '알림이 선다고 본다.', '기록이 서지 않으면 실패다.'], '금지어')
    passed(['실행 순서가 중요하다.', '서지 정보를 읽는다.', '이 서지 정보는 따로 둔다.', '대기 줄이 선다.', '요청 줄이 서야 한다.', '서버가 서류를 읽는다.', '여기서지 않는다.', '위험 카드가 만들어진다. 티켓이 생기지 않는다. 표시된다.'])
  })
  test('서는 화면 계열은 막고 서는을 품은 말은 막지 않는다', () => {
    caught(['결과가 서는 화면을 바꾼다.', '알림이 서는 곳을 정한다.', '버튼이 서는 자리에 둔다.', '서는 화면이 둘이다.'], '서는')
    passed(['여기서는 화면을 나눈다.', '문서는 곳곳에 예시를 둔다.', '목록에서는 자리를 비운다.', '이 계획서는 화면 설계를 다룬다.', '서버는 곳마다 다르다.', '결과가 보이는 화면을 바꾼다. 알림이 표시되는 곳을 정한다.'])
  })
  test('날 요소 계열은 막고 날짜 같은 말은 막지 않는다', () => {
    caught(['날 요소를 쓴다.', '날 HTML 요소를 쓴다.', '날 태그를 쓴다.', '날 <button> 대신 쓴다.'], '날')
    passed(['날짜를 적는다.', '그 날 요청이 들어왔다.', '오늘날 요소가 많다.', '생일날 태그를 단다.', '날씨 HTML 을 만든다.', 'a < b 이면 날 수 있다.', 'HTML 기본 요소 대신 컴포넌트를 쓴다.'])
  })
})

describe('손으로, 거르다, 가르다, 견주다', () => {
  test('손으로와 거르다 활용형', () => {
    caught(['파일을 손으로 옮겨 배포한다.', '조건으로 거르는 방식이다.', '목록을 거른다.', '중복을 거를 수 있다.', '무효 항목을 걸러낸다.'], (i) => ['손으로', '거르', '거른', '거를', '걸러'][i])
    passed(['근거를 남긴다.', '증거를 모은다.', '판단 근거를 적는다.', '빈손으로 돌아왔다.', '맨손으로 만졌다.', '왼손으로 쓴다.', '메일함 필터링 조건을 추가하고 직접 확인한다.'])
  })
  test('가르다 활용형', () => {
    caught(['원인을 가르지 못한다.', '둘을 가르는 기준이다.', '두 경우를 가른다.', '둘을 가를 수 없다.', '판단을 갈랐다.', '먼저 갈라야 한다.', '승패를 가름한다.'], (i) => ['가르지', '가르는', '가른', '가를', '갈랐', '갈라야', '가름'][i])
    passed(['후배를 가르치는 일이다.', '방법을 가르쳐 준다.', '브랜치가 갈라진다.', '갈라진 두 갈래를 합친다.', '승패는 판가름이 난다.', '첫 평가를 남긴다.', '원인을 확인하지 않았다. 두 경우를 구분한다.'])
  })
  test('견주다 활용형', () => {
    caught(['평가 세트로 다시 견준다.', '기준선에 견줄 만한 값이 없다.', '결과를 기준과 견주어 본다.', '두 값을 견주는 표를 만든다.'], (i) => ['견준다', '견줄', '견주', '견주'][i])
    passed(['견적을 받는다.', '의견을 준다.', '의견 주세요.', '견본을 만든다.', '견고하게 짠다.', '평가 세트로 다시 측정한다. 두 결과를 비교한다.'])
  })
})

describe('판', () => {
  test('버전 뜻으로 쓴 판은 막는다', () => {
    caught(['SDK 판을 올린다.', '라이브러리 판 올리기를 한다.', '배포 판 번호를 적는다.', '의존성 판 고정이 필요하다.', 'SDK 판이 바뀌었다.', '의존성 판을 고정한다.', '최신 판으로 올린다.', '새 판이 나왔다.', '기준 판을 정한다.', '판마다 다르다.', '판 접두사를 붙인다.', '릴리스 판에서 확인한다.'], '금지어')
  })
  test('다른 낱말 속의 판은 막지 않는다', () => {
    passed(['원인을 판단한다.', '결과를 판별한다.', '통과 여부를 판정한다.', '문서를 출판한다.', '간판을 단다.', '게시판에 올린다.', '게시판을 올려 둔다.', '게시판 번호를 적는다.', '간판을 올린다.', '상품을 판매한다.', '판단 기준을 정한다.', '새 판단을 내린다.', '번호판 번호를 확인한다.', '출판 번호를 적는다.', '자판 번호를 누른다.', '전광판 번호를 본다.', '초판을 올린다.', '철판을 올린다.', '바둑판을 올린다.', '계산판 고정 나사.', '기준 판단을 내린다.', '새 판단을 한다.', '판별 fixture 를 둔다.', '두 방식은 판이하게 다르다.', '판정 결과를 판독한다.', '판례를 찾는다.', '판도가 바뀐다.'])
  })
})

describe('없앤 금지어', () => {
  test('평범한 우리말과 영어 원어는 금지어가 아니다', () => {
    passed(['원인을 좁혀 나간다.', '테스트가 이 경우를 덮는다.', '응답 시간을 잰다.', '로그 레벨을 강등한다.'])
    passed(['matrix', 'triage', 'spike', 'sweep', 'gate', 'wall-time', 'baseline'].map((term) => `${term} 을 사용한다.`))
  })
})

describe('매핑 표 읽기', () => {
  const TABLE = '## 어색한 말 매핑 표\n\n| 금지 | 원어 | 권장 |\n| --- | --- | --- |\n| 폭주 (CPU 폭주 등) | runaway | 과점유 |\n| gate / 게이트 | | 점검 |\n'
  const withTable = (text: string) => {
    const dir = tempDir()
    const rules = write(join(dir, 'rules.md'), TABLE)
    return style([write(join(dir, 'a.md'), text)], { env: cleanEnv({ KOREAN_STYLE_RULES: rules }) })
  }
  test('슬래시는 동의어를 나눈다', () => {
    for (const text of ['외부 상태 gate 를 둔다.\n', '배포 게이트를 지난다.\n']) assert.equal(withTable(text).code, 1, text)
  })
  test('괄호 안 설명과 원어 열은 금지어가 아니다', () => {
    assert.equal(withTable('CPU 가 runaway 상태다.\n').code, 0)
    assert.equal(withTable('CPU 가 폭주한다.\n').code, 1)
  })
  test('영문 금지어는 더 긴 영어 낱말 속에서 잡지 않는다', () => {
    for (const text of ['aggregate 를 쓴다.\n', 'gateway 를 앞에 둔다.\n', 'pre-gate-check 라는 이름이다.\n']) assert.equal(withTable(text).code, 0, text)
  })
  test('표가 없거나 금지어를 뽑지 못하면 2 다', () => {
    const dir = tempDir()
    const empty = write(join(dir, 'empty.md'), '## 어색한 말 매핑 표\n\n| 금지 | 원어 | 권장 |\n| --- | --- | --- |\n')
    const done = style([write(join(dir, 'a.md'), '문장이다.\n')], { env: cleanEnv({ KOREAN_STYLE_RULES: empty }) })
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('금지어를 추출하지 못했다'), done.stderr)
  })
  test('표가 다음 절에서 끝난다', () => {
    const dir = tempDir()
    const rules = write(join(dir, 'rules.md'), `${TABLE}\n## 다른 절\n\n| 폭풍 | x | y |\n`)
    const done = style([write(join(dir, 'a.md'), '폭풍이 분다.\n')], { env: cleanEnv({ KOREAN_STYLE_RULES: rules }) })
    assert.equal(done.code, 0)
  })
})

describe('발견 줄의 꼴', () => {
  test('걸린 글자와 열을 보인다', () => {
    assert.ok(on('장애를 트리아지한다.\n').stdout.includes('a.md:1: 금지어 "트리아지" (열 5, 걸린 글자 "트리아지")'))
  })
  test('같은 줄의 발견은 각자 걸린 글자를 가진다', () => {
    const out = on('트리아지와 스파이크를 한다.\n').stdout
    assert.ok(out.includes('걸린 글자 "트리아지"') && out.includes('걸린 글자 "스파이크"'), out)
  })
  test('대안 형태 가운데 실제로 걸린 것을 보인다', () => {
    assert.ok(on('배포 게이트를 지나 기계가 판정한다.\n').stdout.includes('(열 12, 걸린 글자 "기계가")'))
  })
  test('코드 스팬 안의 같은 글자는 건너뛰고 열을 센다', () => {
    assert.ok(on('`트리아지` 와 트리아지 를 구분한다.\n').stdout.includes('(열 10, 걸린 글자 "트리아지")'))
  })
  test('열은 코드 포인트로 센다', () => {
    assert.ok(on('😀 트리아지.\n').stdout.includes('(열 3, 걸린 글자 "트리아지")'))
    assert.ok(on('`😀` 트리아지.\n').stdout.includes('(열 5, 걸린 글자 "트리아지")'))
  })
  test('발견 줄 앞의 경로와 줄 번호는 check-diff 가 읽는 꼴이다', () => {
    const first = on('트리아지.\n').stdout.split('\n')[0]
    const m = /^(.+?):(\d+)[: ]/.exec(first)
    assert.equal(m?.[2], '1')
    assert.ok(m?.[1].endsWith('a.md'))
  })
  test('발견은 줄 순서이고 경고는 발견 뒤에 같은 파일 안에서 모인다', () => {
    const rows = on('배포 + 검증을 한다.\n트리아지.\n').stdout.split('\n').filter(Boolean)
    assert.equal(rows.length, 2)
    assert.match(rows[0], /a\.md:2: 금지어/)
    assert.match(rows[1], /a\.md:1: 경고: 인라인 \+ 연결/)
  })
  test('여러 파일을 넘기면 파일 순서대로 낸다', () => {
    const dir = tempDir()
    const a = write(join(dir, 'a.md'), '트리아지.\n')
    const b = write(join(dir, 'b.md'), '스파이크.\n')
    const done = style([b, a])
    assert.deepEqual(done.stdout.split('\n').filter(Boolean).map((row) => row.slice(dir.length + 1, dir.length + 2)), ['b', 'a'])
    assert.equal(done.code, 1)
  })
})

describe('인라인 + 연결', () => {
  const warns = (text: string) => on(text).stdout.includes('경고: 인라인 + 연결')
  test('경고만 내고 통과다', () => {
    const done = on('배포 + 검증을 함께 한다.\n')
    assert.equal(done.code, 0, done.stdout)
    assert.ok(done.stdout.includes('경고: 인라인 + 연결'))
  })
  test('경고가 나지 않는 형태', () => {
    for (const text of ['a+b 를 계산한다.\n', '`GPU 수 + 1` 로 센다.\n', '`BASE` + `OFFSET` 으로 계산한다.\n', 'TIMEOUT + RETRY_DELAY 만큼 기다린다.\n', '`base` + MAX_SIZE 로 상한을 정한다.\n']) assert.equal(warns(text), false, text)
  })
  test('낱말 사이의 + 는 경고한다', () => {
    assert.equal(warns('(배포 + 검증) 을 함께 한다.\n'), true)
    assert.equal(warns('`build` + 검증을 함께 한다.\n'), true)
  })
  test('\\S 는 Python 의 공백 정의를 따른다: US(0x1f)가 낀 자리는 낱말이 아니다', () => {
    assert.equal(warns('가\x1f + 나 를 한다.\n'), false)
    assert.equal(warns('가 + 나 를 한다.\n'), true)
  })
})

describe('규칙 파일 자신과 확장자', () => {
  test('매핑 표 자신은 건너뛴다', () => {
    const done = style([RULES], { env: cleanEnv({ KOREAN_STYLE_RULES: RULES }) })
    assert.equal(done.code, 0, done.stdout)
  })
  test('CHANGELOG.md 도 직접 넘기면 검사한다', () => assertCaught('장애를 트리아지했다.\n', '트리아지', 'CHANGELOG.md'))
  test('직접 넘긴 파일은 확장자와 상관없이 검사한다', () => {
    const done = on('매트릭스 자리다.\n', 'a.txt')
    assert.notEqual(done.code, 0)
    assert.ok(done.stdout.includes('매트릭스'))
    assertPassed('문제가 없는 문장이다.\n', 'a.txt')
  })
})

describe('예외 파일', () => {
  const NAME = '시험 던전'
  function makeRepo(allowText?: string, repo = 'repo') {
    const root = join(tempDir(), repo)
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, 'docs'))
    if (allowText !== undefined) write(join(root, '.claude', 'korean-check-allow.txt'), allowText)
    return root
  }
  const runIn = (root: string, text: string, env: Record<string, string> = {}) => style([write(join(root, 'docs', 'a.md'), text)], { env: cleanEnv(env) })

  test('예외 파일이 없으면 걸린다', () => assert.equal(runIn(makeRepo(), `${NAME} 입장 조건이다.\n`).code, 1))
  test('적은 문자열은 건너뛴다', () => {
    const done = runIn(makeRepo(`# 게임 콘텐츠 이름\n\n${NAME}\n`), `${NAME} 입장 조건이다.\n`)
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })
  test('문자열 밖의 금지어는 그대로 잡는다', () => {
    const done = runIn(makeRepo(`${NAME}\n`), `${NAME} 에서 시험 한다.\n`)
    assert.equal(done.code, 1)
    assert.ok(done.stdout.includes('"시험"'))
  })
  test('주석 줄은 항목이 아니다', () => assert.equal(runIn(makeRepo(`# ${NAME}\n`), `${NAME} 입장이다.\n`).code, 1))
  test('한 글자 항목은 검사를 끄지 못하고 stderr 로 알린다', () => {
    const done = runIn(makeRepo('시\n'), '시험 한다.\n')
    assert.equal(done.code, 1)
    assert.ok(done.stderr.includes('너무 짧아'))
  })
  test('저장소 경계 위의 예외 파일은 쓰지 않는다', () => {
    const outer = tempDir()
    write(join(outer, '.claude', 'korean-check-allow.txt'), `${NAME}\n`)
    const inner = join(outer, 'inner')
    mkdirSync(join(inner, '.git'), { recursive: true })
    mkdirSync(join(inner, 'docs'))
    assert.equal(runIn(inner, `${NAME} 입장이다.\n`).code, 1)
  })
  test('같은 저장소의 위 디렉터리 예외 파일은 쓴다', () => {
    const root = makeRepo(`${NAME}\n`)
    const nested = join(root, 'docs', 'deep')
    const done = style([write(join(nested, 'a.md'), `${NAME} 입장이다.\n`)])
    assert.equal(done.code, 0, done.stdout)
  })
  test('KOREAN_CHECK_ALLOW 는 그 파일만 본다', () => {
    const allow = write(join(tempDir(), 'elsewhere.txt'), `${NAME}\n`)
    assert.equal(runIn(makeRepo(), `${NAME} 입장이다.\n`, { KOREAN_CHECK_ALLOW: allow }).code, 0)
    assert.equal(runIn(makeRepo(`${NAME}\n`), `${NAME} 입장이다.\n`, { KOREAN_CHECK_ALLOW: join(tempDir(), 'none.txt') }).code, 1)
  })
  test('예외 문자열은 DB 문맥 검사에도 적용한다', () => {
    const done = runIn(makeRepo('`orders` 표\n'), '`orders` 표에 행을 넣는다.\n')
    assert.equal(done.code, 0, done.stdout)
  })
})

describe('종료 코드와 옵션', () => {
  test('깨끗한 파일은 0 이고 출력이 없다', () => assert.deepEqual(Object.values(on('문제가 없는 문장이다.\n')).slice(1, 3), [0, '']))
  test('없는 경로는 2 이고 나머지 파일의 발견은 그대로 낸다', () => {
    const dir = tempDir()
    const gone = style([join(dir, '없다.md')])
    assert.equal(gone.code, 2)
    assert.ok(gone.stderr.includes('파일이 없다'))
    const both = style([write(join(dir, 'a.md'), '장애를 트리아지한다.\n'), join(dir, '없다.md')])
    assert.equal(both.code, 2)
    assert.ok(both.stdout.includes('트리아지'))
  })
  test('매핑 표가 없으면 2 다', () => {
    const done = style([write(join(tempDir(), 'a.md'), '문장이다.\n')], { env: cleanEnv({ KOREAN_STYLE_RULES: join(tempDir(), '없다.md') }) })
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('매핑 표를 찾지 못했다'))
  })
  test('인자가 없으면 사용법과 2 다', () => {
    const done = style([])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.includes('사용법'))
  })
  test('다루지 않는 인자는 2 다. --text 도 받지 않는다', () => {
    for (const args of [['--text', '장애를 트리아지한다'], ['--bogus', 'a.md'], ['--']]) {
      const done = style(args)
      assert.equal(done.code, 2, args.join(' '))
      assert.ok(done.stderr.includes('다루지 않는 인자다'), done.stderr)
    }
  })
  test('--hook 은 첫 인자일 때만 훅 모드다', () => {
    const path = write(join(tempDir(), 'a.md'), '문장이다.\n')
    assert.equal(style([path, '--hook']).code, 2)
  })
})

describe('훅 모드', () => {
  const hook = (payload: unknown, env?: NodeJS.ProcessEnv) => style(['--hook'], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env })
  const intro = '한국어 표기 정책 점검 — 방금 편집한 파일에서 발견했다. 금지어는 지금 고치고, 경고는 문맥을 보고 판단한다.\n'

  test('발견이 있어도 0 이고 JSON 한 줄을 낸다', () => {
    const path = write(join(tempDir(), 'a.md'), '# 장애를 트리아지한다\n')
    const done = hook({ tool_input: { file_path: path } })
    assert.equal(done.code, 0)
    const ctx = `${intro}${path}:1: 금지어 "트리아지" (열 7, 걸린 글자 "트리아지") — korean-style 매핑 표의 권장 표현으로`
    assert.equal(done.stdout, `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": ${JSON.stringify(ctx)}}}\n`)
  })
  test('금지어와 경고가 함께 있으면 금지어 줄 뒤에 경고 줄이 온다', () => {
    const path = write(join(tempDir(), 'a.md'), '배포 + 검증을 한다.\n트리아지.\n')
    const out = JSON.parse(hook({ tool_input: { file_path: path } }).stdout)
    const rows = out.hookSpecificOutput.additionalContext.split('\n').slice(1)
    assert.match(rows[0], /:2: 금지어/)
    assert.match(rows[1], /:1: 경고: 인라인/)
  })
  test('경로의 한글과 비 ASCII 기호는 \\u 로 이스케이프하지 않는다', () => {
    const path = write(join(tempDir(), '“인용” ☃ 😀.md'), '트리아지\n')
    const done = hook({ tool_input: { file_path: path } })
    assert.ok(!done.stdout.includes('\\u'), done.stdout)
    assert.ok(done.stdout.includes('“인용” ☃ 😀.md'))
  })
  test('JSON 이스케이프는 따옴표, 역슬래시, 탭, 제어 문자에 건다', () => {
    const path = write(join(tempDir(), 'a "q"\\b.md'), '트리아지 "인용" \\ \t 끝\x01\n')
    const done = hook({ tool_input: { file_path: path } })
    assert.equal(done.code, 0)
    const parsed = JSON.parse(done.stdout)
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(path))
    assert.ok(done.stdout.includes('\\u0001') || !done.stdout.includes('\x01'))
    assert.ok(!done.stdout.includes('\t'))
  })
  test('tool_response.filePath 도 대상으로 읽는다', () => {
    const path = write(join(tempDir(), 'a.md'), '장애를 트리아지한다.\n')
    assert.ok(hook({ tool_response: { filePath: path } }).stdout.includes('트리아지'))
  })
  test('tool_input.file_path 가 있으면 그것이 먼저다', () => {
    const dir = tempDir()
    const a = write(join(dir, 'a.md'), '장애를 트리아지한다.\n')
    const b = write(join(dir, 'b.md'), '문제 없다.\n')
    assert.ok(hook({ tool_input: { file_path: a }, tool_response: { filePath: b } }).stdout.includes('트리아지'))
    assert.equal(hook({ tool_input: { file_path: b }, tool_response: { filePath: a } }).stdout, '')
  })
  test('깨끗한 파일은 출력이 없다', () => {
    const done = hook({ tool_input: { file_path: write(join(tempDir(), 'a.md'), '문제가 없는 문장이다.\n') } })
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })
  test('CHANGELOG.md 도 훅에서는 검사한다', () => {
    const path = write(join(tempDir(), 'CHANGELOG.md'), '예전에 장애를 트리아지했다.\n')
    assert.ok(hook({ tool_input: { file_path: path } }).stdout.includes('트리아지'))
  })
  test('.md 가 아닌 파일, 없는 파일, 규칙 파일은 건너뛴다', () => {
    const dir = tempDir()
    for (const file_path of [write(join(dir, 'a.txt'), '# 장애를 트리아지한다\n'), join(dir, '없다.md'), RULES]) {
      const done = hook({ tool_input: { file_path } }, cleanEnv({ KOREAN_STYLE_RULES: RULES }))
      assert.deepEqual([done.code, done.stdout], [0, ''], file_path)
    }
  })
  test('깨진 입력과 맞지 않는 모양은 0 이고 출력이 없다', () => {
    for (const payload of ['', '{', 'null', '[]', '"x"', '{}', '{"tool_input": 3}', '{"tool_input": {}}', '{"tool_input": {"file_path": ""}}']) {
      const done = hook(payload)
      assert.deepEqual([done.code, done.stdout], [0, ''], payload)
    }
  })
  test('매핑 표가 없으면 훅에서도 2 다', () => {
    const done = hook({ tool_input: { file_path: write(join(tempDir(), 'a.md'), '트리아지\n') } }, cleanEnv({ KOREAN_STYLE_RULES: join(tempDir(), '없다.md') }))
    assert.equal(done.code, 2)
  })
  test('금지어를 뽑지 못해도 훅은 0 이고 stderr 로만 알린다', () => {
    const empty = write(join(tempDir(), 'empty.md'), '## 어색한 말 매핑 표\n')
    const done = hook({ tool_input: { file_path: write(join(tempDir(), 'a.md'), '트리아지\n') } }, cleanEnv({ KOREAN_STYLE_RULES: empty }))
    assert.deepEqual([done.code, done.stdout], [0, ''])
    assert.ok(done.stderr.includes('금지어를 추출하지 못했다'))
  })
})

describe('링크로 부르기', () => {
  // 사용자 훅이 ~/.claude/scripts/korean-style-check.py 링크로 이 검사기를 --hook 으로 부른다(스펙 REQ6).
  // 링크를 실체까지 따라가 매핑 표를 찾아야 한다. 일반 모드의 출력은 링크로 불러도 같다
  const legacyPath = join(SCRIPTS_DIR, 'korean-style-check.py')
  function linked() {
    const link = join(tempDir(), 'korean-style-check.py')
    symlinkSync(realpathSync(legacyPath), link)
    return link
  }
  test('링크로 부른 일반 모드의 stdout 과 종료 코드가 같다', () => {
    const path = write(join(tempDir(), 'a.md'), '# 장애를 트리아지한다\n\n배포 + 검증.\n')
    const direct = style([path])
    const viaLink = spawnSync(linked(), [path], { env: cleanEnv(), encoding: 'utf8' })
    assert.equal(viaLink.status, direct.code)
    assert.equal(viaLink.stdout, direct.stdout)
  })
  test('링크로 부른 훅 모드는 발견을 additionalContext 에 담는다', () => {
    const path = write(join(tempDir(), 'a.md'), '# 장애를 트리아지한다\n')
    const done = spawnSync(linked(), ['--hook'], { env: cleanEnv(), input: JSON.stringify({ tool_input: { file_path: path } }), encoding: 'utf8' })
    assert.equal(done.status, 0)
    const ctx: string = JSON.parse(done.stdout).hookSpecificOutput.additionalContext
    assert.ok(ctx.includes(`${path}:1: 금지어 "트리아지"`), ctx)
  })
  test('링크로 부른 훅 모드는 발견이 없으면 출력이 없다', () => {
    const path = write(join(tempDir(), 'a.md'), '문제가 없는 문장이다.\n')
    const done = spawnSync(linked(), ['--hook'], { env: cleanEnv(), input: JSON.stringify({ tool_input: { file_path: path } }), encoding: 'utf8' })
    assert.deepEqual([done.status, done.stdout], [0, ''])
  })
})

// 추적 문서에서 과거 이력과 저장소가 지정한 외부 사본만 제외한다.
// .claude/korean-check-exclude.txt 는 저장소 기준 파일 경로나 / 로 끝나는 디렉터리를 받는다
function repositoryMarkdownFiles(root: string): string[] {
  const config = join(root, '.claude', 'korean-check-exclude.txt')
  const exclusions: string[] = []
  if (existsSync(config)) {
    readFileSync(config, 'utf8').split('\n').forEach((line, i) => {
      const entry = line.trim()
      if (!entry || entry.startsWith('#')) return
      const parts = entry.replace(/\/+$/, '').split('/')
      if (parts.some((part) => ['', '.', '..'].includes(part)) || /[*?[\]\\]/.test(entry)) throw new Error(`${config}:${i + 1}: 저장소 기준 파일이나 디렉터리 경로를 쓴다: ${entry}`)
      exclusions.push(entry)
    })
  }
  const tracked = git(root, 'ls-files', '-z', '--', '*.md').split('\0')
  return tracked.filter((name) => name && name.split('/').at(-1) !== 'CHANGELOG.md' && !exclusions.some((entry) => (entry.endsWith('/') ? name.startsWith(entry) : name === entry)))
}

describe('저장소 제외 목록', () => {
  function makeRepo() {
    const root = initRepo(tempDir())
    for (const name of ['owned.md', 'with space.md', 'CHANGELOG.md', 'plugins/nhn-dev/skills/nhncloud-cli/references/rds-mysql.md', 'plugins/nhn-dev/skills/nhncloud-cli-extra/owned.md']) write(join(root, name), '장애를 트리아지한다.\n')
    git(root, 'add', '.')
    return root
  }
  const exclude = (root: string, text: string) => write(join(root, '.claude', 'korean-check-exclude.txt'), text)

  test('목록이 없으면 소유 문서와 패키지 문서를 모두 남기고 CHANGELOG 는 뺀다', () => {
    const files = repositoryMarkdownFiles(makeRepo())
    assert.ok(files.includes('owned.md') && files.includes('with space.md'))
    assert.ok(files.includes('plugins/nhn-dev/skills/nhncloud-cli/references/rds-mysql.md'))
    assert.ok(!files.includes('CHANGELOG.md'))
  })
  test('디렉터리 제외는 형제 디렉터리와 소유 문서를 숨기지 않는다', () => {
    const root = makeRepo()
    exclude(root, '# 외부 패키지 사본\n\nplugins/nhn-dev/skills/nhncloud-cli/\n')
    const files = repositoryMarkdownFiles(root)
    assert.ok(!files.includes('plugins/nhn-dev/skills/nhncloud-cli/references/rds-mysql.md'))
    assert.ok(files.includes('plugins/nhn-dev/skills/nhncloud-cli-extra/owned.md') && files.includes('owned.md'))
  })
  test('파일 제외 뒤에도 직접 넘기면 검사한다', () => {
    const root = makeRepo()
    exclude(root, 'with space.md\n')
    const files = repositoryMarkdownFiles(root)
    assert.ok(!files.includes('with space.md') && files.includes('owned.md'))
    assert.equal(style([join(root, 'with space.md')]).code, 1)
  })
  test('잘못된 제외 항목은 문서를 숨기지 않고 실패한다', () => {
    const root = makeRepo()
    for (const entry of ['/tmp/', '../', '.', './', 'plugins/../', '**/*.md']) {
      exclude(root, `${entry}\n`)
      assert.throws(() => repositoryMarkdownFiles(root), /저장소 기준/, entry)
    }
  })
})

describe('이 저장소의 문서', () => {
  test('추적 중인 .md 가 자기 규칙을 지킨다', (t) => {
    // 저장소 밖 사본(git archive)에서는 목록을 얻지 못해 건너뛴다. 이 스킬의 SKILL.md 가 자기 금지어를 쓰던 적이 있어 둔다
    const root = join(import.meta.dirname, '..', '..', '..')
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' })
    if (inside.status !== 0) {
      if (!inside.stderr.includes('not a git repository')) assert.fail(`git 이 저장소를 읽지 못했다: ${inside.stderr}`)
      return t.skip('git 저장소 밖이라 추적 중인 .md 목록을 얻을 수 없다')
    }
    const files = repositoryMarkdownFiles(root)
    assert.ok(files.length > 0, '검사할 .md 를 찾지 못했다')
    const done = style(files, { cwd: root, env: cleanEnv({ KOREAN_STYLE_RULES: RULES }) })
    assert.equal(done.code, 0, done.stdout)
  })
})
