import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'

function report(dir: string, stage: string): void {
  let remaining: string
  try {
    remaining = JSON.stringify(readdirSync(dir, { recursive: true }).sort())
  } catch (error) {
    remaining = `읽지 못했다 (${(error as NodeJS.ErrnoException).code ?? '오류'})`
  }
  const open = spawnSync('lsof', ['-nP', '+D', dir], { encoding: 'utf8', timeout: 1_000 })
  const processes = open.stdout?.trim() || (open.error ? `조회하지 못했다 (${open.error.message})` : '조회 결과 없음')
  process.stderr.write(`orch-doctor 테스트 정리 ${stage} (${dir})\n남은 파일: ${remaining}\n열린 파일을 가진 프로세스:\n${processes}\n`)
}

export function cleanupDoctorTemp(dir: string, remove = rmSync): void {
  const options = { recursive: true, force: true }
  try {
    remove(dir, options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    report(dir, '재시도 전 ENOTEMPTY')
    try {
      // 이 호출의 첫 시도까지 합쳐 최대 세 번 다시 지운다.
      remove(dir, { ...options, maxRetries: 2 })
    } catch (retryError) {
      report(dir, '재시도 후 실패')
      throw retryError
    }
  }
}
