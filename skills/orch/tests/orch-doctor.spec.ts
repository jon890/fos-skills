// orch-doctor.ts 를 임시 설치 캐시와 로컬 git 원본, 가짜 orca 와 ps 로 본다. Orca 와 원격 저장소에는 닿지 않는다.
// 마켓플레이스 clone 은 실제처럼 커밋 하나뿐인 shallow clone 으로 만든다.
// 핸들러와 설정은 작업 디렉터리(임시 폴더)의 .orch/ 에 둔다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/orch-doctor.ts', import.meta.url))
const LAUNCHER = fileURLToPath(new URL('../../../bin/orch', import.meta.url))
// 안내 줄의 앞 낱말. beforeEach 가 표지 있는 실행기를 PATH 에 두므로 orch 다(lib/commands.ts 의 orchWord)
const WORD = 'orch'

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

// 질문 조회에 답하는 가짜 orca. 질문 하나를 FAKE_AGE 초 전에 만든 것으로 낸다. 시각은 불린 때 정한다.
// doctor 가 조회를 마친 뒤에 시각을 재므로 테스트가 느려도 나이가 경계를 넘지 않는다.
// FAKE_FAIL 이 있으면 실패로 끝난다. FAKE_SLEEP 이 있으면 그 초만큼 잔다. 확장자가 없어 타입 문법 없이 쓴다.
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const print = (value) => fs.writeSync(1, JSON.stringify(value) + '\\n')
if (process.env.FAKE_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP) * 1000)
if (process.env.FAKE_FAIL) {
  fs.writeSync(2, 'orca offline\\n')
  process.exit(1)
}
if (argv.includes('worker-list')) {
  // FAKE_WORKERS 파일의 행을 낸다. 없으면 빈 목록이다
  const rows = process.env.FAKE_WORKERS ? JSON.parse(fs.readFileSync(process.env.FAKE_WORKERS, 'utf8')) : []
  print({ ok: true, result: { workers: rows, scope: { source: 'flag' }, page: { nextCursor: null } } })
} else if (argv[0] === 'terminal' && argv[1] === 'read') {
  // FAKE_SCREENS 파일의 handle 별 화면 줄을 낸다. 없는 handle 은 읽지 못한다
  const screens = process.env.FAKE_SCREENS ? JSON.parse(fs.readFileSync(process.env.FAKE_SCREENS, 'utf8')) : {}
  const lines = screens[argv[argv.indexOf('--terminal') + 1]]
  if (!lines) process.exit(1)
  print({ ok: true, result: { terminal: { tail: lines } } })
} else if (argv.includes('run-current')) {
  print({ ok: true, result: { run: { id: 'r' } } })
} else if (argv.includes('check')) {
  const created = new Date(Date.now() - Number(process.env.FAKE_AGE || '0') * 1000).toISOString()
  const question = { id: 'q1', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d', thread_id: 'q1', body: '질문', created_at: created }
  const ready = process.env.FAKE_READY ? JSON.parse(process.env.FAKE_READY) : null
  print({ ok: true, result: { messages: argv.includes('status') ? (ready ? [ready] : []) : [question] } })
} else {
  print({ ok: true, result: { messages: [] } })
}
`

let binDir: string
let tmp: string
let env: NodeJS.ProcessEnv

function git(...args: string[]): string {
  const done = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function doctor(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { code: number | null; stdout: string; stderr: string } {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
    cwd: opts.cwd ?? tmp,
    env: { ...env, ...opts.env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-doctor-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  // ps 는 FAKE_PS 파일의 내용을 낸다
  writeFileSync(join(binDir, 'ps'), '#!/bin/sh\ncat "$FAKE_PS" 2>/dev/null\n')
  chmodSync(join(binDir, 'orca'), 0o755)
  chmodSync(join(binDir, 'ps'), 0o755)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-doctor-')))
  env = {
    ...process.env,
    ...GIT_ENV,
    // 가짜 orca 의 #! 줄이 이 테스트의 node 를 쓰게 한다. 안내 줄의 앞 낱말과 CLI 판정이 PATH 와 HOME 에 따라 바뀌므로
    // 사용자 PATH 를 물려받지 않고, HOME 에는 최신 ~/.local/bin/orch 를 깔아 둔 PATH 를 준다
    PATH: [dirname(process.execPath), join(tmp, 'home', '.local', 'bin'), '/usr/bin', '/bin'].join(delimiter),
    HOME: join(tmp, 'home'),
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: tmp,
    ORCA: join(binDir, 'orca'),
    PS: join(binDir, 'ps'),
    // 이 머신의 설치 기록을 읽지 않게 없는 설정 폴더로 고정한다. 설치 기록 판정은 그 폴더에 가짜를 만들어 본다
    CLAUDE_CONFIG_DIR: join(tmp, 'no-config'),
  }
  delete env.ORCH_DIR
  mkdirSync(join(tmp, 'home', '.local', 'bin'), { recursive: true })
  copyFileSync(LAUNCHER, join(tmp, 'home', '.local', 'bin', 'orch'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('설치본 판정', () => {
  let origin: string
  let dev: string
  let clone: string
  let skill: string
  let installed: string

  function commit(message: string): string {
    git('-C', dev, 'add', '-A')
    git('-C', dev, 'commit', '-q', '-m', message)
    git('-C', dev, 'push', '-q', 'origin', 'main')
    return git('-C', dev, 'rev-parse', 'HEAD')
  }

  function updateMarketplace(): void {
    git('-C', clone, 'fetch', '-q', '--depth', '1', 'origin', 'main')
    git('-C', clone, 'reset', '-q', '--hard', 'FETCH_HEAD')
  }

  function run(...args: string[]) {
    return doctor(['--skip-questions', '--skill-dir', skill, ...args])
  }

  function installVersion(record: unknown = [{ installPath: join(tmp, 'plugins', 'cache', 'mkt', 'plug', '3.23.0'), gitCommitSha: installed }]): void {
    const installPath = join(tmp, 'plugins', 'cache', 'mkt', 'plug', '3.23.0')
    skill = join(installPath, 'skills', 'orch')
    cpSync(join(dev, 'orch'), skill, { recursive: true })
    if (record !== null) {
      write(join(tmp, 'no-config', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'plug@mkt': record } }))
    }
  }

  beforeEach(() => {
    origin = join(tmp, 'origin.git')
    git('init', '-q', '--bare', '-b', 'main', origin)
    dev = join(tmp, 'dev')
    git('init', '-q', '-b', 'main', dev)
    git('-C', dev, 'remote', 'add', 'origin', origin)
    write(join(dev, '.gitignore'), '__pycache__/\n')
    write(join(dev, 'orch', 'SKILL.md'), '```bash\npython3 "$SKILL_DIR/scripts/a.py"\n```\n')
    write(join(dev, 'orch', 'scripts', 'a.py'), '')
    write(join(dev, 'other', 'SKILL.md'), '# other\n')
    installed = commit('처음')
    clone = join(tmp, 'plugins', 'marketplaces', 'mkt')
    git('clone', '-q', '--depth', '1', `file://${origin}`, clone)
    write(join(tmp, 'plugins', 'known_marketplaces.json'), JSON.stringify({ mkt: { installLocation: clone } }))
    // 설치 캐시는 설치한 커밋의 복사본이다. 실행하면서 생긴 __pycache__ 가 섞여도 같은 내용으로 본다
    skill = join(tmp, 'plugins', 'cache', 'mkt', 'plug', installed.slice(0, 12), 'orch')
    cpSync(join(dev, 'orch'), skill, { recursive: true })
    write(join(skill, 'scripts', '__pycache__', 'a.cpython-313.pyc'), 'x')
  })

  test('skills 아래 설치 캐시도 같은 커밋과 스크립트를 확인한다', () => {
    git('-C', dev, 'mv', 'orch', 'old-orch')
    mkdirSync(join(dev, 'skills'), { recursive: true })
    git('-C', dev, 'mv', 'old-orch', 'skills/orch')
    installed = commit('배치 변경')
    updateMarketplace()
    skill = join(tmp, 'plugins', 'cache', 'mkt', 'plug', installed.slice(0, 12), 'skills', 'orch')
    cpSync(join(dev, 'skills', 'orch'), skill, { recursive: true })
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^OK-VERSION /m)
    assert.match(r.stdout, /^OK-SCRIPTS 1$/m)
    write(join(dev, 'other', 'changed.md'), 'unrelated')
    commit('다른 스킬 변경')
    updateMarketplace()
    assert.match(run().stdout, /^OK-VERSION /m)
  })

  test('마켓플레이스 clone 은 실제처럼 shallow 다', () => {
    assert.equal(git('-C', clone, 'rev-parse', '--is-shallow-repository'), 'true')
  })

  test('같은 커밋이면 OK-VERSION 이다', () => {
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`^OK-VERSION ${installed.slice(0, 12)}$`, 'm'))
    assert.match(r.stdout, /^OK-SCRIPTS 1$/m)
  })

  test('스킬이 바뀐 커밋이면 STALE 과 갱신 명령을 낸다', () => {
    write(join(dev, 'orch', 'scripts', 'spec-line.ts'), '')
    const latest = commit('orch 변경')
    updateMarketplace()
    const r = run()
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.ok(r.stdout.includes(`STALE ${installed.slice(0, 12)} ${latest.slice(0, 12)}`), r.stdout)
    assert.ok(r.stdout.includes('claude plugin marketplace update mkt'), r.stdout)
    assert.ok(r.stdout.includes('claude plugin update plug@mkt'), r.stdout)
  })

  test('버전 폴더에서 설치 기록의 커밋이 오래됐으면 STALE 이다', () => {
    installVersion()
    write(join(dev, 'orch', 'scripts', 'spec-line.ts'), '')
    const latest = commit('orch 변경')
    updateMarketplace()
    const r = run()
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.ok(r.stdout.includes(`STALE ${installed.slice(0, 12)} ${latest.slice(0, 12)}`), r.stdout)
  })

  test('버전 폴더에서 설치 기록의 커밋이 같으면 OK-VERSION 이다', () => {
    installVersion()
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`^OK-VERSION ${installed.slice(0, 12)}$`, 'm'))
  })

  test('버전 폴더에서 설치 기록을 읽지 못하면 SKIP-VERSION 이다', () => {
    installVersion(null)
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-VERSION 버전 설치 기록을 읽지 못했다:/m)
  })

  test('버전 폴더의 설치 기록에 일치하는 경로가 있어도 gitCommitSha 가 없으면 SKIP-VERSION 이다', () => {
    installVersion([{ installPath: join(tmp, 'plugins', 'cache', 'mkt', 'plug', '3.23.0') }])
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-VERSION 현재 설치 경로의 gitCommitSha 가 없거나 SHA 형식이 아니다:/m)
  })

  test('버전 폴더에서 설치 기록에 일치하는 경로가 없으면 SKIP-VERSION 이다', () => {
    installVersion([{ installPath: join(tmp, 'plugins', 'cache', 'mkt', 'plug', '3.22.0'), gitCommitSha: installed }])
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-VERSION 설치 기록에서 현재 설치 경로를 찾지 못했다:/m)
  })

  test('다른 스킬만 바뀐 커밋이면 OK-VERSION 이다', () => {
    write(join(dev, 'other', 'x.md'), 'x\n')
    commit('다른 스킬만 변경')
    updateMarketplace()
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^OK-VERSION /m)
  })

  test('마켓플레이스를 아직 갱신하지 않았으면 tree 를 비교하지 못해 STALE 이다', () => {
    write(join(dev, 'other', 'y.md'), 'y\n')
    commit('밖에서 변경')
    const r = run()
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^STALE /m)
  })

  test('설치 캐시가 아닌 체크아웃은 비교하지 않는다', () => {
    const r = doctor(['--skip-questions', '--skill-dir', join(dev, 'orch')])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-VERSION /m)
  })

  test('원본을 읽지 못하면 SKIP-VERSION 이고 실패하지 않는다', () => {
    const r = run('--remote', join(tmp, 'nowhere.git'))
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-VERSION /m)
  })

  test('없는 스크립트는 문서와 줄 번호로 알리고, 형제 번들 변수는 그 번들에서 찾는다', () => {
    write(
      join(skill, 'references', 'x.md'),
      '본문\n[링크](../scripts/gone.sh)\n`$SKILL_DIR/scripts/a.py`\n`scripts/verify.sh` 는 저장소 예시다\n' +
        '`python3 "$PLAN_SKILL_DIR/scripts/verify_task.py"`\n`python3 "$PLANNING_SKILL_DIR/scripts/verify_task.py"`\n',
    )
    const r = run('--skip-version')
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.ok(r.stdout.includes('MISSING references/x.md:2 scripts/gone.sh'), r.stdout)
    assert.ok(r.stdout.includes('MISSING references/x.md:5 plan/scripts/verify_task.py'), r.stdout)
    assert.ok(!r.stdout.includes('verify.sh'), r.stdout)
    assert.ok(!r.stdout.includes('VERSION'), r.stdout)
    write(join(skill, '..', 'plan', 'scripts', 'verify_task.py'), '')
    assert.ok(!run('--skip-version').stdout.includes('plan'))
  })
})

