// triage-messages.ts 를 출력 파일과 가짜 orca 로 본다. Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { collect, parseObjects } from '../scripts/wait/triage-messages.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/wait/triage-messages.ts', import.meta.url))

type Json = Record<string, unknown>
type Result = { code: number | null; stdout: string; stderr: string }

let tmp: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'triage-')))
  env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
  delete env.ORCA
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function msg(id: string, kind: string, created = '2026-10-12T15:00:00Z', who = 'term_a', body = '본문'): Json {
  return { id, type: kind, subject: `s${id}`, body, payload: null, created_at: created, from_handle: who }
}

function file(text: string): string {
  const path = join(tmp, `out-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(path, text)
  return path
}

function batch(messages: Json[], delivery = 'd1'): string {
  return JSON.stringify({ ok: true, result: { deliveryId: delivery, messages } })
}

function triage(args: string[], input?: string): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env, input, encoding: 'utf8', timeout: 60_000 })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function json(args: string[]): { deliveries: string[]; groups: Record<string, Json[]>; heartbeats: Record<string, number> } {
  const r = triage([...args, '--json'])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout)
}

describe('분류', () => {
  test('턴만 끝낸 멈춤 보고는 dispatch 마다 개수만 내고, 실제로 멈춘 보고는 멈춘 worker 로 모은다', () => {
    const stop = (id: string, reason: string, subject: string) => ({
      ...msg(id, 'escalation'),
      subject,
      payload: JSON.stringify({ taskId: 't', dispatchId: 'ctx_a', stopReason: reason }),
    })
    const messages = [
      stop('msg_stop_1', 'finished', 'Worker stopped without reporting'),
      stop('msg_stop_2', 'finished', 'Worker stopped without reporting'),
      stop('msg_stop_3', 'exited', 'Worker exited without reporting'),
      msg('4', 'escalation'),
    ]
    const out = json([file(batch(messages)), '--completion-contract', 'none']) as ReturnType<typeof json> & { quiet_stops: Record<string, number> }
    assert.deepEqual(Object.keys(out.groups), ['stopped_worker', 'escalation'])
    assert.deepEqual(out.groups.stopped_worker.map((m) => m.id), ['msg_stop_3'])
    assert.deepEqual(out.quiet_stops, { ctx_a: 2 })
    const text = triage([file(batch(messages)), '--completion-contract', 'none']).stdout
    assert.match(text, /^== 멈춘 worker 1건$/m)
    assert.match(text, /^== 턴만 끝낸 멈춤 보고 2건\(기본 제외, --stop-reports 로 본문\) ctx_a=2$/m)
    const all = json([file(batch(messages)), '--completion-contract', 'none', '--stop-reports']) as ReturnType<typeof json> & { quiet_stops: Record<string, number> }
    assert.deepEqual(all.groups.stopped_worker.map((m) => m.id), ['msg_stop_1', 'msg_stop_2', 'msg_stop_3'])
    assert.deepEqual(all.quiet_stops, {})
  })

  test('읽기 전용 계약(none)은 PR 준비를 요구하지 않는다', () => {
    const out = json([file(batch([msg('1', 'worker_done')])), '--completion-contract', 'none'])
    assert.deepEqual(Object.keys(out.groups), ['worker_done'])
  })

  test('--since 보다 앞선 준비 상태도 완료 근거가 된다', () => {
    const ids = { task_id: 'task_a', dispatch_id: 'ctx_a' }
    const status = { ...msg('s', 'status', '2026-10-12T14:00:00Z'), ...ids, subject: `준비됨 #12, head ${'a'.repeat(40)}` }
    const done = { ...msg('d', 'worker_done', '2026-10-12T16:00:00Z'), ...ids }
    const out = json([file(batch([status, done])), '--since', '2026-10-12T15:00:00Z'])
    assert.deepEqual(Object.keys(out.groups), ['worker_done'])
  })

  test('keepalive 와 종료 코드 줄이 섞인 출력에서 결과 JSON 을 꺼낸다', () => {
    const text = '{"_keepalive":true}\n{"result":{"deliveryId":"d1","messages":[]}}\nexit code 0\n{"result":{}}'
    const out = json([file(text)])
    assert.deepEqual(out.deliveries, ['d1'])
    assert.deepEqual(out.groups, {})
    // keepalive 도 객체라 셋을 꺼낸다. result 가 있는 것만 delivery 가 된다
    const objects = parseObjects(text)
    assert.equal(objects.length, 3, JSON.stringify(objects))
    assert.deepEqual(collect(objects).deliveries, ['d1'])
  })

  test('우선 종류를 앞에 두고 heartbeat 는 보낸 쪽마다 센다', () => {
    const messages = [
      msg('1', 'heartbeat'),
      msg('2', 'status'),
      msg('3', 'worker_done'),
      msg('4', 'heartbeat', undefined, 'term_b'),
      msg('5', 'question'),
      msg('6', 'heartbeat'),
    ]
    const out = json([file(batch(messages))])
    assert.deepEqual(Object.keys(out.groups), ['suspicious_worker_done', 'question', 'status'])
    assert.deepEqual(out.heartbeats, { term_a: 2, term_b: 1 })
  })

  test('묶음이 겹쳐도 같은 id 는 한 번만 센다', () => {
    const one = batch([msg('1', 'worker_done')], 'd')
    const out = json([file(`${one}\n${one}`), '--completion-contract', 'none'])
    assert.equal(out.groups.worker_done.length, 1)
  })

  test('--since 는 그보다 오래된 메시지를 뺀다', () => {
    const out = json([file(batch([msg('1', 'worker_done', '2026-10-12T14:00:00Z'), msg('2', 'worker_done', '2026-10-12T16:00:00Z')])), '--since', '2026-10-12T15:00:00Z'])
    assert.deepEqual(
      out.groups.suspicious_worker_done.map((m) => m.id),
      ['2'],
    )
  })

  test('--since 는 지금부터 거스른 30m, 2h, 1d 를 받는다', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    const text = batch([msg('old', 'status', ago(2 * 3_600_000)), msg('new', 'status', ago(30 * 60_000)), msg('day', 'status', ago(2 * 86_400_000))])
    const path = file(text)
    assert.deepEqual(json([path, '--since', '90m']).groups.status.map((m) => m.id), ['new'])
    assert.deepEqual(json([path, '--since', '1d']).groups.status.map((m) => m.id), ['old', 'new'])
  })

  test('사람이 읽는 출력은 본문을 --width 에서 자른다', () => {
    const r = triage([file(batch([msg('1', 'escalation', undefined, undefined, '가'.repeat(20))])), '--width', '5'])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes(`${'가'.repeat(5)} …(잘림)`), r.stdout)
    assert.match(r.stdout, /^delivery d1$/m)
    assert.match(r.stdout, /^== escalation 1건$/m)
  })

  test('payload 줄은 옛 명령의 json.dumps 꼴로 앞 200자를 낸다', () => {
    const payload = { kind: '준비', list: [1, 'a'], long: 'x'.repeat(300) }
    const r = triage([file(batch([{ ...msg('1', 'status'), payload }]))])
    assert.equal(r.code, 0, r.stderr)
    const line = r.stdout.split('\n').find((l) => l.startsWith('  payload: ')) ?? ''
    const expected = `{"kind": "준비", "list": [1, "a"], "long": "${'x'.repeat(300)}"}`
    assert.equal(line, `  payload: ${Array.from(expected).slice(0, 200).join('')}`)
  })

  test('표준 입력을 - 로 읽는다', () => {
    const r = triage(['-'], batch([msg('1', 'question')]))
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^== question 1건$/m)
  })

  test('결과 JSON 이 없는 파일은 1 이다', () => {
    const r = triage([file('nothing here')])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /읽을 orca 결과 JSON 이 없다/)
  })

  test('FILE 과 --live 를 함께 주거나 둘 다 빼면 사용법 오류다', () => {
    assert.equal(triage([]).code, 2)
    assert.equal(triage([file('{}'), '--live']).code, 2)
    assert.equal(triage([file('{}'), '--since', 'yesterday']).code, 2)
  })
})

