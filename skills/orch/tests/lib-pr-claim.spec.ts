// lib/pr-claim.ts: PR 하나의 실행권은 한 프로세스만 쥔다. 쥔 쪽이 죽으면 회수하고, 살아 있는지 읽지 못하면 회수하지 않는다.
// PR 558 리뷰에서 재현된 순서(동시 잡기, 확인 실패, 회수하다 죽은 상태, 늦은 회수)를 여기 고정한다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { peek, reclaimDead } from '../scripts/lib/owner-lock.ts'
import { claimFile, claimPrs, refusal, releaseByToken, releaseClaim, sweepClaims, takeClaim } from '../scripts/lib/pr-claim.ts'
import { identity } from '../scripts/lib/process.ts'

const HOLDER = fileURLToPath(new URL('./fixtures/claim-holder.ts', import.meta.url))

function dir(t: TestContext): string {
  const made = mkdtempSync(join(tmpdir(), 'pr-claim-'))
  t.after(() => rmSync(made, { recursive: true, force: true }))
  return made
}

type Held = { child: ChildProcess; result: { pid: number; kind: string; holder?: { pid: number; note: string } } }

// 다른 프로세스가 실행권을 잡으려 한 결과. 잡았으면 테스트가 끝날 때까지 쥔다
async function holder(t: TestContext, file: string, note = ''): Promise<Held> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOLDER, 'take', file, note], { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => child.kill('SIGKILL'))
  let text = ''
  for await (const chunk of child.stdout!) {
    text += chunk
    if (text.includes('\n')) break
  }
  return { child, result: JSON.parse(text) }
}

async function killed(child: ChildProcess): Promise<void> {
  child.kill('SIGKILL')
  await once(child, 'exit')
}

function plant(file: string, owner: unknown): void {
  mkdirSync(file, { recursive: true })
  writeFileSync(join(file, 'owner'), typeof owner === 'string' ? owner : JSON.stringify(owner))
}

test('잡고 놓으면 실행권이 없어지고 묘비만 남는다. 같은 token 으로 다시 잡으면 이미 내 것이다', (t) => {
  const base = dir(t)
  const file = join(base, 'pr-claims', 'queue-1')
  const taken = takeClaim(file, { note: 'queue merge run=run_1', token: 'tok' })
  assert.equal(taken.kind, 'taken')
  const owner = JSON.parse(readFileSync(join(file, 'owner'), 'utf8'))
  assert.equal(owner.pid, process.pid)
  assert.equal(owner.identity, identity(process.pid))
  assert.equal(owner.note, 'queue merge run=run_1')
  assert.equal(takeClaim(file, { token: 'tok' }).kind, 'mine')
  assert.equal(takeClaim(file, { inherit: 'tok' }).kind, 'mine')
  if (taken.kind === 'taken') releaseClaim(taken.claim)
  assert.equal(existsSync(file), false)
  assert.deepEqual(readdirSync(join(base, 'pr-claims')).filter((name) => !/^queue-1\.dead-/.test(name)), [])
})

test('여러 프로세스가 같은 PR 을 동시에 잡으려 하면 하나만 잡고 나머지는 쥔 쪽을 알려 준다', async (t) => {
  const file = join(dir(t), 'pr-claims', 'queue-7')
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => holder(t, file, `n${i}`)))
  const winners = all.filter((one) => one.result.kind === 'taken')
  assert.equal(winners.length, 1, JSON.stringify(all.map((one) => one.result)))
  for (const one of all) {
    if (one === winners[0]) continue
    assert.equal(one.result.kind, 'held')
    assert.equal(one.result.holder?.pid, winners[0].result.pid)
  }
})

test('쥔 프로세스가 죽으면 다음 호출이 회수한다. 살아 있으면 잡지 못한다', async (t) => {
  const file = join(dir(t), 'pr-claims', 'queue-1')
  const first = await holder(t, file, 'queue merge run=run_a')
  assert.equal(first.result.kind, 'taken')
  const blocked = takeClaim(file)
  assert.equal(blocked.kind, 'held')
  if (blocked.kind === 'held') assert.deepEqual([blocked.holder.pid, blocked.holder.note], [first.result.pid, 'queue merge run=run_a'])
  await killed(first.child)
  assert.equal(takeClaim(file).kind, 'taken')
})

