import { createHash } from 'node:crypto'
// 알린 기록의 키(머리 주석의 「알린 기록」). files 의 순서는 보지 않는다
export function notifiedKey(pr: number, headSha: string, files: readonly string[]): string {
  const print = createHash('sha256').update([...files].sort().join('\n')).digest('hex').slice(0, 12)
  return `${pr}@${headSha}#${print}`
}
