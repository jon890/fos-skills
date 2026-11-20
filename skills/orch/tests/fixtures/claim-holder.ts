// 실행권을 잡은 결과를 JSON 한 줄로 내고, stdin 이 닫힐 때까지 쥐고 있는다. 다른 프로세스가 쥔 실행권을 흉내 낸다.
//   claim-holder.ts take <실행권 경로> [note]
//   claim-holder.ts finish <저장소> <PR> <pid 파일>     lib/finish-claim.ts 의 beginFinish
import { beginFinish } from '../../scripts/lib/finish-claim.ts'
import { takeClaim } from '../../scripts/lib/pr-claim.ts'

const [mode, ...rest] = process.argv.slice(2)
const result = mode === 'finish' ? beginFinish(rest[0], rest[1], rest[2]) : takeClaim(rest[0], { note: rest[1] ?? '' })
process.stdout.write(`${JSON.stringify({ pid: process.pid, ...result })}\n`)
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
