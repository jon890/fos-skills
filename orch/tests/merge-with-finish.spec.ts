// merge-with-finish.ts 가 PR 인자를 해석하고, 마무리를 PR 마다 한 번만 걸고, 머지 큐에 `!` 를 뗀 인자를 넘기는지 본다.
//
// 머지 큐와 마무리는 대개 인자를 기록하는 가짜 스크립트(queue.sh, finish.py)로 바꾼다. 확장자대로 bash 와 python3 로 돈다.
// 옛 칸이 머지 큐의 이벤트로 이어지는지는 MERGE_QUEUE 를 바꾸지 않고 진짜 merge_queue.ts 를 가짜 gh, git 으로 돌려 본다
// (tests/fixtures/merge-queue-fakes.ts). GitHub 와 Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { QUEUE_VALUE_OPTIONS } from '../scripts/lib/queue-options.ts'
import { FAKE_GH, FAKE_GIT, HAS_TOOLS, spawnDone, writeNodeBin } from './fixtures/merge-queue-fakes.ts'
import type { Done } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/merge-with-finish.ts', import.meta.url))
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT]
const HAS_BASH = spawnSync('sh', ['-c', 'command -v bash']).status === 0

const FAKE_QUEUE_SH = `echo "queue $*" >> "$FAKE_LOG"
exit "\${FAKE_QUEUE_EXIT:-0}"
`
const FAKE_FINISH = `import os, sys, time
open(os.environ["FAKE_LOG"], "a").write("finish " + " ".join(sys.argv[1:]) + "\\n")
pid = sys.argv[sys.argv.index("--pid-file") + 1]
open(pid, "w").write(str(os.getpid()))
time.sleep(float(os.environ.get("FAKE_FINISH_SLEEP", "0")))
`

type Json = Record<string, unknown>
type Ctx = {
  tmp: string
  logs: string
  logFile: string
  env: NodeJS.ProcessEnv
  wrap: (args: string[], env?: Record<string, string>, opts?: { logDir?: boolean }) => Promise<Done>
  lines: (prefix: string, count?: number) => Promise<string[]>
  finishes: (count: number) => Promise<Record<string, string>>
  writeConfig: (body: Json) => void
  writeBoard: (items: unknown[], name?: string) => void
  reset: () => void
}

function setup(t: TestContext): Ctx {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'merge-with-finish-')))
  // 백그라운드로 띄운 가짜 마무리가 지우는 사이에 pid 파일을 쓸 수 있어 ENOTEMPTY 면 다시 지운다
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  writeFileSync(join(tmp, 'queue.sh'), FAKE_QUEUE_SH)
  writeFileSync(join(tmp, 'finish.py'), FAKE_FINISH)
  const logFile = join(tmp, 'log.txt')
  const logs = join(tmp, 'logs')
  const env: NodeJS.ProcessEnv = { ...process.env, MERGE_QUEUE: join(tmp, 'queue.sh'), FINISH_PR: join(tmp, 'finish.py'), FAKE_LOG: logFile }
  // 설정과 핸들러는 --repo 의 .orch 에 둔다. 바깥 환경의 ORCH_DIR 이 그 위치를 바꾸지 않게 한다
  delete env.ORCH_DIR
  const read = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter((line) => line) : [])
  // 마무리는 백그라운드로 돌아 명령이 끝난 뒤에 적을 수 있다. count 줄이 모이거나 5초가 지날 때까지 다시 본다
  const lines = async (prefix: string, count = 1) => {
    const deadline = Date.now() + 5000
    let found = read().filter((line) => line.startsWith(prefix))
    while (found.length < count && Date.now() < deadline) {
      await sleep(50)
      found = read().filter((line) => line.startsWith(prefix))
    }
    return found
  }
  return {
    tmp,
    logs,
    logFile,
    env,
    wrap: (args, extra = {}, opts = {}) =>
      spawnDone([...NODE, ...(opts.logDir === false ? [] : ['--finish-log-dir', logs]), ...args], { cwd: tmp, env: { ...env, ...extra } }),
    lines,
    finishes: async (count) => Object.fromEntries((await lines('finish ', count)).map((line) => [line.split(' ')[1], line])),
    writeConfig: (body) => {
      mkdirSync(join(tmp, '.orch'), { recursive: true })
      writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify(body))
    },
    writeBoard: (items, name = '.omc/board.json') => {
      const target = join(tmp, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify({ items }))
    },
    reset: () => {
      rmSync(logFile, { force: true })
      rmSync(logs, { recursive: true, force: true })
    },
  }
}

