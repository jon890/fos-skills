// orch doctor 의 「Codex CLI 판정」. 설치된 Codex CLI 가 최신 버전보다 낮으면 CODEX-OUTDATED 와 갱신 명령 한 줄을 낸다(스펙 REQ6).
// Codex CLI 가 낡으면 `codex debug models` 에 새 세대가 나오지 않아, 띄우기의 새 세대 전환(lib/model-generation.ts)도 일어나지 않는다.
//
// 대상: `codex` 명령이 있는 머신만이다. CODEX_BIN, 없으면 PATH 에서 처음 찾은 실행 파일 `codex` 다. 없으면 아무 줄도 내지 않는다.
// 설치 버전: `<codex> --version` 출력의 첫 x.y.z. 읽지 못하면 줄을 내지 않는다.
// 최신 버전: GitHub 의 openai/codex 최신 릴리스(LATEST_URL)의 tag_name(`rust-v0.166.0`)에서 읽는다. ORCH_CODEX_LATEST_URL 로 주소를 바꾸고 file: 주소도 받는다(테스트).
//     FETCH_MS(5초) 안에 읽지 못하거나 꼴이 다르면 줄을 내지 않는다. doctor 는 오프라인에서도 돌아야 한다.
//     읽은 값은 <머신 폴더>/codex-latest.json 에 { version, at } 로 CACHE_MS(12시간) 둔다. 스킬을 열 때마다 네트워크를 부르지 않는다.
// 종료 코드에 영향이 없는 경고다. 갱신은 하지 않는다(스펙 범위 밖).
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { machineDir } from '../lib/machine.ts'
import { run } from '../lib/proc.ts'

export const LATEST_URL = 'https://api.github.com/repos/openai/codex/releases/latest'
const FETCH_MS = 5_000
const CACHE_MS = 12 * 60 * 60 * 1000

export function findCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CODEX_BIN) return executable(env.CODEX_BIN) ? env.CODEX_BIN : null
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, 'codex')
    if (executable(file)) return file
  }
  return null
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function versionOf(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null
}

export function compareVersion(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

async function fetchLatest(url: string): Promise<string | null> {
  try {
    const body = url.startsWith('file:')
      ? readFileSync(fileURLToPath(url), 'utf8')
      : await (await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { accept: 'application/vnd.github+json', 'user-agent': 'orch-doctor' } })).text()
    const tag = (JSON.parse(body) as { tag_name?: unknown }).tag_name
    return typeof tag === 'string' ? versionOf(tag) : null
  } catch {
    return null
  }
}

async function latestVersion(now: number): Promise<string | null> {
  const url = process.env.ORCH_CODEX_LATEST_URL || LATEST_URL
  const cache = join(machineDir(), 'codex-latest.json')
  // 테스트가 주소를 바꾸면 캐시를 쓰지 않는다
  const cached = url === LATEST_URL ? readCache(cache, now) : null
  if (cached) return cached
  const version = await fetchLatest(url)
  if (version && url === LATEST_URL) {
    try {
      mkdirSync(dirname(cache), { recursive: true })
      writeFileSync(`${cache}.${process.pid}.tmp`, JSON.stringify({ version, at: now }))
      renameSync(`${cache}.${process.pid}.tmp`, cache)
    } catch { /* 캐시를 못 쓰면 다음에 다시 읽는다 */ }
  }
  return version
}

function readCache(file: string, now: number): string | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; at?: unknown }
    return typeof raw.version === 'string' && typeof raw.at === 'number' && now - raw.at < CACHE_MS ? raw.version : null
  } catch {
    return null
  }
}

export async function codexOutdatedLines(now = Date.now()): Promise<string[]> {
  const bin = findCodex()
  if (!bin) return []
  const done = run([bin, '--version'], { timeoutMs: 10_000 })
  const installed = done.code === 0 ? versionOf(done.stdout) : null
  if (!installed) return []
  const latest = await latestVersion(now)
  if (!latest || compareVersion(installed, latest) >= 0) return []
  return [`CODEX-OUTDATED ${installed} ${latest}`, '  codex update']
}
