#!/usr/bin/env node
// docs-refresh 의 session-resume 핸들러(../hooks/session-resume.ts)를 orch 루트의 hooks/ 에 복사한다.
// orch 루트(.orch/)는 git 이 무시해 핸들러를 커밋할 수 없으므로, PC 마다 한 번 이 명령으로 설치한다.
//
// 사용법
//   node .claude/skills/docs-refresh/scripts/install-hook.ts --orch-dir "$(orch paths root)"
//
// 동작
//   대상이 없으면 만든다. 이미 이 스킬의 핸들러(첫 줄 표지가 같다)면 새 내용으로 덮는다.
//   다른 session-resume 핸들러가 있으면 덮지 않는다. 그 핸들러에 check-drift.ts --summary 호출을 직접 더한다.
//
// 종료 코드
//   0  설치했다(`INSTALLED <경로>`) 또는 이미 같다(`UP-TO-DATE <경로>`)
//   2  다른 핸들러가 있어 덮지 않았다(`HANDLER-EXISTS <경로>`), 또는 옵션 오류

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../hooks/session-resume.ts')

export function install(orchDir: string, source = SOURCE): { code: number; line: string } {
  const body = readFileSync(source, 'utf8')
  const mark = body.split('\n')[0]
  const target = join(orchDir, 'hooks', 'session-resume.ts')
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8')
    if (current === body) return { code: 0, line: `UP-TO-DATE ${target}` }
    if (current.split('\n')[0] !== mark) return { code: 2, line: `HANDLER-EXISTS ${target}` }
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
  return { code: 0, line: `INSTALLED ${target}` }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--orch-dir')
  if (i < 0 || !args[i + 1] || args.length !== 2) {
    process.stderr.write('사용법: install-hook.ts --orch-dir <orch 루트>\n')
    process.exitCode = 2
  } else {
    const r = install(resolve(args[i + 1]))
    process.stdout.write(`${r.line}\n`)
    process.exitCode = r.code
  }
}
