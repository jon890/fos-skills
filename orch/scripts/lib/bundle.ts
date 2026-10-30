// 직접 부른 스크립트도 설치 기록과 다른 번들이면 stderr 에 한 줄 알린다.
// args.ts 와 proc.ts 가 함께 import 한다. ESM 모듈은 한 번만 실행되어 경고도 한 번이다.
// 체크아웃·링크 설치는 갱신 전 검증에 쓰므로 plugins/cache 안의 복사본만 판정한다.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function canonical(value: string): string {
  try { return realpathSync(value) } catch { return resolve(value) }
}

export function staleBundleWarning(bundle: string, configDir: string): string | null {
  if (!/[\\/]plugins[\\/]cache[\\/]/.test(bundle)) return null
  try {
    const entries = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.['fos-skills@fos-skills']
    if (!Array.isArray(entries)) return null
    const valid = entries.filter((e) => typeof e?.installPath === 'string' && existsSync(join(e.installPath, 'orch', 'scripts')))
    const installed = [...valid.filter((e) => e.scope === 'user'), ...valid.filter((e) => e.scope !== 'user')][0]?.installPath
    if (!installed || canonical(installed) === canonical(bundle)) return null
    return `STALE-BUNDLE orch: ${bundle} 는 현재 설치본과 다르다. 현재 진입점: ${join(installed, 'orch', 'bin', 'orch.ts')}`
  } catch { return null }
}

const warning = staleBundleWarning(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
if (warning) process.stderr.write(`${warning}\n`)