test('pid 가 다른 프로세스에 다시 쓰였거나 owner 가 깨진 실행권은 죽은 것으로 보고 회수한다', (t) => {
  const base = dir(t)
  plant(join(base, 'reused'), { pid: process.pid, identity: 'Mon Jan  1 00:00:00 2001 other-command', token: 'old', at: '', note: '' })
  plant(join(base, 'broken'), '{')
  mkdirSync(join(base, 'empty'))
  for (const name of ['reused', 'broken', 'empty']) assert.equal(takeClaim(join(base, name)).kind, 'taken', name)
})

// 리뷰의 순서: ps 가 잠깐 실패하면 쥔 쪽이 있는지 모르는 채로 큐를 걸었다
test('쥔 쪽이 살아 있는지 읽지 못하면 회수하지 않고 unknown 을 낸다', async (t) => {
  const base = dir(t)
  const file = join(base, 'pr-claims', 'queue-1')
  const first = await holder(t, file)
  const ps = join(base, 'ps')
  writeFileSync(ps, '#!/bin/sh\nfor a in "$@"; do [ "$a" = "$FAIL_PID" ] && exit 1; done\nexec ps "$@"\n')
  chmodSync(ps, 0o755)
  const before = process.env.PS
  t.after(() => {
    if (before === undefined) delete process.env.PS
    else process.env.PS = before
    delete process.env.FAIL_PID
  })
  process.env.PS = ps
  process.env.FAIL_PID = String(first.result.pid)
  const owner = readFileSync(join(file, 'owner'), 'utf8')
  assert.equal(takeClaim(file).kind, 'unknown')
  assert.equal(readFileSync(join(file, 'owner'), 'utf8'), owner)
  const refused = refusal({ kind: 'unknown', reason: 'x' })
  assert.equal(refused.code, 1)
  assert.match(refused.lines[0], /^QUEUE-CLAIM-FAIL /)
  // 내 정보를 읽지 못해도 잡지 않는다
  process.env.FAIL_PID = String(process.pid)
  assert.equal(takeClaim(join(base, 'pr-claims', 'queue-2')).kind, 'unknown')
  assert.equal(existsSync(join(base, 'pr-claims', 'queue-2')), false)
})

// 리뷰의 순서: 이전 잠금을 넘겨받다가 종료돼, 남은 잠금과 넘겨받기 표시가 다음 호출에서 회수되지 않았다
test('회수하던 프로세스가 도중에 죽어 묘비만 남아도 다음 호출이 잡는다', (t) => {
  const file = join(dir(t), 'pr-claims', 'queue-1')
  plant(file, { pid: 999999, identity: 'x', token: 'dead', at: '', note: '' })
  assert.equal(reclaimDead(file, peek(file)!), true)
  assert.equal(existsSync(file), false)
  assert.equal(takeClaim(file).kind, 'taken')
})

// 리뷰의 순서: A 와 B 가 같은 죽은 잠금을 읽고, B 가 회수해 일하는 동안 A 가 회수를 이어 가고, C 가 잡으려 한다
test('같은 죽은 실행권을 늦게 회수하는 쪽은 새 주인의 실행권을 옮기지 못하고, 세 번째 호출도 잡지 못한다', async (t) => {
  const file = join(dir(t), 'pr-claims', 'queue-1')
  plant(file, { pid: 999999, identity: 'x', token: 'dead', at: '', note: '' })
  const seenByA = peek(file)!
  const b = await holder(t, file, 'b')
  assert.equal(b.result.kind, 'taken')
  assert.equal(reclaimDead(file, seenByA), false)
  assert.equal(JSON.parse(readFileSync(join(file, 'owner'), 'utf8')).pid, b.result.pid)
  const c = takeClaim(file)
  assert.equal(c.kind, 'held')
})

// 리뷰의 순서: A 가 쥔다 → C 가 잡기 실패 후 A 를 읽는다 → A 가 놓는다 → B 가 잡는다 → C 가 A 의 죽음을 확인하고 회수한다
test('놓기 전에 읽은 실행권을 늦게 회수하려 해도, 그 사이 새로 잡힌 실행권을 옮기지 못한다', (t) => {
  const file = join(dir(t), 'pr-claims', 'queue-1')
  const a = takeClaim(file, { token: 'a' })
  assert.equal(a.kind, 'taken')
  const seenByC = peek(file)!
  if (a.kind === 'taken') releaseClaim(a.claim)
  const b = takeClaim(file, { token: 'b' })
  assert.equal(b.kind, 'taken')
  assert.equal(reclaimDead(file, seenByC), false)
  assert.equal(JSON.parse(readFileSync(join(file, 'owner'), 'utf8')).token, 'b')
})

