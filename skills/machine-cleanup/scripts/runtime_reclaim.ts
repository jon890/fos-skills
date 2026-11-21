#!/usr/bin/env node
// 정리 뒤 컨테이너 런타임 하나의 VM 디스크를 런타임에 맞는 방법으로 회수하고 결과를 보고한다.
//
// 사용법:
//   runtime_reclaim.ts RUNTIMES_JSON --runtime ID [--threshold-gib N] [--max-attempts N] [--interval SEC] [--max-seconds SEC]
//
// RUNTIMES_JSON 은 1단계에 `container_runtimes.ts --json-out FILE` 이 쓴 파일이다. 런타임의 `reclaim` 값으로 방법이 갈린다(값은 container_runtimes.ts 의 표가 소유한다).
//   fstrim     Colima. `colima_trim.ts --profile <프로필>` 을 그대로 부른다. 재시도, 시간 상한, 종료 코드 0/1/2 는 그 스크립트의 것이다.
//              옵션은 주었을 때만 넘긴다.
//   disk-size  Docker Desktop, OrbStack. trim 명령이 없다. 1단계 조사 때(파일의 disk_bytes)와 지금의 디스크 파일 점유 크기(`du -sk`)를 보고만 한다.
//              덜 줄었어도 다시 하지 않고, 줄지 않았으면 런타임이 비동기로 줄인다는 문구를 낸다. 두 런타임은 지운 만큼 디스크 파일을 스스로 줄인다.
//   none       알 수 없는 런타임. 회수하지 않았다고 보고하고 사용자 몫으로 남긴다.
// 이 맥 밖의 엔진은 대상이 아니라 2 로 끝난다.
//
// 종료 코드: 0 완료(disk-size 는 줄지 않아도 0), 1 측정 실패나 Colima 정지, 2 입력 오류나 Colima 의 남은 차이(colima_trim.ts 의 2 와 같다).
// colima_trim.ts 의 종료 코드를 그대로 돌려주므로 Colima 에서는 0/1/2 가 그 스크립트의 뜻이다. 입력 오류도 2 라 출력의 첫 문장으로 구분한다.

import { join } from 'node:path'
import { readArgs, type Entry } from './cli.ts'
import { readRuntimesFile } from './container_runtimes.ts'
import { isMain, runText, write } from './io.ts'
import { osErrorMessage, pyFixed } from './pylike.ts'
import { duKb } from './survey_system.ts'

const USAGE = `usage: runtime_reclaim.ts [-h] --runtime RUNTIME [--threshold-gib THRESHOLD_GIB]
                          [--max-attempts MAX_ATTEMPTS] [--interval INTERVAL]
                          [--max-seconds MAX_SECONDS]
                          runtimes_json
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
정리 뒤 컨테이너 런타임 하나의 VM 디스크를 런타임에 맞는 방법으로 회수하고 보고한다.

positional arguments:
  runtimes_json

options:
  -h, --help            show this help message and exit
  --runtime RUNTIME
  --threshold-gib THRESHOLD_GIB
  --max-attempts MAX_ATTEMPTS
  --interval INTERVAL
  --max-seconds MAX_SECONDS
`

const PASS = ['threshold-gib', 'max-attempts', 'interval', 'max-seconds']

const ENTRY: Entry = {
  prog: 'runtime_reclaim.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [{ name: 'runtime', value: true, required: true }, { name: 'threshold-gib', value: true, float: true }, { name: 'max-attempts', value: true, int: true }, { name: 'interval', value: true, float: true }, { name: 'max-seconds', value: true, float: true }],
    positionals: [{ name: 'runtimes_json', nargs: 1 }],
  },
}

const GIB = 1024 ** 3
const fmt = (bytes: number): string => `${pyFixed(bytes / GIB, 1)}GiB`

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const id = args.options.runtime as string
  const file = args.positionals.runtimes_json as string
  let rt
  try {
    rt = readRuntimesFile(file).find((r) => r.id === id)
  } catch (error) {
    write(2, `입력을 읽을 수 없다: ${osErrorMessage(error, file)}\n`)
    return 2
  }
  if (!rt) {
    write(2, `입력 오류: 런타임 ${id} 가 조사 파일에 없다\n`)
    return 2
  }
  if (!rt.local) {
    write(2, `입력 오류: ${rt.label}(${rt.id}) 는 이 맥 밖의 엔진이라 회수 대상이 아니다\n`)
    return 2
  }

  if (rt.reclaim === 'fstrim') {
    const passed = PASS.flatMap((name) => (args.options[name] === undefined ? [] : [`--${name}`, String(args.options[name])]))
    write(1, `${rt.label}(${rt.id}): fstrim 으로 회수한다\n`)
    const done = runText([process.execPath, join(import.meta.dirname, 'colima_trim.ts'), '--profile', rt.profile ?? 'default', ...passed], { closeStdin: true })
    if (done.failure) {
      write(2, `colima_trim.ts 를 실행하지 못했다: ${done.message}\n`)
      return 1
    }
    write(1, done.stdout)
    if (done.stderr) write(2, done.stderr)
    return done.code
  }

  if (rt.reclaim === 'disk-size') {
    const path = rt.disk_path
    const rows = path ? duKb(['-s', path]) : []
    if (!path || rows.length === 0) {
      write(2, `${rt.label}(${rt.id}): VM 디스크 파일을 찾지 못해 크기를 재지 못했다\n`)
      return 1
    }
    const after = rows[0][0] * 1024
    const before = rt.disk_bytes
    write(1, `${rt.label}(${rt.id}): trim 명령이 없다. 디스크 파일 점유 크기만 정리 전후로 비교한다\n`)
    if (before === null) {
      write(1, `디스크 파일 ${path}: 정리 전 크기를 몰라 지금 ${fmt(after)} 만 보고한다\n`)
      return 0
    }
    write(1, `디스크 파일 ${fmt(before)} -> ${fmt(after)}, 줄어든 크기 ${fmt(before - after)}\n`)
    if (after >= before) write(1, `디스크 파일이 줄지 않았다. ${rt.label} 는 지운 만큼 디스크 파일을 스스로 비동기로 줄이므로 시간이 지나야 줄 수 있다. 다시 하지 않는다\n`)
    return 0
  }

  write(1, `${rt.label}(${rt.id}): 디스크를 회수하지 않았다. 이 런타임의 VM 디스크 회수는 사용자 몫이다\n`)
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
