// worker-ask.ts 를 가짜 orca 로 본다. ask 의 성공, 시간 제한, 실패 뒤 대신 보내기, 결정 질문 형식 검사를 다룬다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/worker-ask.ts', import.meta.url))

// ask 는 n 번째 호출에 askN.out 이 있으면 그것을 내고 askN.rc(없으면 0)로 끝난다. 없으면 FAKE_ASK_SLEEP 초 잔 뒤 ask.out 을 내고 FAKE_ASK_RC 로 끝난다. check 는 n 번째 호출에 checkN.json, 없으면 check.json 을 낸다.
// 받은 인자는 [인자] 를 이어 한 줄로 기록한다. 여러 줄 인자는 로그에서 줄이 나뉜다.
const FAKE_ORCA = `#!/usr/bin/env bash
for a in "$@"; do printf '[%s]' "$a" >> "$FAKE_LOG"; done; echo >> "$FAKE_LOG"
case "$2" in
  ask)
    n=$(($(cat "$FAKE_DIR/ask-n" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_DIR/ask-n"
    if [ -f "$FAKE_DIR/ask$n.out" ]; then cat "$FAKE_DIR/ask$n.out"; echo; exit "$(cat "$FAKE_DIR/ask$n.rc" 2>/dev/null || echo 0)"; fi
    [ -n "\${FAKE_IGNORE_TERM:-}" ] && trap '' TERM
    sleep "\${FAKE_ASK_SLEEP:-0}"; cat "$FAKE_DIR/ask.out"; echo; exit "$FAKE_ASK_RC" ;;
  check)
    n=$(($(cat "$FAKE_DIR/n" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_DIR/n"
    f="$FAKE_DIR/check$n.json"; [ -f "$f" ] || f="$FAKE_DIR/check.json"; cat "$f"; echo ;;
  send)
    if [ -n "\${FAKE_SEND_OUT+x}" ]; then echo "$FAKE_SEND_OUT"; else echo '{"ok":true,"result":{"message":{"id":"msg_sent"}}}'; fi
    echo "\${FAKE_SEND_STDERR:-}" >&2; exit "$FAKE_SEND_RC" ;;
esac
`

const DECISION = '결정: 저장 형식을 바꿀까요\n배경: 마이그레이션이 필요하다\n선택지:\n- 바꾼다: 빠르다\n- 둔다: 안전하다\n권장: 둔다. 사용자 데이터가 있다'

let binDir: string
let tmp: string
let log: string
let env: NodeJS.ProcessEnv

before(() => {
  binDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-ask-bin-')))
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA)
  chmodSync(join(binDir, 'orca'), 0o755)
})
after(() => rmSync(binDir, { recursive: true, force: true }))

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'worker-ask-')))
  log = join(tmp, 'calls.log')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

type Json = Record<string, unknown>

// checks 를 주면 n 번째 check 가 그 n 번째 출력을 낸다. 다 쓰면 checkOut 을 낸다.
function fake(askOut: string, askRc: number, opts: { checkOut?: string; sendRc?: number; checks?: Json[] } = {}): void {
  writeFileSync(join(tmp, 'check.json'), opts.checkOut ?? '{"result":{"runId":"run_x"}}')
  writeFileSync(join(tmp, 'ask.out'), askOut)
  opts.checks?.forEach((out, i) => writeFileSync(join(tmp, `check${i + 1}.json`), JSON.stringify(out)))
  env = {
    ...process.env,
    // shim 과 가짜 orca 가 이 테스트의 node 를 쓰게 한다
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ORCA: join(binDir, 'orca'),
    ORCH_ASK_SEEN: join(tmp, 'seen'),
    FAKE_DIR: tmp,
    FAKE_LOG: log,
    FAKE_ASK_RC: String(askRc),
    FAKE_SEND_RC: String(opts.sendRc ?? 0),
  }
}

function inbox(...messages: Json[]): Json {
  return { result: { runId: 'run_x', dispatchId: 'ctx_1', messages } }
}

