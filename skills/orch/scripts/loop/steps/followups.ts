// 배포 뒤 할 일 알림: 틱마다 한 번 lib/followups.ts 의 followupTick 을 부른다. 판정과 기록 규칙은 그 머리 주석의 「루프 확인」 이 소유한다.
//     배포 설정은 config.json 의 finish.deploy_workflow 와 deploy_branch 다. 둘 다 있어야 배포를 다시 본다.
//     알림은 이 틱의 주 Run(StepContext.primary)에 FOLLOWUP-READY kind 로 바로 보낸다. 코디네이터가 확인할 일이라 모아 보내지 않는다.
//     로그: 배포를 새로 확인한 PR 은 `FOLLOWUP-DEPLOYED #a #b`, 알린 PR 은 `FOLLOWUP-READY #a #b`, 보내지 못하면 `NOTICE-FAIL FOLLOWUP-READY <이유>`.
//     읽기·쓰기나 보내기에 실패하면 errors 의 followups 에 이유를 둔다. 다음 틱이 다시 한다

import { loadConfig, section } from '../../lib/config.ts'
import { FINISH_KEYS } from '../../lib/finish-options.ts'
import { followupTick } from '../../lib/followups.ts'
import type { DeploySettings } from '../../lib/followups.ts'
import { notifyRun } from '../../lib/run-notice.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { log, oneLine } from './shared.ts'

function deploySettings(repo: string): DeploySettings | null {
  const finish = section<{ deploy_workflow?: unknown; deploy_branch?: unknown }>(loadConfig(repo), 'finish', FINISH_KEYS)
  const workflow = typeof finish.deploy_workflow === 'string' ? finish.deploy_workflow : ''
  const branch = typeof finish.deploy_branch === 'string' ? finish.deploy_branch : ''
  return workflow && branch ? { workflow, branch } : null
}

export async function notifyFollowups(ctx: StepContext, _state: StepState): Promise<StepResult> {
  const errors: Record<string, string | null> = {}
  try {
    const got = followupTick(ctx.repo, {
      deploy: deploySettings(ctx.repo),
      run: ctx.primary,
      notify: (run, text) => {
        const sent = notifyRun(run, 'FOLLOWUP-READY', text, null, { repo: ctx.repo, subject: `FOLLOWUP-READY 배포 뒤 할 일` })
        return sent.ok ? { ok: true } : sent
      },
    })
    if (got.deployed.length > 0) log(`FOLLOWUP-DEPLOYED ${got.deployed.map((pr) => `#${pr}`).join(' ')}`)
    if (got.notified.length > 0) log(`FOLLOWUP-READY ${got.notified.map((pr) => `#${pr}`).join(' ')}`)
    if (got.error) {
      log(`NOTICE-FAIL FOLLOWUP-READY ${oneLine(got.error)}`)
      errors.followups = oneLine(got.error)
    } else if (typeof ctx.previous?.followups === 'string') {
      errors.followups = null
    }
  } catch (e) {
    log(`orch-loop: 배포 뒤 할 일을 확인하지 못했다: ${oneLine(e)}`)
    errors.followups = oneLine(e)
  }
  return { errors }
}
