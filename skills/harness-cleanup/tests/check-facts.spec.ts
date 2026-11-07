// check_facts 의 명령 경계 테스트. 개수 표기를 잡고 개수가 아닌 표현은 잡지 않는지, 옵션과 목록 절의 출력을 본다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Repo } from './helpers.ts'

const COUNTED = [
  '가장 큰 함정은 둘이다',
  '확인한 것은 셋이다',
  '서식은 D055, D056, D059, D075, D091, D103 여섯 가지다',
  '## 일곱 단계',
  '요청 구분은 다섯이다',
  '입력할 것은 세 항목이다',
  '상태 체크박스 다섯 개',
  '플러그인은 둘이다',
  '스킬 넷',
  '스킬은 둘, 검사는 셋이다',
  '대상은 스킬 넷.',
  '서식은 16개다',
  '검사 5개를 돌린다',
  '스킬 다섯입니다',
  '검사는 둘뿐',
  '두 개',
  '열 단계',
]
const NOT_COUNTED = [
  '둘 다 맞다',
  '둘째 항목을 본다',
  '셋째 줄을 고친다',
  '하나씩 확인한다',
  '한 번 돌린다',
  '두 번 돌린다',
  '세 번째 단계다',
  '인터넷 연결을 확인한다',
  '표를 상위 불릿 아래에 둘 때는 들여쓴다',
  '업무가 둘 이상이면 목록으로 나눈다',
  '계정은 irteam 과 irteamsu 둘 다가 기본이다. 대상자는 특정한다',
  '본문과 미리보기를 둘 자리를 하나 정해 담는다.',
  '`SP` 는 payload 와 미리보기를 둘 실행별 임시 디렉터리다.',
  '여섯 달 뒤 이 코드를 처음 보는 사람이 무엇을 알아야 하는지로 판단한다.',
  '둘 다는 아니다',
  '셋 다를 확인한다',
  '일곱 번 돌린다',
  '세 번 돌린다',
  '한글둘이다',
  '열다',
  '1개',
  '2개',
]

function section(sentence: string): string {
  const r = new Repo()
  r.file('CLAUDE.md', `# 지침\n\n${sentence}\n`)
  const done = r.run('check_facts', [r.root])
  assert.equal(done.code, 0, done.stdout + done.stderr)
  return done.stdout.split('## 개수 표기')[1].split('##')[0]
}

describe('개수 표기', () => {
  for (const sentence of COUNTED) {
    test(`잡는다: ${sentence}`, () => assert.ok(section(sentence).includes('CLAUDE.md:3'), section(sentence)))
  }
  for (const sentence of NOT_COUNTED) {
    test(`잡지 않는다: ${sentence}`, () => {
      const s = section(sentence)
      assert.ok(s.includes('없음'), s)
      assert.ok(!s.includes('CLAUDE.md:3'))
    })
  }

  test('출력 꼴은 줄 번호와 잡은 표기와 70자로 자른 맥락이다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', `# 지침\n\n검사 5개를 돌린다 ${'가'.repeat(80)}\n`)
    const done = r.run('check_facts', [r.root])
    assert.ok(done.stdout.includes(`  CLAUDE.md:3  "5개"  — 검사 5개를 돌린다 ${'가'.repeat(70 - '검사 5개를 돌린다 '.length)}\n`), done.stdout)
  })

  test('단위 없는 작은 수는 버전과 날짜로 보고 건너뛴다', () => {
    const s = section('2개 와 1개 와 3개 와 12개 명령 와 2개 파일')
    assert.ok(s.includes('"3개"') && s.includes('"12개 명령"') && s.includes('"2개 파일"'), s)
    assert.ok(!s.includes('"2개"\n') && !s.includes('"1개"'))
  })

  test('유니코드 숫자도 개수로 센다', () => {
    const s = section('검사 ５개와 ٥개')
    assert.ok(s.includes('CLAUDE.md:3'), s)
  })

  test('README 는 루트에 있을 때만 읽는다', () => {
    const r = new Repo()
    r.file('README.md', '플러그인은 둘이다\n')
    r.file('docs/README.md', '플러그인은 둘이다\n')
    r.file('CLAUDE.md', '# 지침\n')
    const done = r.run('check_facts', [r.root])
    assert.ok(done.stdout.includes('README.md:1'))
    assert.ok(!done.stdout.includes('docs/README.md'))
  })
})

