// `orch worker resume` 가 연 새 터미널에서 도는 실행기다. 사용법: resume-exec.ts <요청 폴더>
// 새 터미널의 셸이 `node resume-exec.ts <폴더> && . <폴더>/launch.sh` 로 부른다. 이 프로세스는 에이전트를 자식으로 띄우지 않는다.
// launch.sh 를 쓰고 끝나면 셸이 그 줄을 exec 해 에이전트가 터미널의 직접 프로세스가 된다(설계 DECISION6).
// lib/resume.ts 만 import 한다. lib/bundle.ts 의 경고나 orca 조회 없이 뜨게 하려는 것이다.
//
// 차례(docs/features/limit-resume/design.md 「실행기」):
//     1. request.json 을 읽고 자기 계정 환경의 기록 폴더에서 세션을 찾는다.
//        Claude 는 CLAUDE_CONFIG_DIR(없으면 ~/.claude), Codex 는 CODEX_HOME(없으면 ~/.codex)이다
//     2. Claude 면 --plugin-dir 을 정한다(ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR, 없으면 request.json 의 pluginDir).
//        Codex 면 ORCA_* 다섯이 모두 있어야 한다
//     3. found.json 에 결과를 쓴다
//     4. 내용이 자기 nonce 인 go 를 goDeadline 까지 200ms 간격으로 기다린다. 다른 실행의 go 로는 출발하지 않는다
//     5. launch.sh 에 exec 한 줄을 쓴다
// 종료 코드: 0 launch.sh 를 썼다, 2 사용법이나 request.json 오류, 3 세션이나 실행 인자를 찾지 못했다, 4 출발 신호 시한이 지났다.
// 0 이 아니면 launch.sh 가 없어 셸이 에이전트를 띄우지 않는다.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeResumeArgv, codexResumeArgv, findClaudeSession, findCodexSession, goFor, pickPluginDir, readRequest, writeFound, writeLaunch } from '../lib/resume.ts'
import type { ResumeRequest } from '../lib/resume.ts'

const POLL_MS = 200

function fail(dir: string, reason: string): number {
  writeFound(dir, { ok: false, reason })
  process.stderr.write(`RESUME-EXEC-FAIL ${reason}\n`)
  return 3
}

async function main(): Promise<number> {
  const dir = process.argv[2]
  if (!dir || process.argv.length !== 3) {
    process.stderr.write('사용법: resume-exec.ts <요청 폴더>\n')
    return 2
  }
  let req: ResumeRequest
  try {
    req = readRequest(dir)
  } catch (error) {
    // 코디네이터가 시한까지 기다리지 않고 이유를 보게 found.json 에도 남긴다
    try {
      writeFound(dir, { ok: false, reason: `요청을 읽지 못했다: ${(error as Error).message}` })
    } catch {
      // 폴더가 없으면 남길 곳이 없다
    }
    process.stderr.write(`RESUME-EXEC-FAIL ${(error as Error).message}\n`)
    return 2
  }
  const home = req.agent === 'claude' ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') : process.env.CODEX_HOME || join(homedir(), '.codex')
  const session = req.agent === 'claude' ? findClaudeSession(home, req.worktree, req.dispatch) : findCodexSession(home, req.worktree, req.dispatch)
  if (!session) return fail(dir, `${home} 에 ${req.worktree} 의 dispatch ${req.dispatch} 가 든 ${req.agent} 세션 기록이 없다`)
  let argv: string[] | null
  if (req.agent === 'claude') {
    const pluginDir = pickPluginDir(process.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR, req.pluginDir)
    if (!pluginDir) return fail(dir, '--plugin-dir 을 정하지 못했다. ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR 도, 옛 에이전트의 실행 줄 값도 없다')
    argv = claudeResumeArgv(session, req, pluginDir)
  } else {
    argv = codexResumeArgv(session, req, process.env)
    if (!argv) return fail(dir, 'Orca 가 Codex 에 넘길 ORCA_* 환경 변수가 이 터미널에 다 있지 않다')
  }
  writeFound(dir, { ok: true, session, home, terminal: process.env.ORCA_TERMINAL_HANDLE ?? null })
  while (!goFor(dir, req.nonce)) {
    if (Date.now() > req.goDeadline) {
      process.stderr.write('RESUME-EXEC-FAIL 출발 신호를 시한 안에 받지 못했다. 에이전트를 띄우지 않는다\n')
      return 4
    }
    await new Promise((done) => setTimeout(done, POLL_MS))
  }
  writeLaunch(dir, argv)
  return 0
}

process.exitCode = await main()
