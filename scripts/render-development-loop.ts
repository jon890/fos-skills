#!/usr/bin/env node
// README 의 Mermaid 원본에서 손그림 SVG(docs/images/development-loop.svg)를 다시 만든다. 원본은 README 한곳에만 둔다.
//
// 의존성: @mermaid-js/mermaid-cli 12.2.0 (mmdc), 해당 CLI 가 지원하는 Chrome.
// 사용: node scripts/render-development-loop.ts [--mmdc /path/to/mmdc] [--puppeteer-config 설정.json] [--preview /tmp/loop.png]
//   --mmdc              mmdc 실행 파일 (기본 mmdc)
//   --puppeteer-config  컨테이너의 브라우저 설정. 절대 경로로 바꿔 mmdc 의 -p 로 넘긴다
//   --preview           시각 검토용 PNG 도 만든다
// 저장소는 이 파일의 상위 폴더다. 긴 옵션은 고유 접두로 줄여 쓸 수 있다.
// 출력: 만든 SVG 의 저장소 상대 경로 한 줄.
// 종료 코드: 0 만들었다, 1 mmdc 가 실패했거나 90초를 넘겼다, 2 사용법 오류나 README 에 Mermaid 원본이 없다

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from '../modules/kit/args.ts'
import { pyReadText } from '../modules/kit/py.ts'
import { isMainModule } from './is-main.ts'

const ROOT = join(import.meta.dirname, '..')
const USAGE = 'usage: render-development-loop.ts [-h] [--mmdc MMDC] [--puppeteer-config PUPPETEER_CONFIG] [--preview PREVIEW]'
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  mmdc: { type: 'string', default: 'mmdc' },
  'puppeteer-config': { type: 'string' },
  preview: { type: 'string' },
} as const
const TIMEOUT_MS = 90_000

function usageError(message: string): number {
  process.stderr.write(`${USAGE}\nrender-development-loop.ts: error: ${message}\n`)
  return 2
}

function mmdc(argv: string[]): boolean {
  const done = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', timeout: TIMEOUT_MS })
  if (done.error || done.status !== 0) {
    process.stderr.write(`render-development-loop: ${argv[0]} 가 실패했다 (${done.error?.message ?? `종료 코드 ${done.status ?? done.signal}`})\n`)
    return false
  }
  return true
}

export function main(argv: string[], root: string = ROOT): number {
  let values: { help?: boolean; mmdc: string; 'puppeteer-config'?: string; preview?: string }
  try {
    values = parseArgs({ args: expandArgs(argv, OPTIONS), options: OPTIONS, strict: true, allowPositionals: false }).values as typeof values
  } catch (error) {
    return usageError((error as Error).message)
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n\nREADME 의 Mermaid 원본에서 손그림 SVG 를 다시 만든다. 자세한 것은 이 파일의 머리 주석에 있다.\n`)
    return 0
  }
  // re.M | re.S 의 ^ 다. JS 의 m 플래그는 \r, \u2028 도 줄 경계로 본다
  const source = /(?<![^\n])```mermaid\n([\s\S]*?)\n```/.exec(pyReadText(join(root, 'README.md')))
  if (!source) return usageError('README 에 Mermaid 원본이 없다')
  const output = join(root, 'docs/images/development-loop.svg')
  mkdirSync(dirname(output), { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'render-loop-'))
  try {
    const diagram = join(tmp, 'development-loop.mmd')
    writeFileSync(diagram, `${source[1]}\n`)
    const common = [values.mmdc, '-i', diagram, '-c', join(root, 'docs/diagrams/development-loop.config.json'), '-b', 'white', '--size', '1400']
    if (values['puppeteer-config']) common.push('-p', resolve(values['puppeteer-config']))
    if (!mmdc([...common, '-o', output])) return 1
    if (values.preview && !mmdc([...common, '-o', resolve(values.preview)])) return 1
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  process.stdout.write(`${relative(root, output)}\n`)
  return 0
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다
const isMain = isMainModule(import.meta.url, import.meta.main)
if (isMain) process.exitCode = main(process.argv.slice(2))
