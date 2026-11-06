// 명령 경계 테스트가 함께 쓰는 도우미. 옛 명령은 자기 파일 위치의 상위 폴더를 저장소로 쓰므로,
// 명령 파일을 임시 저장소의 같은 상대 경로로 복사해 거기서 부른다. 이 저장소의 파일은 바꾸지 않는다.

import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const REPO_ROOT = join(import.meta.dirname, '..', '..')

// files 는 저장소 상대 경로다. 실행 비트도 함께 옮긴다
export function copyFromRepo(root: string, files: readonly string[]): void {
  for (const file of files) {
    const target = join(root, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(REPO_ROOT, file), target)
    chmodSync(target, statSync(join(REPO_ROOT, file)).mode & 0o7777)
  }
}