test('token 으로 놓은 실행권도 늦은 회수가 새 주인의 실행권을 옮기지 못한다', (t) => {
  const file = join(dir(t), 'pr-claims', 'queue-1')
  assert.equal(takeClaim(file, { token: 'a' }).kind, 'taken')
  const seenByC = peek(file)!
  releaseByToken(file, ['a'])
  assert.equal(takeClaim(file, { token: 'b' }).kind, 'taken')
  assert.equal(reclaimDead(file, seenByC), false)
  assert.equal(JSON.parse(readFileSync(join(file, 'owner'), 'utf8')).token, 'b')
})

// sweepClaims 의 회수도 같은 틈이 있다: 한 시간 넘은 실행권을 읽은 뒤 놓이고 새 주인이 잡는다
test('sweepClaims 가 읽은 실행권이 그 사이 놓이고 새로 잡혀도 새 실행권을 옮기지 않는다', (t) => {
  const base = dir(t)
  const file = join(base, 'queue-1')
  const a = takeClaim(file, { token: 'a' })
  assert.equal(a.kind, 'taken')
  const seen = peek(file)!
  if (a.kind === 'taken') releaseClaim(a.claim)
  assert.equal(takeClaim(file, { token: 'b' }).kind, 'taken')
  // sweepClaims 안의 회수는 읽은 seen 으로 reclaimDead 를 부른다. 같은 호출이 실패해야 한다
  assert.equal(reclaimDead(file, seen), false)
  sweepClaims(base, Date.now() + 2 * 60 * 60 * 1000)
  assert.equal(JSON.parse(readFileSync(join(file, 'owner'), 'utf8')).token, 'b')
})

test('한 시간 넘게 남은 묘비는 지우고 죽은 실행권은 묘비로 옮긴다. 살아 있는 실행권과 새 묘비는 둔다', (t) => {
  const base = dir(t)
  plant(join(base, 'queue-9'), { pid: 999999, identity: 'x', token: 'dead', at: '', note: '' })
  plant(join(base, 'queue-8.dead-abc'), 'tomb')
  assert.equal(takeClaim(join(base, 'queue-1')).kind, 'taken')
  assert.deepEqual(readdirSync(base).sort(), ['queue-1', 'queue-8.dead-abc', 'queue-9'])
  sweepClaims(base, Date.now() + 2 * 60 * 60 * 1000)
  const left = readdirSync(base)
  assert.equal(left.length, 2, left.join(' '))
  assert.equal(left.includes('queue-1'), true, left.join(' '))
  assert.equal(left.some((name) => name.startsWith('queue-9.dead-')), true, left.join(' '))
})

test('claimPrs 는 인자 순서와 상관없이 낮은 번호부터 잡는다. 순서가 다른 두 호출이 하나씩 잡고 서로 막히지 않는다', async (t) => {
  const repo = dir(t)
  const claims = join(repo, '.orch', 'state', 'pr-claims')
  // 다른 호출이 `1 2` 로 걸어 1 을 먼저 잡은 순간이다. `2 1` 로 건 이 호출은 2 를 잡지 않고 1 에서 물러난다
  const other = await holder(t, join(claims, 'queue-1'))
  assert.equal(other.result.kind, 'taken')
  const claimed = claimPrs(repo, 'queue', ['2', '1'])
  assert.equal(claimed.kind, 'held')
  if (claimed.kind === 'held') assert.deepEqual(claimed.held.map((one) => one.pr), ['1'])
  assert.deepEqual(readdirSync(claims), ['queue-1'])
})

