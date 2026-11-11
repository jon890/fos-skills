// spec-lint.ts 를 실제 git 저장소와 지시서 파일로 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/spec/spec-lint.ts', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../templates/spec-common.md', import.meta.url))
// 로컬의 전역 git 설정이 결과를 바꾸지 않게 하고, CI 에 없는 작성자 설정을 채운다.
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

let tmp: string
let repo: string
let specs: string

function git(...args: string[]): string {
  const done = spawnSync('git', args, { env: ENV, encoding: 'utf8' })
  assert.equal(done.status, 0, `git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

function write(file: string, body: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
  return file
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'spec-lint-')))
  repo = join(tmp, 'repo')
  const files: Record<string, string> = {
    'src/net/client.ts': 'export function connect() {}\n',
    'src/net/retry.ts': 'export const retry = 1\n',
    'src/ui/panel.ts': 'export class Panel { render() {} }\n',
    'docs/adr/001.md': '# ADR\n',
  }
  for (const [name, body] of Object.entries(files)) write(join(repo, name), body)
  git('init', '-q', repo)
  git('-C', repo, 'add', '-A')
  specs = join(tmp, 'specs')
  mkdirSync(specs)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// 제목 경고와 선택, 루프 발견이 다른 검사의 출력에 섞이지 않게 끝에 제목 줄과 선택 줄, 할 일 절을 둔다. 줄 번호는 그대로다
const SELECTED = 'worker 선택: `codex` `gpt-6.1-sol` effort `low`. 행: impl-planned. 비교: Claude Sonnet 5.5. 이유: CI 리뷰가 Claude 다.'
const NO_LOOP = '## 할 일\n루프 없이: 테스트 지시서다'

test('자동 진행 단계에서 항목 id가 빠졌거나 번호가 틀리면 실행 지시서를 거절한다', () => {
  for (const header of ['자동 진행 단계: 2', '보드 항목 id: a\n자동 진행 단계: zero']) {
    const r = lint([spec('auto', header)])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /보드 자동 단계:/)
  }
  assert.equal(lint([spec('valid-auto', '보드 항목 id: a\n자동 진행 단계: 2')]).code, 0)
})

function spec(name: string, text: string): string {
  return write(join(specs, `${name}.md`), `${text}\n# ${name}\n${SELECTED}\n${NO_LOOP}\n`)
}

function overlay(text: string): string {
  return write(join(tmp, 'overlay.md'), `# orch 오버레이\n\n## spec-lint\n\n${text}`)
}

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: ENV, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function lint(files: string[], over?: string): { code: number | null; stdout: string } {
  const r = run(['--repo', repo, ...(over ? ['--overlay', over] : []), ...files])
  return { code: r.code, stdout: r.stdout }
}

function commitAsOrigin(): void {
  git('-C', repo, 'add', '-A')
  git('-C', repo, 'commit', '-q', '-m', 'base')
  git('-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
}

function checkOverlay(over: string): { code: number | null; stdout: string } {
  const r = run(['--repo', repo, '--overlay', over, '--check-overlay'])
  return { code: r.code, stdout: r.stdout }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe('지시서 검사', () => {
  test('겹치는 담당 경로를 잡는다', () => {
    const a = spec('spec-net', '담당: `src/net/**`\n')
    const b = spec('spec-retry', '- 담당: `src/net/retry.ts`\n')
    const r = lint([a, b])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /spec-net\.md:1: 겹침: `src\/net\/\*\*` 와 spec-retry\.md 의 `src\/net\/retry\.ts`/)
  })

  test('짧은 출력은 막을 발견에 SPEC-ERROR 를 붙인다', () => {
    const a = spec('spec-net', '담당: `src/net/**`\n')
    const b = spec('spec-retry', '- 담당: `src/net/retry.ts`\n')
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, a, b], { env: { ...ENV, ORCH_OUTPUT: 'short' }, encoding: 'utf8' })
    assert.equal(done.status, 1, done.stdout)
    assert.match(done.stdout, /^SPEC-ERROR .*spec-net\.md:1: 겹침: /m)
    assert.ok(done.stdout.split('\n').filter(Boolean).every((l) => /^SPEC-(?:ERROR|WARN) /.test(l)), done.stdout)
  })

  test('따로인 담당 경로는 통과한다', () => {
    const a = spec('spec-net', '담당: `src/net/**`\n')
    const b = spec('spec-ui', '담당: `src/ui/**`, `docs/ui.md`\n')
    assert.deepEqual(lint([a, b]), { code: 0, stdout: '' })
  })

  test('코디네이터 소유 경로를 잡는다', () => {
    const a = spec('spec-adr', '담당: `docs/adr/001.md`\n')
    const r = lint([a], overlay('- 코디네이터 소유: `docs/adr/**`\n'))
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /코디네이터: `docs\/adr\/001\.md`/)
  })

  test('소유 계약은 그 소유자만 담당으로 가질 수 있다', () => {
    const over = overlay('- 소유: `src/net/**` spec-net\n')
    const other = spec('spec-ui', '담당: `src/net/client.ts`\n')
    const owner = spec('spec-net', '담당: `src/net/client.ts`\n')
    const r = lint([other], over)
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /소유: `src\/net\/client\.ts` 는 spec-net 소유/)
    assert.equal(lint([owner], over).code, 0)
  })

  test('없는 함수를 잡고 있는 함수는 통과한다', () => {
    const bad = spec('spec-a', '`reconnect()` 를 고친다\n')
    const good = spec('spec-b', '`connect()` 와 `Panel.render()` 를 고친다\n')
    const r = lint([bad])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /없음: `reconnect\(\)`/)
    assert.equal(lint([good]).code, 0)
  })

  test('금지 명령을 잡고, 부정 표현이나 예외 줄이면 통과한다', () => {
    const bad = spec('spec-a', '끝나면 `pkill -f node` 로 호스트를 끈다\n')
    const negated = spec('spec-b', '`pkill` 은 쓰지 않는다. 자기 PID 만 끈다\n')
    const excepted = spec('spec-c', '예외: 이 작업은 `rm -rf work/tmp` 를 한다\n')
    const over = overlay('- 금지 문구: `rm -rf`\n')
    const r = lint([bad], over)
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /금지: `pkill`/)
    assert.equal(lint([negated, excepted], over).code, 0)
  })

  test('없는 경로는 경고뿐이다', () => {
    const a = spec(
      'spec-a',
      '`src/net/new-file.ts` 를 만든다. `src/net/client.ts` 와 `panel.ts` 를 고친다\n브랜치: `fix/net-retry`. 접두는 `feature/` 를 쓴다\n',
    )
    const r = lint([a])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /경로: `src\/net\/new-file\.ts`/)
    // 있는 경로, 폴더 없이 적은 있는 파일 이름, 브랜치 이름과 접두는 경고하지 않는다
    assert.equal(count(r.stdout, '경로:'), 1, r.stdout)
  })

  test('첫 글자 뒤의 한글도 식별자 글자로 본다', () => {
    // 첫 글자는 ASCII 여야 하고 뒤는 Python 의 \w 처럼 유니코드 글자를 받는다
    write(join(repo, 'src/kr.ts'), 'export function get값() {}\n')
    git('-C', repo, 'add', '-A')
    assert.equal(lint([spec('spec-kr', '`get값()` 을 고친다\n')]).code, 0)
    const r = lint([spec('spec-kr2', '`put값()` 을 고친다\n')])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /없음: `put값\(\)`/)
  })

  test('제목 줄도 보드 항목 id 도 없으면 고르는 순서와 첫 줄 예시를 경고한다', () => {
    const bare = write(join(specs, 'spec-bare.md'), `공통 지시서를 먼저 읽는다.\n\n## 할 일\n루프 없이: 설정만 바꾼다\n- 고친다\n${SELECTED}\n`)
    const r = run(['--repo', repo, bare])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /^spec-bare\.md:1: 제목: .*업무 연결 줄의 제목, `## 목표` 첫 문장, id 순으로 고른다\. 첫 줄 예: `# .+`$/m)
    assert.match(r.stderr, /제목 경고 1건/)
    const named = write(join(specs, 'spec-named.md'), `공통 지시서를 먼저 읽는다.\n보드 항목 id: \`chart\`\n${SELECTED}\n${NO_LOOP}\n`)
    assert.deepEqual(lint([named]), { code: 0, stdout: '' })
  })

  test('보드 항목 id 줄에 설명이 붙으면 보드 경고를 내고 종료 코드는 0 이다. id 만 있으면 조용하다', () => {
    const noted = write(join(specs, 'spec-noted.md'), `# 제목\n보드 항목 id: 326-eval-resume (이 PR 은 5단계)\n${SELECTED}\n${NO_LOOP}\n`)
    const r = run(['--repo', repo, noted])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /^spec-noted\.md:2: 보드: .*설명은 다른 줄로 옮긴다.*\(326-eval-resume\)$/m)
    assert.match(r.stderr, /보드 경고 1건/)
    assert.match(r.stderr, /경로 경고 0건/)
    const plain = write(join(specs, 'spec-plain.md'), `# 제목\n보드 항목 id: \`326-eval-resume\`\n${SELECTED}\n${NO_LOOP}\n`)
    assert.deepEqual(lint([plain]), { code: 0, stdout: '' })
  })

  test('공통 지시서에 틀의 규칙 표지가 빠졌으면 공통 경고를 내고, 틀을 옮긴 공통 지시서는 통과한다', () => {
    const template = readFileSync(TEMPLATE, 'utf8')
    // 틀은 준비됨 status, MERGED 확인 뒤 worker_done, worker-ask 로 묻기, 스킬 개선 후보 보고, 공부 후보 보고,
    // 검토 하위 에이전트 허락, 보드 고치기 금지, 마이그레이션 번호 예약, ADR 번호 예약 규칙에 표지를 단다
    for (const rule of ['ready-status', 'done-after-merged', 'worker-ask', 'skill-feedback', 'study-candidates', 'review-subagents', 'no-board-edit', 'migration', 'adr']) {
      assert.match(template, new RegExp(`<!-- orch-rule: ${rule} -->`))
    }
    const a = spec('spec-a', '담당: `src/a/**`')
    write(join(specs, 'spec-common.md'), template)
    assert.deepEqual(lint([a]), { code: 0, stdout: '' })
    // 옛 규칙: PR 을 열면 끝이다
    write(join(specs, 'spec-common.md'), '## 공통 규칙\n\n- `worker_done` 은 완료 기준을 채운 뒤 보낸다.\n')
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /^.*spec-common\.md:1: 공통: 틀의 규칙 표지 .* 가 없다/m)
    // migration 은 orch 설정에 migrations 가, adr 은 adr 이 있는 저장소에서만 요구한다
    for (const [, rule] of template.matchAll(/<!-- orch-rule: ([\w-]+) -->/g)) {
      assert.equal(r.stdout.includes(`\`${rule}\``), rule !== 'migration' && rule !== 'adr', `${rule}\n${r.stdout}`)
    }
    assert.match(r.stderr, /공통 경고 1건/)
    assert.match(r.stderr, /경로 경고 0건/)
  })

  test('기능 루프 표지만 빠진 공통 지시서도 경고한다', () => {
    const template = readFileSync(TEMPLATE, 'utf8')
    assert.match(template, /<!-- orch-rule: feature-loop -->/)
    const a = spec('spec-a', '담당: `src/a/**`')
    write(join(specs, 'spec-common.md'), template.replace('<!-- orch-rule: feature-loop -->', ''))
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /공통: 틀의 규칙 표지 `feature-loop` 가 없다/)
    assert.match(r.stderr, /공통 경고 1건/)
  })

  test('표지는 있지만 본문이 틀과 다른 규칙을 표지마다 그 항목 머리 줄로 경고한다', () => {
    const template = readFileSync(TEMPLATE, 'utf8')
    const a = spec('spec-a', '담당: `src/a/**`')
    // 옛 사본: worker-ask 의 이어지는 설명에 `SENT-RUN` 안내가 없고, 보드 줄은 표지만 남긴 채 단계 체크를 시킨다
    const sentence = /3 이고 `SENT-RUN <id>` 면[^\n]*?\.(?=\n)/.exec(template)
    assert.ok(sentence, '틀에서 SENT-RUN 안내를 찾지 못했다')
    const board = /^- 진행 보드\(`board\.json`\)를 고치지 않는다\..*$/m.exec(template)
    assert.ok(board, '틀에서 보드 줄을 찾지 못했다')
    const old = template
      .replace(sentence[0], '')
      .replace(board[0], '- phase 가 끝나면 `board.ts step` 으로 보드 단계를 체크한다. <!-- orch-rule: no-board-edit -->')
    const common = write(join(specs, 'spec-common.md'), old)
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length
    const askLine = lineOf(old, '- **ask 는 설치된 스킬의 `worker-ask`(`orch worker ask`)로 보낸다.**')
    const boardLine = lineOf(old, '- phase 가 끝나면 `board.ts step`')
    assert.ok(r.stdout.includes(`${common}:${askLine}: 공통: 표지 \`worker-ask\` 가 붙은 규칙이 틀과 다르다`), r.stdout)
    assert.ok(r.stdout.includes(`${common}:${boardLine}: 공통: 표지 \`no-board-edit\` 가 붙은 규칙이 틀과 다르다`), r.stdout)
    assert.doesNotMatch(r.stdout, /틀의 규칙 표지 .* 가 없다/)
    assert.match(r.stderr, /공통 경고 2건/)
    // 줄 끝 공백과 빈 줄만 다르면 같은 규칙이다
    write(join(specs, 'spec-common.md'), template.replace(/\n\n/g, '\n\n\n').replace(/\n/g, '  \n'))
    assert.deepEqual(lint([a]), { code: 0, stdout: '' })
  })

  test('틀 본문의 {{...}} 는 저장소가 채운 값에 맞춘다', () => {
    const template = write(join(tmp, 'template.md'), '- 검증은 `{{VERIFY_CMD}}` 로 한다. <!-- orch-rule: verify -->\n')
    const a = spec('spec-a', '담당: `src/a/**`')
    const withTemplate = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, a], { env: { ...ENV, SPEC_TEMPLATE: template }, encoding: 'utf8' })
    write(join(specs, 'spec-common.md'), '- 검증은 `bash scripts/verify.sh` 로 한다. <!-- orch-rule: verify -->\n')
    assert.equal(withTemplate().stdout, '')
    write(join(specs, 'spec-common.md'), '- 검증은 건너뛴다. <!-- orch-rule: verify -->\n')
    assert.match(withTemplate().stdout, /공통: 표지 `verify` 가 붙은 규칙이 틀과 다르다/)
  })

  test('공통 규칙의 머리 목록 기호만 무시하고 본문 변경은 경고한다', () => {
    const template = write(join(tmp, 'template.md'), '5. PR 준비를 알린다. <!-- orch-rule: ready-status -->\n  이어지는 설명은 그대로 둔다.\n')
    const a = spec('spec-a', '담당: `src/a/**`')
    const check = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, a], {
      env: { ...ENV, SPEC_TEMPLATE: template }, encoding: 'utf8',
    })
    for (const prefix of ['- ', '* ', '27. ']) {
      write(join(specs, 'spec-common.md'), `${prefix}PR 준비를 알린다. <!-- orch-rule: ready-status -->\n  이어지는 설명은 그대로 둔다.\n`)
      assert.equal(check().stdout, '')
    }
    write(join(specs, 'spec-common.md'), '- PR 준비를 알린다. <!-- orch-rule: ready-status -->\n  설명을 바꿨다.\n')
    assert.match(check().stdout, /표지 `ready-status` 가 붙은 규칙이 틀과 다르다/)
  })

  test('마이그레이션 표지는 orch 설정에 migrations 가 있는 저장소에서만 빠진 것을 알린다', () => {
    const template = readFileSync(TEMPLATE, 'utf8')
    const without = template.replace(/^- Flyway 마이그레이션[\s\S]*?(?=^- )/m, '')
    assert.notEqual(without, template)
    assert.doesNotMatch(without, /orch-rule: migration/)
    const a = spec('spec-a', '담당: `src/a/**`')
    write(join(specs, 'spec-common.md'), without)
    assert.deepEqual(lint([a]), { code: 0, stdout: '' })
    write(join(repo, '.orch', 'config.json'), JSON.stringify({ migrations: { dirs: { api: 'db/api' } } }))
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /공통: 틀의 규칙 표지 `migration` 가 없다/)
  })

  test('ADR 표지는 orch 설정에 adr.dirs 가 있는 저장소에서만 빠진 것을 알린다', () => {
    const template = readFileSync(TEMPLATE, 'utf8')
    const without = template.replace(/^- 번호 붙은 ADR[\s\S]*?(?=^- )/m, '')
    assert.notEqual(without, template)
    assert.doesNotMatch(without, /orch-rule: adr/)
    const a = spec('spec-a', '담당: `src/a/**`')
    write(join(specs, 'spec-common.md'), without)
    write(join(repo, '.orch', 'config.json'), JSON.stringify({ adr: { dirs: {} } }))
    assert.deepEqual(lint([a]), { code: 0, stdout: '' })
    write(join(repo, '.orch', 'config.json'), JSON.stringify({ adr: { dirs: { root: 'docs/adr' } } }))
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /공통: 틀의 규칙 표지 `adr` 가 없다/)
  })

  test('임시 폴더 아래 경로를 가리키면 임시 경고를 내고 종료 코드는 0 이다', () => {
    const a = spec(
      'spec-temp',
      [
        '회신은 `/tmp/reply-1.md` 에 있다.',
        '목록: /private/tmp/list.txt, 결과는 $TMPDIR/out.json 과 ${TMPDIR}/a.log',
        '초안: `/Users/me/.claude/scratchpad/draft.md`, /var/folders/x/T/notes.md',
        'PR 본문 파일은 세션 임시 폴더(scratchpad, 없으면 `$TMPDIR`)에 쓴다.',
        '예외: 테스트는 `/tmp/fixture` 를 쓴다',
      ].join('\n'),
    )
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    for (const [no, path] of [
      [1, '/tmp/reply-1.md'],
      [2, '/private/tmp/list.txt'],
      [2, '$TMPDIR/out.json'],
      [2, '${TMPDIR}/a.log'],
      [3, '/Users/me/.claude/scratchpad/draft.md'],
      [3, '/var/folders/x/T/notes.md'],
    ] as const) {
      assert.ok(r.stdout.includes(`spec-temp.md:${no}: 임시: \`${path}\` 는 임시 폴더라`), `${path}\n${r.stdout}`)
    }
    assert.equal(count(r.stdout, ': 임시: '), 6, r.stdout)
    assert.match(r.stderr, /임시 경고 6건/)
  })

  test('재개 절이 임시 경로를 가리키면 재개 절 안내가 붙은 임시 경고를 내고, 다른 절의 경고에는 붙지 않는다', () => {
    const a = spec(
      'spec-resume',
      [
        '## 할 일',
        '루프 없이: 작은 고침이다.',
        '측정은 `/tmp/measure.md` 를 본다.',
        '## 재개',
        '앞 worker 의 측정 보고서는 `/var/folders/ab/T/report.md` 와 $TMPDIR/mk-review.py 에 있다.',
        '- 커밋 abc123 까지 끝났다.',
        '## 완료 기준',
        '결과는 /tmp/after.md 에 쓴다.',
      ].join('\n'),
    )
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    const lines = r.stdout.split('\n')
    const at = (no: number, path: string) => lines.find((line) => line.includes(`spec-resume.md:${no}: 임시: \`${path}\``)) ?? ''
    assert.match(at(5, '/var/folders/ab/T/report.md'), /재개 절에는 회신과 측정 결과를 본문에 옮겨 적고 임시 경로를 가리키지 않는다/)
    assert.match(at(5, '$TMPDIR/mk-review.py'), /재개 절에는 회신과 측정 결과를/)
    assert.doesNotMatch(at(3, '/tmp/measure.md'), /재개 절/)
    assert.match(at(3, '/tmp/measure.md'), /임시 폴더라/)
    assert.doesNotMatch(at(8, '/tmp/after.md'), /재개 절/)
    assert.equal(count(r.stdout, ': 임시: '), 4, r.stdout)
  })

  test('PR 본문 파일을 작업 이름 없는 고정 이름으로 적으면 본문 경고를 내고 종료 코드는 0 이다', () => {
    const a = spec(
      'spec-body',
      [
        'PR 본문은 `$TMPDIR/pr-body.md` 에 쓴다.',
        '본문 파일 body.md 를 만든다.',
        'PR 본문은 pr-body-fb1109-spec-sweep.md 로 쓴다.',
        '예외: 옛 이름 pr-body.md 는 안 쓴다',
      ].join('\n'),
    )
    const r = run(['--repo', repo, a])
    assert.equal(r.code, 0, r.stdout)
    assert.ok(r.stdout.includes('spec-body.md:1: 본문: `pr-body.md` 는 고정된 공용 이름'), r.stdout)
    assert.ok(r.stdout.includes('spec-body.md:2: 본문: `body.md` 는 고정된 공용 이름'), r.stdout)
    assert.equal(count(r.stdout, ': 본문: '), 2, r.stdout)
    assert.match(r.stderr, /본문 경고 2건/)
  })

  test('완료 기준에 PR 이 둘 이상이면 한 PR 기준을 가리키며 경고하고 종료 코드는 0 이다', () => {
    const multi = spec('spec-multi', '## 완료 기준\n\n- PR1 과 PR2 가 MERGED 됐다.\n')
    const r = run(['--repo', repo, multi])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /^spec-multi\.md:3: 완료: .*PR 하나의 MERGED 다\. 이 지시서는 PR1 만 맡는다.*새 지시서로 띄운다.*\(PR1, PR2\)$/m)
    assert.match(r.stderr, /완료 경고 1건/)
    assert.match(r.stderr, /경로 경고 0건/)
    for (const [name, body] of [
      ['range', '- 완료 기준: PR1~PR3 이 MERGED 됐다'],
      ['range-short', '## 완료 기준\n- PR 1-3 이 MERGED 됐다'],
      ['count', '## 완료 기준\n- PR 두 개가 MERGED 됐다'],
    ]) {
      assert.match(run(['--repo', repo, spec(`spec-${name}`, body)]).stdout, /: 완료: /, name)
    }
  })

  test('완료 기준이 PR 하나이거나, 뒤 PR 이 완료 기준 밖 참고 절에만 있으면 경고하지 않는다', () => {
    const one = spec('spec-one', '## 완료 기준\n\n- PR #12 가 MERGED 됐다. 같은 PR #12 에서 CI 가 통과한다.\n')
    assert.deepEqual(lint([one]), { code: 0, stdout: '' })
    const later = spec(
      'spec-later',
      '## 범위\n\n이 지시서는 PR1 만 맡는다. 뒤 PR(참고): PR2 문서, PR3 정리\n\n## 완료 기준\n\n- PR 하나가 MERGED 됐다.\n\n## 참고\n\nPR2, PR3',
    )
    assert.deepEqual(lint([later]), { code: 0, stdout: '' })
  })

  test('선택 줄이 없거나 빠진 요소가 있거나 둘이면 막는다', () => {
    const none = write(join(specs, 'spec-none.md'), '# 일\n')
    const partial = write(join(specs, 'spec-partial.md'), '# 일\n- **worker 선택:** `claude` `claude-opus-5-5` 로 고른다\n')
    const twice = write(join(specs, 'spec-twice.md'), `# 일\n${SELECTED}\n${SELECTED}\n`)
    const r = lint([none, partial, twice])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /spec-none\.md:1: 선택: `worker 선택:` 줄이 없다\. 형식: worker 선택: `<에이전트>`/)
    assert.match(r.stdout, /spec-partial\.md:1: 선택: 행 가 빠졌거나 형식이 틀렸다/)
    assert.match(r.stdout, /spec-twice\.md:1: 선택: `worker 선택:` 줄은 하나만 둔다/)
    assert.equal(count(r.stdout, ': 선택: '), 6, r.stdout)
  })

  test('새 지시서의 행과 Opus high 근거, 실험 후보를 검사한다', () => {
    const source = (selection: string, experiment = '') => `# 선택\n${selection}\n${experiment}\n${NO_LOOP}\n`
    const opus = 'worker 선택: `claude` `claude-opus-5-5` effort `high`. 행: hard-design. 비교: sol. 이유: 설계.'
    const cases = [
      [SELECTED.replace('행: impl-planned.', ''), '', /행/],
      [SELECTED.replace('impl-planned', 'missing-row'), '', /모델 표에 없다/],
      [opus, '', /high 근거/],
      [opus.replace('비교:', 'high 근거: medium 실패 ctx_missing. 비교:'), '', /Opus medium/],
      [SELECTED, 'experiment: broken.', /experiment/],
      [SELECTED, 'experiment: outside. 후보: `claude` `claude-sonnet-5-5` effort `medium` / `codex` `gpt-6-luna` effort `high`.', /후보 밖/],
    ] as const
    for (const [selection, experiment, expected] of cases) {
      const file = write(join(specs, 'spec-selection.md'), source(selection, experiment))
      const r = lint([file])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stdout, expected)
    }
    const valid = write(join(specs, 'spec-valid.md'), source(opus.replace('비교:', 'high 근거: 사용자 지정 2026-11-05. 비교:')))
    assert.equal(lint([valid]).code, 0)
  })

  test('행 없는 옛 선택 줄은 활성 지시서로만 호환한다', () => {
    const old = write(join(specs, 'spec-old-selection.md'), `# 이전 일\n${SELECTED.replace('행: impl-planned.', '')}\n${NO_LOOP}`)
    assert.equal(lint([old]).code, 1)
    const r = run(['--repo', repo, '--active', old, spec('spec-fresh-selection', '')])
    assert.equal(r.code, 0, r.stdout)
  })

  test('--active 로 넘긴 이미 띄운 지시서는 선택 줄을 보지 않고 겹침은 본다', () => {
    const launched = write(join(specs, 'spec-old.md'), '# 앞 일\n담당: `src/net/**`\n')
    const fresh = spec('spec-new', '담당: `src/net/retry.ts`\n')
    const r = run(['--repo', repo, '--active', launched, fresh])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /겹침/)
    assert.doesNotMatch(r.stdout, /선택:/)
    assert.equal(run(['--repo', repo, '--active', launched, spec('spec-ui', '담당: `src/ui/**`\n')]).code, 0)
  })

  test('--active 로 넘긴 이미 띄운 지시서는 할 일 첫 줄을 보지 않는다', () => {
    const launched = write(join(specs, 'spec-old.md'), '# 앞 일\n## 할 일\n- 고친다\n')
    const r = run(['--repo', repo, '--active', launched, spec('spec-new', '담당: `src/ui/**`\n')])
    assert.equal(r.code, 0, r.stdout)
    assert.doesNotMatch(r.stdout, /루프:/)
  })

  test('없는 지시서는 사용법 오류다', () => {
    assert.equal(lint([join(specs, 'nope.md')]).code, 2)
  })
})

