// cmux 백엔드. 실패를 종료 코드로 정확히 알리는 유일한 백엔드다.

import { READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT } from '../config.ts'
import { DriverError, UsageError } from '../errors.ts'
import { JsonDecodeError, loadJson, normalizeNewlines, parsePyInt, pyDecode, pySplitLines, pyStrip } from '../pylike.ts'
import { jsValue } from '../shell.ts'
import { Backend } from './base.ts'
import { runtimeEnv } from '../runtime.ts'
import { runtimeSpawnSync } from '../runtime.ts'

const rstripNewlines = (text: string) => text.replace(/\n+$/, '')

// cmux 내장 브라우저 (manaflow-ai/cmux).
//
// 실패를 종료 코드 1 로 정확히 알린다 (실측). 다른 두 백엔드와 달리 출력 표식을 볼 필요가 없다.
// 출력에 error 라는 낱말이 들어간 정상 결과를 실패로 오판하지 않으려면 문자열 검사를 쓰지 않는다.
//
// 탭을 surface 번호로 가리킨다. open 이 `OK surface=surface:2 pane=... placement=...` 를 낸다 (실측).
//
// 소켓 접근이 기본으로 cmux 안에서 시작된 프로세스에만 허용된다 (`automation.socketControlMode`
// 기본값 `cmuxOnly`). 밖에서 부르면 `Access denied` 로 끝나므로, cmux 터미널에서 에이전트를
// 돌리거나 `password` 모드로 바꾸고 CMUX_SOCKET_PASSWORD 를 넘긴다 (실측).
export class CmuxBackend extends Backend {
  readonly name = 'cmux'
  readonly binary = 'cmux'
  readonly supported = new Set(['open', 'nav', 'js', 'waitjs', 'ready', 'url', 'snap', 'shot', 'console', 'errors', 'close'])

  private cmux(...args: string[]): string {
    const done = runtimeSpawnSync(this.binary, args, { stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 30, env: runtimeEnv() })
    if (done.error) throw done.error
    const decode = (bytes: Buffer | null) => normalizeNewlines(pyDecode(bytes ?? Buffer.alloc(0)))
    const out = decode(done.stdout) + decode(done.stderr)
    if (done.status !== 0) throw new DriverError(pyStrip(out))
    return out
  }

  private static surface(handle: string): string {
    return handle.startsWith('surface:') ? handle : `surface:${handle}`
  }

  // 소켓에 실제로 붙는지 확인한다. 설치돼 있어도 밖에서는 거부되기 때문이다
  override prepareNote(): string {
    try {
      this.cmux('ping')
    } catch (error) {
      if (!(error instanceof DriverError)) throw error
      const first = error.message ? (pySplitLines(error.message)[0] ?? '') : '붙지 못했다'
      return `소켓에 붙지 못한다 (${first}). cmux 터미널 안에서 에이전트를 돌리거나, cmux.json 의 automation.socketControlMode 를 password 로 두고 socketPassword 를 적는다`
    }
    return ''
  }

  private ready(surface: string, timeout: bigint): void {
    this.cmux('browser', surface, 'wait', '--load-state', 'complete', '--timeout-ms', String(timeout))
  }

  dispatch(cmd: string, args: any[]): unknown {
    if (cmd === 'open') {
      const out = this.cmux('browser', 'open', args[0])
      const timeout = args.length > 1 ? parsePyInt(args[1]) : READY_TIMEOUT_DEFAULT
      const m = /surface=(surface:\p{Nd}+)/u.exec(out)
      let surface: string
      if (!m) {
        // 환경변수로 지정한 surface 를 마지막 수단으로 쓴다. 출력 형식이 바뀌어도 막히지 않는다.
        const fixed = runtimeEnv().BROWSER_CMUX_SURFACE
        if (!fixed) throw new DriverError(`open 출력에서 surface 를 찾지 못했다. BROWSER_CMUX_SURFACE 로 지정한다.\n${pyStrip(out)}`)
        surface = CmuxBackend.surface(fixed)
      } else surface = m[1]
      this.ready(surface, timeout)
      return surface
    }

    const surface = CmuxBackend.surface(args[0])

    if (cmd === 'nav') {
      const timeout = args.length > 2 ? parsePyInt(args[2]) : READY_TIMEOUT_DEFAULT
      this.cmux('browser', surface, 'goto', args[1])
      this.ready(surface, timeout)
      return null
    }

    if (cmd === 'js') {
      // eval 은 Promise 를 기다린다 (실측). 객체는 여백을 넣어 내므로 파싱해 형식을 맞춘다.
      const raw = rstripNewlines(this.cmux('browser', surface, 'eval', args[1]))
      try {
        return jsValue(loadJson(raw))
      } catch (error) {
        if (error instanceof JsonDecodeError) return raw
        throw error
      }
    }

    if (cmd === 'ready') {
      this.ready(surface, args.length > 1 ? parsePyInt(args[1]) : READY_TIMEOUT_DEFAULT)
      return null
    }

    if (cmd === 'waitjs') {
      // 조건 대기 명령이 있으므로 eval 폴링을 쓰지 않는다 (실측).
      const timeout = args.length > 2 ? parsePyInt(args[2]) : WAIT_TIMEOUT_DEFAULT
      this.cmux('browser', surface, 'wait', '--function', args[1], '--timeout-ms', String(timeout))
      return null
    }

    if (cmd === 'url') return rstripNewlines(this.cmux('browser', surface, 'url'))

    if (cmd === 'snap') return rstripNewlines(this.cmux('browser', surface, 'snapshot'))

    if (cmd === 'shot') {
      // screenshot 은 `OK <경로>` 를 낸다 (실측). 경로만 남겨 다른 백엔드와 형식을 맞춘다.
      const out = args.length > 1 ? args[1] : '/tmp/cmux-shot.png'
      this.cmux('browser', surface, 'screenshot', '--out', out)
      return out
    }

    if (cmd === 'console') return rstripNewlines(this.cmux('browser', surface, 'console', 'list'))

    if (cmd === 'errors') return rstripNewlines(this.cmux('browser', surface, 'errors', 'list'))

    if (cmd === 'close') {
      this.cmux('browser', surface, 'tab', 'close')
      return null
    }

    throw new UsageError(`cmux 백엔드가 '${cmd}' 를 다루지 않는다`)
  }
}
