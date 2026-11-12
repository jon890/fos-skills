// run_checks 의 명령 경계 테스트. 검사마다 종료 코드를 그대로 읽어 판정 표를 내고 종료 코드를 정하는지, argparse 식 옵션을 본다.
// 하위 검사 파일 이름(.py/.ts)이 stdout 에 섞여 나오는 문구는 확장자를 맞춰 비교한다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Repo, type Result } from './helpers.ts'

const ext = (text: string) => text.replace(/(check_references|run_checks)\.(py|ts)\b/g, '$1.EXT')

function repo(): Repo {
  return new Repo('hc-rc-', true)
}
const row = (done: Result, name: string) => done.stdout.split('\n').find((l) => l.startsWith(`| ${name} |`))!

describe('판정과 종료 코드', () => {
  test('깨끗한 저장소는 표와 검사별 출력을 내고 0', () => {
    const r = repo()
    r.file('CLAUDE.md', '# 지침\n\n본문\n')
    const done = r.run('run_checks', [r.root])
    assert.equal(done.code, 0, done.stdout + done.stderr)
    assert.equal(
      ext(done.stdout),
      `| 검사 | 종료 코드 | 판정 | 출력 줄 수 |
| --- | --- | --- | --- |
| collect_targets | 0 | 통과 | 4 |
| check_references | 0 | 통과 | 1 |
| check_facts | 0 | 출력 판정 | 15 |
| check_duplication | 0 | 통과 | 5 |
| check_rename_drift | 2 | 해당 없음 | 0 |

### collect_targets (종료 코드 0)

감사 대상
  ${'CLAUDE.md'.padEnd(60)}     3

합계: 1개 파일, 3줄

### check_references (종료 코드 0)

깨진 참조 0건

### check_facts (종료 코드 0)

## 개수 표기 — 늘거나 줄면 곧 틀린다
개수를 빼고 서술하는 것이 안전하다.

  없음

## 여러 문서에 흩어진 옵션 — 한 곳이 단일 소스여야 한다
  없음

## 여러 문서에 나열된 캐시·설정 파일 — 목록이 갈라지기 쉽다
  없음

## 직접 확인할 것
  - 위 개수가 실제와 맞는지 세어 본다 (\`ls\`, \`--help\`, \`grep -c\`)
  - 옵션이 실제로 있는지 \`--help\` 로 대조한다
  - 파일 목록은 코드(예: 캐시 경로 상수)와 대조한다

### check_duplication (종료 코드 0)

연속 5줄 이상 중복 0건

주의 — 이 검사는 줄 단위 문자열 일치만 본다.
0건은 의미 중복이 없다는 뜻이 아니다. 같은 규칙을 문서마다 다르게 표현해 두면 잡히지 않는다.
같은 개념(레이어 경계, 배포 정책, 검증 순서 등)을 언급하는 파일이 몇 개인지는 사람이 센다.

### check_rename_drift (종료 코드 2)

(표준 출력 없음)

표준 오류:
검사 대상 없음 — 기준 'HEAD' 대비 변경된 SKILL.md 가 하나도 없다.
기준을 바꾸거나 변경을 커밋한 뒤 다시 돌린다.
다른 지침의 절 참조는 check_references.EXT 가 본다.
`,
    )
  })

  test('깨진 참조는 발견이고 1', () => {
    const r = repo()
    r.file('CLAUDE.md', '[깨짐](없다.md)\n')
    const done = r.run('run_checks', [r.root])
    assert.equal(done.code, 1, done.stdout)
    assert.ok(row(done, 'check_references').startsWith('| check_references | 1 | 발견 |'))
    assert.ok(done.stdout.includes('CLAUDE.md:1  [링크] 없다.md'))
  })

  test('git 이 없으면 참조 검사는 안내와 실행 실패로 집계한다', () => {
    const r = repo()
    r.file('CLAUDE.md', '# 지침\n')
    const done = r.run('run_checks', [r.root], { env: { ...process.env, PATH: '/nonexistent' } })
    assert.equal(done.code, 2, done.stdout + done.stderr)
    assert.ok(row(done, 'check_references').startsWith('| check_references | 2 | 실행 실패 |'), done.stdout)
    assert.ok(done.stdout.includes('git 실행 파일을 찾을 수 없다. PATH 를 확인한다.'), done.stdout)
  })

  test('대상 파일이 0 이면 실행 실패이고 2', () => {
    const r = repo()
    r.file('data.txt', 'x\n')
    const done = r.run('run_checks', [r.root])
    assert.equal(done.code, 2, done.stdout)
    assert.ok(row(done, 'collect_targets').startsWith('| collect_targets | 2 | 실행 실패 |'))
    assert.ok(done.stdout.includes('대상 파일을 찾지 못했다. 저장소 루트를 확인한다.'))
  })

  test('바뀐 SKILL.md 가 없으면 해당 없음', () => {
    const r = repo()
    r.file('CLAUDE.md', '# 지침\n')
    assert.ok(row(r.run('run_checks', [r.root]), 'check_rename_drift').startsWith('| check_rename_drift | 2 | 해당 없음 |'))
  })

  test('드리프트가 있으면 발견이다', () => {
    const r = repo()
    r.file('skills/s/SKILL.md', '---\nname: s\n---\n\n## 옛 절\n')
    r.file('skills/s/references/a.md', '옛 절\n')
    r.commitAll('init')
    r.file('skills/s/SKILL.md', '---\nname: s\n---\n\n## 새 절\n')
    const done = r.run('run_checks', [r.root])
    assert.equal(done.code, 1)
    assert.ok(row(done, 'check_rename_drift').startsWith('| check_rename_drift | 1 | 발견 |'))
    assert.ok(done.stdout.includes('DRIFT: ./skills/s/SKILL.md'))
  })

  test('실행 실패가 발견보다 먼저 정해진다', () => {
    const r = repo()
    r.file('data.txt', 'x\n')
    r.file('CLAUDE.md', '[깨짐](없다.md)\n')
    r.file('.hidden/x', '')
    assert.equal(r.run('run_checks', [r.root, '--scope', 'zzz']).code, 2)
  })
})

