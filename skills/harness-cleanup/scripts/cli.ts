// 명령줄 인자를 옛 Python(argparse)과 같은 뜻으로 읽는다.
//
// plan 스킬의 cli.ts 에 이 폴더의 명령이 필요한 둘을 더했다. 스킬은 자기 폴더 밖을 import 하지 않으므로 복사본이다.
//     OptionSpec.append   argparse 의 action="append". 옵션을 거듭 주면 값을 모두 모은 배열이다
//     OptionSpec.int      argparse 의 type=int. 정수가 아니면 `invalid int value` 사용법 오류다(파싱 도중이라 필수 인자 누락보다 먼저 난다)
//     Spec.help === false  add_help=False 와 같다. -h, --help 는 도움말이 아니라 모르는 옵션이다
//
// 읽는 법
//     긴 옵션은 고유한 접두로 줄여 쓸 수 있다(`--aud` → `--audit`). 여러 옵션에 맞으면 사용법 오류다.
//     `--옵션=값` 을 받는다. 값 옵션을 거듭 주면 마지막 값이다. 플래그에 `=값` 을 주면 사용법 오류다.
//     `-` 로 시작해도 음수 꼴이거나 공백이 든 인자는 위치 인자다. 그 밖에 `-` 로 시작하는데 모르는 옵션이면 사용법 오류다.
//     `--` 뒤는 모두 위치 인자다. `-h`, `--help` 는 도움말을 내고 끝낸다(종료 코드 0).
//     위치 인자는 이어진 덩어리 하나만 받는다. 옵션을 사이에 두고 갈라져 나온 뒤 덩어리는 사용법 오류다.
//     값 없는 `nargs="?"` 위치 인자는 옵션 앞에서 빈 채로 정해지지 않고 뒤 덩어리를 기다린다.
//     사용법 오류는 `prog: error: 이유` 를 stderr 에 내고 종료 코드 2 다.

import { parsePyInt, pyRepr } from './pylike.ts'

export type OptionSpec = { name: string; value: boolean; required?: boolean; choices?: string[]; append?: boolean; int?: boolean }
// nargs: 1 은 꼭 하나, '?' 는 없거나 하나, '*' 는 몇이든
export type PositionalSpec = { name: string; nargs: 1 | '?' | '*' }
export type Spec = { options: OptionSpec[]; positionals: PositionalSpec[]; help?: boolean }

export type Parsed = {
  help: boolean
  options: Record<string, string | true | string[] | undefined>
  positionals: Record<string, string | string[] | undefined>
}

export class UsageError extends Error {}

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/

// argparse 가 옵션 값 자리의 인자를 옵션으로 읽는가. `-` 로 시작해도 음수 꼴이거나 공백이 든 인자는 값이다
export function looksLikeOption(token: string): boolean {
  return token.startsWith('-') && token !== '-' && !NEGATIVE_NUMBER.test(token) && !token.includes(' ')
}

type Token = { kind: 'positional' } | { kind: 'help'; explicit?: string } | { kind: 'option'; spec: OptionSpec; explicit?: string } | { kind: 'unknown' }

function classify(token: string, spec: Spec): Token {
  if (!token.startsWith('-')) return { kind: 'positional' }
  const helpOn = spec.help !== false
  if (helpOn && (token === '-h' || token === '--help')) return { kind: 'help' }
  if (token === '-') return { kind: 'positional' }
  const longs = [...spec.options.map((option) => option.name), ...(helpOn ? ['help'] : [])]
  if (token.startsWith('--')) {
    const eq = token.indexOf('=')
    const given = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    const explicit = eq >= 0 ? token.slice(eq + 1) : undefined
    const exact = longs.includes(given) ? [given] : longs.filter((name) => name.startsWith(given))
    if (exact.length > 1) throw new UsageError(`ambiguous option: --${given} could match ${exact.map((name) => `--${name}`).join(', ')}`)
    if (exact.length === 1) {
      if (exact[0] === 'help') return { kind: 'help', explicit }
      return { kind: 'option', spec: spec.options.find((option) => option.name === exact[0])!, explicit }
    }
  } else if (helpOn && token.startsWith('-h')) {
    return { kind: 'help', explicit: token.slice(2) }
  }
  if (NEGATIVE_NUMBER.test(token)) return { kind: 'positional' }
  if (token.includes(' ')) return { kind: 'positional' }
  return { kind: 'unknown' }
}

export function parseCli(argv: string[], spec: Spec): Parsed {
  const options: Parsed['options'] = {}
  const chunks: string[][] = []
  const unknown: string[] = []
  let chunk: string[] | null = null
  const addPositional = (value: string) => {
    if (!chunk) {
      chunk = []
      chunks.push(chunk)
    }
    chunk.push(value)
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      for (const rest of argv.slice(i + 1)) addPositional(rest)
      break
    }
    const kind = classify(token, spec)
    if (kind.kind === 'positional') {
      addPositional(token)
      continue
    }
    chunk = null
    if (kind.kind === 'unknown') {
      unknown.push(token)
      continue
    }
    if (kind.kind === 'help') {
      if (kind.explicit !== undefined) throw new UsageError(`argument -h/--help: ignored explicit argument '${kind.explicit}'`)
      return { help: true, options: {}, positionals: {} }
    }
    const option = kind.spec
    if (!option.value) {
      if (kind.explicit !== undefined) throw new UsageError(`argument --${option.name}: ignored explicit argument '${kind.explicit}'`)
      options[option.name] = true
    } else {
      let given: string
      if (kind.explicit !== undefined) {
        given = kind.explicit
      } else {
        const value = argv[i + 1]
        if (value === undefined || (value !== '--' && classify(value, spec).kind !== 'positional')) throw new UsageError(`argument --${option.name}: expected one argument`)
        given = value
        i++
      }
      if (option.append) options[option.name] = [...((options[option.name] as string[] | undefined) ?? []), given]
      else options[option.name] = given
    }
    const given = options[option.name]
    if (option.int && typeof given === 'string') {
      try {
        parsePyInt(given)
      } catch {
        throw new UsageError(`argument --${option.name}: invalid int value: ${pyRepr(given)}`)
      }
    }
    if (option.choices && typeof given === 'string' && !option.choices.includes(given)) {
      throw new UsageError(`argument --${option.name}: invalid choice: '${given}' (choose from ${option.choices.map((c) => `'${c}'`).join(', ')})`)
    }
  }
  const missing = spec.options.filter((option) => option.required && options[option.name] === undefined).map((option) => `--${option.name}`)
  const positionals: Parsed['positionals'] = {}
  const first = chunks.find((c) => c.length > 0) ?? []
  let at = 0
  for (const positional of spec.positionals) {
    if (positional.nargs === 1) {
      if (at < first.length) positionals[positional.name] = first[at++]
      else missing.push(positional.name)
    } else if (positional.nargs === '?') {
      positionals[positional.name] = at < first.length ? first[at++] : undefined
    } else {
      positionals[positional.name] = first.slice(at)
      at = first.length
    }
  }
  if (missing.length) throw new UsageError(`the following arguments are required: ${missing.join(', ')}`)
  const extras = [...unknown, ...first.slice(at), ...chunks.filter((c) => c !== first).flat()]
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(' ')}`)
  return { help: false, options, positionals }
}
