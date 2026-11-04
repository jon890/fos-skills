// 파일 경로 판정의 한 벌이다. 실경로, 파일 여부, 하위 경로 판정을 orch 모듈이 같은 규칙으로 쓰게 한다.

import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

// 실경로. 없거나 읽지 못하면 절대경로로만 바꾼다.
export function real(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

// 없는 경로도 실경로로 바꾼다. 있는 앞부분까지 실경로로 풀고 나머지를 붙인다. Python 의 os.path.realpath 와 같다.
export function realPath(target: string): string {
  const full = resolve(target)
  try {
    return realpathSync(full)
  } catch {
    const parent = dirname(full)
    return parent === full ? full : join(realPath(parent), basename(full))
  }
}

// 따라간 끝이 보통 파일인지. 없거나 읽지 못하면 false.
export function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

// target 이 root 자신이거나 그 아래인지. 문자열로만 비교하므로 실경로 비교가 필요하면 부르는 쪽이 둘 다 바꿔 넘긴다.
// root 가 sep 로 끝나도(예: /) 한 번만 붙여 비교한다.
export function inside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}
