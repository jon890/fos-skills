#!/usr/bin/env node
// node 테스트 파일을 하나씩 자기 세션에서 돌리고, 결과를 파일에 남긴다.
//
// 왜 필요한가 (실측):
//   `node --test "orch/tests/*.spec.ts" ...` 한 줄은 신호를 보내는 테스트가 같은 프로세스 그룹의 실행기까지 끝내
//   요약과 끝 줄 없이 끝났다. 끝까지 돌아도 이 머신에서 600초를 넘어 Bash 도구의 전경 제한에 걸렸다.
//   파일마다 새 세션(detached)으로 돌리면 테스트가 보낸 신호가 실행기에 닿지 않는다.
//   결과 폴더에 요약을 남기므로 백그라운드로 띄우고 --wait 로 끝 줄을 나눠 기다릴 수 있다.
//
// 사용법 (cwd: 저장소 루트)
//   node scripts/run-node-tests.ts                         기본 파일 묶음을 전경으로 돌린다
//   node scripts/run-node-tests.ts orch/tests/a.spec.ts    주어진 파일이나 glob 만 돌린다
//   node scripts/run-node-tests.ts --background            띄우고 결과 폴더를 출력한 뒤 바로 끝난다
//   node scripts/run-node-tests.ts --wait "$DIR"           결과 폴더의 끝 줄을 기다린다
//
// 옵션
//   --concurrency N   동시에 돌릴 파일 수 (기본 4)
//   --timeout SEC     파일 하나의 제한 시간. 넘으면 그 세션을 통째로 끝내고 실패로 센다 (기본 600)
//   --out DIR         결과 폴더 (기본: 임시 폴더 아래 새 폴더)
//   --max-wait SEC    --wait 가 기다릴 최대 시간 (기본 540, Bash 도구의 600초 안)
//
// 결과 폴더에는 파일별 로그와 summary.txt 를 쓴다. summary.txt 는 파일이 끝날 때마다 한 줄씩 늘고,
// 모두 끝나면 `결과: ` 로 시작하는 끝 줄을 쓴다.
//
// 종료 코드
//   0  모두 통과했다 (--background 는 띄우는 데 성공했다)
//   1  실패한 파일이 있다
//   2  실행하지 못했다. 인자 오류, 대상 파일 없음, 결과 폴더 없음, 실행기가 끝 줄 없이 멈췄다
//   3  --wait 가 최대 시간까지 끝 줄을 보지 못했다. 같은 명령으로 다시 기다린다

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, globSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 저장소의 node:test 묶음이다. 새 묶음을 더하면 여기와 CI 의 node 테스트 명령을 함께 고친다.
export const DEFAULT_PATTERNS = ["orch/tests/*.spec.ts", "work-board/tests/*.spec.ts", "inbox/tests/*.spec.ts"];
export const END_PREFIX = "결과: ";
const SUMMARY = "summary.txt";
const PID_FILE = "runner.pid";

type Options = { concurrency: number; timeout: number; out?: string; maxWait: number; background: boolean; wait?: string; patterns: string[] };

export function parseArgs(argv: string[]): Options {
  const opts: Options = { concurrency: 4, timeout: 600, maxWait: 540, background: false, patterns: [] };
  const value = (i: number, name: string) => {
    if (i >= argv.length) throw new Error(`${name} 에 값이 없다`);
    return argv[i];
  };
  const positive = (text: string, name: string) => {
    const n = Number(text);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 는 양의 정수여야 한다: ${text}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--concurrency") opts.concurrency = positive(value(++i, arg), arg);
    else if (arg === "--timeout") opts.timeout = positive(value(++i, arg), arg);
    else if (arg === "--max-wait") opts.maxWait = positive(value(++i, arg), arg);
    else if (arg === "--out") opts.out = value(++i, arg);
    else if (arg === "--wait") opts.wait = value(++i, arg);
    else if (arg === "--background") opts.background = true;
    else if (arg.startsWith("-")) throw new Error(`모르는 옵션: ${arg}`);
    else opts.patterns.push(arg);
  }
  return opts;
}

export function expand(patterns: string[], cwd: string): string[] {
  const files = new Set<string>();
  for (const pattern of patterns.length ? patterns : DEFAULT_PATTERNS) {
    const found = /[*?[]/.test(pattern) ? globSync(pattern, { cwd }) : existsSync(join(cwd, pattern)) ? [pattern] : [];
    for (const file of found) files.add(file);
  }
  return [...files].sort();
}

function killGroup(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // 이미 끝난 그룹이다.
  }
}

