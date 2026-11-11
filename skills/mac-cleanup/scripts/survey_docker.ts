#!/usr/bin/env node
// 켜진 컨테이너 런타임마다 context 를 지정해 이미지와 volume 을 따로 조사한다. 읽기 전용이다.
//
// 사용법:
//   survey_docker.ts RUNTIMES_JSON --out-dir DIR [--runtime ID] [--peek N|all]
//
// RUNTIMES_JSON 은 `container_runtimes.ts --json-out FILE` 이 쓴 파일이다. 기본은 거기서 켜져 있는(state running) 이 맥 안의 런타임 모두다.
// 같은 소켓을 가리키는 context 는 container_runtimes.ts 가 런타임 하나로 합쳤으므로 런타임마다 한 번만 조사한다.
// --runtime ID 를 주면 그 런타임 하나만 켜짐 여부와 상관없이 조사한다(승인받아 방금 켠 런타임). 이 맥 밖의 엔진은 조사하지 않는다.
// 런타임마다 `## 런타임 ID` 절로 나누고, `docker_images.ts --context` 와 `docker_volumes.ts --context --peek N --json-out` 의 출력을 그대로 보인다.
// volume 조사 JSON 은 DIR/volumes-<ID 의 :을 _로 바꾼 이름>.json 에 쓰고, 두 조사가 모두 성공했을 때만 그 경로를 출력한다. 실패하면 이전 실행의 같은 파일도 지운다. `delete_volumes.ts` 가 이 파일을 입력으로 받는다.
// 사용자의 현재 context 설정은 바꾸지 않는다. 한 런타임의 조사가 실패해도 나머지를 계속한다.
//
// 종료 코드: 0 조사 완료, 1 한 런타임이라도 조사가 실패함, 2 입력 오류.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readArgs, type Entry } from './cli.ts'
import { readRuntimesFile, type Runtime } from './container_runtimes.ts'
import { isMain, runText, write } from './io.ts'
import { osErrorMessage } from './pylike.ts'

const USAGE = `usage: survey_docker.ts [-h] --out-dir OUT_DIR [--runtime RUNTIME]
                        [--peek N|all]
                        runtimes_json
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
켜진 컨테이너 런타임마다 context 를 지정해 이미지와 volume 을 따로 조사한다. 읽기 전용이다.

positional arguments:
  runtimes_json

options:
  -h, --help         show this help message and exit
  --out-dir OUT_DIR
  --runtime RUNTIME
  --peek N|all
`

const ENTRY: Entry = {
  prog: 'survey_docker.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [{ name: 'out-dir', value: true, required: true }, { name: 'runtime', value: true }, { name: 'peek', value: true }],
    positionals: [{ name: 'runtimes_json', nargs: 1 }],
  },
}

export const volumesFileName = (id: string): string => `volumes-${id.replace(/[^A-Za-z0-9.-]/g, '_')}.json`

const script = (name: string): string => join(import.meta.dirname, name)

// 조사 스크립트 하나를 돌려 출력을 그대로 보인다. 종료 코드가 0 이 아니면 false 다
function runSurvey(title: string, argv: string[]): boolean {
  write(1, `### ${title}\n`)
  const done = runText([process.execPath, ...argv], { timeoutSec: 600, closeStdin: true })
  if (done.failure) {
    write(2, `${title} 조사를 실행하지 못했다: ${done.message}\n`)
    return false
  }
  write(1, done.stdout)
  if (done.stderr) write(2, done.stderr)
  return done.code === 0
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const file = args.positionals.runtimes_json as string
  const outDir = args.options['out-dir'] as string
  const only = args.options.runtime as string | undefined
  const peek = (args.options.peek as string | undefined) ?? 'all'
  let runtimes: Runtime[]
  try {
    runtimes = readRuntimesFile(file)
    mkdirSync(outDir, { recursive: true })
  } catch (error) {
    write(2, `입력을 읽을 수 없다: ${osErrorMessage(error, file)}\n`)
    return 2
  }
  let targets: Runtime[]
  if (only !== undefined) {
    targets = runtimes.filter((r) => r.id === only)
    if (targets.length === 0 || !targets[0].local || !targets[0].context) {
      write(2, `런타임 ${only} 는 조사 대상이 아니다(파일에 없거나 이 맥 밖의 엔진이다)\n`)
      return 2
    }
  } else {
    targets = runtimes.filter((r) => r.local && r.state === 'running' && r.context)
  }
  if (targets.length === 0) write(1, '조사할 켜진 런타임이 없다\n')

  let failed = false
  for (const rt of targets) {
    write(1, `\n## 런타임 ${rt.id} (${rt.label}, context=${rt.context})\n`)
    const volumes = join(outDir, volumesFileName(rt.id))
    rmSync(volumes, { force: true }) // 이전 실행의 파일이 이번 조사 결과로 읽히지 않게 한다
    const images = runSurvey('이미지', [script('docker_images.ts'), '--context', rt.context!])
    const vols = runSurvey('volume', [script('docker_volumes.ts'), '--context', rt.context!, '--peek', peek, '--json-out', volumes])
    if (images && vols) {
      write(1, `volume 조사 파일: ${volumes}\n`)
    } else {
      failed = true
      rmSync(volumes, { force: true })
      write(1, `${rt.id}: 조사에 실패했다. 이 런타임의 이미지와 volume 은 정리 후보에 넣지 않는다\n`)
    }
  }
  return failed ? 1 : 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