describe('스크립트 판정', () => {
  test('.ts 참조도 파일이 없으면 MISSING 이고, 만들면 OK-SCRIPTS 다', () => {
    const skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '```bash\nnode --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/b.ts" --run "$RUN_ID"\n```\n')
    const missing = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(missing.code, 1, missing.stdout + missing.stderr)
    assert.equal(missing.stdout, 'MISSING SKILL.md:2 scripts/b.ts\n')
    write(join(skill, 'scripts', 'b.ts'), '')
    const found = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(found.code, 0, found.stdout + found.stderr)
    assert.equal(found.stdout, 'OK-SCRIPTS 1\n')
  })

  test('진입점으로 부르는 스크립트는 bin/orch.ts 와 그 이름의 .ts 를 모두 본다', () => {
    const skill = join(tmp, 'skill')
    write(
      join(skill, 'SKILL.md'),
      '```bash\n"$SKILL_DIR/bin/orch.ts" wait-important --run "$RUN_ID"\n"$SKILL_DIR/bin/orch.ts" --path\n```\n`"$SKILL_DIR/bin/orch.ts" <이름>` 처럼 부른다\n',
    )
    const missing = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(missing.code, 1, missing.stdout + missing.stderr)
    assert.equal(missing.stdout, 'MISSING SKILL.md:2 bin/orch.ts\nMISSING SKILL.md:2 scripts/wait-important.ts\nMISSING SKILL.md:3 bin/orch.ts\nMISSING SKILL.md:5 bin/orch.ts\n')
    write(join(skill, 'bin', 'orch.ts'), '')
    const half = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(half.stdout, 'MISSING SKILL.md:2 scripts/wait-important.ts\n')
    write(join(skill, 'scripts', 'wait-important.ts'), '')
    const found = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(found.code, 0, found.stdout + found.stderr)
    assert.equal(found.stdout, 'OK-SCRIPTS 2\n')
  })

  test('SKILL.md 가 없는 폴더는 사용법 오류다', () => {
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', tmp])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /SKILL\.md 가 없다/)
  })
})

