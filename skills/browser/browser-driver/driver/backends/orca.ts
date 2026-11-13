// orca 백엔드. 워크트리에 탭을 만들고 앱의 로그인 세션을 그대로 쓴다.

import { writeFileSync } from 'node:fs'
import { DriverError, UsageError } from '../errors.ts'
import { READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT } from '../config.ts'
import { eprint } from '../io.ts'
import { JsonDecodeError, dumpJson, loadJson, parsePyInt, pyPath, pyStrOf, pySuffix, pyTruthy } from '../pylike.ts'
import { jsValue, run } from '../shell.ts'
import { Backend } from './base.ts'
import { runtimeEnv } from '../runtime.ts'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// base64.b64decode(문자열). 알파벳 밖의 글자는 건너뛰고, 패딩을 채우면 거기서 멈추고, 모자라면 던진다
function b64decode(value: unknown): Buffer {
  if (typeof value !== 'string') throw new TypeError(`argument should be a bytes-like object or ASCII string, not '${typeof value}'`)
  if (/[^\x00-\x7f]/.test(value)) throw new Error('string argument should contain only ASCII characters')
  const out: number[] = []
  let quad = 0
  let pads = 0
  let left = 0
  let done = false
  for (const ch of value) {
    if (ch === '=') {
      if (quad >= 2 && quad + ++pads >= 4) {
        done = true
        break
      }
      continue
    }
    const idx = B64.indexOf(ch)
    if (idx < 0) continue
    pads = 0
    if (quad === 0) left = idx
    else if (quad === 1) {
      out.push(((left << 2) | (idx >> 4)) & 0xff)
      left = idx & 0xf
    } else if (quad === 2) {
      out.push(((left << 4) | (idx >> 2)) & 0xff)
      left = idx & 3
    } else out.push(((left << 6) | idx) & 0xff)
    quad = (quad + 1) % 4
  }
  if (!done && quad !== 0) throw new Error('Incorrect padding')
  return Buffer.from(out)
}

// Orca 내장 브라우저.
//
// orca CLI 는 실패해도 종료 코드가 0 이고 JSON 의 "ok" 필드만 실패를 알린다 (실측).
export class OrcaBackend extends Backend {
  readonly name = 'orca'
  readonly binary = 'orca'
  override readonly shotSize = true
  readonly supported = new Set(['open', 'nav', 'js', 'waitjs', 'ready', 'url', 'snap', 'shot', 'console', 'errors', 'worktree', 'close'])

  // orca 를 부르고 result 의 하위 경로를 뽑는다. path 가 빈 문자열이면 result 전체.
  //
  // orca wait --load 는 이미 로드된 페이지에서도 항상 시간이 초과되므로 쓰지 않는다 (실측).
  private call(path: string, ...orcaArgs: string[]): any {
    const raw = run([this.binary, ...orcaArgs, '--json'])
    let data: unknown
    try {
      data = loadJson(raw)
    } catch (error) {
      if (error instanceof JsonDecodeError) throw new DriverError(`orca 응답이 JSON 이 아니다:\n${raw}`)
      throw error
    }
    // 객체가 아닌 응답에는 .get 이 없어 Python 도 처리하지 못한 오류로 끝난다
    if (!(data instanceof Map)) throw new TypeError("object has no attribute 'get'")
    if (!pyTruthy(data.get('ok'))) {
      const rawError = data.get('error')
      const err = pyTruthy(rawError) ? rawError : new Map()
      if (!(err instanceof Map)) throw new TypeError("object has no attribute 'get'")
      const code = err.has('code') ? err.get('code') : 'unknown'
      const message = err.has('message') ? err.get('message') : raw
      throw new DriverError(`orca 실패 [${pyStrOf(code)}] ${pyStrOf(message)}`)
    }
    let node: unknown = pyTruthy(data.get('result')) ? data.get('result') : new Map()
    if (!path) return node
    for (const key of path.split('.')) {
      if (!(node instanceof Map) || !node.has(key)) throw new DriverError(`응답에 ${path} 가 없다: ${dumpJson(node)}`)
      node = node.get(key)
    }
    return node
  }

  private ready(handle: string, timeout: bigint): void {
    this.call('', 'wait', '--fn', "document.readyState==='complete'", '--timeout', String(timeout), '--page', handle)
  }

