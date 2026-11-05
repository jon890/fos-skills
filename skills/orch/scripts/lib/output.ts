// 진입점으로 부른 스크립트의 짧은 출력. 진입점(bin/orch.ts)이 새 꼴과 옛 꼴 모두에 ORCH_OUTPUT=short 를 넘기고, `--full` 이면 넘기지 않는다.
// 신호를 읽고 지우는 일은 lib/bundle.ts 가 한다. 계약은 docs/features/orch-cli/design.md 의 「짧은 출력 (PR2)」 이다.
//
// 짧은 출력의 줄(emit):
//     1. 스크립트가 넘긴 규칙표에서 처음 맞는 규칙의 결과를 낸다. 결과가 null 이면 버린다
//     2. 맞는 규칙이 없으면 판정 줄(대문자 낱말로 시작하는 줄, VERDICT)은 그대로 낸다
//     3. fix 를 켠 명령은 두 칸 들여 쓴 고칠 줄을, 그 줄이 딸린 판정 줄(앞의 들여 쓰지 않은 마지막 줄)을 냈을 때 그대로 낸다.
//        `  안내:` 줄은 고칠 줄이 아니라 버린다
//     4. 나머지(설명과 진행 줄)는 버린다
// 진입점이 `--full` 로 부르면 신호 값이 full 이다. short() 는 거짓이고, 대기가 다음 대기(NEXT_WAIT)에 --full 을 잇는 데만 쓴다(fullAsked).
// 짧은 출력이 아니면 받은 글을 그대로 낸다. 스크립트를 경로로 직접 실행하면 신호가 없어 지금 출력 그대로다(스펙 DECISION16).
import { orchOutput } from './bundle.ts'

export const VERDICT = /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*(?=\s|$)/

export type Rule = [RegExp, (m: RegExpExecArray) => string | null]

// 첫 `--` 앞의 인자. 그 뒤는 다른 명령에 넘어가는 인자라 보지 않는다
function head(argv: string[]): string[] {
  const i = argv.indexOf('--')
  return i < 0 ? argv : argv.slice(0, i)
}

// 짧은 출력인가. 신호가 있고 사용법(--help, -h)이나 JSON(--json)을 고르지 않았을 때다. 사용법과 JSON 은 늘 그대로다
export function short(argv: string[] = process.argv.slice(2)): boolean {
  if (orchOutput() !== 'short') return false
  return !head(argv).some((a) => a === '--help' || a === '-h' || a === '--json')
}

// 진입점에서 --full 로 불렸는가
export function fullAsked(): boolean {
  return orchOutput() === 'full'
}

export function isVerdict(line: string): boolean {
  return VERDICT.test(line)
}

// 출력을 그대로 잇는 자식(stdio 상속)에 넘길 환경. 짧은 출력일 때만 신호를 다시 넣는다
export function shortEnv(): Record<string, string> {
  return short() ? { ORCH_OUTPUT: 'short' } : {}
}

// 줄바꿈을 공백 하나로 바꾸고 max 글자에서 자른다. 글자는 코드 포인트로 센다
export function oneLine(text: string, max?: number): string {
  const flat = text.replace(/\s*(?:\r\n|[\n\r\u2028\u2029])\s*/g, ' ').trim()
  const chars = Array.from(flat)
  return max !== undefined && chars.length > max ? chars.slice(0, max).join('') : flat
}

// 짧은 출력의 줄 하나. 머리 주석의 1-4 다. kept 는 이 줄이 딸린 판정 줄(앞의 들여 쓰지 않은 마지막 줄)을 냈는지다
export function shortLine(line: string, rules: Rule[], fix: boolean, kept: boolean): string | null {
  for (const [pattern, make] of rules) {
    const m = pattern.exec(line)
    if (m) return make(m)
  }
  if (isVerdict(line)) return line
  if (fix && kept && /^ {2}\S/.test(line) && !line.startsWith('  안내:')) return line
  return null
}

export type EmitOptions = { fix?: boolean; write?: (text: string) => void }

// 고칠 줄은 딸린 판정 줄을 냈을 때만 남는다. 여러 번의 emit 사이에서도 마지막 판정 줄을 냈는지 기억한다
let headKept = false

export function emit(text: string, rules: Rule[] = [], opts: EmitOptions = {}): void {
  const write = opts.write ?? ((s: string) => void process.stdout.write(s))
  if (!short()) {
    write(`${text}\n`)
    return
  }
  const shown: string[] = []
  for (const line of text.split('\n')) {
    const made = shortLine(line, rules, opts.fix === true, headKept)
    if (!/^\s/.test(line)) headKept = made !== null
    if (made !== null) shown.push(made)
  }
  if (shown.length) write(`${shown.join('\n')}\n`)
}