describe('orch 명령 판정', () => {
  // 플러그인 루트에 실행기가 있는 번들의 스킬. CLI 판정은 이 실행기와 ~/.local/bin/orch 를 비교한다
  function pluginSkill(): string {
    const root = join(tmp, 'bundle')
    mkdirSync(join(root, 'bin'), { recursive: true })
    copyFileSync(LAUNCHER, join(root, 'bin', 'orch'))
    write(join(root, 'skills', 's', 'SKILL.md'), '# 스킬\n')
    return join(root, 'skills', 's')
  }

  test('~/.local/bin/orch 가 없거나, 낡았거나, PATH 에 없으면 알리고 종료 코드는 바꾸지 않는다', () => {
    const skill = pluginSkill()
    const copy = join(tmp, 'home', '.local', 'bin', 'orch')
    const ok = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(ok.code, 0, ok.stdout + ok.stderr)
    assert.doesNotMatch(ok.stdout, /CLI-/)
    rmSync(copy)
    const missing = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(missing.code, 0)
    // PATH 에 실행기가 없으니 고칠 명령의 앞 낱말은 진입점 절대경로다
    assert.match(missing.stdout, new RegExp(`^CLI-MISSING ${copy}\n  고칠 명령: \\S+/skills/orch/bin/orch\\.ts doctor install-cli$`, 'm'))
    writeFileSync(copy, '#!/usr/bin/env node\n// fos-skills orch launcher\n// old\n')
    const stale = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.match(stale.stdout, new RegExp(`^CLI-STALE ${copy}$`, 'm'))
    copyFileSync(LAUNCHER, copy)
    const offPath = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) } })
    assert.equal(offPath.code, 0)
    assert.match(offPath.stdout, new RegExp(`^CLI-NOT-ON-PATH ${dirname(copy)}\n  셸 설정`, 'm'))
  })

  test('저장소 파일의 옛 꼴과 스크립트 직접 경로를 고칠 새 꼴과 함께 알린다', () => {
    const repo = join(tmp, 'repo')
    write(
      join(repo, '.orch', 'overlay.md'),
      [
        '"$SKILL_DIR/bin/orch.ts" wait-important --run "$RUN_ID"',
        'node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/merge-with-finish.ts" --repo /r 12',
        '<!-- orch-compat -->',
        '"$SKILL_DIR/bin/orch.ts" orch-loop --start',
        'node "$SKILL_DIR/scripts/remove-worktree.ts" /w # orch-compat',
        'orch queue merge 12',
        '',
      ].join('\n'),
    )
    write(
      join(repo, '.orch', 'specs', 'spec-common.md'),
      [
        'ORCH_SCRIPTS=$(node -e \'...\') && node --disable-warning=ExperimentalWarning "$ORCH_SCRIPTS/worker-ask.ts" --from "$FROM"',
        'ORCH=$(node -e \'...\') && "$ORCH" heavy-slot -- make',
        'node /Users/me/.claude/plugins/cache/fos-skills/fos-skills/88daf0fe2fe7/orch/scripts/worker-ask.ts --from x',
        'python3 "$SKILL_DIR/scripts/orch-doctor.py"',
        'ORCH_SCRIPTS=$(node -e \'...\') && node "$ORCH_SCRIPTS/study-candidates.ts" add --slug s',
        '',
      ].join('\n'),
    )
    write(join(repo, '.orch', 'hooks', 'worker-stalled.ts'), "const nudge = join(process.env.ORCH_SCRIPTS, 'nudge-worker.ts')\nspawnSync('node', [join(ORCH_SCRIPTS, 'nudge-worker.ts')])\n")
    write(join(repo, '.orch', 'bin', 'with-heavy-slot.sh'), 'GATE=$(node /r/.orch/bin/orch.mts --path mem-gate)\n')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', pluginSkill(), '--repo', repo])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const lines = r.stdout.split('\n').filter((l) => /^(OLD-CALL|DIRECT-PATH|  새 꼴)/.test(l))
    assert.deepEqual(lines, [
      'OLD-CALL .orch/overlay.md:1 wait-important',
      '  새 꼴: orch wait',
      'DIRECT-PATH .orch/overlay.md:2 merge-with-finish.ts',
      '  새 꼴: orch queue merge',
      'DIRECT-PATH .orch/specs/spec-common.md:1 worker-ask.ts',
      '  새 꼴: orch worker ask',
      'OLD-CALL .orch/specs/spec-common.md:2 heavy-slot',
      '  새 꼴: orch slot heavy',
      'DIRECT-PATH .orch/specs/spec-common.md:3 worker-ask.ts',
      '  새 꼴: orch worker ask',
      'OLD-CALL .orch/specs/spec-common.md:4 orch-doctor',
      '  새 꼴: orch doctor',
      'DIRECT-PATH .orch/specs/spec-common.md:5 study-candidates.ts',
      '  새 꼴: orch study add',
      'OLD-CALL .orch/bin/with-heavy-slot.sh:1 mem-gate',
      '  새 꼴: orch slot mem',
      'DIRECT-PATH .orch/hooks/worker-stalled.ts:2 nudge-worker.ts',
      '  새 꼴: orch worker nudge',
    ])
  })

  test('대기 출력의 LAST_DELIVERY 를 읽는 저장소 스크립트는 WAIT-READER 로 알리고 문서와 표지 줄은 보지 않는다', () => {
    const repo = join(tmp, 'repo')
    write(join(repo, '.orch', 'bin', 'summary.py'), "import json\nfor line in open(path):\n    if line.startswith('LAST_DELIVERY'):\n        pass\n")
    write(join(repo, '.orch', 'bin', 'keep.sh'), 'grep LAST_DELIVERY out.txt # orch-compat\n')
    write(join(repo, '.orch', 'overlay.md'), '대기 출력의 마지막 줄 `LAST_DELIVERY` 를 읽는다\n')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', pluginSkill(), '--repo', repo])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout.split('\n')
    assert.deepEqual(out.filter((l) => l.startsWith('WAIT-READER')), ['WAIT-READER .orch/bin/summary.py:3'])
    assert.match(out[out.indexOf('WAIT-READER .orch/bin/summary.py:3') + 1], /^  고칠 것: orch wait 의 짧은 출력/)
  })

  test('옛 번들로 도는 대기는 WAIT-STALE 로 알린다', () => {
    const config = join(tmp, 'profile')
    const bundle = (v: string) => join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', v)
    write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fos-skills@fos-skills': [{ scope: 'user', installPath: bundle('4.6.0') }] } }))
    mkdirSync(join(bundle('4.6.0'), 'skills', 'orch', 'scripts'), { recursive: true })
    const psFile = join(tmp, 'ps.txt')
    writeFileSync(
      psFile,
      [
        `  501 node --disable-warning=ExperimentalWarning ${join(bundle('4.2.0'), 'skills', 'orch', 'scripts', 'wait-important.ts')} --run r --ack d`,
        `  502 node ${join(bundle('4.6.0'), 'skills', 'orch', 'scripts', 'wait-important.ts')} --run r`,
        `  503 orca orchestration check --run r --wait ${join(bundle('4.2.0'), 'skills', 'orch', 'scripts', 'wait-important.ts')}`,
        '',
      ].join('\n'),
    )
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', join(tmp, 'skill')], { env: { FAKE_PS: psFile, CLAUDE_CONFIG_DIR: config } })
    write(join(tmp, 'skill', 'SKILL.md'), '# 스킬\n')
    const again = doctor(['--skip-version', '--skip-questions', '--skill-dir', join(tmp, 'skill')], { env: { FAKE_PS: psFile, CLAUDE_CONFIG_DIR: config } })
    assert.equal(r.code, 2)
    assert.equal(again.code, 0, again.stdout + again.stderr)
    const out = again.stdout.split('\n')
    assert.deepEqual(out.filter((l) => l.startsWith('WAIT-STALE')), ['WAIT-STALE 501 4.2.0'])
    assert.match(out[out.indexOf('WAIT-STALE 501 4.2.0') + 1], /kill 501\) orch wait --ack/)
  })

  test('문서의 새 꼴은 명령 표로 확인하고 산문은 보지 않는다', () => {
    const skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '`orch loop start` 로 띄운다. orch 루트는 `.orch` 다.\n```bash\norch wait --ack "$D"\norch nope x\n```\n`orch loop nope` 와 `orch` 스킬\n')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.equal(r.stdout, 'MISSING SKILL.md:4 orch nope x\nMISSING SKILL.md:6 orch loop nope\n')
  })
})