async function run(opts: Options, cwd: string): Promise<number> {
  const files = expand(opts.patterns, cwd);
  if (!files.length) {
    console.error(`돌릴 테스트 파일이 없다: ${(opts.patterns.length ? opts.patterns : DEFAULT_PATTERNS).join(" ")}`);
    return 2;
  }
  const out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), "node-tests-"));
  mkdirSync(out, { recursive: true });
  const summary = join(out, SUMMARY);
  writeFileSync(summary, "");
  writeFileSync(join(out, PID_FILE), String(process.pid));
  console.log(`결과 폴더: ${out} (파일 ${files.length}개, 동시 ${opts.concurrency}개)`);

  const running = new Set<ChildProcess>();
  const stop = () => {
    for (const child of running) killGroup(child);
    process.exit(2);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let failed = 0;
  let next = 0;
  const one = (index: number) =>
    new Promise<void>((done) => {
      const file = files[index];
      const log = join(out, `${String(index + 1).padStart(3, "0")}-${file.replace(/[^A-Za-z0-9._-]+/g, "_")}.log`);
      const fd = openSync(log, "w");
      const started = Date.now();
      // detached 는 새 세션의 리더로 띄운다. 테스트가 그룹에 보낸 신호가 이 실행기에 닿지 않는다.
      const child = spawn(process.execPath, ["--test", file], { cwd, detached: true, stdio: ["ignore", fd, fd] });
      running.add(child);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, opts.timeout * 1000);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        running.delete(child);
        killGroup(child); // 테스트가 남긴 자식 프로세스까지 정리한다.
        closeSync(fd);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const ok = code === 0 && !timedOut;
        if (!ok) failed++;
        const why = timedOut ? `시간 초과 ${opts.timeout}초` : signal ? `신호 ${signal}` : `종료 코드 ${code}`;
        const line = ok ? `통과 ${file} ${seconds}s` : `실패 ${file} ${seconds}s (${why}) 로그: ${log}`;
        appendFileSync(summary, line + "\n");
        console.log(line);
        done();
      });
    });
  const worker = async () => {
    while (next < files.length) await one(next++);
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, files.length) }, worker));
  const end = `${END_PREFIX}통과 ${files.length - failed}, 실패 ${failed}, 전체 ${files.length}`;
  appendFileSync(summary, end + "\n");
  console.log(end);
  return failed ? 1 : 0;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function wait(dir: string, maxWait: number, pollMs = 2000): Promise<number> {
  const summary = join(dir, SUMMARY);
  if (!existsSync(summary)) {
    console.error(`결과 폴더에 ${SUMMARY} 가 없다: ${dir}`);
    return 2;
  }
  const deadline = Date.now() + maxWait * 1000;
  for (;;) {
    const lines = readFileSync(summary, "utf8").split("\n").filter(Boolean);
    const end = lines.find((line) => line.startsWith(END_PREFIX));
    if (end) {
      console.log(lines.join("\n"));
      return / 실패 0,/.test(end) ? 0 : 1;
    }
    const pid = Number(existsSync(join(dir, PID_FILE)) ? readFileSync(join(dir, PID_FILE), "utf8") : NaN);
    if (Number.isInteger(pid) && !alive(pid)) {
      console.log(lines.join("\n"));
      console.error(`실행기(pid ${pid})가 끝 줄 없이 멈췄다. 로그: ${join(dir, "runner.log")}`);
      return 2;
    }
    if (Date.now() >= deadline) {
      console.log(`아직 끝나지 않았다: 끝난 파일 ${lines.length}개. 같은 명령으로 다시 기다린다`);
      return 3;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function background(argv: string[], opts: Options): number {
  const out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), "node-tests-"));
  mkdirSync(out, { recursive: true });
  // 요약 파일을 먼저 만들어 둔다. 띄운 직후 --wait 가 「요약 없음」 으로 끝나지 않게 한다.
  writeFileSync(join(out, SUMMARY), "");
  const fd = openSync(join(out, "runner.log"), "w");
  const rest = argv.filter((arg) => arg !== "--background");
  const outIndex = rest.indexOf("--out");
  if (outIndex >= 0) rest.splice(outIndex, 2);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...rest, "--out", out], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  writeFileSync(join(out, PID_FILE), String(child.pid));
  child.unref();
  console.log(`결과 폴더: ${out}`);
  console.log(`기다리기: node scripts/run-node-tests.ts --wait "${out}"`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (opts.wait) return wait(opts.wait, opts.maxWait);
  if (opts.background) return background(argv, opts);
  return run(opts, process.cwd());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
