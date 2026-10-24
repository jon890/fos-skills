// 명령줄 인자를 parseArgs 에 넘기기 전에 옛 Python(argparse) 명령과 같은 꼴로 고친다. 옮긴 명령은 모두 parseArgs 전에 expandArgs 를 부른다.
//
// 고유 접두: argparse 처럼 긴 옵션의 고유한 접두를 온 이름으로 펼친다(`--wor` → `--worktree`, `--wor=x` → `--worktree=x`).
//     이름과 똑같은 옵션이 있으면 그것이다. 접두가 여러 옵션에 맞으면 Error 를 던진다. 부르는 쪽은 사용법 오류(종료 코드 2)로 끝낸다.
//     맞는 옵션이 없으면 그대로 둔다. parseArgs 가 모르는 옵션으로 거부한다.
//     옛 `.py` 경로를 부르는 다른 저장소가 줄여 쓴 옵션으로 깨지지 않게 하려는 것이다.
// `--` 뒤의 인자는 건드리지 않는다.
//
// 값 이어 붙이기(join): join 에 적은 문자열 옵션은 바로 뒤 인자를 `--이름=값` 으로 붙여 값으로 받는다.
//     parseArgs 는 `--body "-x"` 처럼 `-` 로 시작하는 값을 옵션으로 보고 거부한다.
//     옛 Python 명령은 이 값을 사용법 오류(2)로 거부했다. 옮긴 명령은 받아들인다. 넓어진 동작이고 CHANGELOG 3.0.0 에 적었다.
//     거부하던 호출이 통하게 될 뿐이라 옛 호출 가운데 깨지는 것은 없다. 붙인 값은 접두로 펼치지 않는다.

type Options = Record<string, { type: 'string' | 'boolean' }>

function resolveName(given: string, names: string[]): string {
  if (names.includes(given)) return given
  const matches = names.filter((name) => name.startsWith(given))
  if (matches.length > 1) throw new Error(`--${given} 이 여러 옵션의 접두다: ${matches.map((name) => `--${name}`).join(', ')}`)
  return matches.length === 1 ? matches[0] : given
}

export function expandArgs(argv: string[], options: Options, join: readonly string[] = []): string[] {
  const names = Object.keys(options)
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      out.push(...argv.slice(i))
      break
    }
    if (!token.startsWith('--') || token.length === 2) {
      out.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = resolveName(eq >= 0 ? token.slice(2, eq) : token.slice(2), names)
    if (eq < 0 && join.includes(name) && options[name]?.type === 'string' && i + 1 < argv.length) {
      out.push(`--${name}=${argv[++i]}`)
      continue
    }
    out.push(`--${name}${eq >= 0 ? token.slice(eq) : ''}`)
  }
  return out
}