describe('할 일 첫 줄의 루프 선택', () => {
  // 루프 검사만 보게 제목 줄과 선택 줄을 둔다. body 는 그 뒤에 붙는다
  function task(name: string, body: string): string {
    return write(join(specs, `${name}.md`), `# ${name}\n${SELECTED}\n\n${body}\n`)
  }

  function confirmed(head = '확인: 2026-11-02'): string {
    return `# 기능\n${head}\n\n## 목표\n\n고친다\n\n## 결정\n\n확인: 2026-11-03 은 머리 밖이라 보지 않는다\n`
  }

  function loops(text: string): string[] {
    return text.split('\n').filter((line) => line.includes(': 루프: '))
  }

  test('`## 할 일` 제목이 없으면 1번 줄에 세 꼴을 알리며 막는다', () => {
    const r = lint([task('spec-none', '## 목표\n고친다')])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /^spec-none\.md:1: 루프: `## 할 일` 제목이 없다\. .*`루프를 쓴다\(스펙: <경로>\)`, `루프를 쓴다\(스펙: 새로 쓴다\)`, `루프 없이: <이유>`/m)
  })

  test('첫 줄이 세 꼴이 아니거나 비었으면 그 줄을 가리키며 막는다', () => {
    const r = lint([task('spec-plain', '## 할 일\n\n1. 문서를 고친다\n루프 없이: 뒤에 와도 첫 줄이 아니다'), task('spec-empty', '## 할 일\n\n## 완료 기준\n- 끝')])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /^spec-plain\.md:6: 루프: `## 할 일` 아래 첫 줄이 .* 가운데 하나가 아니다: 문서를 고친다$/m)
    assert.match(r.stdout, /^spec-empty\.md:4: 루프: .*\(첫 줄이 없다\)$/m)
    assert.equal(loops(r.stdout).length, 2, r.stdout)
  })

  test('`루프 없이:` 는 이유가 있으면 통과하고 비면 막는다', () => {
    assert.deepEqual(lint([task('spec-why', '## 할 일\n- **루프 없이:** 오타만 고친다\n- 고친다')]), { code: 0, stdout: '' })
    const r = lint([task('spec-blank', '## 할 일\n루프 없이:   ')])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /^spec-blank\.md:5: 루프: `루프 없이:` 뒤에 이유가 없다/m)
  })

  test('`스펙: 새로 쓴다` 는 스펙 파일 없이 통과한다', () => {
    assert.deepEqual(lint([task('spec-new', '## 할 일\n루프를 쓴다(스펙: 새로 쓴다). spec 인터뷰부터 한다')]), { code: 0, stdout: '' })
  })

  test('절대경로 스펙은 디스크에서 읽고 확인 줄이 있어야 통과한다', () => {
    const good = write(join(tmp, 'drafts/good.md'), confirmed())
    const draft = write(join(tmp, 'drafts/draft.md'), confirmed('작성: 2026-11-02'))
    const badDate = write(join(tmp, 'drafts/bad-date.md'), confirmed('확인: 2026-02-30'))
    // 테스트 스펙은 OS 임시 폴더에 있어 임시 경고가 붙는다. 그 밖의 발견이 없어야 한다
    const passed = lint([task('spec-good', `## 할 일\n루프를 쓴다(스펙: \`${good}\`). plan 부터 한다`)])
    assert.equal(passed.code, 0, passed.stdout)
    assert.deepEqual(passed.stdout.split('\n').filter((line) => line && !line.includes(': 임시: ')), [])
    const r = lint([
      task('spec-draft', `## 할 일\n루프를 쓴다(스펙: ${draft})`),
      task('spec-date', `## 할 일\n루프를 쓴다(스펙: ${badDate})`),
      task('spec-gone', `## 할 일\n루프를 쓴다(스펙: ${join(tmp, 'drafts/gone.md')})`),
      task('spec-blank', '## 할 일\n루프를 쓴다(스펙: )'),
    ])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /^spec-draft\.md:5: 루프: 스펙 `.*draft\.md`: 제목 아래에 `확인: YYYY-MM-DD` 줄이 없다\..*`루프를 쓴다\(스펙: 새로 쓴다\)`/m)
    assert.match(r.stdout, /^spec-date\.md:5: 루프: .*확인 줄의 날짜가 올바르지 않다: 2026-02-30$/m)
    assert.match(r.stdout, /^spec-gone\.md:5: 루프: 스펙 `.*gone\.md` 을 파일로 읽지 못했다$/m)
    assert.match(r.stdout, /^spec-blank\.md:5: 루프: `스펙:` 뒤에 경로가 없다/m)
    assert.equal(loops(r.stdout).length, 4, r.stdout)
  })

  test('상대경로 스펙은 origin/<base> 에 있어야 하고 작업 트리에만 있으면 막는다', () => {
    write(join(repo, 'docs/features/a/spec.md'), confirmed())
    commitAsOrigin()
    write(join(repo, 'docs/features/b/spec.md'), confirmed())
    write(join(repo, 'docs/features/a/spec.md'), confirmed('작성: 확인 줄을 지운 작업 트리'))
    // 작업 트리에서 확인 줄을 지워도 origin/main 의 내용으로 판정한다
    assert.deepEqual(lint([task('spec-a', '## 할 일\n루프를 쓴다(스펙: ./docs/features/a/spec.md)')]), { code: 0, stdout: '' })
    const r = lint([task('spec-b', '## 할 일\n루프를 쓴다(스펙: docs/features/b/spec.md)')])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /^spec-b\.md:5: 루프: 스펙 `docs\/features\/b\/spec\.md` 이 origin\/main 에 없다\. .*절대경로로 적는다$/m)
    // --base 로 준 기준 브랜치에서 읽는다
    git('-C', repo, 'update-ref', 'refs/remotes/origin/release', 'refs/remotes/origin/main')
    const other = run(['--repo', repo, '--base', 'release', task('spec-a2', '## 할 일\n루프를 쓴다(스펙: docs/features/a/spec.md)')])
    assert.equal(other.code, 0, other.stdout)
    assert.match(run(['--repo', repo, '--base', 'gone', task('spec-a3', '## 할 일\n루프를 쓴다(스펙: docs/features/a/spec.md)')]).stdout, /origin\/gone 가 없어 .*--base 로 주거나/)
    // 폴더를 가리키면 파일이 아니라고 알린다
    assert.match(lint([task('spec-dir', '## 할 일\n루프를 쓴다(스펙: docs/features/a)')]).stdout, /이 origin\/main 에서 파일이 아니다/)
  })

  test('--base 가 없으면 origin/HEAD 의 브랜치에서 읽고, --spec-ref 와 --spec-root 가 읽을 곳을 바꾼다', () => {
    write(join(repo, 'docs/features/a/spec.md'), confirmed())
    git('-C', repo, 'add', '-A')
    git('-C', repo, 'commit', '-q', '-m', 'base')
    git('-C', repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD')
    git('-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    const rel = task('spec-rel', '## 할 일\n루프를 쓴다(스펙: docs/features/a/spec.md)')
    assert.deepEqual(lint([rel]), { code: 0, stdout: '' })
    // 커밋하지 않은 스펙도 worker 가 일할 워크트리(--spec-root)에 있으면 통과한다
    const wt = join(tmp, 'wt')
    write(join(wt, 'docs/features/b/spec.md'), confirmed())
    const b = task('spec-b', '## 할 일\n루프를 쓴다(스펙: docs/features/b/spec.md)')
    assert.equal(lint([b]).code, 1)
    assert.equal(run(['--repo', repo, '--spec-root', wt, b]).code, 0)
    assert.match(run(['--repo', repo, '--spec-root', wt, rel]).stdout, /spec\.md` 을 파일로 읽지 못했다/)
    // --spec-ref 는 그 ref 에서 읽는다
    git('-C', repo, 'update-ref', 'refs/remotes/origin/feat-x', 'HEAD')
    assert.equal(run(['--repo', repo, '--spec-ref', 'origin/feat-x', rel]).code, 0)
    assert.match(run(['--repo', repo, '--spec-ref', 'origin/nope', rel]).stdout, /origin\/nope 가 없어/)
  })

  test('괄호 앞 띄어쓰기, 제목 뒤 설명, 여러 목록 기호를 받는다', () => {
    for (const [name, body] of [
      ['space', '## 할 일\n루프를 쓴다 (스펙: 새로 쓴다)'],
      ['heading', '## 할 일 (이 PR 범위)\n루프 없이: 오타만 고친다'],
      ['plus', '## 할 일\n+ 루프 없이: 오타만 고친다'],
      ['paren', '## 할 일\n1) 루프 없이: 오타만 고친다'],
      ['check', '## 할 일\n- [ ] 루프 없이: 오타만 고친다'],
    ]) {
      assert.deepEqual(lint([task(`spec-${name}`, body)]), { code: 0, stdout: '' }, name)
    }
    // `## 할 일과 순서` 는 다른 제목이다
    assert.match(lint([task('spec-other', '## 할 일과 순서\n루프 없이: 오타')]).stdout, /`## 할 일` 제목이 없다/)
  })

  test('코드 블록 안의 제목과 확인 줄은 보지 않는다', () => {
    const quoted = task('spec-fence', '## 목표\n\n```markdown\n## 할 일\n루프 없이: 예시\n```')
    assert.match(lint([quoted]).stdout, /spec-fence\.md:1: 루프: `## 할 일` 제목이 없다/)
    const fenced = write(join(tmp, 'drafts/fenced.md'), '# 기능\n\n~~~\n확인: 2026-11-02\n## 예시\n~~~\n\n## 목표\n')
    assert.match(lint([task('spec-fenced', `## 할 일\n루프를 쓴다(스펙: ${fenced})`)]).stdout, /`확인: YYYY-MM-DD` 줄이 없다/)
    // 지시서 쪽 코드 블록이 할 일 절 뒤에 있어도 첫 줄 판정은 그대로다
    assert.deepEqual(lint([task('spec-after', '## 할 일\n루프 없이: 오타만 고친다\n\n```\n## 할 일\n아무 줄\n```')]), { code: 0, stdout: '' })
  })

  test('`리뷰 PR:` 줄이나 머리의 `중간 과정:` 줄이 있으면 보지 않는다', () => {
    const review = task('spec-review-pr-7', '리뷰 PR: #7\n\n## 할 일\n- 리뷰한다')
    const interim = write(join(specs, 'spec-ci.md'), `# CI 고침\n중간 과정: PR #8\n${SELECTED}\n\n## 할 일\n- 고친다\n`)
    assert.deepEqual(lint([review, interim]), { code: 0, stdout: '' })
    // 할 일 본문에서 인용한 중간 과정 줄은 표시가 아니다
    const quoted = task('spec-quote', '## 할 일\n- 중간 과정: PR #N 줄을 문서에 적는다')
    const r = lint([quoted])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /^spec-quote\.md:5: 루프: /m)
  })
})