describe('옵션과 파일 목록', () => {
  test('세 문서 이상에 나온 옵션은 많은 순으로 낸다', () => {
    const r = new Repo()
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'a/AGENTS.md', 'b/AGENTS.md']) r.file(f, '`--apply` 를 쓴다\n')
    r.file('c/AGENTS.md', '`--dry-run` `--dry-run`\n')
    r.file('d/AGENTS.md', '`--dry-run`\n')
    r.file('e/AGENTS.md', '`--dry-run`\n')
    const done = r.run('check_facts', [r.root])
    assert.ok(done.stdout.includes('  --apply: 4개 문서 — AGENTS.md, CLAUDE.md, a/AGENTS.md, b/AGENTS.md\n'), done.stdout)
    assert.ok(done.stdout.includes('  --dry-run: 3개 문서 — c/AGENTS.md, d/AGENTS.md, e/AGENTS.md\n'), done.stdout)
    assert.ok(done.stdout.indexOf('--apply:') < done.stdout.indexOf('--dry-run:'))
  })

  test('두 문서 이상에 나열된 json 파일 이름', () => {
    const r = new Repo()
    r.file('CLAUDE.md', '`cache-x.json` `only.json`\n')
    r.file('AGENTS.md', '`cache-x.json`\n')
    const done = r.run('check_facts', [r.root])
    assert.ok(done.stdout.includes('  cache-x.json: AGENTS.md, CLAUDE.md\n'), done.stdout)
    assert.ok(!done.stdout.includes('only.json'))
  })

  test('발견이 없으면 없음과 확인 목록을 낸다', () => {
    const r = new Repo()
    r.file('CLAUDE.md', '# 지침\n')
    const done = r.run('check_facts', [r.root])
    assert.equal(done.code, 0)
    assert.equal(
      done.stdout,
      '## 개수 표기 — 늘거나 줄면 곧 틀린다\n개수를 빼고 서술하는 것이 안전하다.\n\n  없음\n\n## 여러 문서에 흩어진 옵션 — 한 곳이 단일 소스여야 한다\n  없음\n\n## 여러 문서에 나열된 캐시·설정 파일 — 목록이 갈라지기 쉽다\n  없음\n\n## 직접 확인할 것\n  - 위 개수가 실제와 맞는지 세어 본다 (`ls`, `--help`, `grep -c`)\n  - 옵션이 실제로 있는지 `--help` 로 대조한다\n  - 파일 목록은 코드(예: 캐시 경로 상수)와 대조한다\n',
    )
  })

  test('옵션은 열두 개까지만 낸다', () => {
    const r = new Repo()
    const flags = Array.from({ length: 14 }, (_, i) => `\`--opt-${String.fromCharCode(97 + i)}\``).join(' ')
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'a/AGENTS.md']) r.file(f, `${flags}\n`)
    const done = r.run('check_facts', [r.root])
    assert.equal(done.stdout.split('\n').filter((l) => /^ {2}--opt-/.test(l)).length, 12)
  })
})

describe('범위 인자', () => {
  test('--scope 는 읽는 문서를 제한하고 틀리면 2', () => {
    const r = new Repo()
    r.file('a/AGENTS.md', '플러그인은 둘이다\n')
    r.file('b/AGENTS.md', '스킬은 셋이다\n')
    const done = r.run('check_facts', [r.root, '--scope', 'b'])
    assert.ok(done.stdout.includes('b/AGENTS.md:1') && !done.stdout.includes('a/AGENTS.md'))
    const bad = r.run('check_facts', [r.root, '--scope', 'zzz'])
    assert.equal(bad.code, 2)
    assert.equal(bad.stderr, '범위 경로가 없다: zzz\n')
  })

  test('저장소 밖을 가리키는 링크 문서는 읽지 않는다', () => {
    const r = new Repo()
    const other = new Repo('hc-other-')
    other.file('AGENTS.md', '플러그인은 둘이다\n')
    r.link('AGENTS.md', `${other.root}/AGENTS.md`)
    r.file('CLAUDE.md', '# 지침\n')
    const done = r.run('check_facts', [r.root])
    assert.ok(!done.stdout.includes('AGENTS.md:1'))
  })
})
