// 파일이 직접 실행된 진입인지 판정한다. 이 폴더의 .ts 진입이 함께 쓴다.
// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다.
// 심볼릭 링크나 /var → /private/var 경로로 불리면 argv[1] 은 링크 경로이고 import.meta.url 은 실체 경로라
// 둘 다 realpathSync 로 실체로 바꿔 비교한다. realpathSync 가 던지면 false 다.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMainModule(url: string, flag: boolean | undefined): boolean {
  if (flag) return true
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
}
