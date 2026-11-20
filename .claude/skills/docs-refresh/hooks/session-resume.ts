// fos-skills docs-refresh session-resume handler
// orch 의 session-resume 핸들러다. `orch doctor --run` 이 부르면 설명 문서의 어긋남을 한 줄로 알린다.
// scripts/install-hook.ts 가 이 파일을 <orch 루트>/hooks/session-resume.ts 로 복사한다. 첫 줄은 설치기가 자기 파일인지 알아보는 표지다.
// 검사 규칙은 저장소의 check-drift.ts 가 갖는다. 이 파일은 그것을 부르기만 해서, main 을 받으면 복사본을 다시 설치하지 않아도 새 규칙으로 돈다.
// session-resume 은 거부할 수 없는 이벤트라 늘 0 으로 끝낸다. 검사가 실패해도 doctor 를 막지 않는다.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.env.ORCH_REPO ?? process.cwd()
const script = join(repo, '.claude/skills/docs-refresh/scripts/check-drift.ts')
if (existsSync(script)) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, '--root', repo, '--summary'], { encoding: 'utf8' })
  if (r.status === 1 && r.stdout.trim()) console.log(r.stdout.trim().split('\n')[0])
  else if (r.status !== 0) console.log(`DOCS-DRIFT 검사를 돌리지 못했다(종료 코드 ${r.status}). node ${script} 로 확인한다`)
}