describe('--live', () => {
  test('ORCA 의 check --all 을 읽고 --run, --terminal 을 넘긴다', () => {
    const orca = fakeBin(tmp, 'orca', [{ args: ['--all'], stdout: batch([msg('1', 'question')]) }])
    env.ORCA = orca.path
    const r = triage(['--live', '--run', 'run_x', '--terminal', 'term_c'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^== question 1건$/m)
    assert.deepEqual(orca.calls()[0].argv, ['orchestration', 'check', '--all', '--json', '--run', 'run_x', '--terminal', 'term_c', '--full'])
  })

  test('orca 가 실패하면 그 출력을 stderr 로 내고 1 이다', () => {
    env.ORCA = fakeBin(tmp, 'orca', [{ stderr: 'runtime_unavailable', code: 1 }]).path
    const r = triage(['--live'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /runtime_unavailable/)
  })
})

describe('짧은 출력', () => {
  function shortRun(args: string[]): Result {
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: { ...env, ORCH_OUTPUT: 'short' }, encoding: 'utf8', timeout: 60_000 })
    return { code: done.status, stdout: done.stdout, stderr: done.stderr }
  }

  test('메시지마다 판정 줄을 우선 종류 차례로 내고 heartbeat 합과 delivery 로 끝난다', () => {
    const messages = [
      { ...msg('q', 'question'), task_id: 'tq', dispatch_id: 'cq' },
      msg('h1', 'heartbeat'),
      msg('h2', 'heartbeat', undefined, 'term_b'),
      { ...msg('e', 'escalation', undefined, 'term_e', ''), task_id: 'te', dispatch_id: 'ce' },
      { ...msg('w', 'worker_done', undefined, 'term_w', '끝냈다\n둘째 줄'), task_id: 'tw', dispatch_id: 'cw' },
      msg('s', 'status'),
    ]
    const r = shortRun([file(batch(messages)), '--completion-contract', 'none'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'DONE cw tw 끝냈다 둘째 줄',
      'ESCALATION ce te se',
      'QUESTION cq tq 본문',
      'STATUS - - 본문',
      'HEARTBEAT 2',
      'DELIVERY d1',
    ])
  })

  test('근거 없는 worker_done 은 DONE-SUSPECT 로 맨 앞이다', () => {
    const r = shortRun([file(batch([msg('q', 'question'), { ...msg('w', 'worker_done'), task_id: 't', dispatch_id: 'c' }]))])
    assert.equal(r.stdout.split('\n')[0], 'DONE-SUSPECT c t 본문')
  })

  test('읽을 메시지가 없으면 NO-MESSAGES 다', () => {
    const r = shortRun([file(JSON.stringify({ ok: true, result: { messages: [] } }))])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'NO-MESSAGES')
  })

  test('--json 과 신호 없는 실행은 지금 출력이다', () => {
    const input = file(batch([msg('q', 'question')]))
    assert.match(triage([input]).stdout, /== question 1건/)
    const r = shortRun([input, '--json'])
    assert.ok(JSON.parse(r.stdout).groups.question)
  })
})
