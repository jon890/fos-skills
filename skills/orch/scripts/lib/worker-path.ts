// worker 터미널의 셸이 PATH 로 `orch` 실행기(bin/orch)를 찾는지 띄우기 전에 본다.
//
// 공통 지시서는 명령을 `orch …` 로만 쓴다. 지시서에 실행기 경로를 푸는 코드를 넣지 않으므로, 뜬 worker 의 셸에 `orch` 가 있어야 한다.
// Orca 의 worker-start 는 터미널 환경 변수를 받지 않아 띄우는 쪽이 PATH 를 넣어 줄 수 없다. 그래서 띄우기 전에 같은 조건의 셸을 열어 보고, 못 찾으면 멈춘다.
//
// 보는 방법: 사용자 셸(ORCH_WORKER_SHELL, 없으면 SHELL, 없으면 /bin/zsh)을 PATH 없이 띄워 `$PATH` 를 읽는다. 그 PATH 의 첫 orch 가 표지 있는 실행기여야 한다.
//     zsh 는 `-c`(비대화형, 비로그인)다. 이때 읽는 설정은 ~/.zshenv 뿐이라, Codex worker 의 도구 셸처럼 가장 적게 읽는 셸에서도 찾는지 본다.
//     다른 셸은 `-lc` 다. 비대화형이 설정 파일을 읽지 않는 셸이 많아서다.
// 프로세스의 PATH 는 보지 않는다. 코디네이터가 Claude 세션이면 플러그인 bin/ 이 PATH 에 들어 있어 worker 의 셸과 다르다.
// ORCH_WORKER_PATH 가 있으면 셸을 열지 않고 그 값을 worker 의 PATH 로 본다(테스트 대용).

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LAUNCHER_MARK, launcherOnPath } from './commands.ts'

const PROBE_MS = 10_000

export type WorkerOrch = { ok: true; file: string } | { ok: false; reason: string; fix: string[] }

// worker 의 셸이 갖는 PATH 값. 셸을 열지 못했거나 값이 비면 null
export function workerShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ORCH_WORKER_PATH !== undefined) return env.ORCH_WORKER_PATH
  const shell = env.ORCH_WORKER_SHELL || env.SHELL || '/bin/zsh'
  const probeEnv = { ...env }
  delete probeEnv.PATH
  const flag = basename(shell) === 'zsh' ? '-c' : '-lc'
  const done = spawnSync(shell, [flag, 'printf %s "$PATH"'], { env: probeEnv, encoding: 'utf8', timeout: PROBE_MS })
  if (done.status !== 0 || !done.stdout) return null
  return done.stdout
}

// ~/.local/bin/orch 가 표지 있는 실행기인가
function installedCopy(home: string): string | null {
  const file = join(home, '.local', 'bin', 'orch')
  try {
    return readFileSync(file, 'utf8').slice(0, 400).includes(LAUNCHER_MARK) ? file : null
  } catch {
    return null
  }
}

export function checkWorkerOrch(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): WorkerOrch {
  const workerPath = workerShellPath(env)
  const found = workerPath === null ? null : launcherOnPath(workerPath)
  if (found) return { ok: true, file: found }
  const shell = env.ORCH_WORKER_SHELL || env.SHELL || '/bin/zsh'
  const rc = basename(shell) === 'zsh' ? '~/.zshenv' : '로그인 셸 설정 파일'
  const copy = installedCopy(home)
  const reason = workerPath === null
    ? `셸 ${shell} 을 열어 PATH 를 읽지 못했다`
    : `셸 ${shell} 의 PATH 에서 orch 실행기를 찾지 못했다(PATH=${workerPath})`
  const dir = copy ? dirname(copy) : join(home, '.local', 'bin')
  const fix = [
    ...(copy ? [] : ['orch doctor install-cli']),
    `${rc}에 export PATH="${dir}:$PATH" 를 더한다(비대화형 셸도 읽는 파일이어야 한다)`,
  ]
  return { ok: false, reason, fix }
}

// resume 처럼 터미널 명령을 우리가 쓰는 자리에서 PATH 앞에 더할 폴더. 설치된 사본이 없으면 null
export function installedLauncherDir(home: string = homedir()): string | null {
  const copy = installedCopy(home)
  return copy ? dirname(copy) : null
}
