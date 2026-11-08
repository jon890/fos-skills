// 설정 파일과 기본 제한 시간.

import { readdirSync, statSync } from 'node:fs'
import { JsonDecodeError, exists, isFile, loadJson, osErrorMessage, pyExpanduser, pyHomePrefix, pyPath, pyReadText, pyResolve, pyStrCompare, pyTruthy, shQuote } from './pylike.ts'
import { UsageError } from './errors.ts'
import { eprint } from './io.ts'

export const READY_TIMEOUT_DEFAULT = 30000n
export const WAIT_TIMEOUT_DEFAULT = 10000n
export const WAIT_INTERVAL = 150

type Env = Record<string, string | undefined>

// Python 의 LEGACY_CONFIG = Path.home() / ".claude" / "browser.config.json"
const legacyConfig = (): string => pyPath(`${pyHomePrefix()}/.claude/browser.config.json`)

export function claudeConfigDir(env: Env, home?: string): string {
  if (env.CLAUDE_CONFIG_DIR) return pyResolve(pyExpanduser(env.CLAUDE_CONFIG_DIR))
  return pyPath(`${home === undefined ? pyHomePrefix() : home}/.claude`)
}

// 본체가 플러그인 설치 캐시 안에 있으면 그 플러그인의 데이터 폴더를 낸다. 아니면 null.
//
// <루트>/plugins/cache/<마켓플레이스>/<플러그인>/<버전>/skills/browser/browser-driver/driver/config.ts
// (팀 사본은 .../<버전>/tools/browser-driver/driver/config.ts) 꼴일 때만 데이터 폴더를 돌려준다.
// 어느 도구의 설치본인지는 <루트>/config.toml 로 구분한다.
//   - config.toml 이 파일이면 Codex 설치본이다. Codex 에는 데이터 폴더가 없어서
//     두 도구를 함께 쓰는 사람의 설정이 하나가 되도록 Claude 설정 폴더의 것을 쓴다.
//     <Claude 설정 폴더>/plugins/data/<플러그인>-<마켓플레이스>/
//     Claude 설정 폴더는 환경변수 CLAUDE_CONFIG_DIR 가 비어 있지 않으면 그 값, 아니면 ~/.claude 다.
//   - 없으면 Claude Code 설치본이다. <루트>/plugins/data/<플러그인>-<마켓플레이스>/
// 이름 규칙은 Claude Code 2.1.286 과 Codex 0.159.3 에서 실측했다.
// 저장소 체크아웃이나 ~/.claude/scripts/ 링크는 이 꼴이 아니므로 실체 경로를 본다.
// 읽기만 한다.
export function pluginDataDir(moduleFile: string, env: Env, home?: string): string | null {
  const parts = ['/', ...pyResolve(moduleFile).split('/').filter((part) => part !== '')]
  // ..., plugins, cache, <마켓플레이스>, <플러그인>, <버전>, <드라이버 자리>, driver, config.ts
  // 드라이버 자리는 이 저장소에서 skills/browser/browser-driver, 팀 사본에서 tools/browser-driver 다.
  let tail = 0
  for (const place of [['skills', 'browser', 'browser-driver'], ['tools', 'browser-driver']]) {
    const want = [...place, 'driver']
    const size = place.length + 2
    if (parts.length >= size + 6 && want.every((name, i) => parts[parts.length - size + i] === name)) {
      tail = size
      break
    }
  }
  if (tail === 0) return null
  const plugin = parts[parts.length - tail - 2]
  const marketplace = parts[parts.length - tail - 3]
  if (parts[parts.length - tail - 4] !== 'cache' || parts[parts.length - tail - 5] !== 'plugins') return null
  let root = pyPath(`/${parts.slice(1, parts.length - tail - 5).join('/')}`)
  if (isFile(pyPath(`${root}/config.toml`))) root = claudeConfigDir(env, home)
  return `${root}/plugins/data/${plugin}-${marketplace}`
}

export type ConfigResolution = { path: string; reason: string; searched: string[]; legacy: string; warning: string }

