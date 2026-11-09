// 백엔드 프로세스를 부르고 반환값을 정규화하는 공통 도구.

import { spawn as spawnSync, runtimeEnv } from './runtime.ts'
import { constants } from 'node:os'
import { WAIT_INTERVAL } from './config.ts'
import { DriverError } from './errors.ts'
import { dumpJson, normalizeNewlines, pyDecode, pySplitLines, pyStrip } from './pylike.ts'

// 외부 명령을 돌리고 stdout+stderr 를 한 덩어리로 돌려준다.
//
// check_marker 가 있으면 출력 줄머리에서 그 표식을 찾아 실패로 판정한다. 백엔드가 실패를 종료 코드로 알리지 않기 때문이다 (실측).
// stdin_text 를 주면 그 문자열을 표준 입력으로 넘기고, 없으면 표준 입력을 물려준다.
// check_exit 가 참이면 0 이 아닌 종료 코드를 실패로 판정한다.
export function run(argv: string[], opts: { checkMarker?: string; stdinText?: string; checkExit?: boolean } = {}): string {
  // subprocess 는 문자열이 아닌 인자를 TypeError 로 거절한다
  for (const arg of argv) if (typeof arg !== 'string') throw new TypeError(`expected str, bytes or os.PathLike object, not ${typeof arg}`)
  const done = spawnSync(argv[0], argv.slice(1), {
    input: opts.stdinText,
    stdio: [opts.stdinText === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 1 << 30,
    env: runtimeEnv(),
  })
  if (done.error) throw done.error
  // text=True: 로캘 인코딩(UTF-8)으로 엄격히 읽고 줄바꿈을 \n 으로 바꾼다
  const decode = (bytes: Buffer | null) => normalizeNewlines(pyDecode(bytes ?? Buffer.alloc(0)))
  const out = decode(done.stdout) + decode(done.stderr)
  if (opts.checkMarker) {
    for (const line of pySplitLines(out)) if (line.startsWith(opts.checkMarker)) throw new DriverError(pyStrip(out))
  }
  const code = done.status ?? -(constants.signals[done.signal as keyof typeof constants.signals] ?? 0)
  if (opts.checkExit && code !== 0) throw new DriverError(pyStrip(out) || `${argv[0]} 가 종료 코드 ${code} 로 끝났다`)
  return out
}

// js 명령의 반환값을 백엔드와 무관한 한 가지 형식으로 맞춘다.
//
// 문자열은 따옴표 없이 그대로, 나머지는 JSON 표기로 낸다.
// 구분자에 여백을 두지 않는다. orca 는 객체를 여백 없는 JSON 문자열로 돌려주므로 (실측)
// 기본 구분자를 쓰면 같은 표현식이 백엔드마다 다른 바이트로 나온다.
export function jsValue(value: unknown): string {
  if (typeof value === 'string') return value
  return dumpJson(value, { compact: true })
}

// 조건이 참이 될 때까지 기다리는 JS 표현식을 만든다.
// 조건 대기 명령이 없는 백엔드에서 eval 안의 폴링으로 대신한다.
export function waitExpression(condition: string, timeout: bigint | number): string {
  return `(async () => {
  const t0 = Date.now();
  while (true) {
    let ok = false;
    try { ok = !!(${condition}); } catch (e) { ok = false; }
    if (ok) return 'ok in ' + (Date.now() - t0) + 'ms';
    if (Date.now() - t0 > ${timeout}) throw new Error('waitjs timeout after ${timeout}ms');
    await new Promise(r => setTimeout(r, ${WAIT_INTERVAL}));
  }
})()`
}