describe('--check-overlay', () => {
  test('origin/<base> 에 없는 오버레이 경로를 알린다', () => {
    write(join(repo, '.gitignore'), '.orch/\n')
    write(join(repo, '.orch/config.json'), '{"finish": {"verify": "bash src/gone.sh --fast"}, "queue": {"before": "node src/net/client.ts"}}\n')
    commitAsOrigin()
    // 로컬에만 만든 파일은 origin/main 에 없으므로 지적한다
    write(join(repo, 'src/local.ts'), '')
    const over = overlay(
      '- 검증: `bash src/net/verify.sh --fast` 와 `src/local.ts`\n' +
        '- 문서: `docs/adr/001.md`, `$SKILL_DIR/scripts/x.py`, `merge-queue.sh`, `docs/<이름>.md`\n' +
        '- 로컬: `.orch/bin/start.sh`, `~/bin/x.sh`, `/abs/x.sh`\n' +
        '- 바깥: `references/cleanup.md`, `scratchpad/aapi.sh`, `origin/release-1.2.x`, `github.com/o/r.git`\n' +
        '- 예외: `src/local-only.sh` 는 로컬에만 둔다\n',
    )
    const r = checkOverlay(over)
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /overlay\.md:5: 오버레이: `src\/net\/verify\.sh` 가 origin\/main 에 없다/)
    assert.match(r.stdout, /overlay\.md:5: 오버레이: `src\/local\.ts` 가 origin\/main 에 없다/)
    assert.match(r.stdout, /config\.json:1: 오버레이: `src\/gone\.sh` 가 origin\/main 에 없다/)
    assert.equal(count(r.stdout, '오버레이:'), 3, r.stdout)
  })

  test('경로가 모두 있으면 지시서 없이 통과한다', () => {
    commitAsOrigin()
    const over = overlay('- 문서: `docs/adr/001.md`, `./src/net/client.ts`, `src/net`\n')
    assert.deepEqual(checkOverlay(over), { code: 0, stdout: '' })
  })

  test('origin/<base> 가 없으면 사용법 오류다', () => {
    assert.equal(checkOverlay(overlay('')).code, 2)
  })

  test('config.json 이 깨졌으면 사용법 오류다', () => {
    commitAsOrigin()
    write(join(repo, '.orch/config.json'), '{broken')
    const r = run(['--repo', repo, '--overlay', overlay(''), '--check-overlay'])
    assert.equal(r.code, 2, r.stdout)
    assert.match(r.stderr, /config\.json/)
  })

  test('지시서도 --check-overlay 도 없으면 사용법 오류다', () => {
    assert.equal(run(['--repo', repo]).code, 2)
    assert.equal(run([]).code, 2)
  })
})

