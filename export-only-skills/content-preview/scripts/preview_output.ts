// 미리보기 생성기가 공유하는 출력 파일 처리와 HTML 이스케이프.
//
// 생성기가 실패했을 때 이전 미리보기가 남아 새 본문으로 오인되지 않게 한다.
// 호출하는 쪽이 `rm -f` 로 미리 지우지 않아도 되도록 생성기가 직접 처리한다.

import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

// 시작할 때 이전 산출물을 지운다. 이후 어느 단계에서 실패해도 낡은 파일이 남지 않는다
export function clearOutput(out: string): void {
  unlinkIfExists(out)
}

// 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꿔 덮어쓴다. 쓰다 실패해도 반쪽 파일이 남지 않는다
export function writeOutput(out: string, text: string): void {
  const tmp = join(dirname(out), `.${basename(out)}.tmp-${process.pid}`)
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, out)
  } finally {
    unlinkIfExists(tmp)
  }
}

// Python 의 html.escape(text, quote=True)
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')
}
