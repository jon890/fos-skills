// worker 터미널의 셸이 PATH 로 `orch` 실행기(bin/orch)와 그 실행기가 쓰는 node 를 찾는지 띄우기 전에 본다.
//
// 공통 지시서는 명령을 `orch …` 로만 쓴다. 지시서에 실행기 경로를 푸는 코드를 넣지 않으므로, 뜬 worker 의 셸에 `orch` 가 있어야 한다.
// Orca 의 worker-start 는 터미널 환경 변수를 받지 않아 띄우는 쪽이 PATH 를 넣어 줄 수 없다. 그래서 띄우기 전에 같은 조건의 셸을 열어 보고, 못 찾으면 멈춘다.
//
// 보는 방법: 사용자 셸(ORCH_WORKER_SHELL, 없으면 SHELL, 없으면 /bin/zsh)을 로그인 셸(`-lc`)로 PATH 없이 띄워 `$PATH` 를 읽는다.
//     zsh 면 ~/.zshenv 와 ~/.zprofile 을 읽고 ~/.zshrc 는 읽지 않는다. 기준을 셸 종류와 무관하게 `-lc` 하나로 둔 것은, worker 가 쓰는 도구 셸
//     (Codex 의 명령 셸, Claude 의 Bash)이 대화형 설정(~/.zshrc)에만 있는 PATH 를 못 받을 수 있어서다.
//     설정 파일이 출력을 내도 PATH 로 읽지 않게 표지(__ORCH_PATH__) 뒤만 읽는다.
// 그 PATH 의 첫 `orch` 가 표지 있는 실행기여야 하고, 실행기의 `#!/usr/bin/env node` 가 돌도록 같은 PATH 에 node 도 있어야 한다.
// 프로세스의 PATH 는 보지 않는다. 코디네이터가 Claude 세션이면 플러그인 bin/ 이 PATH 에 들어 있어 worker 의 셸과 다르다.
// ORCH_WORKER_PATH 가 있으면 셸을 열지 않고 그 값을 worker 의 PATH 로 본다(테스트 대용).
// Claude worker 는 플러그인 bin/ 이 PATH 에 들어가므로 부르는 쪽(launch, resume)이 확인하지 않는다.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { LAUNCHER_MARK, launcherOnPath } from './commands.ts'

const PROBE_MS = 10_000
const PATH_MARK = '__ORCH_PATH__'

export type WorkerOrch = { ok: true; file: string } | { ok: false; reason: string; fix: string[] }

// worker 의 셸이 갖는 PATH 값. 셸을 열지 못했거나 값이 비면 null
export function workerShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ORCH_WORKER_PATH !== undefined) return env.ORCH_WORKER_PATH
  const shell = env.ORCH_WORKER_SHELL || env.SHELL || '/bin/zsh'
  const probeEnv = { ...env }
  delete probeEnv.PATH
  const done = spawnSync(shell, ['-lc', `printf '\\n${PATH_MARK}%s' "$PATH"`], { env: probeEnv, encoding: 'utf8', timeout: PROBE_MS })
  if (done.status !== 0) return null
  const at = done.stdout.lastIndexOf(PATH_MARK)
  const value = at < 0 ? '' : done.stdout.slice(at + PATH_MARK.length)
  return value === '' ? null : value
}

// PATH 값 안의 실행 파일. 링크는 따라간다
function executableOn(pathValue: string, name: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return file
    } catch {
      continue
    }
  }
  return null
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
  if (found && workerPath !== null && executableOn(workerPath, 'node')) return { ok: true, file: found }
  const shell = env.ORCH_WORKER_SHELL || env.SHELL || '/bin/zsh'
  const zsh = basename(shell) === 'zsh'
  const rc = zsh ? '~/.zshenv' : '로그인 셸 설정 파일'
  const copy = installedCopy(home)
  const dir = copy ? dirname(copy) : join(home, '.local', 'bin')
  if (found) {
    return {
      ok: false,
      reason: `셸 ${shell} 의 PATH 에서 node 를 찾지 못했다(PATH=${workerPath}). 실행기가 \`#!/usr/bin/env node\` 로 돈다`,
      fix: [`${rc}에 node 가 있는 폴더를 PATH 에 더한다(비대화형 로그인 셸이 읽는 파일이어야 한다)`],
    }
  }
  const reason = workerPath === null
    ? `셸 ${shell} 을 로그인 셸로 열어 PATH 를 읽지 못했다`
    : `셸 ${shell} 의 PATH 에서 orch 실행기를 찾지 못했다(PATH=${workerPath})`
  const fix = [
    ...(copy ? [] : ['orch doctor install-cli']),
    `${rc}에 export PATH="${dir}:$PATH" 를 더한다(비대화형 로그인 셸이 읽는 파일이어야 한다)`,
    ...(zsh ? ['~/.zshrc 에만 있는 PATH 설정은 읽지 않는다. 위 파일(~/.zshenv 나 ~/.zprofile)로 옮긴다'] : []),
  ]
  return { ok: false, reason, fix }
}

// resume 처럼 터미널 명령을 우리가 쓰는 자리에서 PATH 앞에 더할 폴더. 설치된 사본이 없으면 null
export function installedLauncherDir(home: string = homedir()): string | null {
  const copy = installedCopy(home)
  return copy ? dirname(copy) : null
}