  // 탭이 붙은 워크트리를 읽는다.
  //
  // tab list 는 현재 워크트리의 탭만 보여주므로 쓸 수 없다.
  // tab show 는 워크트리를 넘어 조회된다 (실측).
  private worktree(handle: string): string {
    const tab = this.call('tab', 'tab', 'show', '--page', handle)
    let wt: unknown = ''
    if (pyTruthy(tab)) {
      if (!(tab instanceof Map)) throw new TypeError("object has no attribute 'get'")
      wt = pyTruthy(tab.get('worktreeId')) ? tab.get('worktreeId') : ''
    }
    // 문자열이 아닌 id 는 split 이 없어 Python 도 처리하지 못한 오류로 끝난다
    if (typeof wt !== 'string') throw new TypeError("object has no attribute 'split'")
    return wt.includes('::') ? wt.slice(wt.indexOf('::') + 2) : wt
  }

  dispatch(cmd: string, args: any[]): unknown {
    if (cmd === 'open') {
      const url = args[0]
      const timeout = args.length > 1 ? parsePyInt(args[1]) : READY_TIMEOUT_DEFAULT
      // orca tab create 는 셸의 작업 디렉토리가 속한 워크트리에 탭을 만든다. 조사하느라 다른
      // 저장소로 옮긴 상태에서 열면 사용자가 보는 워크트리가 아닌 곳에 탭이 생긴다 (실측).
      // --worktree active 로도 막지 못한다. active 역시 작업 디렉토리를 따라간다 (실측).
      const worktree = runtimeEnv().ORCA_WORKTREE
      const create = ['tab', 'create', '--url', url]
      if (worktree) create.push('--worktree', worktree)
      const handle = this.call('browserPageId', ...create)
      this.ready(handle, timeout)
      // 어느 워크트리에 열렸는지 알린다. 사용자가 탭을 찾지 못하는 상황을 바로 드러낸다.
      try {
        const where = this.worktree(handle) || '(워크트리 없음)'
        eprint(`탭 위치: ${where}`)
      } catch (error) {
        if (!(error instanceof DriverError)) throw error
      }
      return handle
    }

    if (cmd === 'nav') {
      const [handle, url] = args
      const timeout = args.length > 2 ? parsePyInt(args[2]) : READY_TIMEOUT_DEFAULT
      this.call('', 'goto', '--url', url, '--page', handle)
      this.ready(handle, timeout)
      return null
    }

    if (cmd === 'js') return jsValue(this.call('result', 'eval', '--expression', args[1], '--page', args[0]))

    if (cmd === 'waitjs') {
      const timeout = args.length > 2 ? parsePyInt(args[2]) : WAIT_TIMEOUT_DEFAULT
      this.call('', 'wait', '--fn', args[1], '--timeout', String(timeout), '--page', args[0])
      return null
    }

    if (cmd === 'ready') {
      const timeout = args.length > 1 ? parsePyInt(args[1]) : READY_TIMEOUT_DEFAULT
      this.ready(args[0], timeout)
      return null
    }

    if (cmd === 'url') return this.call('url', 'get', '--what', 'url', '--page', args[0])

    // --json 을 붙이면 접근성 트리가 snapshot 필드로 오고 실패도 ok 로 알려준다 (실측).
    // 붙이지 않으면 없는 탭에도 종료 코드 0 이라 실패가 묻힌다.
    if (cmd === 'snap') return this.call('snapshot', 'snapshot', '--page', args[0])

    if (cmd === 'shot') {
      // orca screenshot 은 파일이 아니라 base64 를 JSON 으로 돌려주므로 직접 디코딩한다.
      const out = pyPath(args.length > 1 ? args[1] : '/tmp/orca-shot.png')
      const fmt = ['.jpg', '.jpeg'].includes(pySuffix(out).toLowerCase()) ? 'jpeg' : 'png'
      // --size 는 찍기 전에 이 탭의 뷰포트를 바꾼다. 뒤 촬영도 그 크기로 남는다
      if (args[2]) this.call('', 'viewport', '--width', String(args[2][0]), '--height', String(args[2][1]), '--page', args[0])
      const data = this.call('data', 'screenshot', '--format', fmt, '--page', args[0])
      writeFileSync(out, b64decode(data))
      return out
    }

    if (cmd === 'console') return this.call('', 'exec', '--command', 'console', '--page', args[0])

    if (cmd === 'errors') return this.call('', 'exec', '--command', 'errors', '--page', args[0])

    if (cmd === 'worktree') return this.worktree(args[0]) || '(워크트리 없음)'

    if (cmd === 'close') {
      this.call('', 'tab', 'close', '--page', args[0])
      return null
    }

    throw new UsageError(`orca 백엔드가 '${cmd}' 를 다루지 않는다`)
  }
}
