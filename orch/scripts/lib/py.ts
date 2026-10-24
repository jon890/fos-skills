// 옛 Python 명령과 같은 글자를 내는 변환이다. 출력 줄과 저장 파일의 바이트 꼴을 옛 명령과 맞춰, 그것을 읽는 다른 저장소가 깨지지 않게 한다.
//
//     pyStr    Python 의 str(). 없는 값은 None, 참거짓은 True 와 False 다
//     pyJson   json.dumps(value, ensure_ascii=False) 의 꼴. 구분자가 `, ` 와 `: ` 이고 한글을 \u 로 바꾸지 않는다.
//              정수와 문자열은 Python 과 같은 바이트다. 실수는 JSON.parse 가 정수와 실수를 가르지 않아
//              정수 값의 실수(1.0)는 1 로, 지수 꼴의 경계가 다른 수(1e16)는 JS 의 꼴로 나온다. orca 와 orch 의 기록에는 그런 수가 없다
//     shQuote  shlex.quote. 사람이 그대로 붙여 넣을 명령을 낸다

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