function message(over: { type?: string; body?: string; who?: string; thread?: string | null; to?: string } = {}): Json {
  return {
    id: 'msg_c',
    type: over.type ?? 'status',
    subject: 's',
    body: over.body ?? '본문',
    from_handle: over.who ?? 'term_c',
    to_handle: over.to ?? 'dispatch:ctx_1',
    thread_id: over.thread ?? null,
    created_at: '2026-10-19T10:00:00Z',
  }
}

type Result = { code: number | null; stdout: string; stderr: string; calls: string[] }

function calls(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line) : []
}

function ask(...args: string[]): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env, encoding: 'utf8', timeout: 60_000 })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr, calls: calls() }
}

function firstLine(text: string): string {
  return text.split('\n')[0]
}

describe('묻고 답 받기', () => {
  test('답이 첫 줄 answer: 이고 그 뒤에 ask 출력이 온다', () => {
    fake('{"result":{"answer":"그렇게 한다","messageId":"m1"}}', 0)
    const r = ask('--from', 'term_w', '--question', '두 단어 질문', '--options', 'a,b')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(firstLine(r.stdout), 'answer: 그렇게 한다')
    assert.match(r.stdout, /"messageId":"m1"/)
    assert.ok(r.calls[0].includes('[check][--terminal][term_w][--peek]'), r.calls[0])
    assert.ok(r.calls[1].includes('[--question][두 단어 질문]'), r.calls[1])
    assert.ok(r.calls[1].includes('[--options][a,b]'), r.calls[1])
  })

  test('reply 객체의 body 를 답으로 읽는다', () => {
    fake('{"result":{"reply":{"body":"B 로 간다"}}}', 0)
    assert.equal(firstLine(ask('--from', 'term_w', '--question', 'q').stdout), 'answer: B 로 간다')
  })

  test('출력 앞뒤에 다른 줄이 섞여도 마지막 JSON 객체에서 답을 읽는다', () => {
    fake('경고 한 줄\n{"result":{"answer":"섞여도 읽는다"}}', 0)
    assert.equal(firstLine(ask('--from', 'term_w', '--question', 'q').stdout), 'answer: 섞여도 읽는다')
  })

  test('- 로 시작하는 질문도 본문으로 보낸다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const r = ask('--from', 'term_w', '--question', '-x 를 켤까')
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.calls[1].includes('[--question][-x 를 켤까]'), r.calls[1])
  })

  test('--decision 이 없는 짧은 질문은 형식 없이 묻는다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const r = ask('--from', 'term_w', '--question', '이 경로가 맞나')
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.calls[1].includes('[ask]'), r.calls[1])
  })
})

describe('질문만 보내고 끝나기', () => {
  const askCalls = (r: Result) => r.calls.filter((c) => c.includes('[ask]'))

  test('pending 과 질문 ID 를 내면 ASKED 와 0 이고 ask 를 한 번만 부른다', () => {
    fake('{"ok":true,"result":{"messageId":"msg_q","pending":true,"next":"End your turn"}}', 0)
    const r = ask('--from', 'term_w', '--question', '이대로 갈까')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(firstLine(r.stdout), 'ASKED msg_q')
    assert.match(r.stdout, /"pending":true/)
    assert.equal(askCalls(r).length, 1)
    assert.ok(askCalls(r)[0].includes('[--question][이대로 갈까]'), askCalls(r)[0])
    assert.ok(askCalls(r)[0].includes('[--timeout-ms][5000]'), askCalls(r)[0])
    assert.ok(!askCalls(r)[0].includes('[--wait]'), askCalls(r)[0])
    assert.match(r.stderr, /질문 msg_q 를 보냈다. 턴을 끝낸다/)
  })

  test('시간 초과여도 질문 ID 가 있으면 ASKED 와 0 이다', () => {
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, firstLine(r.stdout), askCalls(r).length], [0, 'ASKED m1', 1])
  })

  test('0 으로 끝났는데 답도 질문 ID 도 없으면 닿았는지 몰라 2 다', () => {
    fake('{"ok":true,"result":{}}', 0)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.doesNotMatch(r.stdout, /^answer: /)
    assert.match(r.stderr, /답도 질문 ID 도 내지 않았다/)
  })

  test('시간 초과인데 질문 ID 가 없으면 NO-ANSWER 와 2 이고 대신 보내지 않는다', () => {
    fake('{"result":{"timedOut":true}}', 0)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.ok(!r.calls.some((c) => c.includes('[send]')), r.calls.join('\n'))
    assert.match(r.stderr, /닿았는지 알 수 없다/)
  })

  test('orca 명령에 --full 을 붙인다', () => {
    fake('{"result":{"answer":"x","messageId":"m1"}}', 0)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.ok(r.calls.every((c) => c.includes('[--full]')), r.calls.join('\n'))
  })
})