describe('질문 판정', () => {
  let skill: string
  beforeEach(() => {
    skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
  })

  test('600초 이상 답이 없는 질문은 UNANSWERED 이고 종료 코드 1 이다', () => {
    const r = doctor(['--skip-version', '--skill-dir', skill], { env: { FAKE_AGE: '600' } })
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^UNANSWERED q1 10분 이상 답이 없다 \(Run r\)$/m)
  })

  test('다른 dispatch 의 같은 Task PR 이 끝났으면 UNANSWERED 에서 제외한다', () => {
    const head = 'a'.repeat(40)
    const rows = join(tmp, 'workers.json')
    write(rows, JSON.stringify([{ dispatchId: 'd', taskId: 'task', dispatchStatus: 'abandoned' }]))
    const fakeGh = join(tmp, 'gh')
    write(fakeGh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ state: "MERGED", headRefOid: "' + head + '" }))\n')
    chmodSync(fakeGh, 0o755)
    const ready = { type: 'status', task_id: 'task', dispatch_id: 'new', subject: `준비됨 #123, head ${head}` }
    const r = doctor(['--skip-version', '--skill-dir', skill], { env: { FAKE_AGE: '600', FAKE_WORKERS: rows, FAKE_READY: JSON.stringify(ready), GH: fakeGh, ORCH_GH_CACHE: '0' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /UNANSWERED/u)
  })

  test('워크트리와 지시서가 지워진 옛 dispatch 질문도 띄우기 기록으로 제외한다', () => {
    const worktree = join(tmp, 'removed-worktree')
    const rows = join(tmp, 'workers.json')
    write(rows, JSON.stringify([{ dispatchId: 'd', dispatchStatus: 'abandoned', resource: { worktreeId: `repo::${worktree}` } }]))
    write(join(tmp, '.orch/state/launched-workers/d.json'), JSON.stringify({ dispatch: 'd', worktree, run: 'r', terminal: null, spec: join(tmp, 'removed-spec.md') }))
    const r = doctor(['--skip-version', '--skill-dir', skill], { env: { FAKE_AGE: '600', FAKE_WORKERS: rows } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /UNANSWERED/u)
  })

  test('599초면 UNANSWERED 가 없고 종료 코드 0 이다', () => {
    const r = doctor(['--skip-version', '--skill-dir', skill], { env: { FAKE_AGE: '599' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(!r.stdout.includes('UNANSWERED'), r.stdout)
  })

  test('질문 조회가 실패하면 SKIP-QUESTIONS 이고 종료 코드 0 이다', () => {
    const r = doctor(['--skip-version', '--skill-dir', skill], { env: { FAKE_FAIL: '1' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-QUESTIONS .*orca offline/m)
  })
})

describe('저장소 판정', () => {
  let skill: string
  beforeEach(() => {
    skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
  })

  test('이벤트 이름이 아닌 핸들러 파일은 UNKNOWN-HOOK 이고 종료 코드 0 이다', () => {
    write(join(tmp, '.orch', 'hooks', 'befor-merge.ts'), '')
    write(join(tmp, '.orch', 'hooks', 'before-merge.ts'), '')
    write(join(tmp, '.orch', 'hooks', 'lib', 'helper.ts'), '')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, `OK-SCRIPTS 0\nUNKNOWN-HOOK ${join(tmp, '.orch', 'hooks', 'befor-merge.ts')}\n`)
  })

  test('삭제한 설정 칸은 INVALID-CONFIG 이고 종료 코드 1 이다', () => {
    write(join(tmp, '.orch', 'config.json'), JSON.stringify({ queue: { before: 'make check' } }))
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /INVALID-CONFIG .*queue.before.* doctor migrate-hooks --repo /)
    assert.doesNotMatch(r.stdout, /DEPRECATED/)
  })

  test('queue.auto_review.require 의 모르는 조건 이름은 INVALID-CONFIG 이고 종료 코드 1 이다', () => {
    const review = { pass: '통과', block: '보류', require: ['verdict-seen', 'thread-resolved'] }
    write(join(tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_merge: true, auto_review: review } }))
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^INVALID-CONFIG queue\.auto_review\.require 에 모르는 조건이 있다: thread-resolved\. 쓸 수 있는 조건: verdict-on-head, /m)
  })

  test('아는 조건만 적은 조합은 INVALID-CONFIG 가 아니다', () => {
    const review = { pass: '통과', block: '보류', require: ['verdict-seen', 'last-verdict-pass', 'rereview-after-block'] }
    write(join(tmp, '.orch', 'config.json'), JSON.stringify({ queue: { auto_merge: true, auto_review: review } }))
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, 'OK-SCRIPTS 0\n')
  })

  test('설정 파일이 깨졌으면 이유를 stderr 에 내고 그 판정만 건너뛴다', () => {
    write(join(tmp, '.orch', 'config.json'), '{')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, 'OK-SCRIPTS 0\n')
    assert.match(r.stderr, /설정 파일을 읽지 못했다/)
  })

  test('다시 보지 않은 개선 후보 파일 수를 FEEDBACK-OPEN 으로 내고 종료 코드는 0 이다', () => {
    const dir = join(tmp, '.orch', 'feedback')
    write(join(dir, 'wt-a.md'), '후보\n')
    write(join(dir, 'wt-b.md'), '후보\n')
    // README 와 다시 본 뒤 옮긴 파일, .md 가 아닌 파일은 세지 않는다
    write(join(dir, 'README.md'), '안내\n')
    write(join(dir, 'reviewed', 'wt-old.md'), '판정함\n')
    write(join(dir, 'notes.txt'), 'x\n')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, `OK-SCRIPTS 0\nFEEDBACK-OPEN 2 ${dir}\n`)
  })

  test('코디네이터의 coordinator-<YYYYMMDD>.md 도 열린 후보로 센다. 다른 이름의 폴더는 세지 않는다', () => {
    const dir = join(tmp, '.orch', 'feedback')
    write(join(dir, 'coordinator-20261101.md'), '## 후보\n')
    write(join(dir, 'wt-a.md'), '후보\n')
    write(join(tmp, '.orch', 'skill-feedback', 'wt-b.md'), '후보\n')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, `OK-SCRIPTS 0\nFEEDBACK-OPEN 2 ${dir}\n`)
  })

  test('열린 후보가 없거나 폴더가 없으면 FEEDBACK-OPEN 을 내지 않는다', () => {
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.stdout, 'OK-SCRIPTS 0\n')
    write(join(tmp, '.orch', 'feedback', 'reviewed', 'wt-old.md'), '판정함\n')
    assert.equal(doctor(['--skip-version', '--skip-questions', '--skill-dir', skill]).stdout, 'OK-SCRIPTS 0\n')
  })

  test('공부 후보 파일 가운데 후보와 리뷰함만 세어 STUDY-OPEN 으로 내고 종료 코드는 0 이다', () => {
    const dir = join(tmp, '.orch', 'study')
    const statuses = { a: '후보', b: '리뷰함: 다시 나온다', c: '뺌: 하루 끝에 뺌', d: '글 씀: study/d.md', e: '모름' }
    for (const [slug, status] of Object.entries(statuses)) write(join(dir, `${slug}.md`), `---\n주제: ${slug}\n상태: ${status}\n적은 날: 2026-11-02\n---\n\n메모\n`)
    write(join(dir, 'README.md'), '# 안내\n')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, `OK-SCRIPTS 0\nSTUDY-OPEN 2 ${dir}\n`)
  })

  test('열린 공부 후보가 없거나 폴더가 없으면 STUDY-OPEN 을 내지 않고, 머리 없는 파일과 옛 표 파일은 세지 않고 stderr 에 알린다', () => {
    assert.equal(doctor(['--skip-version', '--skip-questions', '--skill-dir', skill]).stdout, 'OK-SCRIPTS 0\n')
    const dir = join(tmp, '.orch', 'study')
    write(join(dir, 'a.md'), '---\n주제: a\n상태: 뺌: 이유\n---\n')
    assert.equal(doctor(['--skip-version', '--skip-questions', '--skill-dir', skill]).stdout, 'OK-SCRIPTS 0\n')
    write(join(dir, 'broken.md'), '# 머리가 없다\n')
    // ai-analysis 의 .orch/study/candidates.md 를 2026-11-01 에 복사한 것이다. 원본은 고치지 않는다
    write(join(dir, 'candidates.md'), readFileSync(fileURLToPath(new URL('./fixtures/study/candidates.md', import.meta.url)), 'utf8'))
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, 'OK-SCRIPTS 0\n')
    assert.match(r.stderr, /옛 공부 후보 표 파일이 남아 있다. \S+ study migrate 로 옮긴다: .*candidates\.md/)
    assert.match(r.stderr, /공부 후보 파일의 머리를 읽지 못했다: .*broken\.md/)
  })

  test('--repo 로 준 저장소를 본다', () => {
    const other = join(tmp, 'other')
    write(join(other, '.orch', 'hooks', 'tik.ts'), '')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--repo', other])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, `OK-SCRIPTS 0\nUNKNOWN-HOOK ${join(other, '.orch', 'hooks', 'tik.ts')}\n`)
  })
})

