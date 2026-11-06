// 생성기 둘이 함께 쓰는 옵션 해석. 옛 Python(argparse)과 같은 꼴로 받는다.
//
// 같은 것: 긴 옵션의 고유 접두(`--tit` 는 `--title`), `--옵션=값`, 필수 옵션 빠짐·잘못된 choices·모르는 옵션·남는 인자는 사용법 오류(종료 코드 2),
//     `--help` 는 사용법을 stdout 에 내고 0 으로 끝남. 사용법 오류는 stderr 에 사용법과 `<프로그램>: error: <이유>` 를 낸다.
// 넓어진 것: 값이 `-` 로 시작하는 옵션(`--title -x`)을 받는다. 옛 argparse 는 사용법 오류로 거부했다. kit/args.ts 의 join 이다.

import { parseArgs } from 'node:util'
import { expandArgs } from './kit/args.ts'
import { write } from './io.ts'

export type Spec = {
  prog: string
  usage: string
  help: string
  // 선언 순서가 필수 옵션 오류 문구의 순서다
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean; required?: boolean; choices?: string[] }>
}

export type Parsed = Record<string, string | boolean | string[] | undefined>

// 파싱한 값을 낸다. --help 와 사용법 오류는 출력하고 종료 코드를 돌려준다
export function parseCli(argv: string[], spec: Spec): { values: Parsed } | { exit: number } {
  const fail = (message: string) => {
    write(2, `${spec.usage}${spec.prog}: error: ${message}\n`)
    return { exit: 2 }
  }
  const options = { help: { type: 'boolean' as const, short: 'h' }, ...Object.fromEntries(Object.entries(spec.options).map(([name, o]) => [name, { type: o.type, ...(o.multiple || o.choices ? { multiple: true } : {}) }])) }
  const joined = Object.entries(spec.options).filter(([, o]) => o.type === 'string').map(([name]) => name)
  let values: Parsed
  try {
    values = parseArgs({ args: expandArgs(argv, options, joined), options, strict: true, allowPositionals: false }).values as Parsed
  } catch (error) {
    return fail(String((error as Error).message))
  }
  if (values.help) {
    write(1, spec.help)
    return { exit: 0 }
  }
  const missing = Object.entries(spec.options).filter(([name, o]) => o.required && values[name] === undefined).map(([name]) => `--${name}`)
  if (missing.length) return fail(`the following arguments are required: ${missing.join(', ')}`)
  // 선택형 옵션은 거듭 줘도 등장한 값마다 choices 를 검사한다(argparse 는 파싱하는 때마다 검사한다). 값은 마지막 것이다
  for (const [name, o] of Object.entries(spec.options)) {
    if (!o.choices || o.multiple) continue
    const given = values[name] as string[] | undefined
    if (given === undefined) continue
    for (const value of given) if (!o.choices.includes(value)) return fail(`argument --${name}: invalid choice: '${value}' (choose from ${o.choices.map((c) => `'${c}'`).join(', ')})`)
    values[name] = given.at(-1)
  }
  return { values }
}