test('keep 표지의 의도적 변경은 공통 본문 경고를 내지 않는다', () => {
  const template = write(join(tmp, 'keep-template.md'), '- 새 규칙 <!-- orch-rule: local -->\n')
  write(join(specs, 'spec-common.md'), '- 저장소 규칙 <!-- orch-rule: local keep -->\n')
  const done = spawnSync(process.execPath, [SCRIPT, '--repo', repo, spec('keep', '')], {
    encoding: 'utf8', env: { ...ENV, SPEC_TEMPLATE: template },
  })
  assert.equal(done.status, 0, done.stderr)
  assert.doesNotMatch(done.stdout, /공통:/)
})


test('중복 표지를 공통 경고로 알리고 표지 이름과 모든 줄 번호를 보인다', () => {
  const template = write(join(tmp, 'duplicate-template.md'), '- 새 규칙 <!-- orch-rule: local -->\n')
  write(join(specs, 'spec-common.md'), '- 하나 <!-- orch-rule: local -->\n- 둘 <!-- orch-rule: local -->\n')
  const done = spawnSync(process.execPath, [SCRIPT, '--repo', repo, spec('duplicate', '')], {
    encoding: 'utf8', env: { ...ENV, SPEC_TEMPLATE: template },
  })
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /공통: 같은 표지 local 가 둘 이상 있다: 1, 2줄/)
})