function both(r: Done): string {
  return `종료 코드 ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`
}

function has(text: string, part: string, detail = text): void {
  assert.ok(text.includes(part), `${JSON.stringify(part)} 가 없다:\n${detail}`)
}

function lacks(text: string, part: string, detail = text): void {
  assert.ok(!text.includes(part), `${JSON.stringify(part)} 가 있으면 안 된다:\n${detail}`)
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

function hook(tmp: string, event: string, body = 'process.exit(0)\n'): void {
  mkdirSync(join(tmp, '.orch', 'hooks'), { recursive: true })
  writeFileSync(join(tmp, '.orch', 'hooks', `${event}.ts`), body)
}

describe('merge-with-finish PR 인자 해석', { skip: !HAS_BASH && 'bash 가 필요하다', concurrency: 4 }, () => {
  test('PR, PR!, PR:명령, PR!:명령 을 나눠 머지 큐에는 ! 를 뗀 인자를, 마무리에는 --complete 를 넘긴다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--no-sweep', '449', '450!', '102:./bin/backup.sh a:b', '446!:./backup.sh "pre-446"'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(await c.lines('queue'), [
      'queue --last-of-task 450 --last-of-task 446 --no-sweep 449 450 102:./bin/backup.sh a:b 446:./backup.sh "pre-446"',
    ])
    const by = await c.finishes(4)
    assert.deepEqual(Object.keys(by).sort(), ['102', '446', '449', '450'])
    lacks(by['449'], '--complete')
    has(by['450'], '--complete')
    lacks(by['102'], '--complete')
    has(by['446'], '--complete')
  })

  test('~ 는 마무리에 --intermediate 를 넘기고, 표시가 없으면 둘 다 넘기지 않아 마무리가 판정한다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--no-sweep', '449', '450~', '451~:./backup.sh', '452!'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(await c.lines('queue'), ['queue --last-of-task 452 --no-sweep 449 450 451:./backup.sh 452'])
    const by = await c.finishes(4)
    for (const flag of ['--complete', '--intermediate']) lacks(by['449'], flag)
    has(by['450'], '--intermediate')
    lacks(by['450'], '--complete')
    has(by['451'], '--intermediate')
    has(by['452'], '--complete')
    lacks(by['452'], '--intermediate')
    has(r.stdout, `마무리 시작: PR 449 (마지막 PR 인지는 배포 뒤 판정) -> ${c.logs}/finish-449.out`)
    has(r.stdout, `마무리 시작: PR 450 (중간 PR) -> ${c.logs}/finish-450.out`)
  })

  test('PR 번호가 아닌 인자는 사용법 오류이고 아무것도 걸지 않는다', async (t) => {
    const c = setup(t)
    for (const arg of ['abc', '12a', '!449', '449!!', '449!~', '449~!', '449~~', '']) {
      const r = await c.wrap([arg])
      assert.equal(r.code, 2, `${JSON.stringify(arg)}: ${both(r)}`)
      has(r.stderr, 'PR 번호가 아니다')
    }
    assert.equal(existsSync(c.logFile), false)
  })

  test('래퍼 옵션과 머지 큐 옵션을 가른다', async (t) => {
    const c = setup(t)
    const r = await c.wrap([
      '--repo',
      c.tmp,
      '--check-timeout',
      '30',
      '--finish-arg=--run',
      '--finish-arg',
      'run_1',
      '--require-up-to-date',
      '--finish-config',
      '/nowhere/c.json',
      '101',
      '102!',
    ])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(await c.lines('queue'), [`queue --last-of-task 102 --sweep-arg --run --sweep-arg run_1 --repo ${c.tmp} --check-timeout 30 --require-up-to-date 101 102`])
    const by = await c.finishes(2)
    for (const n of ['101', '102']) {
      has(by[n], `--repo ${c.tmp}`)
      has(by[n], `--pid-file ${c.logs}/finish-${n}.pid`)
      has(by[n], '--config /nowhere/c.json')
      has(by[n], '--run run_1')
    }
  })

  test('449! 면 머지 큐가 --last-of-task 449 와 449 를 받는다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--no-finish', '--no-sweep', '449!'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(await c.lines('queue'), ['queue --last-of-task 449 --no-sweep 449'])
  })

  test('값을 받는 머지 큐 옵션의 숫자 값은 PR 로 읽지 않고 그대로 넘긴다', async (t) => {
    const c = setup(t)
    for (const option of QUEUE_VALUE_OPTIONS) {
      c.reset()
      const r = await c.wrap(['--no-finish', '--no-sweep', option, '5', '7'])
      assert.equal(r.code, 0, `${option}: ${both(r)}`)
      assert.deepEqual(await c.lines('queue'), [`queue --no-sweep ${option} 5 7`], option)
    }
  })

  test('래퍼 옵션의 값이 없거나 형식이 틀리면 사용법 오류다', async (t) => {
    const c = setup(t)
    for (const argv of [['--repo'], ['--finish-arg'], ['--board-item', 'x'], ['--board-item', '5='], ['--board-item'], ['--run'], ['--run=', '449']]) {
      const r = await c.wrap(argv)
      assert.equal(r.code, 2, `${argv.join(' ')}: ${both(r)}`)
    }
    assert.equal(existsSync(c.logFile), false)
  })

  test('PR 이 없으면 사용법을 찍고 2 로 끝난다', async (t) => {
    const c = setup(t)
    const r = await c.wrap([])
    assert.equal(r.code, 2, both(r))
    has(r.stdout, '사용법:')
    assert.equal(existsSync(c.logFile), false)
  })
})