describe('없어진 옵션', () => {
  test('--resume 은 orca 를 부르지 않고 안내 한 줄과 2 다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const r = ask('--from', 'term_w', '--resume', 'm1')
    assert.equal(r.code, 2, r.stderr)
    assert.deepEqual(r.calls, [])
    assert.deepEqual(r.stderr.trim().split('\n'), ['worker-ask: --resume 은 없어졌다. 질문을 보낸 뒤 턴을 끝내면 Orca 가 답과 함께 깨운다. 읽을 문서: 공통 지시서의 worker-ask 규칙'])
  })

  test('--timeout-ms 와 --max-wait 는 안내 한 줄만 내고 값과 상관없이 묻는다', () => {
    fake('{"result":{"messageId":"m1","pending":true}}', 0)
    for (const args of [['--timeout-ms', '600000', '--max-wait', '3600000'], ['--timeout-ms', 'abc'], ['--max-wait', '0']]) {
      const r = ask('--from', 'term_w', '--question', 'q', ...args)
      assert.deepEqual([r.code, firstLine(r.stdout)], [0, 'ASKED m1'])
      assert.match(r.stderr, /worker-ask: --timeout-ms, --max-wait 는 없어진 옵션이라 무시했다/)
      // 받은 값을 orca 에 넘기지 않는다
      assert.ok(r.calls.find((c) => c.includes('[ask]'))!.includes('[--timeout-ms][5000]'))
    }
  })
})

describe('결정 질문 형식', () => {
  test('형식을 따르면 본문 전체를 묻는다', () => {
    fake('{"result":{"answer":"둔다"}}', 0)
    const r = ask('--from', 'term_w', '--question', DECISION, '--decision')
    assert.deepEqual([r.code, firstLine(r.stdout)], [0, 'answer: 둔다'])
    // 로그는 줄 단위라 여러 줄 본문이 나뉜다. 이어 붙여 본문 전체가 ask 로 갔는지 본다
    assert.ok(r.calls.join('\n').includes(`[--question][${DECISION}]`), r.calls.join('\n'))
  })

  test('권장 줄이 없으면 묻지 않고 2 다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const r = ask('--from', 'term_w', '--question', DECISION.slice(0, DECISION.lastIndexOf('\n')), '--decision')
    assert.equal(r.code, 2, r.stderr)
    assert.ok(r.stderr.includes('`권장:` 줄이 정확히 하나여야 한다(지금 0개)'), r.stderr)
    assert.deepEqual(r.calls, [], '형식이 어긋난 질문은 orca 를 부르지 않는다')
  })

  test('결정: 뒤 제목이 비면 그 한 줄만 알리고 2 다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const r = ask('--from', 'term_w', '--question', DECISION.replace('결정: 저장 형식을 바꿀까요', '결정:   '), '--decision')
    assert.equal(r.code, 2, r.stderr)
    assert.deepEqual(r.stderr.trim().split('\n'), ['worker-ask: --decision 형식 위반: `결정:` 뒤에 무엇을 정하는지 제목이 있어야 한다'])
    assert.deepEqual(r.calls, [], '제목이 빈 질문은 orca 를 부르지 않는다')
  })

  test('어긋난 규칙을 모두 한 줄씩 알린다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const r = ask('--from', 'term_w', '--question', '배경: 첫 줄이 다르다\n- 하나\n권장: a\n권장: b', '--decision')
    assert.equal(r.code, 2, r.stderr)
    assert.deepEqual(r.stderr.trim().split('\n'), [
      'worker-ask: --decision 형식 위반: 첫 줄이 `결정:` 으로 시작해야 한다',
      'worker-ask: --decision 형식 위반: `- ` 로 시작하는 선택지 줄이 둘 이상이어야 한다(지금 1개)',
      'worker-ask: --decision 형식 위반: `권장:` 줄이 정확히 하나여야 한다(지금 2개)',
    ])
  })

  test('결정 블록 여러 개를 한 질문으로 보낸다', () => {
    fake('{"result":{"answer":"D1 둔다, D2 A"}}', 0)
    const body = `${DECISION}\n\n결정: 응답 형식\n선택지:\n- A: 짧다\n- B: 길다\n권장: A. 소비자가 하나다\n스펙 초안: docs/features/x/spec.md`
    const r = ask('--from', 'term_w', '--question', body, '--decision')
    assert.deepEqual([r.code, firstLine(r.stdout)], [0, 'answer: D1 둔다, D2 A'])
  })

  test('여러 블록이면 어긋난 블록 번호를 붙여 알린다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const body = `${DECISION}\n결정: 응답 형식\n- A: 짧다\n권장: A\n권장: B`
    const r = ask('--from', 'term_w', '--question', body, '--decision')
    assert.equal(r.code, 2, r.stderr)
    assert.deepEqual(r.stderr.trim().split('\n'), [
      'worker-ask: --decision 형식 위반: 결정 블록 2: `- ` 로 시작하는 선택지 줄이 둘 이상이어야 한다(지금 1개)',
      'worker-ask: --decision 형식 위반: 결정 블록 2: `권장:` 줄이 정확히 하나여야 한다(지금 2개)',
    ])
    assert.deepEqual(r.calls, [])
  })

})

