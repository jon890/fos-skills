// spec-lint.ts 를 실제 git 저장소와 지시서 파일로 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/spec-lint.ts', import.meta.url))
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

function spec(name: string, text: string): string {
  return write(join(specs, `${name}.md`), text)
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

  test('없는 지시서는 사용법 오류다', () => {
    assert.equal(lint([join(specs, 'nope.md')]).code, 2)
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