describe('merge-with-finish 마무리', { skip: !HAS_BASH && 'bash 가 필요하다', concurrency: 4 }, () => {
  test('PR 마다 마무리를 걸고 출력 파일을 알린다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--repo', c.tmp, '--required', 'ci', '449!', '450'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(await c.lines('queue'), [`queue --last-of-task 449 --repo ${c.tmp} --required ci 449 450`])
    const by = await c.finishes(2)
    has(by['449'], '--complete')
    lacks(by['450'], '--complete')
    has(by['449'], `--repo ${c.tmp}`)
    has(by['449'], `--pid-file ${c.logs}/finish-449.pid`)
    has(r.stdout, `마무리 시작: PR 449 (업무의 마지막 PR) -> ${c.logs}/finish-449.out`)
  })

  test('--board-item 은 그 PR 의 마무리에만 넘어간다', async (t) => {
    const c = setup(t)
    await c.wrap(['--board-item', '449=item-1', '--board-item=450=item-2', '449', '450', '451'])
    const by = await c.finishes(3)
    has(by['449'], '--board-id item-1')
    has(by['450'], '--board-id item-2')
    lacks(by['451'], '--board-id')
  })

  test('돌고 있는 마무리는 다시 걸지 않는다', async (t) => {
    const c = setup(t)
    await c.wrap(['449'], { FAKE_FINISH_SLEEP: '30' })
    assert.equal((await c.lines('finish ')).length, 1)
    const pidFile = join(c.logs, 'finish-449.pid')
    const deadline = Date.now() + 5000
    while (!existsSync(pidFile) && Date.now() < deadline) await sleep(50)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try {
      const r = await c.wrap(['449'])
      assert.equal(r.code, 0, both(r))
      has(r.stdout, '이미 돌고 있다')
      await sleep(300)
      assert.equal((await c.lines('finish ')).length, 1)
    } finally {
      process.kill(pid, 'SIGTERM')
    }
  })

  test('신호를 보낼 권한이 없는(EPERM) pid 의 마무리는 살아 있는 것으로 보고 다시 걸지 않는다', async (t) => {
    const c = setup(t)
    mkdirSync(c.logs)
    // pid 1 은 늘 살아 있고, root 가 아니면 신호를 보낼 권한이 없어 EPERM 이다. root 면 신호가 닿아 살아 있다
    writeFileSync(join(c.logs, 'finish-449.pid'), '1')
    const r = await c.wrap(['449'])
    assert.equal(r.code, 0, both(r))
    has(r.stdout, '마무리는 이미 돌고 있다: PR 449')
    await sleep(300)
    assert.deepEqual(await c.lines('finish ', 0), [])
  })

  test('죽은 pid 가 든 pid 파일은 새 마무리를 막지 않는다', async (t) => {
    const c = setup(t)
    mkdirSync(c.logs)
    writeFileSync(join(c.logs, 'finish-449.pid'), '999999')
    await c.wrap(['449'])
    assert.equal((await c.lines('finish ')).length, 1)
  })

  test('--no-finish 는 머지 큐만 돌린다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--no-finish', '449!'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(await c.lines('queue'), ['queue --last-of-task 449 449'])
    await sleep(300)
    assert.deepEqual(readFileSync(c.logFile, 'utf8').split('\n').filter((line) => line), ['queue --last-of-task 449 449'])
  })

  test('머지 큐의 종료 코드로 끝난다', async (t) => {
    const c = setup(t)
    assert.equal((await c.wrap(['449'], { FAKE_QUEUE_EXIT: '1' })).code, 1)
  })

  test('마무리 스크립트가 없거나 띄우지 못하면 마무리 시작 줄 없이 머지 큐를 걸지 않고 1 로 끝난다', async (t) => {
    const c = setup(t)
    const missing = join(c.tmp, 'no-such-finish.py')
    let r = await c.wrap(['449'], { FINISH_PR: missing })
    assert.equal(r.code, 1, both(r))
    has(r.stderr, `마무리를 띄우지 못했다: PR 449: 마무리 스크립트가 없다: ${missing}`)
    lacks(r.stdout, '마무리 시작')
    // 인터프리터(python3)를 PATH 에서 찾지 못하면 띄우기가 실패한다. 스크립트 파일은 있다
    r = await c.wrap(['449'], { PATH: join(c.tmp, 'empty-path') })
    assert.equal(r.code, 1, both(r))
    has(r.stderr, '마무리를 띄우지 못했다: PR 449: python3 를 실행하지 못했다')
    lacks(r.stdout, '마무리 시작')
    await sleep(300)
    assert.equal(existsSync(c.logFile), false, '머지 큐도 마무리도 돌면 안 된다')
  })
})