describe('읽지 않은 메시지', () => {
  test('읽지 않은 코디네이터 메시지가 있으면 묻지 않고 5 다', () => {
    fake('{"result":{"answer":"x"}}', 0, { checks: [inbox(message({ body: '이미 정했다: A' }))] })
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stdout, /이미 정했다: A/)
    assert.ok(!r.calls.some((c) => c.includes('[ask]')))
  })

  test('한 번 보인 메시지로 다음 호출을 막지 않는다', () => {
    // worker 가 check 로 읽어도 ack 하지 않으면 --peek 에 남는다. 같은 메시지로 두 번 막지 않는다
    const unread = inbox(message({ body: '이미 정했다: A' }))
    fake('{"result":{"answer":"x"}}', 0, { checks: [unread, unread] })
    const first = ask('--from', 'term_w', '--question', 'q')
    const second = ask('--from', 'term_w', '--question', 'q')
    assert.deepEqual([first.code, second.code], [5, 0])
    assert.equal(firstLine(second.stdout), 'answer: x')
  })

  test('--force 면 읽지 않은 메시지가 있어도 묻는다', () => {
    fake('{"result":{"answer":"x"}}', 0, { checks: [inbox(message())] })
    const r = ask('--from', 'term_w', '--question', 'q', '--force')
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.calls[1].includes('[ask]'), r.calls[1])
  })

  test('자기 메시지와 heartbeat 는 묻기를 막지 않는다', () => {
    fake('{"result":{"answer":"x"}}', 0, { checks: [inbox(message({ who: 'term_w' }), message({ type: 'heartbeat' }))] })
    assert.equal(ask('--from', 'term_w', '--question', 'q').code, 0)
  })
})

