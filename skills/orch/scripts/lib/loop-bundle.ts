// doctor 와 status 가 같은 설치 기록으로 루프 번들을 판정한다. 조회만 하며 읽지 못한 경로는 판정하지 않는다.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { real } from './fs.ts'
import { run } from './proc.ts'

const SHA = /^[0-9a-f]{7,40}$/
const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

// 설치 원본은 skills/ 또는 export-only-skills/ 를 한 번 거친다. 옛 캐시도 읽는다.
export function bundleRoot(skillDir: string): string {
  const parent = dirname(skillDir)
  return ['skills', 'export-only-skills'].includes(basename(parent)) ? dirname(parent) : parent
}

// [plugins 디렉터리, 마켓플레이스, 플러그인, 설치 폴더 이름]. 설치 캐시가 아니면 null.
// versions 면 `<sha>` 자리에 플러그인 버전(3.12.0)도 받는다. plugin.json 에 version 이 생긴 뒤 캐시 폴더 이름이 버전이 됐다.
// 설치본 판정은 커밋과 비교하므로 sha 만 받고, 루프 번들 판정은 폴더 이름만 비교하므로 둘 다 받는다
export function installLayout(skillDir: string, versions = false): [string, string, string, string] | null {
  const parents: string[] = []
  for (let dir = bundleRoot(skillDir); parents.length < 5; dir = dirname(dir)) {
    parents.push(dir)
    if (dirname(dir) === dir) break
  }
  const name = parents.length < 5 ? '' : basename(parents[0])
  if (parents.length < 5 || basename(parents[3]) !== 'cache' || !(SHA.test(name) || (versions && VERSION_DIR.test(name)))) return null
  return [parents[4], basename(parents[2]), basename(parents[1]), basename(parents[0])]
}

// 설치 캐시가 아닌 경로나 판정하지 못한 경로는 null 이다
export function staleBundle(script: string, configDir: string): { sha: string; installed: string } | null {
  // 스킬 폴더는 경로의 마지막 `/scripts/` 앞이다. 옛 번들(scripts/<파일>.ts)과 지금 배치(scripts/<묶음>/<파일>.ts)를 같은 규칙으로 읽는다
  const cut = script.lastIndexOf('/scripts/')
  if (cut < 0) return null
  const skillDir = script.slice(0, cut)
  const layout = installLayout(skillDir, true)
  if (!layout) return null
  const [, marketplace, plugin, sha] = layout
  let entries: unknown
  try {
    entries = (JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> }).plugins?.[
      `${plugin}@${marketplace}`
    ]
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  // 다른 범위(project)의 옛 행은 지금 세션이 싣는 번들이 아니다. 그 행과 같다고 통과시키면 옛 번들의 루프를 놓친다
  const rows = (entries as { installPath?: unknown; scope?: unknown }[]).filter((e) => e?.scope === 'user' && typeof e.installPath === 'string' && e.installPath)
  if (rows.length === 0) return null
  const bundle = real(bundleRoot(skillDir))
  // 프로필마다 캐시 폴더가 달라도 같은 번들이면 마지막 폴더 이름(sha 나 버전)이 같다
  if (rows.some((e) => real(e.installPath as string) === bundle || basename(e.installPath as string) === sha)) return null
  return { sha, installed: join(rows[0].installPath as string, relative(bundle, skillDir)) }
}

export function staleLoopBundles(configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): { pid: number; repo: string; sha: string }[] {
  const done = run([process.env.PS || 'ps', '-axo', 'pid=,command='], { env: { LC_ALL: 'C' } })
  if (done.code !== 0) return []
  const loops: { pid: number; repo: string; sha: string }[] = []
  for (const row of done.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(row)
    if (!m || !/\s--foreground(\s|$)/.test(m[3]) || /\s--tick(\s|$)/.test(m[3])) continue
    const found = /(?:^|\s)(\/.*?orch-loop\.ts)(?=\s|$)/.exec(m[3])
    if (!found) continue
    const stale = staleBundle(found[1], configDir)
    if (!stale) continue
    const repo = /\s--repo\s+(.+?)(?=\s--|$)/.exec(m[3])?.[1] ?? '<repo>'
    loops.push({ pid: Number(m[1]), repo, sha: stale.sha })
  }
  return loops
}
