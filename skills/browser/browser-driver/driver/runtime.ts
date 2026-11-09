// 동기 명령 하나의 환경·출력·자식 실행 범위. 기본 CLI는 기존 Node 동작을 쓴다.
// os.homedir()와 process.cwd()는 주입하지 않는다. 이 경계를 검증할 때는 실제 CLI를 쓴다.
// 함수 테스트는 HOME을 명시하고, FunctionBox는 cwd 옵션이 있으면 실제 CLI로 넘긴다.
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'

export type Runtime = {
  env: NodeJS.ProcessEnv
  write: (fd: 1 | 2, text: string) => void
  spawn?: typeof spawnSync
}
const scope = new AsyncLocalStorage<Runtime>()
export const currentRuntime = (): Runtime | undefined => scope.getStore()
export const runtimeEnv = (): NodeJS.ProcessEnv => scope.getStore()?.env ?? process.env
export const runtimeSpawnSync: typeof spawnSync = ((...args: Parameters<typeof spawnSync>) =>
  (scope.getStore()?.spawn ?? spawnSync)(...args)) as typeof spawnSync
export function withRuntime<T>(runtime: Runtime, action: () => T): T {
  return scope.run(runtime, action)
}
