// macOS 메모리에 여유가 생길 때까지 기다린 뒤 명령을 실행한다.
//
// 사용: mem-gate.ts [-- 명령...]
//     `--` 로 시작하지 않는 인자는 보지 않는다. `--help` 나 `-h` 하나만 주면 이 사용법을 낸다
//
// 통과 판정 (환경 변수, 기본값):
//     free 가 EASY_FREE_PCT(37) 이상이면 swap 사용량과 관계없이 통과한다.
//       macOS 는 메모리가 풀린 뒤에도 swap 을 잡아 둔다(free 50% 에 swap 13GB 가 남은 일이 있었다).
//       swap 만으로는 지금 압박인지 알 수 없어 free 가 넉넉하면 swap 을 보지 않는다
//     아니면 free 가 MIN_FREE_PCT(35) 이상이고 swap 사용량이 MAX_SWAP_MB(10240) 이하일 때 통과한다.
//       free 가 35% 와 37% 사이면 swap 이 10GB 를 넘는 동안 기다린다. 35% 아래면 swap 과 관계없이 기다린다
//     MAX_WAIT(3600초) 동안 통과하지 못하면 명령을 실행하지 않고 끝낸다. POLL(30초) 마다 다시 본다
//     free 는 `memory_pressure` 의 free percentage, swap 은 `sysctl -n vm.swapusage` 의 used 다
//     기다릴 때는 PATH 의 sleep 을 부른다
//
// 통과하면 stderr 에 `mem-gate: ok free=<n>% swap=<n>MB` 를 내고, 명령이 있으면 이 프로세스를 그 명령으로 바꾼다.
//
// 종료: 명령의 종료 코드, 0 통과(명령 없음), 1 시간 초과·조회 실패. 실패하면 명령을 실행하지 않는다.
//       127 명령이 없다, 126 명령을 실행할 수 없다

import { writeSync } from 'node:fs'
import { execCommand, NO_LIMIT_MS, run } from './lib/proc.ts'

const HELP = `macOS 메모리에 여유가 생길 때까지 기다린 뒤 명령을 실행한다.

사용: mem-gate.ts [-- 명령...]
기본값: EASY_FREE_PCT=37, MIN_FREE_PCT=35, MAX_SWAP_MB=10240,
MAX_WAIT=3600초, POLL=30초. free가 충분하면 남은 swap 사용량과 무관하게 통과한다.
종료: 명령의 종료 코드, 1 시간 초과·조회 실패. 실패하면 명령을 실행하지 않는다.`

const DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['EASY_FREE_PCT', '37'],
  ['MIN_FREE_PCT', '35'],
  ['MAX_SWAP_MB', '10240'],
  ['MAX_WAIT', '3600'],
  ['POLL', '30'],
]

// 명령으로 넘어가기 전에 쓰는 줄이라 동기로 쓴다. 파이프로 가는 비동기 쓰기는 exec 와 함께 사라진다
function say(line: string): void {
  writeSync(2, `${line}\n`)
}

// Python 의 int() 처럼 앞뒤 공백과 부호를 받는다. 정수가 아니면 Error 다
function integer(name: string, fallback: string): number {
  const text = process.env[name] ?? fallback
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new Error(`${name} 는 정수여야 한다: ${text}`)
  return Number(text)
}

function main(argv: string[]): number {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  const command = argv[0] === '--' ? argv.slice(1) : []
  const [easy, minimum, maximum, limit, poll] = DEFAULTS.map(([name, fallback]) => integer(name, fallback))
  let waited = 0
  for (;;) {
    const free = run(['memory_pressure'])
    const swap = run(['sysctl', '-n', 'vm.swapusage'])
    const f = /free percentage:\s*(\d+)%/.exec(free.stdout)
    const s = /used\s*=\s*([\d.]+)M/.exec(swap.stdout)
    if (free.code || swap.code || !f || !s) {
      say('mem-gate: memory probe failed')
      return 1
    }
    const freePct = Number(f[1])
    const swapMb = Math.trunc(Number(s[1]))
    if (Number.isNaN(swapMb)) throw new Error(`swap 사용량을 읽지 못했다: ${s[1]}`)
    if (freePct >= easy || (freePct >= minimum && swapMb <= maximum)) {
      say(`mem-gate: ok free=${freePct}% swap=${swapMb}MB`)
      return command.length > 0 ? execCommand(command, 'mem-gate') : 0
    }
    if (waited >= limit) {
      say(`mem-gate: timeout free=${freePct}% swap=${swapMb}MB`)
      return 1
    }
    say(`mem-gate: waiting free=${freePct}% swap=${swapMb}MB (need >=${minimum}% and <=${maximum}MB)`)
    // 따로 띄운 sleep 은 신호로 끊을 수 있고, 테스트가 PATH 의 가짜 sleep 으로 기다림을 센다
    const slept = run(['sleep', String(poll)], { timeoutMs: NO_LIMIT_MS })
    if (slept.code !== 0) throw new Error(`sleep ${poll} 이 종료 코드 ${slept.code} 로 끝났다: ${slept.stderr.trim()}`)
    waited += poll
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`mem-gate: ${(e as Error).message}\n`)
  process.exitCode = 1
}
