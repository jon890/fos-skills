// 직접 부른 스크립트도 설치 기록과 다른 번들이면 stderr 에 한 줄 알린다.
// args.ts 와 proc.ts 가 함께 import 한다. ESM 모듈은 한 번만 실행되어 경고도 한 번이다.
// 진입점의 문맥 신호 ORCH_CONTEXT 와 짧은 출력 신호 ORCH_OUTPUT 도 여기서 읽고 지운다(아래 orchContext, orchOutput). 모든 진입 스크립트가 먼저 지나는 자리다.
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

export function bundleRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '../..') }

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const parent = dirname(skill)
const bundle = ['skills', 'export-only-skills'].includes(basename(parent)) ? dirname(parent) : parent
const warning = staleBundleWarning(bundle, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
if (warning) process.stderr.write(`${warning}\n`)

// 진입점이 새 꼴에서 채운 문맥 인자의 출처(ORCH_CONTEXT). 읽은 뒤 환경에서 지워, 이 스크립트가 띄우는 자식과 상주 루프, 핸들러로 새지 않게 한다
const context: Record<string, string> = Object.fromEntries(
  (process.env.ORCH_CONTEXT ?? '')
    .split(/\s+/)
    .filter((pair) => pair.includes('='))
    .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
)
delete process.env.ORCH_CONTEXT

export function orchContext(): Record<string, string> {
  return { ...context }
}

// 진입점이 넘긴 짧은 출력 신호(ORCH_OUTPUT=short). 판정은 lib/output.ts 의 short() 다.
// 읽은 뒤 환경에서 지워 이 스크립트가 띄우는 자식으로 새지 않게 한다. 출력을 그대로 잇는 자식에는 부르는 쪽이 shortEnv() 로 다시 넘긴다
const output = process.env.ORCH_OUTPUT ?? ''
delete process.env.ORCH_OUTPUT

export function orchOutput(): string {
  return output
}
