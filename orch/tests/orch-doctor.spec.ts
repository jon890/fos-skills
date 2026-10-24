// orch-doctor.ts 를 임시 설치 캐시와 로컬 git 원본, 가짜 orca 와 ps 로 본다. Orca 와 원격 저장소에는 닿지 않는다.
// 마켓플레이스 clone 은 실제처럼 커밋 하나뿐인 shallow clone 으로 만든다.
// 핸들러와 설정은 작업 디렉터리(임시 폴더)의 .orch/ 에 둔다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/orch-doctor.ts', import.meta.url))

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
if (argv.includes('run-current')) {
  print({ ok: true, result: { run: { id: 'r' } } })
} else if (argv.includes('check')) {
  const created = new Date(Date.now() - Number(process.env.FAKE_AGE || '0') * 1000).toISOString()
  const question = { id: 'q1', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d', thread_id: 'q1', body: '질문', created_at: created }
  print({ ok: true, result: { messages: [question] } })
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
    // 가짜 orca 의 #! 줄이 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
    GIT_CEILING_DIRECTORIES: tmp,
    ORCA: join(binDir, 'orca'),
    PS: join(binDir, 'ps'),
  }
  delete env.ORCH_DIR
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
        '`python3 "$PLANNING_SKILL_DIR/scripts/verify_task.py"`\n',
    )
    const r = run('--skip-version')
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.ok(r.stdout.includes('MISSING references/x.md:2 scripts/gone.sh'), r.stdout)
    assert.ok(r.stdout.includes('MISSING references/x.md:5 planning/scripts/verify_task.py'), r.stdout)
    assert.ok(!r.stdout.includes('verify.sh'), r.stdout)
    assert.ok(!r.stdout.includes('VERSION'), r.stdout)
    write(join(skill, '..', 'planning', 'scripts', 'verify_task.py'), '')
    assert.ok(!run('--skip-version').stdout.includes('planning'))
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

  test('SKILL.md 가 없는 폴더는 사용법 오류다', () => {
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', tmp])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /SKILL\.md 가 없다/)
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

  test('옛 설정 칸은 DEPRECATED-CONFIG 이고 종료 코드 0 이다', () => {
    write(join(tmp, '.orch', 'config.json'), JSON.stringify({ queue: { before: 'make check' } }))
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, 'OK-SCRIPTS 0\nDEPRECATED-CONFIG queue.before → hooks/before-merge.ts\n')
  })

  test('설정 파일이 깨졌으면 이유를 stderr 에 내고 그 판정만 건너뛴다', () => {
    write(join(tmp, '.orch', 'config.json'), '{')
    const r = doctor(['--skip-version', '--skip-questions', '--skill-dir', skill])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, 'OK-SCRIPTS 0\n')
    assert.match(r.stderr, /설정 파일을 읽지 못했다/)
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
    // 질문 조회는 orca 호출마다 30초 제한이다(lib/questions.ts). 가짜 orca 는 그보다 오래 잔다
    const r = doctor(['--skip-version', '--skill-dir', skill, '--run', 'r'], { env: { FAKE_SLEEP: '40', FAKE_PS: psFile } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^SKIP-QUESTIONS .+/m)
    assert.doesNotMatch(r.stdout, /^UNANSWERED /m)
  })

  function loopJson(pid: number, aliveAt: string): void {
    write(join(tmp, '.orch', 'state', 'loop.json'), JSON.stringify({ pid, run: 'r', repo: tmp, tick_sec: 300, started_at: aliveAt, alive_at: aliveAt, last_tick: null, ticks: 0, errors: {} }))
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
    assert.equal(out[at + 1], `  node --disable-warning=ExperimentalWarning "${join(skill, 'scripts', 'orch-loop.ts')}" --repo ${tmp} --run r --start`)
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

  test('루프 pid 가 살아 있고 alive_at 이 오래됐어도 다시 보기 전에 새로 써지면 LOOP-DEAD 를 내지 않고 loop_alive 는 true 다', { timeout: 60_000 }, async (t) => {
    handler("import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync(process.env.RECEIVED, readFileSync(0, 'utf8'))\n")
    // 명령줄에 orch-loop 가 든 살아 있는 프로세스다
    const fakeLoop = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'orch-loop'], { stdio: 'ignore' })
    t.after(() => fakeLoop.kill('SIGKILL'))
    await new Promise((resolve) => fakeLoop.once('spawn', resolve))
    loopJson(fakeLoop.pid as number, new Date(Date.now() - 3600_000).toISOString())
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--skip-version', '--skip-questions', '--skill-dir', skill, '--run', 'r'], {
      cwd: tmp,
      // 생존 타이머 간격 1초에 여유 5초를 기다린 뒤 다시 본다
      env: { ...env, FAKE_PS: psFile, RECEIVED: received, ORCH_LOOP_ALIVE_SEC: '1' },
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