describe('merge-with-finish MERGE_QUEUE 인터프리터', { skip: !HAS_BASH && 'bash 가 필요하다', concurrency: 4 }, () => {
  test('MERGE_QUEUE 는 .ts 를 node, .py 를 python3, 그 밖을 bash 로 띄운다', async (t) => {
    const c = setup(t)
    // 각 가짜는 자기 언어로만 읽히는 문법으로 FAKE_LOG 에 적는다. 다른 인터프리터로 띄우면 문법 오류로 적지 못한다
    const ts = join(c.tmp, 'queue.ts')
    writeFileSync(ts, "import { appendFileSync } from 'node:fs'\nconst who: string = 'ts'\nappendFileSync(process.env.FAKE_LOG as string, `queue ${who} ${process.argv.slice(2).join(' ')}\\n`)\n")
    const py = join(c.tmp, 'queue.py')
    writeFileSync(py, 'import os, sys\nopen(os.environ["FAKE_LOG"], "a").write("queue py " + " ".join(sys.argv[1:]) + "\\n")\n')
    const sh = join(c.tmp, 'queue-old')
    writeFileSync(sh, 'echo "queue sh $*" >> "$FAKE_LOG"\n')
    for (const [script, label] of [
      [ts, 'ts'],
      [py, 'py'],
      [sh, 'sh'],
    ]) {
      c.reset()
      const r = await c.wrap(['--no-finish', '449'], { MERGE_QUEUE: script })
      assert.equal(r.code, 0, `${script}\n${both(r)}`)
      assert.deepEqual(await c.lines('queue'), [`queue ${label} 449`], script)
    }
  })
})

