// Docker 자원 (저장소마다 머지 큐 로그 뒤에 한 번. --run 이 없어도 한다):
//     config.json 의 docker 절(lib/docker.ts 의 dockerRules)이 선언한 컨테이너 가운데 띄운 프로세스가 없는 것과,
//     선언한 이미지 가운데 최근 keep 개와 컨테이너가 쓰는 것을 뺀 태그를 지운다. --apply 가 없으면 지울 것만 낸다.
//     워크트리에 귀속된 compose 컨테이너는 remove-worktree.ts 가 워크트리를 지운 직후 지운다.
//     판정과 출력 줄은 lib/docker.ts 머리 주석이, 무엇을 남기는지는 skills/orch/references/cleanup.md 의 「Docker 자원 반납」 이 소유한다.
//     docker 절이 틀렸으면(ConfigError) stderr 에 이유를 내고 종료 코드를 2 로 둔다. Docker 를 쓸 수 없으면 경고 한 줄만 낸다.


// 머리 주석의 「Docker 자원」. docker 절이 틀렸으면 false 다
import { ConfigError, loadConfig } from '../../lib/config.ts'
import type { Log } from './shared.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { dockerCleanup, dockerRules } from '../../lib/docker.ts'
import { err } from './shared.ts'

function sweepDocker(repo: string, apply: boolean, log: Log): boolean {
  let rules
  try {
    rules = dockerRules(loadConfig(repo))
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    err(`cleanup-sweep: ${repo}: Docker 정리를 하지 않는다: ${e.message}`)
    return false
  }
  dockerCleanup({ rules, apply, log })
  return true
}

export async function cleanupDocker(ctx: StepContext, state: StepState): Promise<StepResult> {
  return sweepDocker(ctx.repo, ctx.args.apply, ctx.log) ? {} : { code: 2 }
}
