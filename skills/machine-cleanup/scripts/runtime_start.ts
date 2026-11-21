#!/usr/bin/env node
// 사용자가 승인한 컨테이너 런타임 하나를 켜고 `docker info` 가 성공할 때까지 기다린다.
//
// 사용법:
//   runtime_start.ts RUNTIMES_JSON --runtime ID [--timeout 120] [--interval 2]
//
// RUNTIMES_JSON 은 `container_runtimes.ts --json-out FILE` 이 쓴 파일이다. ID 는 그 파일의 런타임 id 다(`docker-desktop`, `orbstack`, `colima:default` 등).
// 켜는 명령은 런타임마다 하나다(Docker Desktop `open -a Docker`, OrbStack `orb start`, Colima `colima start -p <프로필>`). 값은 container_runtimes.ts 의 표가 소유한다.
// 이미 `docker --context <이름> info` 가 되면 아무것도 켜지 않고 0 으로 끝난다.
// `open -a Docker` 는 엔진이 준비되기 전에 돌아오므로 켠 뒤 `docker info` 성공을 준비로 본다. 최대 --timeout 초(기본 120, 도구의 명령 시간 한도)까지 기다린다.
// 넘으면 「켜지 못함」 을 표준 오류에 내고 1 로 끝난다. 호출하는 쪽은 그 런타임만 건너뛰고 나머지를 계속한다. 정리 뒤 런타임을 끄지 않는다.
// 이 맥 밖의 엔진과 알 수 없는 런타임은 켜는 명령이 없어 2 로 끝난다.
//
// 종료 코드: 0 켜졌거나 이미 켜져 있음, 1 켜지 못함, 2 입력 오류.

import { readArgs, type Entry } from './cli.ts'
import { dockerResponds, readRuntimesFile } from './container_runtimes.ts'
import { isMain, runText, sleep, write } from './io.ts'
import { osErrorMessage, parsePyFloat, pyFixed } from './pylike.ts'

const USAGE = `usage: runtime_start.ts [-h] --runtime RUNTIME [--timeout TIMEOUT]
                        [--interval INTERVAL]
                        runtimes_json
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
승인한 컨테이너 런타임 하나를 켜고 docker info 가 성공할 때까지 기다린다.

positional arguments:
  runtimes_json

options:
  -h, --help            show this help message and exit
  --runtime RUNTIME
  --timeout TIMEOUT     준비를 기다리는 최대 초
  --interval INTERVAL   docker info 확인 사이 대기 초
`

const ENTRY: Entry = {
  prog: 'runtime_start.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [{ name: 'runtime', value: true, required: true }, { name: 'timeout', value: true, float: true }, { name: 'interval', value: true, float: true }],
    positionals: [{ name: 'runtimes_json', nargs: 1 }],
  },
}

// 준비를 기다리는 기본 최대 초. 도구의 명령 시간 한도(120초)에 맞춘 값이다(스펙 DECISION8)
export const START_TIMEOUT_SEC = 120

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const id = args.options.runtime as string
  const timeout = args.options.timeout === undefined ? START_TIMEOUT_SEC : parsePyFloat(args.options.timeout as string)
  const interval = args.options.interval === undefined ? 2 : parsePyFloat(args.options.interval as string)
  let rt
  try {
    rt = readRuntimesFile(args.positionals.runtimes_json as string).find((r) => r.id === id)
  } catch (error) {
    write(2, `입력을 읽을 수 없다: ${osErrorMessage(error, args.positionals.runtimes_json as string)}\n`)
    return 2
  }
  if (!rt) {
    write(2, `런타임 ${id} 가 조사 파일에 없다\n`)
    return 2
  }
  if (!rt.start_command || !rt.context) {
    write(2, `${rt.label}(${rt.id}) 는 이 스킬이 켜지 않는다. 켜는 명령이 정해져 있지 않다\n`)
    return 2
  }
  const clock = () => performance.now() / 1000
  const began = clock()
  if (dockerResponds(rt.context, 10)) {
    write(1, `이미 켜져 있다: ${rt.label}(${rt.id})\n`)
    return 0
  }

  write(1, `켜는 중: ${rt.label}(${rt.id})  ${rt.start_command.join(' ')}\n`)
  const started = runText(rt.start_command, { timeoutSec: Math.max(1, timeout - (clock() - began)), closeStdin: true })
  if (started.failure || started.code !== 0) {
    write(2, `켜지 못함: ${rt.label}(${rt.id}) 켜는 명령이 실패했다: ${started.failure ? started.message : started.stderr.trim() || `종료 코드 ${started.code}`}\n`)
    return 1
  }
  for (;;) {
    const left = timeout - (clock() - began)
    if (dockerResponds(rt.context, Math.min(15, Math.max(1, left)))) {
      write(1, `켜짐: ${rt.label}(${rt.id}) ${pyFixed(clock() - began, 0)}초 뒤 docker info 성공\n`)
      return 0
    }
    if (timeout - (clock() - began) <= interval) break
    sleep(interval)
  }
  write(2, `켜지 못함: ${rt.label}(${rt.id}) ${pyFixed(timeout, 0)}초 안에 docker info 가 성공하지 않았다. 이 런타임만 건너뛰고 나머지를 계속한다\n`)
  return 1
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