describe('session-resume', () => {
  let skill: string
  let received: string
  let psFile: string
  beforeEach(() => {
    skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
    received = join(tmp, 'received.json')
    psFile = join(tmp, 'ps.txt')
    writeFileSync(
      psFile,
      [
        '  111 node --disable-warning=ExperimentalWarning /x/orch/scripts/wait-important.ts --run r --ack d1',
        '  222 /bin/zsh -c node --disable-warning=ExperimentalWarning /x/orch/scripts/wait-important.ts --run r',
        '  333 node --disable-warning=ExperimentalWarning /x/orch/scripts/wait-important.ts --run r2',
        '  444 node --disable-warning=ExperimentalWarning /x/orch/scripts/watch-questions.ts --run r',
        '  555 orca orchestration check --run r --wait',
        '  666 /usr/bin/env node /tmp/wait-important-bin-x/orca orchestration check --run r --wait --json',
        '  777 /bin/bash -c node --disable-warning=ExperimentalWarning /x/orch/scripts/watch-questions.ts --run r',
        '',
      ].join('\n'),
    )
  })

  function handler(body: string): void {
    write(join(tmp, '.orch', 'hooks', 'session-resume.ts'), body)
  }

  test('--run 이면 핸들러가 대기 pid, 미답변 질문 id, 루프 상태를 받는다', () => {
    handler("import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, readFileSync(0, 'utf8'))\n")
    const r = doctor(['--skip-version', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_AGE: '30', FAKE_PS: psFile, RECEIVED: received } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const input = JSON.parse(readFileSync(received, 'utf8'))
    assert.equal(input.event, 'session-resume')
    assert.equal(input.run, 'r')
    assert.equal(input.repo, tmp)
    assert.equal(input.base, '')
    // 대기(111)와 질문 감시(444)만 센다. 다른 Run(333), 셸(222, 777), 자식 check(555, 666)는 뺀다
    assert.deepEqual(input.waiters, [111, 444])
    assert.deepEqual(input.unanswered, ['q1'])
    assert.equal(input.loop_alive, false)
  })

  test('--skip-questions 면 unanswered 는 빈 목록이다', () => {
    handler("import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, readFileSync(0, 'utf8'))\n")
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_PS: psFile, RECEIVED: received } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(received, 'utf8')).unanswered, [])
  })

  test('핸들러가 실패하면 HOOK-FAIL 줄만 남기고 종료 코드를 바꾸지 않는다', () => {
    handler('process.exit(3)\n')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_PS: psFile } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^HOOK-FAIL session-resume 3$/m)
  })

  test('질문 조회가 시간 초과면 SKIP-QUESTIONS 이고 종료 코드는 0 이다', { timeout: 120_000 }, () => {
    // 질문 조회는 orca 호출마다 시간 제한이 있다(운영 30초, lib/questions.ts). 테스트는 1초로 줄이고 가짜 orca 는 그보다 오래 잔다
    const r = doctor(['--skip-version', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_SLEEP: '3', FAKE_PS: psFile, ORCH_QUESTIONS_TIMEOUT_SEC: '1' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-QUESTIONS .+/m)
    assert.doesNotMatch(r.stdout, /^UNANSWERED /m)
  })

  function loopJson(pid: number, aliveAt: string, fields: Record<string, unknown> = {}): void {
    write(join(tmp, '.orch', 'state', 'loop.json'), JSON.stringify({ pid, run: 'r', repo: tmp, tick_sec: 300, started_at: aliveAt, alive_at: aliveAt, last_tick: null, ticks: 0, errors: {}, ...fields }))
  }

  test('죽은 pid 의 loop.json 이면 LOOP-DEAD 와 다시 띄울 명령을 내고 loop_alive 는 false 다', () => {
    handler("import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, readFileSync(0, 'utf8'))\n")
    const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    loopJson(Number(ended.stdout), new Date().toISOString())
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_PS: psFile, RECEIVED: received } })
    // 종료 코드는 바꾸지 않는다
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout.split('\n')
    const at = out.indexOf(`LOOP-DEAD ${tmp} pid ${ended.stdout} 종료`)
    assert.ok(at >= 0, r.stdout)
    assert.equal(out[at + 1], `  ${WORD} loop start --repo ${tmp} --run r`)
    assert.equal(JSON.parse(readFileSync(received, 'utf8')).loop_alive, false)
  })

  test('살아 있는 loop.json 이면 loop_alive 는 true 이고 LOOP-DEAD 를 내지 않는다', () => {
    handler("import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, readFileSync(0, 'utf8'))\n")
    loopJson(process.pid, new Date().toISOString())
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_PS: psFile, RECEIVED: received } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /LOOP-DEAD/)
    assert.equal(JSON.parse(readFileSync(received, 'utf8')).loop_alive, true)
  })

  test('Run 등록을 아는 살아 있는 루프에 이 Run 이 없으면 미등록 LOOP-DEAD 와 다시 등록할 명령을 내고 loop_alive 는 false 다', () => {
    handler("import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, readFileSync(0, 'utf8'))\n")
    loopJson(process.pid, new Date().toISOString(), { run: 'other', runs: ['other'] })
    write(join(tmp, '.orch', 'state', 'loop-runs', 'other.json'), JSON.stringify({ run: 'other', specs_dir: null, registered_at: '2026-01-01T00:00:00Z' }))
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_PS: psFile, RECEIVED: received } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout.split('\n')
    const at = out.indexOf(`LOOP-DEAD ${tmp} run r 미등록`)
    assert.ok(at >= 0, r.stdout)
    assert.equal(out[at + 1], `  ${WORD} loop start --repo ${tmp} --run r`)
    assert.equal(JSON.parse(readFileSync(received, 'utf8')).loop_alive, false)
    write(join(tmp, '.orch', 'state', 'loop-runs', 'r.json'), JSON.stringify({ run: 'r', specs_dir: null, registered_at: '2026-01-02T00:00:00Z' }))
    const joined = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_PS: psFile, RECEIVED: received } })
    assert.doesNotMatch(joined.stdout, /LOOP-DEAD/)
    assert.equal(JSON.parse(readFileSync(received, 'utf8')).loop_alive, true)
  })

  test('루프 pid 가 살아 있고 alive_at 이 오래됐어도 다시 보기 전에 새로 써지면 LOOP-DEAD 를 내지 않고 loop_alive 는 true 다', { timeout: 60_000 }, async (t) => {
    handler("import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, readFileSync(0, 'utf8'))\n")
    // 명령줄에 orch-loop 가 든 살아 있는 프로세스다
    const fakeLoop = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'orch-loop'], { stdio: 'ignore' })
    t.after(() => fakeLoop.kill('SIGKILL'))
    await new Promise((resolve) => fakeLoop.once('spawn', resolve))
    loopJson(fakeLoop.pid as number, new Date(Date.now() - 3600_000).toISOString())
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], {
      cwd: tmp,
      // 생존 타이머 간격 1초에 여유 1.5초를 기다린 뒤 다시 본다. 그 전인 1초에 alive_at 을 새로 쓴다
      env: { ...env, FAKE_PS: psFile, RECEIVED: received, ORCH_LOOP_ALIVE_SEC: '1', ORCH_LOOP_RECHECK_MARGIN_SEC: '1.5' },
    })
    t.after(() => child.kill('SIGKILL'))
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    loopJson(fakeLoop.pid as number, new Date().toISOString())
    assert.equal(await closed, 0, stdout)
    assert.doesNotMatch(stdout, /LOOP-DEAD/)
    assert.equal(JSON.parse(readFileSync(received, 'utf8')).loop_alive, true)
  })

  test('--run 이 없으면 이벤트를 내지 않는다', () => {
    handler("import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, 'called')\n")
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_PS: psFile, RECEIVED: received } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(!existsSync(received), '핸들러가 불렸다')
  })
})

