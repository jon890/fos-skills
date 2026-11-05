// scripts/run-tests.ts 의 node 단계가 쓰는 node:test reporter 다. 파일 하나가 끝날 때마다 JSON 한 줄을 낸다.
//
// 파일 사건: nesting 0 이고 name 이 명령줄에 준 경로 그대로인 test:complete 다. 파일 안의 최상위 테스트도
// nesting 0 으로 오므로, 실행기가 넘긴 경로 목록(환경 변수 RUN_TESTS_FILES, JSON 배열)에 든 이름만 파일 사건으로 본다.
// 파일 사건의 실패 유형은 assert 실패든 시간 초과든 subtestsFailed 라, 하위 테스트의 testTimeoutFailure 를
// 파일마다 모아 timedOut 으로 싣는다. 하위 사건과 파일 사건의 file 은 심볼릭 링크 경유 경로(/var/...)와
// 실제 경로로 갈릴 수 있어 realpath 로 맞춘다.
//
// 내는 줄: {"file", "passed", "ms", "failureType", "exitCode", "signal", "timedOut"}. 그 밖의 사건은 버린다.

import { realpathSync } from "node:fs";

function real(file: unknown): string {
  if (typeof file !== "string") return "";
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export default async function* reporter(source: AsyncIterable<{ type: string; data: any }>) {
  let names: Set<string>;
  try {
    names = new Set(JSON.parse(process.env.RUN_TESTS_FILES ?? "[]"));
  } catch {
    names = new Set();
  }
  const timedOut = new Set<string>();
  for await (const event of source) {
    const data = event.data ?? {};
    const error = data.details?.error;
    // test:complete 는 끝난 순서로 바로 오고 test:fail 은 선언 순서로 늦게 올 수 있어 둘 다 본다.
    if ((event.type === "test:fail" || event.type === "test:complete") && error?.failureType === "testTimeoutFailure") {
      timedOut.add(real(data.file));
      continue;
    }
    if (event.type !== "test:complete" || data.nesting !== 0 || !names.has(data.name)) continue;
    yield (
      JSON.stringify({
        file: data.name,
        passed: data.details?.passed === true,
        ms: data.details?.duration_ms ?? 0,
        failureType: error?.failureType ?? null,
        exitCode: error?.exitCode ?? null,
        signal: error?.signal ?? null,
        timedOut: timedOut.has(real(data.file)),
      }) + "\n"
    );
  }
}
