import { runtimeEnv } from '../runtime.ts'
// 백엔드 목록과 선택 규칙.

import { configPath, configValue } from '../config.ts'
import { UsageError } from '../errors.ts'
import { pyStrOf } from '../pylike.ts'
import { AgentBrowserBackend } from './agent_browser.ts'
import type { Backend } from './base.ts'
import { CmuxBackend } from './cmux.ts'
import { EgoBackend } from './ego.ts'
import { OrcaBackend } from './orca.ts'

export const BACKENDS = new Map<string, Backend>([new EgoBackend(), new OrcaBackend(), new AgentBrowserBackend(), new CmuxBackend()].map((b) => [b.name, b]))

// 자동 감지 순서. 로그인 세션이 필요한 주소는 ego 가 먼저다. ego 는 사용자가
// 로그인해 둔 프로필의 세션을 그대로 쓰고, orca 의 탭은 그 세션을 갖지 않는다.
// cmux 는 마지막이다. 설치돼 있어도 cmux 밖에서는 소켓 접근이 거부되므로 (실측)
// 자동 감지로 먼저 잡히면 쓸 수 없는 백엔드가 선택된다.
const DETECT_ORDER = ['ego', 'orca', 'agent-browser', 'cmux']

export const EGO_INSTALL_URL = 'https://lite.ego.app/'

// 환경변수 → 설정 파일 → 자동 감지 순서로 백엔드를 정한다. 이름은 설정 파일에서 읽은 값이라 문자열이 아닐 수 있다
export function resolveBackendName(): [unknown, string] {
  const fromEnv = runtimeEnv().BROWSER_DRIVER
  if (fromEnv) return [fromEnv, '환경변수 BROWSER_DRIVER']
  const fromConfig = configValue('driver')
  if (fromConfig) return [fromConfig, `${configPath()} 의 driver`]
  for (const name of DETECT_ORDER) {
    if (BACKENDS.get(name)!.available()) return [name, '자동 감지']
  }
  throw new UsageError(
    `쓸 수 있는 브라우저 백엔드가 없다. ego lite(${EGO_INSTALL_URL})를 먼저 설치한다.\n` +
      'orca 나 agent-browser 를 설치해도 된다.\n' +
      `${configPath()} 에 driver 를 적을 수도 있다. 자세한 상태는 doctor 로 본다.`,
  )
}

// 이름이 백엔드 목록에 있는지. 문자열이 아니면 없는 이름이다(목록, 객체는 해시할 수 없어 Python 도 처리하지 못한 오류로 끝난다)
export function backendByName(name: unknown): Backend | undefined {
  if (Array.isArray(name) || name instanceof Map) throw new TypeError(`unhashable type: '${Array.isArray(name) ? 'list' : 'dict'}'`)
  return typeof name === 'string' ? BACKENDS.get(name) : undefined
}

export function unknownBackendMessage(name: unknown, source: string): string {
  return `모르는 백엔드: ${pyStrOf(name)} (${source}). 쓸 수 있는 값: ${[...BACKENDS.keys()].join(', ')}`
}

export function loadBackend(): Backend {
  const [name, source] = resolveBackendName()
  const backend = backendByName(name)
  if (!backend) throw new UsageError(unknownBackendMessage(name, source))
  if (!backend.available()) throw new UsageError(`${name} 을 찾지 못했다 (${source}). 설치했는지 doctor 로 본다.`)
  return backend
}
