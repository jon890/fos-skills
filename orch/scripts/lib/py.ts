// 옛 Python 명령과 같은 글자를 내는 변환이다. 출력 줄과 저장 파일의 바이트 꼴을 옛 명령과 맞춰, 그것을 읽는 다른 저장소가 깨지지 않게 한다.
//
//     pyStr    Python 의 str(). 없는 값은 None, 참거짓은 True 와 False 다
//     pyJson   json.dumps(value, ensure_ascii=False) 의 꼴. 구분자가 `, ` 와 `: ` 이고 한글을 \u 로 바꾸지 않는다.
//              정수와 문자열은 Python 과 같은 바이트다. 실수는 JSON.parse 가 정수와 실수를 가르지 않아
//              정수 값의 실수(1.0)는 1 로, 지수 꼴의 경계가 다른 수(1e16)는 JS 의 꼴로 나온다. orca 와 orch 의 기록에는 그런 수가 없다
//     shQuote  shlex.quote. 사람이 그대로 붙여 넣을 명령을 낸다
//     pyRegExp Python re 의 정규식 글자를 같은 뜻의 JS RegExp 로 바꾼다. 옛 명령의 옵션(--shared-paths 같은 것)에 적힌
//              정규식을 그대로 받으려는 것이다. 바꾸는 글자는 (?P<이름> → (?<이름>, (?P=이름) → \k<이름>, \A → ^, \Z → $ 다.
//              역슬래시는 바로 뒤 한 글자와 짝으로 읽는다. 그래서 앞의 역슬래시가 짝수 개인 \\A 는 이스케이프된 역슬래시와 A 라 바꾸지 않는다.
//              플래그 없이 만든다. 그래야 ^ 는 문자열 처음만, $ 는 문자열 끝만 봐 \A, \Z 와 뜻이 같다.
//              바꾼 글자를 new RegExp 가 거부하면(인라인 플래그 (?i) 같은 것) 원문과 이유를 담은 Error 를 던진다.
//              \w 처럼 두 엔진의 뜻이 다른 글자(Python 은 한글도 글자로 본다)는 바꾸지 않는다

export function pyStr(value: unknown): string {
  if (value === undefined || value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

export function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`)
      .join(', ')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function shQuote(word: string): string {
  if (word === '') return "''"
  if (!/[^\w@%+=:,./-]/.test(word)) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

export function pyRegExp(source: string): RegExp {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\' && i + 1 < source.length) {
      const next = source[++i]
      out += next === 'A' ? '^' : next === 'Z' ? '$' : `\\${next}`
      continue
    }
    if (source.startsWith('(?P<', i)) {
      out += '(?<'
      i += 3
      continue
    }
    const backref = /^\(\?P=([^)]+)\)/.exec(source.slice(i))
    if (backref) {
      out += `\\k<${backref[1]}>`
      i += backref[0].length - 1
      continue
    }
    out += ch
  }
  try {
    return new RegExp(out)
  } catch (e) {
    throw new Error(`정규식 ${JSON.stringify(source)} 를 읽지 못했다: ${(e as Error).message}`)
  }
}
