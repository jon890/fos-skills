#!/usr/bin/env node
// 브라우저 자동화 드라이버 중립 계층.
//
// 왜 필요한가:
//   1. 스킬 본문이 특정 브라우저 도구에 묶이지 않게 한다. 팀원마다 쓰는 도구가 다르다.
//   2. orca 와 agent-browser 는 둘 다 실패해도 종료 코드가 0 이다 (실측).
//      그대로 쓰면 오류가 조용히 묻힌다. 이 계층이 실패를 종료 코드 1 로 바꾼다.
//   3. agent-browser 에는 JS 조건 대기 명령이 없다. eval 안의 async 폴링으로 메운다 (실측).
//
// 명령 목록과 백엔드 상태는 `browser-driver help`, 환경 진단은 `browser-driver doctor` 가 낸다.
// 백엔드별 규칙은 README.md 가 소유한다.
//
// 종료 코드:
//   0 성공
//   1 브라우저 조작 실패
//   2 잘못된 호출이나 환경 문제 (백엔드 없음, 설정 오류, 미지원 명령)
//
// 심링크로 불려도 실체 옆의 driver 폴더를 찾는다(Node 가 모듈 경로를 실체로 푼다).
// main 을 내보내고 직접 실행일 때만 스스로 돈다.

import { readFileSync } from 'node:fs'
import { cmdDoctor, cmdInstall } from './driver/admin.ts'
import { parseJsArgs, parsePointerArgs, parseResetArgs } from './driver/args.ts'
import type { Backend } from './driver/backends/base.ts'
import { backendByName, loadBackend, resolveBackendName, unknownBackendMessage } from './driver/backends/index.ts'
import { COMMAND_MAP, COMMANDS, META_COMMANDS, renderHelp, required, usage } from './driver/commands.ts'
import { configPath, configResolution } from './driver/config.ts'
import { DriverError, EXIT_FAIL, EXIT_USAGE, UsageError } from './driver/errors.ts'
import { eprint, isMain, print } from './driver/io.ts'
import { PyFloat, dumpJson, normalizeNewlines, osErrorMessage, pyDecode, pyFloatStr, pyPath } from './driver/pylike.ts'
import { withRuntime, type Runtime } from './driver/runtime.ts'

// 포인터 명령이 받는 좌표 쌍의 수와 --button 허용 여부
const POINTER_SHAPES: Record<string, [number, boolean]> = { click: [1, true], drag: [2, true], hover: [1, false] }

// 옵션을 떼어 위치 인자로 정규화한다. 백엔드는 옵션 문법을 알 필요가 없다
function normalizeArgs(cmd: string, args: string[], backend: Backend): any[] {
  if (cmd === 'js' || cmd === 'jsfile') {
    const parsed: any[] = parseJsArgs(args)
    if (cmd === 'jsfile') {
      const path = pyPath(parsed[1])
      try {
        parsed[1] = normalizeNewlines(pyDecode(readFileSync(path)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw new UsageError(`스크립트 파일을 읽지 못했다: ${osErrorMessage(error, path)}`)
        throw error
      }
    }
    if (parsed[2] !== null && !backend.jsTimeout) throw new UsageError(`${backend.name} 백엔드는 js 의 --timeout 을 지원하지 않는다.`)
    return parsed
  }
  if (cmd === 'reset') return parseResetArgs(args)
  if (cmd in POINTER_SHAPES) {
    const [points, allowButton] = POINTER_SHAPES[cmd]
    return parsePointerArgs(cmd, args, points, allowButton)
  }
  return args
}

// jsfile 은 js 를 그대로 쓰므로 js 를 지원하면 함께 지원한다
const effectiveCommands = (supported: ReadonlySet<string>): Set<string> => new Set([...supported, ...(supported.has('js') ? ['jsfile'] : [])])

// print(result). 문자열은 그대로, 수는 str() 꼴이다
function printResult(result: unknown): void {
  if (result instanceof Map || Array.isArray(result)) print(dumpJson(result))
  else if (result instanceof PyFloat) print(pyFloatStr(result.value))
  else if (typeof result === 'boolean') print(result ? 'True' : 'False')
  else print(String(result))
}

function run(argv: string[]): number {
  const cmd = argv.length ? argv[0] : ''
  const args = argv.slice(1)

  if (['', 'help', '-h', '--help'].includes(cmd)) {
    // 도움말은 백엔드가 없어도 나와야 한다. 무엇을 설치해야 하는지 여기서 읽기 때문이다.
    let backendName: string | null = null
    let unsupported = new Set<string>()
    try {
      const [name] = resolveBackendName()
      const backend = backendByName(name)
      if (backend) {
        backendName = backend.name
        const effective = effectiveCommands(backend.supported)
        unsupported = new Set(COMMANDS.map((c) => c.name).filter((n) => !effective.has(n)))
      }
    } catch (error) {
      if (!(error instanceof UsageError)) throw error
    }
    print(renderHelp(backendName, unsupported))
    return cmd ? 0 : EXIT_USAGE
  }

  if (cmd === 'doctor') return cmdDoctor()

  if (cmd === 'config-path') {
    // 파일이 있는지는 보지 않는다. 미리보기 같은 호출자가 드라이버와 같은 파일을 읽으려고 묻는다.
    print(configPath())
    return 0
  }

  if (cmd === 'install') return cmdInstall(args)

  if (cmd === 'driver') {
    // 설치 여부는 보지 않는다. 어느 백엔드가 잡히는지 묻는 명령이라 설치 전에도 답해야 한다.
    // 다만 모르는 이름은 여기서 막는다. 그대로 흘리면 첫 조작에서야 드러난다.
    const [name, source] = resolveBackendName()
    if (!backendByName(name)) throw new UsageError(unknownBackendMessage(name, source))
    print(String(name))
    return 0
  }

  const spec = COMMAND_MAP.get(cmd)
  if (spec === undefined) {
    const known = [...COMMANDS, ...META_COMMANDS].map((c) => c.name).join(', ')
    throw new UsageError(`모르는 명령: ${cmd}\n쓸 수 있는 명령: ${known}\n자세한 사용법은 help 로 본다.`)
  }

  if (args.length < required(spec)) throw new UsageError(`인자가 모자란다.\n사용법: ${usage(spec)}\n  ${spec.summary}`)

  const backend = loadBackend()
  if (!effectiveCommands(backend.supported).has(cmd)) {
    throw new UsageError(`${backend.name} 백엔드에서 '${cmd}' 의 대응 명령을 확인하지 못했다. 다른 백엔드를 쓰거나 doctor 로 상태를 본다.`)
  }

  const normalized = normalizeArgs(cmd, args, backend)
  const result = backend.dispatch(cmd !== 'jsfile' ? cmd : 'js', normalized)
  if (result === null || result === undefined) return 0
  printResult(result)
  return 0
}

// 명령 하나를 돌리고 종료 코드를 낸다. 오류는 여기서 stderr 로 쓰고 종료 코드로 바꾼다.
// 처리하지 못한 오류는 Python 의 traceback 처럼 stderr 에 적고 1 이다.
export function main(argv: string[], runtime?: Runtime): number {
  if (runtime) return withRuntime(runtime, () => {
    // CLI의 import 시점처럼 명령 검사보다 먼저 설정 경고를 낸다.
    configResolution()
    return main(argv)
  })
  try {
    return run(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      eprint(error.message)
      return EXIT_USAGE
    }
    if (error instanceof DriverError) {
      eprint(error.message)
      return EXIT_FAIL
    }
    eprint(`Traceback (most recent call last):\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return 1
  }
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
