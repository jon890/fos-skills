// 테스트용 임시 폴더. 만든 폴더는 테스트 파일이 끝날 때 지운다.
//
// `t`(TestContext)를 주면 그 테스트의 `t.after` 에서 지운다. 주지 않으면 모듈 수준 목록에 모았다가
// 파일 끝(루트 `after`)이나 프로세스 종료(`exit`)에서 한꺼번에 지운다.
// `beforeEach`, `before` 안에서 부른 `after` 는 그 훅이 끝나자마자 돌아 테스트 본문보다 먼저 지워지므로 쓰지 않는다.
// `TESTKIT_KEEP=1` 이면 지우지 않고 경로를 stderr 에 낸다.
// node:test 를 import 하는 testkit 파일은 이것 하나다. 일반 스크립트가 이 파일을 import 하면 stdout 끝에 node:test 요약이 붙는다.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

const folders: string[] = []

function cleanupAll(): void {
  const list = folders.splice(0)
  for (const dir of list) removeOrKeep(dir)
}

function removeOrKeep(dir: string): void {
  if (process.env.TESTKIT_KEEP === '1') {
    process.stderr.write(`testkit: 남긴 폴더 ${dir}\n`)
    return
  }
  rmSync(dir, { recursive: true, force: true })
}

after(cleanupAll)
process.on('exit', cleanupAll)

export function tempDir(prefix = 'testkit-', t?: { after(fn: () => void): void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  if (t) t.after(() => removeOrKeep(dir))
  else folders.push(dir)
  return dir
}
