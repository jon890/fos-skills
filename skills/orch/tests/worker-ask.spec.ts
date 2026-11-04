// worker-ask.ts 를 가짜 orca 로 본다. ask 의 성공, 시간 제한, 실패 뒤 대신 보내기, 결정 질문 형식 검사를 다룬다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/worker-ask.ts', import.meta.url))

// ask 는 n 번째 호출에 askN.out 이 있으면 그것을 내고 askN.rc(없으면 0)로 끝난다. 없으면 FAKE_ASK_SLEEP 초 잔 뒤 ask.out 을 내고 FAKE_ASK_RC 로 끝난다. check 는 n 번째 호출에 checkN.json, 없으면 check.json 을 낸다.
// 받은 인자는 [인자] 를 이어 한 줄로 기록한다. 여러 줄 인자는 로그에서 줄이 나뉜다.
const FAKE_ORCA = `#!/usr/bin/env bash
for a in "$@"; do printf '[%s]' "$a" >> "$FAKE_LOG"; done; echo >> "$FAKE_LOG"
case "$2" in
  ask)
    n=$(($(cat "$FAKE_DIR/ask-n" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_DIR/ask-n"
    if [ -f "$FAKE_DIR/ask$n.out" ]; then cat "$FAKE_DIR/ask$n.out"; echo; exit "$(cat "$FAKE_DIR/ask$n.rc" 2>/dev/null || echo 0)"; fi
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

describe('바로 돌아온 ask', () => {
  test('pending 과 질문 ID 만 내면 그 ID 로 --resume 해 답을 기다리고 질문을 다시 보내지 않는다', () => {
    fake('{"result":{"answer":"없어야 한다"}}', 0)
    writeFileSync(join(tmp, 'ask1.out'), '{"ok":true,"result":{"messageId":"msg_q","pending":true,"next":"End your turn"}}')
    writeFileSync(join(tmp, 'ask2.out'), '{"ok":true,"result":{"answer":"권장안으로 간다","messageId":"msg_q"}}')
    const r = ask('--from', 'term_w', '--question', '이대로 갈까')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(firstLine(r.stdout), 'answer: 권장안으로 간다')
    const asks = r.calls.filter((c) => c.includes('[ask]'))
    assert.equal(asks.length, 2)
    assert.ok(asks[0].includes('[--question][이대로 갈까]'), asks[0])
    assert.ok(asks[1].includes('[--resume][msg_q]') && !asks[1].includes('[--question]'), asks[1])
    assert.match(r.stderr, /질문 msg_q 를 보냈다/)
  })

  test('0 으로 끝났는데 답도 질문 ID 도 없으면 닿았는지 몰라 2 다', () => {
    fake('{"ok":true,"result":{}}', 0)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 2, r.stderr)
    assert.doesNotMatch(r.stdout, /^answer: /)
    assert.match(r.stderr, /답도 질문 ID 도 내지 않았다/)
  })

  test('orca 명령에 --full 을 붙인다', () => {
    fake('{"result":{"answer":"x","messageId":"m1"}}', 0)
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.ok(r.calls.every((c) => c.includes('[--full]')), r.calls.join('\n'))
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

  test('--resume 으로 재개할 때는 형식을 보지 않는다', () => {
    fake('{"result":{"answer":"재개한 답"}}', 0)
    const r = ask('--from', 'term_w', '--resume', 'm1', '--decision')
    assert.deepEqual([r.code, firstLine(r.stdout)], [0, 'answer: 재개한 답'])
    // 앞의 check 는 status 답을 가릴 기준이다. 재개해도 읽지 않은 메시지로 막지는 않는다
    assert.ok(r.calls[1].includes('[ask]') && r.calls[1].includes('[--resume][m1]'), r.calls[1])
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
  test('답이 없으면 4 로 끝나 재개할 ID 를 남긴다', () => {
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0)
    const r = ask('--from', 'term_w', '--question', 'q', '--timeout-ms', '1000')
    assert.deepEqual([r.code, r.calls.length], [4, 3])
    assert.match(r.stdout, /"messageId":"m1"/)
    assert.doesNotMatch(r.stdout, /answer:/)
  })

  test('그 질문 스레드의 status 답을 찾으면 3 이고 첫 줄이 그 본문이다', () => {
    const reply = message({ body: 'status 로 답한다: B', thread: 'm1', to: 'run:run_x' })
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, { checks: [inbox(), inbox(reply)] })
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, firstLine(r.stdout)], [3, 'answer: status 로 답한다: B'])
  })

  test('이 dispatch 로 온 status 도 답으로 본다', () => {
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, { checks: [inbox(), inbox(message({ body: 'dispatch 로 답한다' }))] })
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, firstLine(r.stdout)], [3, 'answer: dispatch 로 답한다'])
  })

  test('시간 초과 뒤에도 이 dispatch 로 왔지만 다른 질문 스레드인 status 는 답이 아니다', () => {
    const other = message({ body: '다른 질문의 답', thread: 'm9' })
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, { checks: [inbox(), inbox(other)] })
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 4, r.stderr)
  })

  test('다른 스레드와 다른 dispatch 의 status 는 답이 아니다', () => {
    const other = message({ body: '다른 질문의 답', thread: 'm9', to: 'dispatch:ctx_9' })
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, { checks: [inbox(), inbox(other)] })
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 4, r.stderr)
    assert.doesNotMatch(r.stdout, /answer:/)
  })

  test('ask 가 제한 시간 안에 끝나지 않아 끊으면 시간 초과 4 이고 대신 보내지 않는다', () => {
    fake('', 1)
    env.FAKE_ASK_SLEEP = '5'
    env.ORCH_ASK_SLACK_MS = '300'
    const r = ask('--from', 'term_w', '--question', 'q', '--timeout-ms', '1')
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /ask 가 301ms 안에 끝나지 않아 끊었다/)
    assert.ok(!r.calls.some((c) => c.includes('[send]')), r.calls.join('\n'))
    assert.doesNotMatch(r.stdout, /^answer:/m)
  })

  test('사용법 문구의 timeout 은 시간 초과가 아니다', () => {
    fake('Usage: ask [--timeout-ms <n>]', 1)
    assert.equal(ask('--from', 'term_w', '--question', 'q', '--run', 'run_y').code, 3)
  })
})

describe('기다리는 동안 status 답', () => {
  test('ask 를 기다리는 동안 이 dispatch 로 온 status 를 찾으면 ask 를 끊고 3 이다', () => {
    fake('{"result":{"answer":"늦은 답"}}', 0, { checks: [inbox(), inbox(message({ body: '기다리는 중에 status 로 답한다' }))] })
    env.FAKE_ASK_SLEEP = '20'
    env.ORCH_ASK_POLL_MS = '200'
    const started = Date.now()
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, firstLine(r.stdout)], [3, 'answer: 기다리는 중에 status 로 답한다'])
    assert.match(r.stderr, /ask 를 끊었다/)
    assert.ok(Date.now() - started < 10_000, `ask 를 끝까지 기다렸다: ${Date.now() - started}ms`)
  })

  test('ask 를 부르기 전에 있던 status 는 답으로 보지 않는다', () => {
    // 앞서 받은 지시가 ack 되지 않아 --peek 에 남아 있다. 한 번 보인 메시지라 묻기를 막지 않는다
    const old = inbox(message({ body: '앞서 받은 지시' }))
    fake('{"result":{"answer":"ask 의 답"}}', 0, { checks: [old, old, old, old, old, old] })
    writeFileSync(join(tmp, 'seen'), 'msg_c\n')
    env.FAKE_ASK_SLEEP = '1'
    env.ORCH_ASK_POLL_MS = '100'
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, firstLine(r.stdout)], [0, 'answer: ask 의 답'])
    assert.ok(r.calls.filter((c) => c.includes('[check]')).length >= 2, '기다리는 동안 check 를 다시 읽어야 한다')
  })

  test('--resume 으로 기다리는 동안 같은 dispatch 의 다른 질문 스레드로 온 status 는 답이 아니다', () => {
    const other = inbox(message({ body: '다른 질문 m9 의 답', thread: 'm9' }))
    fake('{"result":{"answer":"m1 의 답"}}', 0, { checks: [inbox(), other, other, other, other, other] })
    env.FAKE_ASK_SLEEP = '1'
    env.ORCH_ASK_POLL_MS = '100'
    const r = ask('--from', 'term_w', '--resume', 'm1')
    assert.deepEqual([r.code, firstLine(r.stdout)], [0, 'answer: m1 의 답'])
  })

  test('--resume 으로 기다리는 동안 그 질문 스레드로 온 status 는 답이다', () => {
    const mine = inbox(message({ body: 'm1 에 status 로 답한다', thread: 'm1', to: 'run:run_x' }))
    fake('{"result":{"answer":"늦은 답"}}', 0, { checks: [inbox(), mine] })
    env.FAKE_ASK_SLEEP = '20'
    env.ORCH_ASK_POLL_MS = '200'
    const r = ask('--from', 'term_w', '--resume', 'm1')
    assert.deepEqual([r.code, firstLine(r.stdout)], [3, 'answer: m1 에 status 로 답한다'])
  })

  test('다른 dispatch 로 간 status 로는 ask 를 끊지 않는다', () => {
    const other = inbox(message({ body: '다른 worker 의 답', to: 'dispatch:ctx_9' }))
    fake('{"result":{"answer":"ask 의 답"}}', 0, { checks: [inbox(), other, other, other, other, other] })
    env.FAKE_ASK_SLEEP = '1'
    env.ORCH_ASK_POLL_MS = '100'
    const r = ask('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, firstLine(r.stdout)], [0, 'answer: ask 의 답'])
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

  test('--resume 이 실패하면 대신 보내지 않고 2 다', () => {
    fake('unknown message', 1)
    const r = ask('--from', 'term_w', '--resume', 'm1')
    assert.deepEqual([r.code, r.calls.length], [2, 2])
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
  test('--question 과 --resume 이 모두 없으면 orca 를 부르지 않고 2 다', () => {
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


test('Orca 상한을 넘긴 timeout 은 줄여서 전달하고 이유를 알린다', () => {
  fake('{"result":{"answer":"ok"}}', 0)
  const r = ask('--from', 'w', '--question', 'q', '--timeout-ms', '3600000')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.calls.find((c) => c.includes('[ask]'))!, /\[--timeout-ms\]\[1800000\]/)
  assert.match(r.stderr, /Orca 상한/)
})

test('max-wait 는 같은 메시지 ID 로 재개하고 질문을 다시 보내지 않는다', () => {
  fake('{"result":{"timedOut":true,"messageId":"msg_first"}}', 0)
  writeFileSync(join(tmp, 'ask2.out'), '{"result":{"timedOut":true}}')
  writeFileSync(join(tmp, 'ask3.out'), '{"result":{"answer":"승인"}}')
  const r = ask('--from', 'w', '--question', 'q', '--max-wait', '10000')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(firstLine(r.stdout), 'answer: 승인')
  const asked = r.calls.filter((c) => c.includes('[ask]'))
  assert.equal(asked.length, 3)
  assert.match(asked[0], /\[--question\]\[q\]/)
  for (const call of asked.slice(1)) {
    assert.match(call, /\[--resume\]\[msg_first\]/)
    assert.doesNotMatch(call, /\[--question\]/)
  }
})

test('max-wait 가 끝나거나 메시지 ID 가 없으면 4 로 멈춘다', () => {
  fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0)
  env.FAKE_ASK_SLEEP = '0.03'
  let r = ask('--from', 'w', '--question', 'q', '--max-wait', '10')
  assert.equal(r.code, 4, r.stderr)
  assert.equal(r.calls.filter((c) => c.includes('[ask]')).length, 1)
  fake('{"result":{"timedOut":true}}', 0)
  r = ask('--from', 'w', '--question', 'q', '--max-wait', '1000')
  assert.equal(r.code, 4, r.stderr)
})

test('잘못된 대기 시간은 Orca 를 부르기 전에 거절한다', () => {
  fake('{}', 0)
  for (const option of ['--timeout-ms', '--max-wait']) {
    for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5']) {
      const r = ask('--from', 'w', '--question', 'q', option, value)
      assert.equal(r.code, 2, r.stderr)
      assert.deepEqual(r.calls, [])
    }
  }
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

  test('시간 초과는 재개할 질문 id 를 TIMEOUT 줄로 낸다', () => {
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0)
    const r = shortAsk('--from', 'term_w', '--question', 'q', '--timeout-ms', '1000')
    assert.deepEqual([r.code, r.stdout], [4, 'TIMEOUT m1\n'])
  })

  test('status 답도 answer: 한 줄이다', () => {
    const reply = message({ body: 'status 로 답한다: B', thread: 'm1', to: 'run:run_x' })
    fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, { checks: [inbox(), inbox(reply)] })
    const r = shortAsk('--from', 'term_w', '--question', 'q')
    assert.deepEqual([r.code, r.stdout], [3, 'answer: status 로 답한다: B\n'])
  })

  test('Run 메일함으로 대신 보내면 SENT-RUN 과 보낸 id 다', () => {
    fake('dispatch is not active', 1)
    const r = shortAsk('--from', 'term_w', '--question', 'q')
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stdout, /^SENT-RUN \S+\n$/)
  })
})