// 설정 경로와 판정 근거를 함께 낸다. 파일이 없어도 경로는 낸다.
//
// BROWSER_CONFIG, 캐시의 해당 플러그인 데이터, 캐시 밖의 단일 후보, 옛 위치 순이다.
// 캐시 밖에서는 Claude 설정 폴더의 plugins/data/*/browser.config.json 을 찾는다.
// 후보가 여럿이면 고르지 않고 경고와 함께 옛 위치로 돌아간다.
// 읽기만 한다. 폴더를 만들거나 파일을 옮기지 않는다.
export function resolveConfig(env: Env, moduleFile: string, legacyPath?: string, home?: string): ConfigResolution {
  const legacy = pyPath(legacyPath ?? (home === undefined ? legacyConfig() : `${home}/.claude/browser.config.json`))
  if (env.BROWSER_CONFIG) {
    const path = pyPath(env.BROWSER_CONFIG)
    return { path, reason: '환경변수 BROWSER_CONFIG', searched: [path], legacy, warning: '' }
  }
  const searched: string[] = []
  let warning = ''
  let reason: string
  const data = pluginDataDir(moduleFile, env, home)
  if (data !== null) {
    const path = `${data}/browser.config.json`
    searched.push(path)
    if (isFile(path)) return { path, reason: '설치 캐시의 해당 플러그인 데이터 폴더', searched, legacy, warning }
    reason = '해당 플러그인 데이터 폴더에 설정이 없어 옛 위치 사용'
  } else {
    const dataRoot = `${claudeConfigDir(env, home)}/plugins/data`
    searched.push(`${dataRoot}/*/browser.config.json`)
    const candidates = globConfigs(dataRoot)
    searched.push(...candidates)
    if (candidates.length === 1) return { path: candidates[0], reason: '설치 캐시 밖에서 플러그인 데이터 설정 후보가 하나', searched, legacy, warning }
    if (candidates.length > 0) {
      reason = '설치 캐시 밖에서 플러그인 데이터 설정 후보가 여러 개여서 옛 위치 사용'
      warning = `경고: ${reason}: ${legacy}\n후보 목록:\n${candidates.map((p) => `  ${p}`).join('\n')}\n쓸 파일을 BROWSER_CONFIG 로 지정한다.`
    } else {
      reason = '설치 캐시 밖에서 플러그인 데이터 설정 후보가 없어 옛 위치 사용'
    }
  }
  searched.push(legacy)
  return { path: legacy, reason, searched, legacy, warning }
}

// Path(data_root).glob("*/browser.config.json") 가운데 파일인 것을 이름순으로. 폴더가 없거나 읽을 수 없으면 비었다
function globConfigs(dataRoot: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dataRoot)
  } catch {
    return []
  }
  return names
    .filter((name) => {
      const dir = `${dataRoot}/${name}`
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
    .sort(pyStrCompare)
    .map((name) => `${dataRoot}/${name}/browser.config.json`)
    .filter(isFile)
}

// 캐시 밖에서 여러 후보가 있을 때의 경고는 stdout 대신 stderr 로 낸다
export const CONFIG_RESOLUTION = resolveConfig(process.env, import.meta.filename)
export const CONFIG_PATH = CONFIG_RESOLUTION.path
if (CONFIG_RESOLUTION.warning) eprint(CONFIG_RESOLUTION.warning)

// 용도별 프로필 설정이 없을 때 실제 탐색 경로와 복구 명령을 안내한다
export function profileConfigGuidance(): string {
  const paths = CONFIG_RESOLUTION.searched.map((p) => `  ${p}`).join('\n')
  const legacy = shQuote(CONFIG_RESOLUTION.legacy)
  return (
    `\n설정 파일: ${CONFIG_PATH}\n설정 판정: ${CONFIG_RESOLUTION.reason}` +
    `\n찾아본 경로:\n${paths}` +
    '\negoProfiles 가 있는 설정 파일을 BROWSER_CONFIG 로 지정한다.' +
    '\n  export BROWSER_CONFIG="/실제/설정/browser.config.json"' +
    `\n옛 위치가 없으면 지정한 파일에 링크를 건다:\n  ln -s "$BROWSER_CONFIG" ${legacy}`
  )
}

// 설정 파일에서 키 하나를 읽는다. 파일이나 키가 없으면 null. 값이 거짓(0, 빈 문자열 등)이면 없는 것으로 본다
export function configValue(key: string): unknown {
  if (!exists(CONFIG_PATH)) return null
  let data: unknown
  try {
    data = loadJson(pyReadText(CONFIG_PATH))
  } catch (error) {
    if (error instanceof JsonDecodeError) throw new UsageError(`${CONFIG_PATH} 를 읽지 못했다: ${error.message}`)
    if ((error as NodeJS.ErrnoException).code) throw new UsageError(`${CONFIG_PATH} 를 읽지 못했다: ${osErrorMessage(error, CONFIG_PATH)}`)
    throw error
  }
  // 객체가 아니면 data.get 이 AttributeError 로 끝난다
  if (!(data instanceof Map)) throw new TypeError(`'${typeof data}' object has no attribute 'get'`)
  const value = data.get(key)
  return pyTruthy(value) ? value : null
}

