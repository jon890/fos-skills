// 세션 임시 폴더 경로를 글에서 찾는다. spec-lint 의 「임시」 경고와 worker-ask 의 거절이 같은 판정을 쓴다.
//
// TEMP_PATH: 임시 폴더 아래 경로(`/tmp/…`, `/private/tmp/…`, `/var/folders/…`, `$TMPDIR/…`, `…/scratchpad/…`).
//     폴더 이름만 말한 것(「scratchpad 에 쓴다」)은 빼고 그 아래 파일이나 폴더를 가리킨 것만 잡는다.
// sessionTempPaths: 위 중 코디네이터 세션이 열지 못하는 세션 임시 폴더 경로만 낸다.
//     `$TMPDIR` 값 아래, `/var/folders/`, `/private/tmp/claude-`, `/tmp/claude-` 와 글자 그대로의 `$TMPDIR/` 다.
//     worker 와 코디네이터는 세션마다 임시 폴더가 달라, 이 경로를 넘겨 받은 쪽은 파일을 열지 못한다(2026-11-17).

export const TEMP_PATH = /(?:^|[\s`'"(=])((?:\/private)?\/tmp\/[^\s`'"()]*|(?:\/private)?\/var\/folders\/[^\s`'"()]*|\$\{?TMPDIR\}?\/[^\s`'"()]*|[^\s`'"()]*\/scratchpad\/[^\s`'"()]*)/g

const SESSION_PREFIXES = ['/var/folders/', '/tmp/claude-']

function clean(path: string): string {
  return path.replace(/[.,;:]+$/, '')
}

function unprivate(path: string): string {
  return path.replace(/^\/private(?=\/)/, '')
}

export function sessionTempPaths(text: string, tmpdir: string | undefined = process.env.TMPDIR): string[] {
  const root = tmpdir ? unprivate(tmpdir.replace(/\/+$/, '')) : ''
  const found: string[] = []
  for (const m of text.matchAll(TEMP_PATH)) {
    const path = clean(m[1])
    const plain = unprivate(path)
    const session = path.startsWith('$')
      || SESSION_PREFIXES.some((prefix) => plain.startsWith(prefix))
      || (root.length > 1 && plain.startsWith(`${root}/`))
    if (session && !found.includes(path)) found.push(path)
  }
  return found
}
