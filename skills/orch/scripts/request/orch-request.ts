// 메인 코디네이터 사이 요청 명령 `orch request …` 이다(ADR-035). 계약은 docs/features/orch-main-coordinator/design.md 의
// 「요청 기록」, 「보드 항목」, 「메시지」, 「명령 표」 이고 기록과 보드는 lib/requests.ts, 판정은 core/main-coordinator.ts 가 소유한다.
//
// 사용법:
//     orch-request.ts send --to <받는 저장소> --title <제목> (--body <글> | --body-file <파일>) --repo <보낸 저장소> --run <보낸 Run>
//     orch-request.ts (accept | hold | reject | done | fail) --id <번호> [--reason <이유>] --repo <받는 저장소> [--run <답한 Run>]
//     orch-request.ts list [--open] --repo <받는 저장소>
//
//     send    받는 저장소의 메인(lib/main-coordinator.ts 의 findMain)을 찾는다. 메인이 없으면 보내지 않고 REQUEST-NO-MAIN <저장소> 와
//             직접 띄우는 명령 줄, 3. 메인을 판정하지 못하면 REQUEST-MAIN-UNKNOWN <이유> 와 1. 메인이 부른 Run 자신이면 REQUEST-SELF 와 3.
//             번호를 잡고 기록을 sent 로 쓴 뒤 메인 Run 에 REQUEST 메시지를 보낸다. 보내기가 실패하면 기록을 지우고 REQUEST-SEND-FAIL 과 1.
//             성공하면 양쪽 보드 항목을 쓰고 REQUEST-SENT <번호> repo=<받는 저장소> main=<메인 Run> 과 0.
//     accept, hold, reject, done, fail
//             받은 저장소의 기록을 바꾸고 답 대상(lib/requests.ts 의 replyRunOf)에 답을 보낸다. hold, reject, fail 은 --reason 이 없으면 2.
//             REQUEST-<상태> <번호> to=<답을 받은 Run> 과 0. 없는 번호는 REQUEST-UNKNOWN, 끝난 요청은 REQUEST-CLOSED <번호> <상태>,
//             지금 상태가 받지 않는 동작(받은 뒤의 거절 같은 것)은 REQUEST-REFUSED <번호> <상태> <동작> 과 3.
//             보내기가 실패하면 기록과 보드를 바꾸지 않고 REQUEST-SEND-FAIL 과 1.
//     list    REQUEST <번호> <상태> from=<보낸 저장소 이름> <제목> 줄을 번호 순으로 낸다. --open 은 끝나지 않은 것만이다. 0.
//     보드를 쓰지 못하면 BOARD-SKIP <저장소> <항목>(보드 파일 없음)이나 BOARD-FAIL <저장소> <항목> <이유> 를 더 낸다. 종료 코드는 바꾸지 않는다.
//
// 종료 코드: 0 성공, 1 조회나 전송 실패, 2 사용법 오류, 3 보낼 수 없거나 받을 수 없는 요청
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { guardWrite, MAIN_GUARD_OPTIONS } from '../lib/main-guard.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isClosed, needsReason, REQUEST_ACTIONS } from '../core/main-coordinator.ts'
import type { RequestAction } from '../core/main-coordinator.ts'
import { expandArgs } from '../lib/args.ts'
import { orchWord } from '../lib/commands.ts'
import { mainCheckout } from '../lib/git.ts'
import { findMain } from '../lib/main-coordinator.ts'
import { shQuote } from '../lib/py.ts'
import {
  allocateNumber, answerRequest, boardLines, listRequests, newRecord, openRequest, parseRequestId, repoName, requestLabel, requestNotice,
} from '../lib/requests.ts'
import type { RequestRecord } from '../lib/requests.ts'

const USAGE = [
  '사용법: orch-request.ts send --to <받는 저장소> --title <제목> (--body <글> | --body-file <파일>) --repo <보낸 저장소> --run <보낸 Run>',
  '        orch-request.ts (accept | hold | reject | done | fail) --id <번호> [--reason <이유>] --repo <받는 저장소> [--run <답한 Run>]',
  '        orch-request.ts list [--open] --repo <받는 저장소>',
].join('\n')

class Usage extends Error {}

