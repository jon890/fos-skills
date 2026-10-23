// `worker-start --spec` 에 넘길 첫 지시 줄을 지시서에서 만든다.
//
// `--spec` 에는 지시서 경로를 담은 한 줄만 준다. 사용자가 허락한 외부 동작(push, PR 열기)이 지시서 파일 안에만 있으면
// Codex worker 가 그 허락을 사용자의 직접 요청으로 볼지 실행마다 달라, 일부는 GitHub 게시가 금지됐다며 멈춘다.
// 지시서의 `허락:` 줄을 첫 지시 줄에 그대로 붙여, 허락이 띄울 때 받는 지시 안에 들어가게 한다.
//
// 지시서에는 이렇게 적는다. 같은 줄의 `허락:` 뒤가 붙는 문구다. 여러 줄이면 차례로 붙인다.
// 목록 기호와 굵은 글씨(`- **허락:** ...`)도 같은 줄로 본다. 줄 판정은 lib/spec.ts 의 permissionsOf 가 소유한다.
//
//     허락: push 와 draft PR 생성(base main)은 사용자가 허락했다.
//
// 사용법:
//     spec-line.ts SPEC_FILE [--require-permission]
//
//     --require-permission  `허락:` 줄이 없으면 종료 코드 1 로 끝난다. PR 을 열게 하는 지시서에 쓴다
//
// 출력:
//     `지시서 <실경로> 를 끝까지 읽고 수행한다. <허락 문구> 못 읽으면 escalation 으로 알린다.` 한 줄
//
// 종료 코드:
//     0  만들었다
//     1  --require-permission 인데 `허락:` 줄이 없다
//     2  사용법 오류, 지시서를 읽지 못했다

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { real } from './lib/fs.ts'
import { permissionsOf } from './lib/spec.ts'

const USAGE = '사용법: spec-line.ts SPEC_FILE [--require-permission]'

function main(argv: string[]): number {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: { 'require-permission': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    })
  } catch (e) {
    process.stderr.write(`${USAGE}\nspec-line: ${(e as Error).message}\n`)
    return 2
  }
  if (parsed.values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (parsed.positionals.length !== 1) {
    process.stderr.write(`${USAGE}\nspec-line: 지시서 하나를 준다\n`)
    return 2
  }
  const path = parsed.positionals[0]
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    process.stderr.write(`spec-line: 지시서를 읽지 못했다: ${(e as Error).message}\n`)
    return 2
  }
  const phrases = permissionsOf(text)
  if (parsed.values['require-permission'] && phrases.length === 0) {
    process.stderr.write(`spec-line: 지시서에 \`허락:\` 줄이 없다: ${path}\n`)
    return 1
  }
  const parts = [`지시서 ${real(path)} 를 끝까지 읽고 수행한다.`, ...phrases, '못 읽으면 escalation 으로 알린다.']
  process.stdout.write(`${parts.join(' ')}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
