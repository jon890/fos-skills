// 직접 부른 스크립트도 설치 기록과 다른 번들이면 stderr 에 한 줄 알린다.
// args.ts 와 proc.ts 가 함께 import 한다. ESM 모듈은 한 번만 실행되어 경고도 한 번이다.
// 체크아웃·링크 설치는 갱신 전 검증에 쓰므로 plugins/cache 안의 복사본만 판정한다.
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, entryOf, selectBundle } from './install-record.ts'

// 현재 설치본은 install-record.ts 의 selectBundle 로 정한다. 고르지 못하면(설치 기록 오류) 판정하지 않는다.
// 그 경우는 진입점의 종료 코드 3 과 doctor 의 설치 기록 판정이 알린다
export function staleBundleWarning(bundle: string, configDir: string): string | null {
  if (!/[\\/]plugins[\\/]cache[\\/]/.test(bundle)) return null
  const chosen = selectBundle(configDir, bundle)
  if ('error' in chosen || chosen.source === 'own') return null
  if (canonical(chosen.bundle) === canonical(bundle)) return null
  return `STALE-BUNDLE orch: ${bundle} 는 현재 설치본과 다르다. 현재 진입점: ${entryOf(chosen.bundle)}`
}

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const parent = dirname(skill)
const bundle = ['skills', 'export-only-skills'].includes(basename(parent)) ? dirname(parent) : parent
const warning = staleBundleWarning(bundle, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
if (warning) process.stderr.write(`${warning}\n`)
