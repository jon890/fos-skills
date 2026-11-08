// agent-browser 백엔드. 조건 대기 명령이 없어 eval 폴링으로 대신한다.

import { CONFIG_PATH, READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT, configValue } from '../config.ts'
import { DriverError, UsageError } from '../errors.ts'
import { JsonDecodeError, loadJson, parsePyInt, pyStrOf, pyStrip } from '../pylike.ts'
import { jsValue, run, waitExpression } from '../shell.ts'
import { Backend } from './base.ts'

const rstripNewlines = (text: string) => text.replace(/\n+$/, '')

// agent-browser CLI.
//
// 실패해도 종료 코드가 0 이고 출력 줄머리에 ✗ 를 붙인다 (실측).
// 세션 기반이라 page id 가 없으므로 세션 이름을 핸들로 돌려준다.
// cdpPort 를 적어 두면 그 Chrome 에 붙고, 없으면 스스로 브라우저를 띄운다 (실측).
// close 한 뒤에도 핸들이 죽지 않고 다음 명령이 새 브라우저를 띄운다. orca 와 다르다 (실측).
export class AgentBrowserBackend extends Backend {
  readonly name = 'agent-browser'
  readonly binary = 'agent-browser'
  readonly supported = new Set(['open', 'nav', 'js', 'waitjs', 'ready', 'url', 'snap', 'shot', 'console', 'errors', 'close'])

  private ab(...args: string[]): string {
    return run([this.binary, ...args], { checkMarker: '✗' })
  }

  private connectIfConfigured(): void {
    const port = configValue('cdpPort')
    if (port) this.ab('connect', pyStrOf(port))
  }

  override prepareNote(): string {
    const port = configValue('cdpPort')
    if (!port) {
      return (
        'cdpPort 가 없어도 스스로 브라우저를 띄운다 (실측). 다만 그 브라우저에는 ' +
        '로그인 세션이 없다. SSO 가 필요한 시스템은 Chrome 을 ' +
        `--remote-debugging-port 로 띄우고 ${CONFIG_PATH} 에 cdpPort 를 적는다`
      )
    }
    return ''
  }

  dispatch(cmd: string, args: any[]): unknown {
    if (cmd === 'open') {
      this.connectIfConfigured()
      this.ab('open', args[0])
      let session: string
      try {
        session = pyStrip(this.ab('session'))
      } catch (error) {
        if (!(error instanceof DriverError)) throw error
        session = ''
      }
      return session || 'default'
    }

    if (cmd === 'nav') {
      this.ab('open', args[1])
      return null
    }

    if (cmd === 'js') {
      // eval 은 값을 JSON 으로 인코딩해 낸다. 그대로 흘리면 문자열에 따옴표가 붙어
      // orca 와 형식이 갈린다. JSON.stringify 결과를 파싱하는 소비자가 그 따옴표에서
      // 깨지므로 (실측), 한 겹 벗겨 orca 와 같은 형식으로 맞춘다.
      const raw = rstripNewlines(this.ab('eval', args[1]))
      try {
        return jsValue(loadJson(raw))
      } catch (error) {
        // undefined 처럼 JSON 이 아닌 출력은 그대로 넘긴다.
        if (error instanceof JsonDecodeError) return raw
        throw error
      }
    }

    if (cmd === 'waitjs') {
      const timeout = args.length > 2 ? parsePyInt(args[2]) : WAIT_TIMEOUT_DEFAULT
      this.ab('eval', waitExpression(args[1], timeout))
      return null
    }

    if (cmd === 'ready') {
      const timeout = args.length > 1 ? parsePyInt(args[1]) : READY_TIMEOUT_DEFAULT
      this.ab('eval', waitExpression("document.readyState==='complete'", timeout))
      return null
    }

    if (cmd === 'url') return rstripNewlines(this.ab('get', 'url'))

    if (cmd === 'snap') return rstripNewlines(this.ab('snapshot'))

    if (cmd === 'shot') {
      const out = args.length > 1 ? args[1] : '/tmp/browser-shot.png'
      this.ab('screenshot', out)
      return out
    }

    if (cmd === 'console') return rstripNewlines(this.ab('console'))

    if (cmd === 'errors') return rstripNewlines(this.ab('errors'))

    if (cmd === 'close') {
      this.ab('close')
      return null
    }

    throw new UsageError(`agent-browser 백엔드가 '${cmd}' 를 다루지 않는다`)
  }
}
