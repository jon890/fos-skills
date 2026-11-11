// 보드 창(hooks/register.js)이 승인 대기를 읽고 누를 때 부르는 창 전용 명령이다. orch 명령 표에는 넣지 않는다.
// mod 는 TypeScript 와 node:fs 를 import 하지 못해 이 명령을 $.process.run 으로 불러 출력만 읽는다.
// orch 의 lib/approvals.ts 를 import 한다. bin/worker-marks.ts 가 lib/movement.ts 를 쓰는 것과 같은 방향이다.
//
// 에이전트의 Bash 도구로 부르지 않는다. 승인 기록은 사람이 보드 창에서 누른 버튼만 쓴다.
// `press` 호출은 skills/orch/hooks/block-approval-press.ts 가 거부한다(막지 못하는 범위는 docs/features/board-approval/design.md 「막는 것과 막지 못하는 것」).
//
// 사용법:
//     approvals.ts where --repo DIR
//         승인 파일의 절대경로 한 줄
//     approvals.ts self [--live]
//         {"terminal": "term_…" | null, "worker": true | false | null} 한 줄
//         terminal 은 이 프로세스의 ORCA_TERMINAL_HANDLE 이다. 변수가 없으면(Orca 밖 창) worker 는 false 다.
//         worker 는 승인 쪽 판정(active, 남은 터미널 상태, released)이고 조회가 실패하면 null 이다.
//         --live 는 active 와 남은 터미널 상태만 읽는다(released 를 건너뛴다). 창이 60초마다 다시 읽을 때 쓴다
//     approvals.ts press <id> <버전> approve|revise [--note=<글>] --origin <kind> --repo DIR
//         승인이나 고쳐 달라를 기록하고 그 대기를 올린 Run 으로 신호를 보낸다. 성공하면 PRESS-OK <메시지 id>
//         글은 --note=<글> 한 낱말로 준다. 글이 - 로 시작해도 옵션으로 읽히지 않게 하려는 것이다
//
// 종료 코드: 0 성공(self, where 는 늘 0), 1 거절이나 실패(stderr 에 이유 한 줄), 2 사용법 오류

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { approvalsFile, recordPress, selfIsWorker } from '../../../skills/orch/scripts/lib/approvals.ts'
import { ACTIVE_STATE, LIVE_STATES, lookupWorkerTerminals } from '../../../skills/orch/scripts/lib/worker-terminal.ts'

const USAGE = '사용법: approvals.ts where --repo DIR | self [--live] | press <id> <버전> approve|revise [--note=글] --origin kind --repo DIR'
const out = (line: string) => process.stdout.write(line + '\n')
const err = (line: string) => process.stderr.write(line + '\n')

async function liveWorker(handle: string): Promise<boolean | null> {
  const result = await lookupWorkerTerminals([handle], { states: [ACTIVE_STATE, ...LIVE_STATES] })
  return result.ok ? result.found.has(handle) : null
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try { parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true }) } catch (error) { err((error as Error).message); return 2 }
  const { values: v, positionals } = parsed
  const [verb, id, versionText, action] = positionals
  if (verb === 'where' && positionals.length === 1 && v.repo) { out(approvalsFile(resolve(v.repo))); return 0 }
  if (verb === 'self' && positionals.length === 1) {
    const terminal = process.env.ORCA_TERMINAL_HANDLE || null
    const worker = !terminal ? false : v.live ? await liveWorker(terminal) : await selfIsWorker()
    out(JSON.stringify({ terminal, worker }))
    return 0
  }
  if (verb === 'press' && positionals.length === 4 && v.repo && v.origin && /^\d+$/.test(versionText) && Number(versionText) > 0 &&
    Number.isSafeInteger(Number(versionText)) && (action === 'approve' || action === 'revise')) {
    const done = await recordPress(resolve(v.repo), { id, version: Number(versionText), action, note: v.note ?? null, origin: v.origin })
    if (done.ok) { out(`PRESS-OK ${done.messageId}`); return 0 }
    err(done.reason)
    return 1
  }
  err(USAGE)
  return 2
}
const OPTIONS = { repo: { type: 'string' }, live: { type: 'boolean' }, origin: { type: 'string' }, note: { type: 'string' } } as const
try { process.exitCode = await main() } catch (error) { err((error as Error).message); process.exitCode = 1 }
