// 옛 명령과 직접 경로 호출이 같은 안내로 끝나게 한다. Orca 를 호출하지 않는다.
export const RETIRED_DOC = 'skills/orch/references/waiting.md'
export function retiredMessage(name: string, doc = RETIRED_DOC): string {
  return `RETIRED ${name}: 없어졌다. Orca 가 메시지마다 깨운다. 읽을 문서: ${doc}`
}
export function retiredMain(name: string): number {
  console.error(retiredMessage(name))
  process.exitCode = 2
  return 2
}
