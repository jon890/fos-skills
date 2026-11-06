#!/usr/bin/env node
// origin 리모트에서 gh 가 봐야 할 호스트 이름을 출력한다.
//
// 사용법:
//   GH_HOST=$(node "$SKILL_DIR/scripts/gh-host.ts")                      # 이후 같은 호출 안의 gh api 에 적용된다
//   gh api --hostname "$(node "$SKILL_DIR/scripts/gh-host.ts")" <경로>   # 한 번만 쓸 때
//
// gh api 는 --repo 를 받지 않아 기본 호스트를 본다.
// 사내 GHE 저장소에서 호스트를 넘기지 않으면 Not Found 가 난다.
// 결과가 github.com 이어도 그대로 넘긴다. 넘겨도 동작이 달라지지 않는다 (실측).
//
// 환경 변수는 호출 사이에 남지 않는다 (실측). 에이전트 하네스는 명령마다 새 셸을 띄운다.
// 그래서 이 값은 쓰는 쪽과 같은 호출 안에서 구한다.
// 이 폴더의 다른 스크립트는 스스로 이것을 부르므로 미리 export 할 필요가 없다.
//
// origin 이 SSH config 별칭이면 별칭이 그대로 나오므로 ssh -G 로 실제 호스트를 되찾는다.
// 실측: git@github-personal:... 이 github-personal 로 나왔고, 그대로 쓰면
//       "error connecting to github-personal" 로 실패했다. ssh -G 가 github.com 으로 되돌린다.
//
// 호출자가 GH_HOST 를 지정했으면 그것을 존중한다. 오버레이가 호스트를 고정하는 경우가 있다.
//
// 종료 코드: 0 호스트를 냈다, 1 origin 주소에서 호스트를 읽지 못했다, 그 밖에는 git remote get-url 이 낸 코드(origin 이 없으면 2)

import { spawnSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import { isMainModule } from './is-main.ts'

// 파이프가 가득 차 EAGAIN 이 나도 다 쓴다. 자식 프로세스와 같은 fd 에 쓰므로 순서가 바뀌지 않게 동기로 쓴다
export function write(fd: 1 | 2, text: string): void {
  let buf = Buffer.from(text)
  while (buf.length) {
    try {
      buf = buf.subarray(writeSync(fd, buf))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
    }
  }
}

export class HostError extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

export function detectHost(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GH_HOST) return env.GH_HOST
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', env, stdio: ['inherit', 'pipe', 'inherit'] })
  if (remote.status !== 0) throw new HostError('', remote.status ?? 1)
  // 명령 치환처럼 끝의 줄바꿈을 뗀다
  const url = remote.stdout.replace(/\n+$/, '')
  const host = url.replace(/^[^@/]*@([^:/]+)[:/].*/, '$1').replace(/^[a-z]+:\/\/([^/]+)\/.*/, '$1')
  if (!host) throw new HostError(`origin 리모트에서 호스트를 읽지 못했다: ${url}`, 1)
  const ssh = spawnSync('ssh', ['-G', host], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] })
  const resolved = (ssh.stdout ?? '')
    .split('\n')
    .find((line) => line.startsWith('hostname '))
    ?.split(/\s+/)[1]
  return resolved || host
}

export function main(): number {
  try {
    write(1, `${detectHost()}\n`)
    return 0
  } catch (error) {
    if (!(error instanceof HostError)) throw error
    if (error.message) write(2, `${error.message}\n`)
    return error.code
  }
}

const isMain = isMainModule(import.meta.url, import.meta.main)
if (isMain) process.exitCode = main()