describe('worker 판정', () => {
  let skill: string
  beforeEach(() => {
    skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
  })

  function workers(rows: unknown[], screens: Record<string, string[]>): NodeJS.ProcessEnv {
    const rowsFile = join(tmp, 'workers.json')
    const screensFile = join(tmp, 'screens.json')
    writeFileSync(rowsFile, JSON.stringify(rows))
    writeFileSync(screensFile, JSON.stringify(screens))
    return { FAKE_WORKERS: rowsFile, FAKE_SCREENS: screensFile, FAKE_PS: join(tmp, 'none') }
  }

  const takeover = (dispatch: string, handle: string) => ({
    dispatchId: dispatch,
    dispatchStatus: 'dispatched',
    workerState: 'ready',
    agentTerminalHandle: handle,
    resource: { terminalHandle: handle, ownershipState: 'user_owned', retainedReason: 'user_takeover' },
  })

  test('user_takeover 로 표시된 살아 있는 worker 를 화면으로 판정해 WORKER-STATE 로 낸다', () => {
    const env = workers(
      [
        takeover('ctx_busy', 'term_busy'),
        takeover('ctx_idle', 'term_idle'),
        { dispatchId: 'ctx_owned', dispatchStatus: 'dispatched', workerState: 'ready', resource: { ownershipState: 'owned' } },
        { dispatchId: 'ctx_done', dispatchStatus: 'completed', workerState: 'succeeded', resource: { ownershipState: 'user_owned' } },
      ],
      { term_busy: ['✳ Thinking… (2s · esc to interrupt)'], term_idle: ['⏺ 끝.', '❯ '] },
    )
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^WORKER-STATE ctx_busy working user_takeover 표시지만 화면이 작업 중이다\(ctx_busy, term_busy\)$/m)
    assert.match(r.stdout, /^WORKER-STATE ctx_idle taken_over 사용자가 넘겨받은 터미널\(ctx_idle user_takeover, 화면 term_idle idle\)$/m)
    assert.doesNotMatch(r.stdout, /ctx_owned|ctx_done/)
  })

  test('--run 이 없으면 판정하지 않는다', () => {
    const env = workers([takeover('ctx_busy', 'term_busy')], {})
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env })
    assert.doesNotMatch(r.stdout, /WORKER-STATE|SKIP-WORKERS/)
  })

  test('worker-list 를 읽지 못하면 SKIP-WORKERS 이고 종료 코드 0 이다', () => {
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_FAIL: '1', FAKE_PS: join(tmp, 'none') } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-WORKERS .*worker-list/m)
  })
})

