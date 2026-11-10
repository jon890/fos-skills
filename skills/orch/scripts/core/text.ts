// Python 의 str.splitlines 가 나누는 줄 경계. 지시서의 줄을 옛 명령(spec-line, spec-lint)과 같게 나눈다. spec-lint 가 줄 번호를 셀 때도 쓴다
export const LINE_BREAK: RegExp = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/