describe('옵션', () => {
  test('--base 는 기준 커밋을 드리프트 검사에 넘긴다', () => {
    const r = repo()
    r.file('skills/s/SKILL.md', '---\nname: s\n---\n\n## 옛 절\n')
    r.file('skills/s/references/a.md', '옛 절\n')
    r.commitAll('init')
    r.file('skills/s/SKILL.md', '---\nname: s\n---\n\n## 새 절\n')
    r.commitAll('rename')
    assert.ok(row(r.run('run_checks', [r.root]), 'check_rename_drift').includes('| 2 | 해당 없음 |'))
    const based = r.run('run_checks', [r.root, '--base', 'HEAD~1'])
    assert.ok(row(based, 'check_rename_drift').includes('| 1 | 발견 |'))
    assert.ok(row(r.run('run_checks', [r.root, '--ba=HEAD~1']), 'check_rename_drift').includes('| 1 | 발견 |'))
  })

  test('--scope 는 모든 검사에 넘기고 줄여 쓸 수 있다', () => {
    const r = repo()
    r.file('a/AGENTS.md', '# a\n')
    r.file('b/AGENTS.md', '[깨짐](없다.md)\n')
    const a = r.run('run_checks', [r.root, '--scope', 'a'])
    assert.equal(a.code, 0, a.stdout)
    assert.ok(a.stdout.includes('감사 대상 (범위: a)'))
    const b = r.run('run_checks', [r.root, '--sc=b'])
    assert.equal(b.code, 1)
    assert.ok(b.stdout.includes('감사 대상 (범위: b)'))
  })

  test('--min-run 은 중복 검사의 최소 줄 수다', () => {
    const r = repo()
    const text = ['첫째 줄은 여기에 길게 적는다', '둘째 줄도 여기에 길게 적는다', '셋째 줄도 여기에 길게 적는다'].join('\n')
    r.file('AGENTS.md', `${text}\n`)
    r.file('CLAUDE.md', `${text}\n`)
    assert.ok(r.run('run_checks', [r.root]).stdout.includes('연속 5줄 이상 중복 0건'))
    const three = r.run('run_checks', [r.root, '--min-run', '3'])
    assert.equal(three.code, 1)
    assert.ok(row(three, 'check_duplication').includes('| 1 | 발견 |'))
    assert.equal(r.run('run_checks', [r.root, '--min=3']).code, 1)
  })

  test('옵션이 위치 인자 앞뒤 어디에 있어도 같다', () => {
    const r = repo()
    r.file('CLAUDE.md', '# 지침\n')
    assert.equal(r.run('run_checks', ['--scope', '.', r.root]).code, 0)
  })

  test('값 옵션을 거듭 주면 마지막 값이다', () => {
    const r = repo()
    r.file('a/AGENTS.md', '# a\n')
    r.file('b/AGENTS.md', '# b\n')
    const done = r.run('run_checks', [r.root, '--scope', 'a', '--scope', 'b'])
    assert.ok(done.stdout.includes('감사 대상 (범위: b)'))
  })

  test('--min-run 이 정수가 아니거나 인자가 틀리면 사용법 오류 2', () => {
    const r = repo()
    r.file('CLAUDE.md', '# 지침\n')
    const bad = r.run('run_checks', [r.root, '--min-run', 'x'])
    assert.equal(bad.code, 2)
    assert.ok(ext(bad.stderr).endsWith("run_checks.EXT: error: argument --min-run: invalid int value: 'x'\n"), bad.stderr)
    assert.equal(bad.stdout, '')
    const noRoot = r.run('run_checks', [])
    assert.equal(noRoot.code, 2)
    assert.ok(ext(noRoot.stderr).endsWith('run_checks.EXT: error: the following arguments are required: root\n'))
    const unknown = r.run('run_checks', [r.root, '--nope'])
    assert.equal(unknown.code, 2)
    assert.ok(unknown.stderr.includes('unrecognized arguments: --nope'))
    const two = r.run('run_checks', [r.root, 'extra'])
    assert.equal(two.code, 2)
    assert.ok(two.stderr.includes('unrecognized arguments: extra'))
    const novalue = r.run('run_checks', [r.root, '--scope'])
    assert.equal(novalue.code, 2)
    assert.ok(novalue.stderr.includes('argument --scope: expected one argument'))
  })

  test('정수가 아닌 --min-run 은 위치 인자 누락보다 먼저 보고한다', () => {
    const r = repo()
    const done = r.run('run_checks', ['--min-run', 'x'])
    assert.equal(done.code, 2)
    assert.ok(ext(done.stderr).endsWith("run_checks.EXT: error: argument --min-run: invalid int value: 'x'\n"), done.stderr)
  })

  test('--help 는 설명을 내고 0', () => {
    const r = repo()
    const done = r.run('run_checks', ['-h'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.startsWith('usage: run_checks.'), done.stdout)
    assert.ok(done.stdout.includes('harness-cleanup 2단계의 정적 검사를 모두 따로 돌리고'))
    assert.equal(r.run('run_checks', ['--help']).code, 0)
    assert.equal(r.run('run_checks', ['--he']).code, 0)
  })

  test('저장소가 없는 경로는 collect_targets 가 실패해 2', () => {
    const r = repo()
    const done = r.run('run_checks', [`${r.root}/nope`])
    assert.equal(done.code, 2)
    assert.ok(row(done, 'collect_targets').includes('| 2 | 실행 실패 |'))
  })
})