describe('시간 제한', () => {
  test('ask 가 제한 시간 안에 끝나지 않아 끊으면 2 이고 대신 보내지 않는다', () => {
    fake('', 1)
    env.FAKE_ASK_SLEEP = '5'
    env.ORCH_ASK_SLACK_MS = '300'
    env.ORCH_ASK_RETURN_MS = '1'
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /ask 가 301ms 안에 끝나지 않아 끊었다/)
    assert.ok(!r.calls.some((c) => c.includes('[send]')), r.calls.join('\n'))
    assert.doesNotMatch(r.stdout, /^answer:/m)
  })

  test('TERM 을 무시하는 ask 도 제한 시간 뒤 강제로 끝내 2 로 돌아온다', () => {
    fake('', 1)
    env.FAKE_ASK_SLEEP = '30'
    env.FAKE_IGNORE_TERM = '1'
    env.ORCH_ASK_SLACK_MS = '300'
    env.ORCH_ASK_RETURN_MS = '1'
    env.ORCH_KILL_GRACE_SEC = '1'
    const started = Date.now()
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.ok(Date.now() - started < 20_000, `끝까지 기다렸다: ${Date.now() - started}ms`)
    assert.ok(!r.calls.some((c) => c.includes('[send]')), r.calls.join('\n'))
  })

  test('사용법 문구의 timeout 은 시간 초과가 아니다', () => {
    fake('Usage: ask [--timeout-ms <n>]', 1)
    assert.equal(ask('--from', 'term_w', '--question', 'q', '--run', 'run_y').code, 3)
  })
})

describe('ask 실패 뒤 대신 보내기', () => {
  test('Run 메일함으로 question 을 보내고 3 이다', () => {
    fake('dispatch is not active', 1)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 3, r.stderr)
    const last = r.calls.at(-1) ?? ''
    assert.ok(last.includes('[send]') && last.includes('[--to][run:run_x]') && last.includes('[--type][question]'), last)
  })

  test('대신 보내는 본문에 선택지를 붙인다', () => {
    fake('dispatch is not active', 1)
    const r = ask('--from', 'term_w', '--question', 'q', '--options', 'a,b')
    assert.equal(r.code, 3, r.stderr)
    // 여러 줄 본문은 로그에서 줄이 나뉘어 이어 붙여 본다
    const sent = r.calls.join('\n')
    assert.ok(sent.includes('[send]') && sent.includes('[--body][q\n선택지: a,b]'), sent)
  })

  test('--run 을 주면 Run 을 찾지 않는다', () => {
    fake('dispatch is not active', 1)
    const r = ask('--from', 'term_w', '--question', 'q', '--run', 'run_y')
    assert.equal(r.code, 3, r.stderr)
    // check 는 묻기 전의 읽지 않은 메시지 확인 한 번뿐이다
    assert.equal(r.calls.filter((c) => c.includes('[check]')).length, 1)
    assert.ok(r.calls.at(-1)?.includes('[--to][run:run_y]'), r.calls.at(-1))
  })

  test('Run 을 찾지 못하면 2 다', () => {
    fake('dispatch is not active', 1, { checkOut: '{"result":{}}' })
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /--run 으로 준다/)
    assert.ok(!r.calls.some((c) => c.includes('[send]')))
  })

  for (const [sendRc, expected] of [
    [0, 3],
    [1, 2],
  ]) {
    test(`대신 보내기의 종료 코드가 ${sendRc} 면 ${expected} 이고 send 의 stderr 를 남긴다`, () => {
      fake('dispatch is not active', 1, { sendRc })
      env.FAKE_SEND_STDERR = 'send diagnostic'
      const r = ask('--from', 'term_w', '--question', 'q')
      assert.equal(r.code, expected, r.stderr)
      assert.match(r.stderr, /send diagnostic/)
    })
  }

  test('대신 보낸 send 가 메시지 ID 를 내지 않으면 닿았는지 몰라 2 다', () => {
    fake('dispatch is not active', 1)
    env.FAKE_SEND_OUT = '{"ok":true,"result":{}}'
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /메시지 ID 를 내지 않았다/)
  })

  test('끝난 dispatch 코드(dispatch_inactive)로 실패하면 대신 보낸다', () => {
    fake('{"ok":false,"error":{"code":"dispatch_inactive","message":"Dispatch ctx_1 is completed"}}', 1)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 3, r.stderr)
    assert.ok(r.calls.at(-1)?.includes('[--to][run:run_x]'), r.calls.at(-1))
  })

  test('끝난 dispatch 가 아닌 코드로 실패하면 대신 보내지 않고 2 다', () => {
    fake('{"ok":false,"error":{"code":"invalid_argument","message":"bad"}}', 1)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /invalid_argument 로 실패했다/)
    assert.ok(!r.calls.some((c) => c.includes('[send]')))
  })

})

