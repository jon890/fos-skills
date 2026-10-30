// decision-pending 기본 핸들러. 현재 Run 의 코디네이터에게 질문 절차를 요청한다.
// 화면 판정과 안전한 입력은 nudge-worker 가 맡고, 저장소 핸들러가 있으면 이 기본 핸들러를 대체한다.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registeredRuns } from '../lib/loop.ts'
import { runAsync, scriptCommand } from '../lib/proc.ts'

async function main(): Promise<number> {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input.event !== 'decision-pending' || typeof input.run !== 'string' || !input.run) throw new Error('결정 알림의 Run 이 없다')
  const registered = registeredRuns(input.repo).find((entry) => entry.run === input.run)
  const terminal = registered?.coordinator_terminal
  if (typeof terminal !== 'string' || !terminal.startsWith('term_')) {
    throw new Error(`Run ${input.run}의 코디네이터 터미널이 등록되지 않았다. 그 코디네이터 터미널에서 orch-loop --start --run ${input.run}으로 다시 등록한다`)
  }
  const prompt = [
    `정할 것 묻기: Run ${input.run} 에 사용자 결정이 남아 있다.`,
    'fos-skills:orch 의 replying 절차로 미답변 결정 질문과 보드 decide 항목을 다시 조회하고, 배경과 권장안을 붙여 사용자에게 물어라.',
    '이미 물어 답을 기다리는 결정은 다시 묻지 말고, 받은 답은 원래 질문에 --reply-to 로 보내고 보드의 해당 줄을 mark 한다.',
    '미완료 dispatch 가 있으면 메시지를 처리한 직후 wait-important 를 백그라운드로 다시 걸어라.',
  ].join('\n')
  const script = process.env.NUDGE_WORKER || fileURLToPath(new URL('../nudge-worker.ts', import.meta.url))
  const done = await runAsync(scriptCommand(script, ['--terminal', terminal, '--text', prompt]), { timeoutMs: 90_000 })
  process.stdout.write(done.stdout)
  process.stderr.write(done.stderr)
  return done.code
}
main().then((code) => { process.exitCode = code }, (error) => { console.error(String(error)); process.exitCode = 1 })
