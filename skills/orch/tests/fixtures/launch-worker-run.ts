// 함수 평가에는 timeoutMs·input·maxBuffer 를 적용하지 않는다.
// 지연·입력·출력 한도를 검증하는 가짜는 resolveCommand 에서 undefined 를 돌려 실제 실행으로 넘긴다.
// launch 의 호출별 격리는 fixture 자식이 맡는다. hook·shell·외부 도구는 실제 실행한다.
// Orca 가짜는 동기 본문이고 spec 명령의 main은 동기 출력만 하므로 함수로 호출한다.
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportError } from '../../scripts/worker/launch-worker.ts'
import { main as specLine } from '../../scripts/spec/spec-line.ts'
import { main as specLint } from '../../scripts/spec/spec-lint.ts'
import { runAsync, scriptCommand } from '../../scripts/lib/proc.ts'
import type { RunResult } from '../../scripts/lib/proc.ts'
import { createStatefulRun } from './stateful-run.ts'

export const statefulRun = createStatefulRun({
  resolveCommand: (argv, env) => argv[0] === env.ORCA ? argv[0] : undefined,
})

// 동기 main만 지원한다. 출력 수집은 await 없이 끝나고 예외가 나도 바로 복구한다.
export function captureMain(main: (argv: string[]) => number, argv: string[]): RunResult {
  const out = process.stdout.write
  const err = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((data: string | Uint8Array) => { stdout += typeof data === 'string' ? data : Buffer.from(data).toString(); return true }) as typeof out
  process.stderr.write = ((data: string | Uint8Array) => { stderr += typeof data === 'string' ? data : Buffer.from(data).toString(); return true }) as typeof err
  try {
    return { code: main(argv), stdout, stderr, timedOut: false }
  } catch (error) {
    return { code: 1, stdout, stderr: stderr + `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, timedOut: false }
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
}

const SPEC_LINE = fileURLToPath(new URL('../../scripts/spec/spec-line.ts', import.meta.url))
const SPEC_LINT = fileURLToPath(new URL('../../scripts/spec/spec-lint.ts', import.meta.url))

export const asyncRun: typeof runAsync = async (argv, opts = {}) => {
  const env = { ...process.env, ...opts.env }
  if (argv[0] === env.ORCA) return statefulRun(argv, opts)
  for (const [script, main] of [[SPEC_LINE, specLine], [SPEC_LINT, specLint]] as const) {
    const command = scriptCommand(script, [])
    // spec 호출에는 실행 옵션이 없다. 별도 env/cwd/시간·출력 제한을 요구하면 실제 실행한다.
    if (Object.keys(opts).length === 0 && command.every((arg, index) => argv[index] === arg)) return captureMain(main, argv.slice(command.length))
  }
  return runAsync(argv, opts)
}

if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), statefulRun, asyncRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