describe('바쁜 Orca', () => {
  const BUSY = '{"ok":false,"error":{"code":"runtime_busy","message":"Remote runtime subscription request capacity reached."}}'

  test('runtime_busy 면 기다렸다 같은 질문을 다시 묻고 메일함으로 보내지 않는다', () => {
    fake('{"result":{"answer":"됐다"}}', 0)
    writeFileSync(join(tmp, 'ask1.out'), BUSY)
    writeFileSync(join(tmp, 'ask1.rc'), '1')
    env.ORCH_ASK_BUSY_MS = '10'
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(firstLine(r.stdout), 'answer: 됐다')
    const asked = r.calls.filter((c) => c.includes('[ask]'))
    assert.equal(asked.length, 2)
    for (const call of asked) assert.match(call, /\[--question\]\[q\]/)
    assert.match(r.stderr, /바빠\(runtime_busy\)/)
    assert.ok(!r.calls.some((c) => c.includes('[send]')))
  })

  test('코드 없이 retry with backoff 만 있어도 바쁨으로 본다', () => {
    fake('{"result":{"answer":"됐다"}}', 0)
    writeFileSync(join(tmp, 'ask1.out'), 'error: capacity reached; retry with backoff')
    writeFileSync(join(tmp, 'ask1.rc'), '1')
    env.ORCH_ASK_BUSY_MS = '10'
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!r.calls.some((c) => c.includes('[send]')))
  })

  test('다시 불러도 계속 바쁘면 2 이고 메일함으로 보내지 않는다', () => {
    fake(BUSY, 1)
    env.ORCH_ASK_BUSY_MS = '1'
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    // 처음 한 번과 다시 부른 5 번
    assert.equal(r.calls.filter((c) => c.includes('[ask]')).length, 6)
    assert.match(r.stderr, /메일함으로 보내지 않는다/)
    assert.ok(!r.calls.some((c) => c.includes('[send]')))
  })
})

describe('사용법', () => {
  test('--question 이 없으면 orca 를 부르지 않고 2 다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    const r = ask('--from', 'term_w')
    assert.equal(r.code, 2, r.stderr)
    assert.deepEqual(r.calls, [])
  })

  test('--from 이 없거나 모르는 옵션이면 2 다', () => {
    fake('{"result":{"answer":"x"}}', 0)
    assert.equal(ask('--question', 'q').code, 2)
    assert.equal(ask('--from', 'term_w', '--question', 'q', '--bogus').code, 2)
  })
})


describe('짧은 출력', () => {
  // fake() 가 env 를 새로 만들므로 부르기 직전에 신호를 넣는다
  const shortAsk = (...args: string[]) => {
    env.ORCH_OUTPUT = 'short'
    return ask(...args)
  }

  test('답이 있으면 answer: 한 줄만 낸다', () => {
    fake('{"result":{"answer":"그렇게 한다","messageId":"m1"}}', 0)
    const r = shortAsk('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, r.stdout], [0, 'answer: 그렇게 한다\n'])
  })

  test('여러 줄 답은 모든 줄을 남기고 ask JSON 만 뺀다', () => {
    fake('{"result":{"answer":"첫 줄\\n둘째 줄","messageId":"m1"}}', 0)
    const r = shortAsk('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, r.stdout], [0, 'answer: 첫 줄\n둘째 줄\n'])
  })

  test('질문만 보내면 ASKED 한 줄만 낸다', () => {
    fake('{"result":{"messageId":"m1","pending":true}}', 0)
    const r = shortAsk('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, r.stdout], [0, 'ASKED m1\n'])
  })

  test('시간 초과에 질문 id 가 없으면 NO-ANSWER - 한 줄이다', () => {
    fake('{"result":{"timedOut":true}}', 0)
    const r = shortAsk('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, r.stdout], [2, 'NO-ANSWER -\n'])
  })

  test('Run 메일함으로 대신 보내면 SENT-RUN 과 보낸 id 다', () => {
    fake('dispatch is not active', 1)
    const r = shortAsk('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stdout, /^SENT-RUN \S+\n$/)
  })
})
