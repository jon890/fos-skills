// orch_paths.ts 명령과 옛 구조 검사, 그리고 .omc 가 없는 저장소에서 띄우기 준비 단계가 도는지 본다.
//
// 경로 규칙 자체(orchDir, pathOf, ensure, makeParent, boardPath, legacyPaths)의 사례는 lib-paths.spec.ts 가 다룬다.
// 여기서는 셸이 부르는 명령과, 옛 구조에서 멈추거나 알리기만 하는 명령의 진입점을 본다.
// 임시 git 저장소만 쓴다. 띄우기 준비는 실제 터미널 없이 되는 부분(지시서 검사, 첫 지시 줄, 워크트리 만들기)이다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url))
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
delete ENV.ORCH_DIR

let tmp: string
let repo: string

type Result = { code: number | null; stdout: string; stderr: string }

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const done = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? ENV, encoding: 'utf8' })
  assert.equal(done.status, 0, `${cmd} ${args.join(' ')} 실패: ${done.stdout}${done.stderr}`)
  return done.stdout.trim()
}

function git(...args: string[]): string {
  return sh('git', args)
}

// orch/scripts 의 .ts 명령을 node 로 부른다
function cmd(script: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(SCRIPTS, script), ...args], {
    cwd: opts.cwd,
    env: opts.env ?? ENV,
    encoding: 'utf8',
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function write(rel: string, body: string): string {
  const file = join(repo, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
  return file
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-paths-')))
  repo = join(tmp, 'repo')
  git('init', '-q', '-b', 'main', repo)
  git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('orch_paths.ts', () => {
  test('이름의 경로 한 줄을 내고 --ensure 는 폴더를 만든다', () => {
    let r = cmd('orch_paths.ts', ['--repo', repo, 'specs'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, `${join(repo, '.orch/specs')}\n`)
    r = cmd('orch_paths.ts', ['--repo', repo, '--ensure', 'bin'])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(statSync(r.stdout.trim()).isDirectory())
    assert.equal(git('-C', repo, 'status', '--porcelain'), '')
  })

  test('root, board 와 원본에 없던 hooks, hooks-state 도 받는다', () => {
    assert.equal(cmd('orch_paths.ts', ['--repo', repo, 'root']).stdout, `${join(repo, '.orch')}\n`)
    assert.equal(cmd('orch_paths.ts', ['--repo', repo, 'board']).stdout, `${join(repo, '.omc/board.json')}\n`)
    assert.equal(cmd('orch_paths.ts', ['--repo', repo, 'hooks']).stdout, `${join(repo, '.orch/hooks')}\n`)
    assert.equal(cmd('orch_paths.ts', ['--repo', repo, 'hooks-state']).stdout, `${join(repo, '.orch/state/hooks')}\n`)
  })

  test('--ensure root 는 루트를 만들고 git 이 무시하게 한다', () => {
    const r = cmd('orch_paths.ts', ['--repo', repo, '--ensure', 'root'])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(statSync(join(repo, '.orch')).isDirectory())
    assert.equal(git('-C', repo, 'status', '--porcelain'), '')
  })

  test('모르는 이름과 이름이 없는 호출은 사용법 오류(2)다', () => {
    for (const args of [['--repo', repo, 'nope'], ['--repo', repo]]) {
      const r = cmd('orch_paths.ts', args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
      assert.equal(r.stdout, '')
    }
  })

  test('옛 경로 orch_paths.py 도 같은 경로를 낸다', () => {
    // shim 은 PATH 의 node 를 부른다. 이 테스트를 도는 node 를 앞에 둔다
    const env = { ...ENV, PATH: [dirname(process.execPath), ENV.PATH ?? ''].join(delimiter) }
    const done = spawnSync('python3', [join(SCRIPTS, 'orch_paths.py'), '--repo', repo, 'specs'], { env, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.equal(done.stdout, `${join(repo, '.orch/specs')}\n`)
    assert.match(done.stderr, /^DEPRECATED python3 orch_paths\.py → /m)
  })
})

describe('옛 구조', () => {
  test('설정을 읽는 명령은 옮기는 명령을 알리고 2 로 멈춘다', () => {
    write('.claude/orch-overlay.md', '# 오버레이\n')
    const spec = write('.orch/specs/spec-a.md', '브랜치: `feat/a`\n')
    for (const [script, args] of [
      ['spec-lint.ts', ['--repo', repo, spec]],
      ['handoff-cleanup.ts', ['--repo', repo]],
      ['finish-pr.ts', ['1', '--repo', repo]],
    ] as const) {
      const r = cmd(script, [...args])
      assert.equal(r.code, 2, `${script}: ${r.stdout}${r.stderr}`)
      assert.ok(r.stderr.includes('migrate-orch-dir.py'), `${script}: ${r.stderr}`)
    }
  })

  test('orch_paths.ts check 와 --ensure 는 옛 구조에서 멈추고 폴더를 만들지 않는다', () => {
    write('.omc/handoffs/specs/spec-a.md', 'x')
    for (const args of [['check'], ['--ensure', 'specs']]) {
      const r = cmd('orch_paths.ts', ['--repo', repo, ...args])
      assert.equal(r.code, 2, args.join(' '))
      assert.ok(r.stderr.includes('migrate-orch-dir.py'), r.stderr)
    }
    assert.equal(existsSync(join(repo, '.orch')), false)
    assert.equal(cmd('orch_paths.ts', ['--repo', repo, 'specs']).stdout, `${join(repo, '.orch/specs')}\n`)
  })

  test('옛 구조가 없으면 check 는 0 이다', () => {
    const r = cmd('orch_paths.ts', ['--repo', repo, 'check'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stderr, '')
  })

  test('띄우기와 정리의 진입점도 옛 구조에서 멈춘다', () => {
    const spec = write('.omc/orch/specs/spec-a.md', '브랜치: `feat/a`\n허락: push\n')
    let r = cmd('launch-worker.ts', ['--spec', spec, '--repo', repo, '--name', 'a', '--', '--agent', 'claude'], {
      env: { ...ENV, ORCA: '/nonexistent/orca' },
    })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.ok(r.stderr.includes('migrate-orch-dir.py'), r.stderr)
    const fake = join(tmp, 'orca')
    writeFileSync(fake, '#!/bin/sh\necho \'{"result": {"terminals": [], "tasks": [], "workers": []}}\'\n')
    chmodSync(fake, 0o755)
    r = cmd('cleanup-sweep.ts', ['--repo', repo], { env: { ...ENV, ORCA: fake } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.ok(r.stderr.includes('옮기기 전이라 건너뛴다'), r.stderr)
  })

  test('대기와 충돌 알림 명령은 알리기만 한다', () => {
    write('.claude/orch-finish.json', '{}')
    let r = cmd('wait-important.ts', ['--run', 'run_x', '--ack-lost', 'ctx_1'], { cwd: repo })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes('ACK_LOST ctx_1'), r.stdout)
    assert.ok(r.stderr.includes('wait-important: 옛 위치가 남아 있다'), r.stderr)
    assert.ok(statSync(join(repo, '.orch/state/wait-important-lost.json')).isFile())
    r = cmd('notify-conflicts.ts', ['--repo', repo, '--base', 'main'])
    assert.ok(r.stderr.includes('notify-conflicts: 옛 위치가 남아 있다'), r.stderr)
    assert.ok(r.stderr.includes('git fetch origin 실패'), r.stderr)
  })

  test('설정 파일을 직접 주면 옛 구조 검사를 건너뛴다', () => {
    const config = write('.claude/orch-finish.json', JSON.stringify({ cleanup: {} }))
    const r = cmd('handoff-cleanup.ts', ['--repo', repo, '--config', config, '--board', 'board.json'])
    assert.equal(r.code, 0, r.stderr)
  })
})

describe('.omc 가 없는 저장소의 띄우기 준비', () => {
  let spec: string

  beforeEach(() => {
    const origin = join(tmp, 'origin.git')
    git('init', '-q', '--bare', '-b', 'main', origin)
    write('src/app.py', 'def run():\n    pass\n')
    git('-C', repo, 'add', '-A')
    git('-C', repo, 'commit', '-q', '-m', 'app')
    git('-C', repo, 'remote', 'add', 'origin', origin)
    git('-C', repo, 'push', '-q', '-u', 'origin', 'main')
    const overlay = cmd('orch_paths.ts', ['--repo', repo, '--ensure', 'overlay']).stdout.trim()
    writeFileSync(overlay, '# 오버레이\n\n- 검증: `src/app.py` 를 고친 뒤 테스트를 돌린다\n')
    spec = join(cmd('orch_paths.ts', ['--repo', repo, '--ensure', 'specs']).stdout.trim(), 'spec-feat-a.md')
    writeFileSync(spec, '# 일\n\n브랜치: `feat/a`\n허락: push 를 허락했다.\n\n## 담당\n\n- `src/app.py` 의 `run()`\n')
  })

  test('지시서 검사, 첫 지시 줄, 워크트리 만들기가 .omc 없이 돈다', () => {
    let r = cmd('spec-lint.ts', ['--repo', repo, '--check-overlay', spec])
    assert.equal(r.code, 0, r.stdout + r.stderr)

    r = cmd('spec-line.ts', [spec, '--require-permission'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(r.stdout.includes(spec), r.stdout)
    assert.ok(r.stdout.includes('push 를 허락했다'), r.stdout)

    r = cmd('make-worktree.ts', ['--repo', repo, '--spec', spec, '--name', 'feat-a'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const wt = r.stdout.trim().split('\n').at(-1) as string
    assert.equal(git('-C', wt, 'branch', '--show-current'), 'feat/a')
    assert.equal(cmd('orch_paths.ts', ['--repo', wt, 'root']).stdout, `${join(repo, '.orch')}\n`)
    assert.equal(existsSync(join(repo, '.omc')), false)
    assert.equal(git('-C', repo, 'status', '--porcelain'), '')
  })
})