test('claimPrs 는 하나라도 다른 쪽이 쥐었으면 아무것도 잡지 않고, 쥔 쪽을 QUEUE-DUP 줄로 알린다', async (t) => {
  const repo = dir(t)
  const claims = join(repo, '.orch', 'state', 'pr-claims')
  const other = await holder(t, join(claims, 'queue-2'), 'queue merge run=run_b')
  assert.equal(other.result.kind, 'taken')
  const claimed = claimPrs(repo, 'queue', ['1', '2', '3'], { note: 'queue merge' })
  assert.equal(claimed.kind, 'held')
  if (claimed.kind !== 'held') return
  const refused = refusal(claimed)
  assert.equal(refused.code, 4)
  assert.equal(refused.lines.length, 1)
  assert.match(refused.lines[0], new RegExp(`^QUEUE-DUP 2 이미 진행 중이다: pid ${other.result.pid} \\S+ queue merge run=run_b$`))
  assert.deepEqual(readdirSync(claims).filter((name) => !name.includes('.dead-')), ['queue-2'])
  await killed(other.child)
  const again = claimPrs(repo, 'queue', ['1', '2', '2', '3'])
  assert.equal(again.kind, 'ok')
  if (again.kind === 'ok') assert.equal(again.claims.length, 3)
})

// 머지 큐가 보류로 뺀 PR 의 실행권을 놓는 길이다. 부모가 잡은 실행권을 token 을 물려받은 자식이 놓는다
test('token 이 같은 실행권만 놓고, 그 뒤 다른 쪽이 잡은 실행권은 처음 잡은 쪽이 끝날 때 건드리지 않는다', async (t) => {
  const file = join(dir(t), 'pr-claims', 'queue-1')
  const mine = takeClaim(file, { token: 'parent' })
  if (mine.kind !== 'taken') return assert.fail(mine.kind)
  releaseByToken(file, ['someone-else'])
  assert.equal(existsSync(file), true)
  releaseByToken(file, ['parent'])
  assert.equal(existsSync(file), false)
  const next = await holder(t, file, 'requeued')
  assert.equal(next.result.kind, 'taken')
  releaseClaim(mine.claim)
  releaseByToken(file, ['parent'])
  assert.equal(JSON.parse(readFileSync(join(file, 'owner'), 'utf8')).pid, next.result.pid)
})

// PR 568 리뷰의 순서: C 가 A 의 inode 를 읽은 뒤 A 가 정상으로 놓고 B 가 잡는다. C 가 A 의 inode 와 읽지 못한 owner 로 회수하면 B 의 실행권을 옮긴다
test('inode 를 읽고 owner 를 읽는 사이에 놓이고 새 주인이 잡으면 새 주인의 것으로 다시 읽는다. 살아 있는 새 주인의 실행권을 회수하지 않는다', async (t) => {
  const base = dir(t)
  const file = join(base, 'pr-claims', 'finish-1')
  plant(file, { pid: process.pid, identity: identity(process.pid), token: 'a', at: '', note: 'a' })
  let b: Held | null = null
  const started: Promise<Held>[] = []
  const seen = peek(file, () => {
    // A 가 정상으로 놓는다. B 의 시작은 아래에서 따로 본다. 여기서는 그 사이 owner 가 사라진 것만 만든다
    renameSync(file, `${file}.released-a`)
    rmSync(`${file}.released-a`, { recursive: true, force: true })
    plant(file, { pid: process.pid, identity: identity(process.pid), token: 'b', at: '', note: 'b' })
  })
  assert.equal(JSON.parse(seen!.owner).token, 'b')
  // 놓인 채 아무도 잡지 않았으면 없는 것으로 읽는다. 앞 주인의 inode 로 빈 owner 를 만들지 않는다
  const gone = peek(file, () => rmSync(file, { recursive: true, force: true }))
  assert.equal(gone, null)
  // 실제 프로세스로: 새 주인 B 가 쥔 동안 C 는 잡지 못한다
  started.push(holder(t, file, 'b'))
  b = await started[0]
  assert.equal(b.result.kind, 'taken')
  assert.equal(takeClaim(file).kind, 'held')
  assert.equal(JSON.parse(readFileSync(join(file, 'owner'), 'utf8')).pid, b.result.pid)
})

test('PR 번호는 정수로 바꿔 쓴다. 0568 과 568 은 같은 실행권이다', (t) => {
  const repo = dir(t)
  assert.equal(claimFile(repo, 'queue', '0568'), claimFile(repo, 'queue', 568))
  const first = claimPrs(repo, 'queue', ['0568'], { token: 'one' })
  assert.equal(first.kind, 'ok')
  const second = claimPrs(repo, 'queue', ['568'], { token: 'two' })
  assert.equal(second.kind, 'held')
  if (second.kind === 'held') assert.equal(second.held[0].pr, '568')
  if (first.kind === 'ok') for (const claim of first.claims) releaseClaim(claim)
})
