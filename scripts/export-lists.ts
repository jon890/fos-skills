// 팀 내보내기 목록(scripts/export-to-team.ts 의 SHARED_SKILLS, SHARED_TOOLS)을 그 파일의 글에서 읽는다.
// githooks/post-commit.ts 는 커밋한 체크아웃의 export-to-team.ts 를 import 하지 않고 글로 읽는다. 그 파일이 낡거나 깨져도
// 훅이 목록을 읽다 죽지 않는다. scripts/tests/exported-imports.spec.ts 도 임시 폴더의 글로 같은 일을 한다.
// 목록은 `export const SHARED_SKILLS = ['a', 'b']` 꼴의 한 줄이어야 한다. 이 꼴을 바꾸면 여기를 함께 고친다.

export function sharedLists(text: string): { skills: string[]; tools: string[] } | null {
  const read = (name: string) => {
    const match = new RegExp(`^export const ${name} = \\[([^\\]]*)\\]`, 'm').exec(text)
    return match ? [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : null
  }
  const skills = read('SHARED_SKILLS')
  const tools = read('SHARED_TOOLS')
  return skills && tools ? { skills, tools } : null
}

// 도구의 원본 폴더 후보(저장소 상대 경로). 앞이 지금 자리이고 뒤는 옛 커밋의 자리다.
// 팀 저장소에는 어느 후보에서 가져왔든 tools/<이름> 으로 실린다. 소유 스킬 안으로 옮긴 도구만 앞 후보를 따로 적는다.
const TOOL_HOMES: Record<string, string> = { 'browser-driver': 'skills/browser/browser-driver' }

export function toolSources(name: string): string[] {
  const home = TOOL_HOMES[name]
  return home ? [home, `tools/${name}`] : [`tools/${name}`]
}