describe('merge-with-finish queue 절', { skip: !HAS_BASH && 'bash 가 필요하다', concurrency: 4 }, () => {
  test('queue 절이 명령줄에 없는 머지 큐 옵션을 채운다', async (t) => {
    const c = setup(t)
    c.writeConfig({
      finish: {},
      queue: { required: ['ci', 'lint'], verify_merged_when: 'code', docs_glob: ['docs/*', '*.md'], method: 'squash' },
    })
    const r = await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    assert.equal(r.code, 0, both(r))
    const [line] = await c.lines('queue')
    for (const part of ['--required-check ci --required-check lint', '--verify-merged-when code', '--docs-glob docs/*,*.md', '--method squash']) {
      has(line, part)
    }
    assert.ok(line.endsWith(`--repo ${c.tmp} 449`), line)
  })

  test('참거짓 키', async (t) => {
    const c = setup(t)
    c.writeConfig({ queue: { skipped_is_missing: true } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    let [line] = await c.lines('queue')
    has(line, '--skipped-is-missing')
    c.reset()
    c.writeConfig({ queue: { skipped_is_missing: false } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    ;[line] = await c.lines('queue')
    lacks(line, '--skipped-is-missing')
  })

  test('명령줄이 queue 절보다 우선한다', async (t) => {
    const c = setup(t)
    c.writeConfig({ queue: { required: 'ci', method: 'squash' } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '--method', 'merge', '449'])
    const [line] = await c.lines('queue')
    has(line, '--required ci')
    lacks(line, 'squash')
  })

  test('update_docs_on_overlap 를 켜고 끈다', async (t) => {
    const c = setup(t)
    c.writeConfig({ queue: { required: 'ci', docs_glob: ['docs/*', '*.md'], update_docs_on_overlap: true } })
    const r = await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    assert.equal(r.code, 0, both(r))
    has((await c.lines('queue'))[0], '--update-docs-on-overlap')
    c.reset()
    c.writeConfig({ queue: { update_docs_on_overlap: false } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    lacks((await c.lines('queue'))[0], '--update-docs-on-overlap')
  })

  test('겹침 판정 옵션을 넘긴다', async (t) => {
    const c = setup(t)
    c.writeConfig({ queue: { require_up_to_date: true, up_to_date_when: 'overlap', unit_prefix: 'apps/', shared_paths: ['^apps/common/', '^build\\.gradle$'], required: 'ci' } })
    const r = await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    assert.equal(r.code, 0, both(r))
    let [line] = await c.lines('queue')
    for (const part of ['--require-up-to-date', '--up-to-date-when overlap', '--unit-prefix apps/', '--shared-paths ^apps/common/|^build\\.gradle$']) has(line, part)
    c.reset()
    c.writeConfig({ queue: { shared_paths: '^lib/', require_up_to_date: false } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    ;[line] = await c.lines('queue')
    has(line, '--shared-paths ^lib/')
    lacks(line, '--require-up-to-date')
  })

  test('unit_groups 는 묶음마다 --unit-group 이 되고 명령줄의 --unit-group 이 대신한다', async (t) => {
    const c = setup(t)
    c.writeConfig({ queue: { unit_groups: [['web', 'bff'], ['a', 'b', 'c']] } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    has((await c.lines('queue'))[0], '--unit-group web,bff --unit-group a,b,c')
    c.reset()
    await c.wrap(['--repo', c.tmp, '--no-finish', '--unit-group', 'x,y', '449'])
    const [line] = await c.lines('queue')
    has(line, '--unit-group x,y')
    lacks(line, 'web')
  })

  test('명령줄 겹침 옵션이 queue 절보다 우선한다', async (t) => {
    const c = setup(t)
    c.writeConfig({ queue: { up_to_date_when: 'overlap', unit_prefix: 'apps/' } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '--up-to-date-when', 'always', '449'])
    const [line] = await c.lines('queue')
    has(line, '--up-to-date-when always')
    lacks(line, 'overlap')
    has(line, '--unit-prefix apps/')
  })

  test('sweep_args 는 항목마다 --sweep-arg 가 되고 명령줄의 --sweep-arg 가 대신한다', async (t) => {
    const c = setup(t)
    c.writeConfig({ queue: { sweep_args: ['--run', 'run_x', '--specs-dir', '.orch/specs'] } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    has((await c.lines('queue'))[0], '--sweep-arg --run --sweep-arg run_x --sweep-arg --specs-dir --sweep-arg .orch/specs')
    c.reset()
    c.writeConfig({ queue: { sweep_args: ['--run', 'run_x'] } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '--sweep-arg', '--kill-holders', '449'])
    const [line] = await c.lines('queue')
    has(line, '--sweep-arg --kill-holders')
    lacks(line, 'run_x')
  })

  test('queue 절의 값이 틀리면 아무것도 걸기 전에 사용법 오류다', async (t) => {
    const c = setup(t)
    const bad: unknown[] = [
      { sweep_args: '--run' },
      { sweep_args: [1] },
      { sweep_args: [''] },
      { up_to_date_when: '' },
      { shared_paths: [] },
      { require_up_to_date: 'yes' },
      { unit_groups: [] },
      { unit_groups: ['web,bff'] },
      { unit_groups: [['web']] },
      { unit_groups: [['a,b', 'c']] },
      { verify: 'x' },
      { method: 3 },
      { required: '' },
      [],
      { skipped_is_missing: 'yes' },
    ]
    for (const queue of bad) {
      c.writeConfig({ queue } as Json)
      const r = await c.wrap(['--repo', c.tmp, '449'])
      assert.equal(r.code, 2, `${JSON.stringify(queue)}: ${both(r)}`)
      assert.equal(existsSync(c.logFile), false, JSON.stringify(queue))
    }
  })

  test('--finish-config 가 읽을 파일을 정한다', async (t) => {
    const c = setup(t)
    const other = join(c.tmp, 'other.json')
    writeFileSync(other, JSON.stringify({ queue: { method: 'rebase' } }))
    c.writeConfig({ queue: { method: 'squash' } })
    await c.wrap(['--repo', c.tmp, '--no-finish', '--finish-config', other, '449'])
    has((await c.lines('queue'))[0], '--method rebase')
  })

  test('.omc 가 없는 저장소는 .orch/config.json 을 읽고 마무리 출력을 .orch/queue 에 둔다', async (t) => {
    const c = setup(t)
    const repo = join(c.tmp, 'repo')
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
    mkdirSync(join(repo, '.orch'))
    writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ queue: { required: ['ci'] } }))
    const r = await c.wrap(['--repo', repo, '449!'], {}, { logDir: false })
    assert.equal(r.code, 0, both(r))
    const [line] = await c.lines('queue')
    has(line, '--required-check ci')
    assert.equal(existsSync(join(repo, '.orch', 'queue', 'finish-449.out')), true)
    assert.ok(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('/.orch/'))
    assert.equal(existsSync(join(repo, '.omc')), false)
  })

  test('옛 구조가 남아 있으면 --finish-config 를 주지 않는 한 머지 큐를 걸지 않는다', async (t) => {
    const c = setup(t)
    mkdirSync(join(c.tmp, '.claude'))
    const old = join(c.tmp, '.claude', 'orch-finish.json')
    writeFileSync(old, JSON.stringify({ queue: { before: './backup.sh' } }))
    let r = await c.wrap(['--repo', c.tmp, '449'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'migrate-orch-dir.ts')
    assert.equal(existsSync(c.logFile), false)
    r = await c.wrap(['--repo', c.tmp, '--finish-config', old, '--no-finish', '449'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'queue.before')
    has(r.stderr, 'migrate-orch-dir')
  })

  test('삭제한 finish.complete_cmd 가 있으면 마무리도 머지 큐도 걸지 않고 2 로 끝난다', async (t) => {
    const c = setup(t)
    c.writeConfig({ finish: { complete_cmd: 'task-cli complete {number}', task_pattern: '(PROJ-[0-9]+)' } })
    const r = await c.wrap(['--repo', c.tmp, '449!'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'finish.complete_cmd')
    has(r.stderr, 'migrate-orch-dir')
    await sleep(300)
    assert.equal(existsSync(c.logFile), false)
    assert.equal(existsSync(c.logs), false)
  })

  test('--no-finish 이어도 삭제한 finish.complete_cmd 가 있으면 머지 큐를 걸지 않는다', async (t) => {
    const c = setup(t)
    hook(c.tmp, 'after-deploy')
    c.writeConfig({ finish: { complete_cmd: 'task-cli complete {number}', task_pattern: '(PROJ-[0-9]+)' } })
    const r = await c.wrap(['--repo', c.tmp, '--no-finish', '449!'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'finish.complete_cmd')
    has(r.stderr, 'migrate-orch-dir')
    await sleep(300)
    assert.deepEqual(await c.lines('finish ', 0), [])
  })

  test('hooks.timeouts.after-deploy 가 틀리면 마무리도 머지 큐도 걸지 않고 2 로 끝난다', async (t) => {
    const c = setup(t)
    hook(c.tmp, 'after-deploy')
    c.writeConfig({ hooks: { timeouts: { 'after-deploy': 'long' } } })
    const r = await c.wrap(['--repo', c.tmp, '449!'])
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'hooks.timeouts.after-deploy 는 양수(초)여야 한다')
    lacks(r.stdout, '마무리 시작')
    await sleep(300)
    assert.equal(existsSync(c.logFile), false, '머지 큐도 마무리도 돌면 안 된다')
  })

  test('삭제한 --complete-cmd 를 --finish-arg 로 넘기면 사용법 오류다', async (t) => {
    const c = setup(t)
    for (const given of [
      ['--finish-arg=--complete-cmd', '--finish-arg', 'task-cli complete {number}'],
      ['--finish-arg=--complete-cmd=task-cli complete {number}'],
    ]) {
      const r = await c.wrap(['--repo', c.tmp, ...given, '449!'])
      assert.equal(r.code, 2, `${given.join(' ')}\n${both(r)}`)
      has(r.stderr, '--complete-cmd')
    }
    await sleep(300)
    assert.equal(existsSync(c.logFile), false, '사용법 오류에서는 머지 큐도 마무리도 돌면 안 된다')
  })

  test('삭제한 큐 옵션은 마무리와 머지 큐를 시작하기 전에 거부한다', async (t) => {
    const c = setup(t)
    for (const option of ['--before', '--verify-merged', '--after-merged']) {
      const r = await c.wrap(['--repo', c.tmp, option, 'true', '449!'])
      assert.equal(r.code, 2, `${option}\n${both(r)}`)
      has(r.stderr, option)
      has(r.stderr, 'hooks/')
      lacks(r.stdout, '마무리 시작')
      assert.equal(existsSync(c.logFile), false, `${option}: 머지 큐나 마무리를 실행하면 안 된다`)
    }
  })
})

describe('merge-with-finish 보드 항목', { skip: !HAS_BASH && 'bash 가 필요하다', concurrency: 4 }, () => {
  test('보드 항목은 마무리가 찾으므로 --board-item 이 없으면 --board-id 를 넘기지 않는다', async (t) => {
    const c = setup(t)
    c.writeBoard([{ id: 'task-a', pr: '492' }])
    const r = await c.wrap(['--repo', c.tmp, '492!', '493'])
    assert.equal(r.code, 0, both(r))
    const by = await c.finishes(2)
    lacks(by['492'], '--board-id')
    lacks(by['493'], '--board-id')
  })

  test('--board-item 은 표시와 상관없이 그 PR 의 마무리에 --board-id 로 넘긴다', async (t) => {
    const c = setup(t)
    c.writeBoard([{ id: 'found', pr: '492' }])
    await c.wrap(['--repo', c.tmp, '--board-item', '492=explicit', '492', '493'])
    const by = await c.finishes(2)
    has(by['492'], '--board-id explicit')
    lacks(by['493'], '--board-id')
  })
})

describe('merge-with-finish --run', { skip: !HAS_BASH && 'bash 가 필요하다', concurrency: 4 }, () => {
  test('--run 은 마무리와 머지 큐의 정리 단계에 간다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--run', 'run_x', '--repo', c.tmp, '449'])
    assert.equal(r.code, 0, both(r))
    has((await c.lines('queue'))[0], '--sweep-arg --run --sweep-arg run_x')
    has((await c.finishes(1))['449'], '--run run_x')
    lacks(r.stderr, '정리 단계가 Run 으로 한정되지 않는다')
  })

  test('--run=값 도 같은 옵션이다', async (t) => {
    const c = setup(t)
    await c.wrap(['--run=run_z', '--no-finish', '449'])
    has((await c.lines('queue'))[0], '--sweep-arg --run --sweep-arg run_z')
  })

  test('정리 인자에 이미 --run 이 있으면 두 번 넘기지 않는다', async (t) => {
    const c = setup(t)
    await c.wrap(['--run', 'run_x', '--no-finish', '--sweep-arg', '--run', '--sweep-arg', 'run_x', '449'])
    const [line] = await c.lines('queue')
    assert.equal(count(line, '--sweep-arg --run'), 1, line)
    c.reset()
    c.writeConfig({ queue: { sweep_args: ['--run', 'run_x'] } })
    await c.wrap(['--run', 'run_x', '--no-finish', '449'])
    assert.equal(count((await c.lines('queue'))[0], '--sweep-arg --run'), 1)
  })

  test('--finish-arg 로만 준 --run 도 정리 단계에 간다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--finish-arg=--run', '--finish-arg', 'run_1', '--repo', c.tmp, '449'])
    assert.equal(r.code, 0, both(r))
    const [line] = await c.lines('queue')
    has(line, '--sweep-arg --run --sweep-arg run_1')
    assert.equal(count(line, '--sweep-arg --run'), 1)
    lacks(r.stderr, '정리 단계가 Run 으로 한정되지 않는다')
    assert.equal(count((await c.finishes(1))['449'], '--run run_1'), 1)
  })

  test('Run 이 없으면 머지 큐 인자는 그대로이고 경고 한 줄을 낸다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--repo', c.tmp, '--no-finish', '449'])
    assert.equal(r.code, 0, both(r))
    assert.deepEqual(await c.lines('queue'), [`queue --repo ${c.tmp} 449`])
    assert.equal(count(r.stderr, '경고: 정리 단계가 Run 으로 한정되지 않는다'), 1, both(r))
  })

  test('--no-sweep 이면 경고하지 않는다', async (t) => {
    const c = setup(t)
    const r = await c.wrap(['--no-sweep', '--no-finish', '449'])
    assert.equal(r.code, 0, both(r))
    lacks(r.stderr, '한정되지 않는다')
  })

  test('Run 값이 서로 다르면 사용법 오류다', async (t) => {
    const c = setup(t)
    for (const argv of [
      ['--run', 'a', '--finish-arg=--run', '--finish-arg', 'b', '449'],
      ['--run', 'a', '--sweep-arg', '--run', '--sweep-arg', 'b', '449'],
      ['--finish-arg=--run', '--finish-arg', 'a', '--sweep-arg', '--run', '--sweep-arg', 'b', '449'],
    ]) {
      const r = await c.wrap(['--repo', c.tmp, ...argv])
      assert.equal(r.code, 2, `${argv.join(' ')}: ${both(r)}`)
      assert.equal(existsSync(c.logFile), false)
    }
  })
})

// 진짜 merge_queue.ts 를 가짜 gh, git 으로 돌린다. 옛 칸이 머지 큐의 이벤트로 이어지는지 본다
describe('merge-with-finish 와 머지 큐 이벤트', { skip: !HAS_TOOLS && 'jq 와 bash 가 필요하다', concurrency: 4 }, () => {
  let bindir = ''
  before(() => {
    bindir = mkdtempSync(join(tmpdir(), 'merge-with-finish-bin-'))
    writeNodeBin(bindir, 'gh', FAKE_GH)
    writeNodeBin(bindir, 'git', FAKE_GIT)
  })
  after(() => rmSync(bindir, { recursive: true, force: true }))

  function realQueue(c: Ctx): NodeJS.ProcessEnv {
    const sweep = join(c.tmp, 'sweep.py')
    writeFileSync(sweep, 'pass\n')
    const pr = {
      state: 'OPEN',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      mergeable: 'MERGEABLE',
      url: 'https://git.example.com/owner/repo/pull/1',
      headRefName: 'feat',
      baseRefName: 'main',
      headRefOid: 'abc',
      isCrossRepository: false,
    }
    writeFileSync(join(c.tmp, 'state.json'), JSON.stringify({ '1': pr }))
    const env: NodeJS.ProcessEnv = {
      ...c.env,
      PATH: `${bindir}:${process.env.PATH}`,
      FAKE_STATE: join(c.tmp, 'state.json'),
      FAKE_REMOTE_HEAD: 'abc',
      MERGE_QUEUE_SLEEP_SCALE: '0',
      CLEANUP_SWEEP: sweep,
    }
    delete env.MERGE_QUEUE
    delete env.GH
    return env
  }

  test('삭제한 queue.before 가 있으면 2 로 끝나고 머지하지 않는다', async (t) => {
    const c = setup(t)
    const env = realQueue(c)
    c.writeConfig({ queue: { before: 'true' } })
    hook(c.tmp, 'before-merge')
    const r = await spawnDone([...NODE, '--repo', c.tmp, '--no-finish', '--threads-cmd', 'echo 0', '1'], { cwd: c.tmp, env })
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'queue.before')
    has(r.stderr, 'migrate-orch-dir')
    lacks(readFileSync(c.logFile, 'utf8'), 'pr merge')
  })

  test('삭제한 queue.after_merged 가 있으면 머지 큐를 걸지 않는다', async (t) => {
    const c = setup(t)
    const env = realQueue(c)
    const seen = join(c.tmp, 'after.txt')
    c.writeConfig({ queue: { after_merged: `echo "$MERGED_PRS" > ${seen}` } })
    const r = await spawnDone([...NODE, '--repo', c.tmp, '--no-finish', '--threads-cmd', 'echo 0', '1'], { cwd: c.tmp, env })
    assert.equal(r.code, 2, both(r))
    has(r.stderr, 'queue.after_merged')
    has(r.stderr, 'migrate-orch-dir')
    assert.equal(existsSync(seen), false)
    lacks(readFileSync(c.logFile, 'utf8'), 'pr merge 1')
  })
})