const OPTIONS = { ...MAIN_GUARD_OPTIONS,
  to: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' },
  repo: { type: 'string' }, run: { type: 'string' }, id: { type: 'string' }, reason: { type: 'string' }, open: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function requestText(record: RequestRecord): string {
  const word = orchWord()
  const repo = shQuote(record.repo)
  return [
    `${repoName(record.from.repo)} 의 Run ${record.from.run} 이 ${repoName(record.repo)} 에 새 요청을 보냈다(${requestLabel(record)}): 「${record.title}」`,
    '',
    record.body,
    '',
    `답(받음·보류·거절 가운데 하나): ${word} request accept ${record.number} --repo ${repo} | ${word} request hold ${record.number} --reason "<이유>" --repo ${repo} | ${word} request reject ${record.number} --reason "<이유>" --repo ${repo}`,
    `끝낼 때: 이 요청의 보드 항목을 확인한 뒤 worker 지시서에 \`보드 항목 id: ${record.board.to}\` 를 두면 마지막 PR 마무리가 완료를 보낸다. 그 밖은 ${word} request done ${record.number} --repo ${repo} 나 ${word} request fail ${record.number} --reason "<이유>" --repo ${repo}`,
  ].join('\n')
}

function send(values: Record<string, unknown>): number {
  const to = values.to as string | undefined
  const title = values.title as string | undefined
  const fromRun = values.run as string | undefined
  if (!to || !title || !oneLine(title)) throw new Usage('send 는 --to 와 --title 을 준다')
  if (!fromRun) throw new Usage('send 는 보낸 Run(--run)이 필요하다. Run 에 묶인 코디네이터 터미널에서 부른다')
  if ((values.body === undefined) === (values['body-file'] === undefined)) throw new Usage('--body 와 --body-file 가운데 하나만 준다')
  const body = values.body !== undefined ? String(values.body) : readFileSync(resolve(String(values['body-file'])), 'utf8')
  if (!body.trim()) throw new Usage('요청 본문이 비었다')
  const fromRepo = mainCheckout(resolve((values.repo as string | undefined) ?? process.cwd()))
  const toRepo = mainCheckout(resolve(to))
  const main = findMain(toRepo)
  if (main.kind === 'unknown') {
    out(`REQUEST-MAIN-UNKNOWN ${oneLine(main.error).slice(0, 200)}`)
    return 1
  }
  if (main.kind === 'none') {
    out(`REQUEST-NO-MAIN ${toRepo}`)
    out(`  메인이 없는 저장소는 지금처럼 직접 띄운다: ${orchWord()} worker launch --repo ${shQuote(toRepo)} --spec <지시서>`)
    return 3
  }
  if (main.run === fromRun) {
    out(`REQUEST-SELF ${main.run} ${toRepo}`)
    return 3
  }
  const now = new Date().toISOString()
  const number = allocateNumber(toRepo)
  const record = newRecord({ repo: toRepo, number, title: oneLine(title), body, from: { repo: fromRepo, run: fromRun, terminal: process.env.ORCA_TERMINAL_HANDLE || null }, toRun: main.run, now })
  // 기록, 메시지, 첫 보드 쓰기를 답 명령과 같은 요청 잠금 안에서 한다. 메인이 깨어나 곧바로 답해도 첫 보드 쓰기가 그 답을 덮지 않는다
  const opened = openRequest(record, () => requestNotice(main.run, 'REQUEST', record, requestText(record)))
  if (!opened.ok) {
    out(`REQUEST-SEND-FAIL ${record.id} ${oneLine(opened.error).slice(0, 200)}`)
    return 1
  }
  out(`REQUEST-SENT ${record.id} repo=${toRepo} main=${main.run}`)
  for (const line of boardLines(opened.boards)) out(line)
  return 0
}

function answer(action: RequestAction, values: Record<string, unknown>): number {
  const raw = values.id as string | undefined
  const number = raw === undefined ? null : parseRequestId(raw)
  if (number === null) throw new Usage(`${action} 에는 요청 번호(12 나 R12)를 준다`)
  const reason = typeof values.reason === 'string' && oneLine(values.reason) ? oneLine(values.reason) : null
  if (needsReason(action) && !reason) throw new Usage(`${action} 에는 --reason 이 필요하다`)
  const repo = mainCheckout(resolve((values.repo as string | undefined) ?? process.cwd()))
  const mainGuard = guardWrite(repo, 'request ' + action, values['not-main'])
  if (mainGuard.code !== 0) return mainGuard.code
  const result = answerRequest(repo, number, action, reason, (values.run as string | undefined) ?? null, new Date().toISOString())
  if (!result.ok) {
    out(result.line)
    return result.code
  }
  out(`REQUEST-${result.record.state.toUpperCase()} ${result.record.id} to=${result.target}`)
  for (const line of boardLines(result.boards)) out(line)
  return 0
}

function list(values: Record<string, unknown>): number {
  const repo = mainCheckout(resolve((values.repo as string | undefined) ?? process.cwd()))
  for (const record of listRequests(repo)) {
    if (values.open && isClosed(record.state)) continue
    out(`REQUEST ${record.id} ${record.state} from=${repoName(record.from.repo)} ${record.title}`)
  }
  return 0
}

function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args: expandArgs(argv, OPTIONS, ['title', 'body', 'reason']), options: OPTIONS, allowPositionals: true })
  } catch (e) {
    process.stderr.write(`${USAGE}\norch-request: ${(e as Error).message}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    out(USAGE)
    return 0
  }
  try {
    const [verb, ...rest] = positionals
    if (rest.length > 0) throw new Usage(`알 수 없는 인자: ${rest.join(' ')}`)
    if (verb === 'send') return send(values)
    if (verb === 'list') return list(values)
    if ((REQUEST_ACTIONS as readonly string[]).includes(verb ?? '')) return answer(verb as RequestAction, values)
    throw new Usage('send, accept, hold, reject, done, fail, list 가운데 하나를 준다')
  } catch (e) {
    if (!(e instanceof Usage)) throw e
    process.stderr.write(`${USAGE}\norch-request: ${e.message}\n`)
    return 2
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`orch-request: ${(e as Error)?.stack ?? String(e)}\n`)
  process.exitCode = 1
}