describe('Orca 형식 판정', () => {
  const full = { dispatchId: 'ctx_1', taskId: 'task_1', dispatchStatus: 'dispatched', workerState: 'ready', agentTerminalHandle: null, resource: { worktreeId: 'w::/x', ownershipState: 'orchestration_owned' } }
  function run(rows: unknown[]) {
    const skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
    const rowsFile = join(tmp, 'workers.json')
    writeFileSync(rowsFile, JSON.stringify(rows))
    return doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_WORKERS: rowsFile, FAKE_PS: join(tmp, 'none') } })
  }

  test('worker-list 행에 orch 가 읽는 키가 빠지면 ORCA-SHAPE 와 안내를 내고 종료 코드는 0 이다', () => {
    const { workerState: _, resource: __, ...rest } = full
    const r = run([{ ...rest, resource: { ownershipState: 'user_owned' } }])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout.split('\n')
    const at = out.indexOf('ORCA-SHAPE worker-list workerState,resource.worktreeId')
    assert.ok(at >= 0, r.stdout)
    assert.match(out[at + 1], /^ {2}안내: Orca 출력 형식이 바뀌어/)
  })

  test('키가 모두 있거나(null 값 포함) 행이 없거나 orca 가 실패하면 내지 않는다', () => {
    assert.doesNotMatch(run([full]).stdout, /ORCA-SHAPE/)
    assert.doesNotMatch(run([]).stdout, /ORCA-SHAPE/)
    const skill = join(tmp, 'skill')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_FAIL: '1', FAKE_PS: join(tmp, 'none') } })
    assert.doesNotMatch(r.stdout, /ORCA-SHAPE/)
  })
})

describe('루프 번들 판정', () => {
  test('설치되지 않은 번들로 도는 루프만 LOOP-STALE 로 알리고, 다시 띄울 명령을 그 Run 의 세션에서 돌리라고 안내한다', () => {
    const skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
    // 프로필 경로에 빈칸이 있다(macOS 의 Application Support)
    const plugins = join(tmp, 'Application Support', 'plugins')
    const bundle = (sha: string) => join(plugins, 'cache', 'fos-skills', 'fos-skills', sha)
    write(
      join(plugins, 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'fos-skills@fos-skills': [{ scope: 'project', installPath: bundle('ccccccc3') }, { scope: 'user', installPath: bundle('bbbbbbb2') }] } }),
    )
    // 현재 설치본은 lib/install-record.ts 의 규칙으로 고르므로 스크립트 폴더가 있어야 한다
    mkdirSync(join(bundle('bbbbbbb2'), 'skills', 'orch', 'scripts'), { recursive: true })
    const repo = join(tmp, 'my repo')
    write(join(repo, '.orch', 'state', 'loop.json'), JSON.stringify({ pid: 111, run: 'r0', bound_run: 'r1', runs: ['r0', 'r1'] }))
    const loopOf = (sha: string) => join(bundle(sha), 'orch', 'scripts', 'orch-loop.ts')
    const psFile = join(tmp, 'ps.txt')
    writeFileSync(
      psFile,
      [
        `  111 /usr/bin/node --disable-warning=ExperimentalWarning ${loopOf('aaaaaaa1')} --repo ${repo} --run r1 --foreground`,
        // 같은 루프의 틱 자식은 따로 세지 않는다
        `  112 /usr/bin/node --disable-warning=ExperimentalWarning ${loopOf('aaaaaaa1')} --repo ${repo} --run r1 --tick --tick-number 3`,
        // 지금 세션의 설치본(user 범위)
        `  222 /usr/bin/node --disable-warning=ExperimentalWarning ${loopOf('bbbbbbb2')} --repo /r/b --run r2 --foreground`,
        // project 범위 행만 있는 번들은 지금 세션이 싣는 번들이 아니다
        `  333 /usr/bin/node --disable-warning=ExperimentalWarning ${loopOf('ccccccc3')} --repo /r/c --run r3 --foreground`,
        // 저장소 체크아웃에서 띄운 개발 중인 루프
        '  444 /usr/bin/node --disable-warning=ExperimentalWarning /Users/me/fos-skills/skills/orch/scripts/orch-loop.ts --repo /r/d --foreground',
        '',
      ].join('\n'),
    )
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_PS: psFile, CLAUDE_CONFIG_DIR: dirname(plugins) } })
    // 경고라 종료 코드는 바꾸지 않는다
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout.split('\n')
    assert.deepEqual(
      out.filter((line) => line.startsWith('LOOP-STALE')),
      [`LOOP-STALE ${repo} 111 aaaaaaa1`, 'LOOP-STALE /r/c 333 ccccccc3'],
    )
    const at = out.indexOf(`LOOP-STALE ${repo} 111 aaaaaaa1`)
    assert.match(out[at + 1], /^ {2}안내: 이 루프는 설치되지 않은 번들\(aaaaaaa1\)로 돈다\. 아래 두 명령은 그 루프의 Run\(r1\) 코디네이터 세션에서 돌린다/)
    assert.equal(out[at + 2], `  ${WORD} loop stop --repo '${repo}' --all`)
    assert.equal(out[at + 3], `  ${WORD} loop start --repo '${repo}' --run r1`)
    // 짧은 출력은 판정 줄과 고칠 명령 줄만 남기고 안내 줄을 뺀다
    const brief = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_PS: psFile, CLAUDE_CONFIG_DIR: dirname(plugins), ORCH_OUTPUT: 'short' } })
    assert.equal(brief.code, 0, brief.stdout + brief.stderr)
    const lines = brief.stdout.split('\n').filter(Boolean)
    const head = lines.indexOf(`LOOP-STALE ${repo} 111 aaaaaaa1`)
    assert.deepEqual(lines.slice(head, head + 3), [`LOOP-STALE ${repo} 111 aaaaaaa1`, `  ${WORD} loop stop --repo '${repo}' --all`, `  ${WORD} loop start --repo '${repo}' --run r1`])
    assert.ok(lines.every((l) => /^[A-Z]/.test(l) || (/^ {2}\S/.test(l) && !l.startsWith('  안내:'))), brief.stdout)
  })

  test('버전 이름의 캐시 폴더도 보고, 다른 프로필의 같은 버전 폴더는 같은 번들로 본다', () => {
    const skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
    const config = join(tmp, 'profile', 'home')
    const bundle = (root: string, version: string) => join(root, 'plugins', 'cache', 'fos-skills', 'fos-skills', version)
    write(
      join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'fos-skills@fos-skills': [{ scope: 'user', installPath: bundle(config, '3.12.0') }, { scope: 'project', installPath: bundle(join(tmp, 'old'), '3.6.0') }] } }),
    )
    mkdirSync(join(bundle(config, '3.12.0'), 'skills', 'orch', 'scripts'), { recursive: true })
    const loopOf = (root: string, version: string) => join(bundle(root, version), 'orch', 'scripts', 'orch-loop.ts')
    const psFile = join(tmp, 'ps.txt')
    writeFileSync(
      psFile,
      [
        `  111 node ${loopOf(join(tmp, 'old'), '3.6.0')} --repo /r/a --run r1 --foreground`,
        `  222 node ${loopOf(join(tmp, 'other-profile'), '3.12.0')} --repo /r/b --run r2 --foreground`,
        `  333 node ${loopOf(config, '3.12.0')} --repo /r/c --run r3 --foreground`,
        '',
      ].join('\n'),
    )
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_PS: psFile, CLAUDE_CONFIG_DIR: config } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(r.stdout.split('\n').filter((line) => line.startsWith('LOOP-STALE')), ['LOOP-STALE /r/a 111 3.6.0'])
    assert.ok(r.stdout.includes(`${WORD} loop stop --repo /r/a --all`), r.stdout)
  })

  test('지금 프로필에 user 범위 행이 없으면 판정하지 않는다', () => {
    const skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
    const config = join(tmp, 'home')
    const plugins = join(config, 'plugins')
    write(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'fos-skills@mkt': [{ scope: 'project', installPath: join(plugins, 'cache', 'mkt', 'fos-skills', 'bbbbbbb2') }] } }))
    const psFile = join(tmp, 'ps.txt')
    writeFileSync(psFile, `  111 node ${join(plugins, 'cache', 'mkt', 'fos-skills', 'aaaaaaa1', 'orch', 'scripts', 'orch-loop.ts')} --repo /r/a --foreground\n`)
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_PS: psFile, CLAUDE_CONFIG_DIR: config } })
    assert.doesNotMatch(r.stdout, /LOOP-STALE/)
  })

  test('installed_plugins.json 을 읽지 못하면 판정하지 않는다', () => {
    const skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
    const psFile = join(tmp, 'ps.txt')
    writeFileSync(psFile, `  111 node ${join(tmp, 'plugins', 'cache', 'mkt', 'fos-skills', 'aaaaaaa1', 'orch', 'scripts', 'orch-loop.ts')} --repo /r/a --foreground\n`)
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { FAKE_PS: psFile } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /LOOP-STALE/)
  })
})

describe('설치 기록 판정', () => {
  let skill: string
  let config: string
  beforeEach(() => {
    skill = join(tmp, 'skill')
    write(join(skill, 'SKILL.md'), '# 스킬\n')
    config = join(tmp, 'config', 'home')
  })

  const record = (plugins: Record<string, unknown>) => write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
  const run = () => doctor(['--skip-version', '--skip-questions', '--skill-dir', skill], { env: { CLAUDE_CONFIG_DIR: config } })

  test('installPath 가 없는 플러그인은 PLUGIN-PATH-MISSING 으로 알리고, 현재 설정 폴더의 같은 경로와 고치는 방법을 안내한다. 파일은 고치지 않는다', () => {
    const old = join(tmp, 'config', 'old-profile', 'plugins', 'cache', 'fos-skills', 'fos-skills', 'abc1234')
    const moved = join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', 'abc1234')
    mkdirSync(moved, { recursive: true })
    const present = join(config, 'plugins', 'cache', 'other', 'ok', '1')
    mkdirSync(present, { recursive: true })
    record({
      'fos-skills@fos-skills': [{ scope: 'user', installPath: old }],
      'ok@other': [{ scope: 'user', installPath: present }],
      'gone@mkt': [{ scope: 'project', installPath: join(tmp, 'nowhere', 'plugins', 'cache', 'gone', 'x') }],
    })
    const before = readFileSync(join(config, 'plugins', 'installed_plugins.json'), 'utf8')
    const r = run()
    // 경고라 종료 코드는 바꾸지 않는다
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const out = r.stdout.split('\n')
    assert.deepEqual(
      out.filter((line) => line.startsWith('PLUGIN-PATH-MISSING')),
      [`PLUGIN-PATH-MISSING fos-skills@fos-skills user ${old}`, `PLUGIN-PATH-MISSING gone@mkt project ${join(tmp, 'nowhere', 'plugins', 'cache', 'gone', 'x')}`],
    )
    const at = out.indexOf(`PLUGIN-PATH-MISSING fos-skills@fos-skills user ${old}`)
    assert.equal(out[at + 1], `  현재 설정 폴더에 같은 경로가 있다: ${moved}`)
    assert.match(r.stdout, /^ {2}고치기: .*installed_plugins\.json 을 백업한 뒤/m)
    assert.match(r.stdout, /^ {2}반영: \/reload-plugins$/m)
    assert.doesNotMatch(r.stdout, /PLUGIN-PATH-MISSING ok@other/)
    assert.equal(readFileSync(join(config, 'plugins', 'installed_plugins.json'), 'utf8'), before)
  })

  test('모든 installPath 가 있으면 아무것도 내지 않는다', () => {
    const present = join(config, 'plugins', 'cache', 'fos-skills', 'fos-skills', 'abc1234')
    mkdirSync(present, { recursive: true })
    record({ 'fos-skills@fos-skills': [{ scope: 'user', installPath: present }] })
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /PLUGIN-PATH-MISSING|반영:/)
  })

  test('기록이 없거나 깨졌으면 판정하지 않는다', () => {
    assert.doesNotMatch(run().stdout, /PLUGIN-PATH-MISSING/)
    write(join(config, 'plugins', 'installed_plugins.json'), '{깨짐')
    const r = run()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /PLUGIN-PATH-MISSING/)
  })

  test('CLAUDE_CONFIG_DIR 가 없으면 ~/.claude 를 본다', () => {
    const home = join(tmp, 'home')
    record({})
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'a@b': [{ scope: 'user', installPath: join(tmp, 'x', 'plugins', 'y') }] } }))
    const e = { ...env, HOME: home }
    delete e.CLAUDE_CONFIG_DIR
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--skip-version', '--skip-questions', '--skill-dir', skill], { cwd: tmp, env: e, encoding: 'utf8' })
    assert.match(done.stdout, /^PLUGIN-PATH-MISSING a@b user /m)
  })
})
