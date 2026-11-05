#!/usr/bin/env node
// 저장소의 node 테스트, Python 테스트 묶음, tsc 타입 검사를 함께 돌고 결과를 파일에 남긴다.
//
// 왜 필요한가:
//   두 언어와 tsc 를 명령 하나로 돈다. 묶음 목록과 TypeScript 버전의 원본이다. CI 와 로컬 검증은 테스트와 tsc 를
//   이 명령 하나로 돈다(`claude plugin test .` 는 따로 부른다).
//   결과 폴더에 요약을 남기므로 백그라운드로 띄우고 --wait 로 끝 줄을 나눠 기다릴 수 있다.
//
// 묶음 (인자가 없을 때)
//   git 이 추적하거나 무시하지 않는 파일 가운데 tests/ 아래 *.spec.ts 를 `node --test` 한 번으로 돌고,
//   tests/test_*.py 를 가진 tests 폴더마다 `python3 -m unittest discover -s <폴더>` 를 돈다. tsc 도 함께 돈다.
//   인자를 주면 그 파일이나 glob, 폴더만 돈다(tsc 는 돌지 않는다). test_*.py 파일이나 그것을 바로 가진 폴더는
//   Python 묶음만 돈다(그 폴더의 *.spec.ts 는 파일로 따로 준다). 그 밖의 폴더는 그 아래 *.spec.ts, 나머지 파일은 node 파일이다.
//
// tsc:
//   node 는 타입을 지우기만 해서 잘못된 속성 접근이 실행 때까지 드러나지 않는다. 저장소에 package.json 과
//   node_modules 를 두지 않으므로(docs/code-architecture.md 「저장소 실행 규칙」 의 「의존」) TypeScript 는 저장소 밖
//   사용자 캐시 폴더에 설치한다. 버전은 TYPESCRIPT, NODE_TYPES 상수가 소유하고, 폴더는 FOS_TSC_DIR 로 바꾼다.
//
// 사용법 (cwd: 저장소 루트)
//   node scripts/run-tests.ts                              모든 묶음과 tsc 를 전경으로 돌린다
//   node scripts/run-tests.ts skills/orch/tests/a.spec.ts  주어진 파일이나 glob, 폴더만 돌린다
//   node scripts/run-tests.ts --background                 띄우고 결과 폴더를 출력한 뒤 바로 끝난다
//   node scripts/run-tests.ts --wait "$DIR"                결과 폴더의 끝 줄을 기다린다
//
// 옵션
//   --concurrency N   node --test 의 동시 파일 수. Python 묶음은 ceil(N/2) 개씩 함께 돈다 (기본 4)
//   --timeout SEC     node 테스트 하나의 제한(--test-timeout), node 단계의 무진행 감시, Python 묶음 하나와
//                     tsc 의 제한 (기본 600). 넘으면 그 프로세스 그룹을 통째로 끝내고 실패로 센다.
//                     node 단계는 파일 완료 보고가 SEC 초 동안 없을 때 끊고, 보고가 없는 파일을 모두 시간 초과로 센다
//   --out DIR         결과 폴더 (기본: 임시 폴더 아래 새 폴더)
//   --max-wait SEC    --wait 가 기다릴 최대 시간 (기본 540, Bash 도구의 600초 안)
//
// 결과 폴더에는 단계별 로그와 summary.txt 를 쓴다. summary.txt 는 node 파일, Python 묶음, tsc 가 끝날 때마다
// 한 줄씩 늘고(`통과 <이름> <초>s`, `실패 <이름> <초>s (<이유>) 로그: <로그>`), 모두 끝나면
// `결과: 통과 P, 실패 F, 전체 T, 걸린 시간 Ss` 끝 줄을 쓴다.
//
// 종료 코드
//   0  모두 통과했다 (--background 는 띄우는 데 성공했다)
//   1  실패한 것이 있다
//   2  실행하지 못했다. 인자 오류, 대상 없음, 인자 없이 git 저장소 밖, 결과 폴더 없음, 실행기가 끝 줄 없이 멈췄다,
//      SIGINT·SIGTERM 으로 중단됐다
//   3  --wait 가 최대 시간까지 끝 줄을 보지 못했다. 같은 명령으로 다시 기다린다

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// tsc 단계의 버전. 범위(@24)로 두면 로컬 캐시와 CI 가 어긋난다. 올릴 때는 이 두 값만 고친다.
export const TYPESCRIPT = "typescript@5.9.3";
export const NODE_TYPES = "@types/node@24.19.2";
export const END_PREFIX = "결과: ";
const SUMMARY = "summary.txt";
const PID_FILE = "runner.pid";
const REPORTER = fileURLToPath(new URL("./run-tests-reporter.ts", import.meta.url));
const PY_TEST = /^test_.*\.py$/;

// 띄운 단계들. 신호나 예외로 끝날 때 그룹을 모두 정리한다.
const running = new Set<ChildProcess>();

type Options = { concurrency: number; timeout: number; out?: string; maxWait: number; background: boolean; wait?: string; patterns: string[] };
export type Targets = { node: string[]; python: string[]; tsc: boolean };

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

function clean(path: string) {
  const p = normalize(path);
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasPythonTests(dir: string) {
  try {
    return readdirSync(dir).some((name) => PY_TEST.test(name));
  } catch {
    return false;
  }
}

// 인자 없이 부르면 git 의 파일 목록에서 묶음을 찾는다. git 저장소 밖이면 null.
export function discover(cwd: string): Targets | null {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
  if (listed.error || listed.status !== 0) return null;
  const node = new Set<string>();
  const python = new Set<string>();
  for (const file of listed.stdout.split("\0")) {
    // --cached 는 지웠지만 커밋하지 않은 파일도 낸다.
    if (!file || !existsSync(join(cwd, file))) continue;
    if (/(^|\/)tests\/.*\.spec\.ts$/.test(file)) node.add(file);
    const m = /^(.*\/)?tests\/(test_[^/]*\.py)$/.exec(file);
    if (m) python.add(`${m[1] ?? ""}tests`);
  }
  return { node: [...node].sort(), python: [...python].sort(), tsc: true };
}

// 인자를 주면 파일 시스템에서 푼다. git 은 필요 없다.
export function expand(patterns: string[], cwd: string): Targets {
  const node = new Set<string>();
  const python = new Set<string>();
  for (const pattern of patterns) {
    const found = /[*?[]/.test(pattern) ? globSync(pattern, { cwd }) : existsSync(resolve(cwd, pattern)) ? [pattern] : [];
    for (const raw of found) {
      const item = clean(raw);
      const full = resolve(cwd, item);
      if (isDir(full)) {
        if (hasPythonTests(full)) python.add(item);
        else for (const file of globSync("**/*.spec.ts", { cwd: full })) node.add(join(item, file));
      } else if (PY_TEST.test(basename(item))) python.add(dirname(item));
      else node.add(item);
    }
  }
  return { node: [...node].sort(), python: [...python].sort(), tsc: false };
}

function childEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  // 물려받은 NODE_TEST_CONTEXT 가 있으면 node --test 가 reporter 출력을 내지 않는다. 테스트 안에서 불려도 돌게 지운다.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function cacheHome() {
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

function killGroup(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // 이미 끝난 그룹이다.
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException; timedOut: boolean };
type Runner = { cwd: string; out: string; timeout: number; running: Set<ChildProcess>; record: (ok: boolean, name: string, seconds: number, why?: string, log?: string) => void };

// 새 세션으로 띄우고 끝나면 그룹을 정리한다. 남은 손자 프로세스까지 끝낸다.
function runGroup(r: Runner, command: string, args: string[], log: string, env = childEnv()): Promise<Exit> {
  return new Promise((done) => {
    const fd = openSync(log, "a");
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd: r.cwd, detached: true, stdio: ["ignore", fd, fd], env });
    r.running.add(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, r.timeout * 1000);
    const finish = (exit: Exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.running.delete(child);
      killGroup(child);
      closeSync(fd);
      done(exit);
    };
    child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, signal: null, error, timedOut }));
    child.on("exit", (code, signal) => finish({ code, signal, timedOut }));
  });
}

function seconds(started: number) {
  return (Date.now() - started) / 1000;
}

function why(exit: Exit) {
  return exit.timedOut ? "시간 초과" : exit.signal ? `신호 ${exit.signal}` : `종료 코드 ${exit.code}`;
}

export type Line = { ok: false; name: string; why: string };

// 대조: 보고가 없는 파일은 끊긴 것이다. 끊긴 실행이 끝 줄에서 실패 0 으로 읽히지 않게 한다.
// 감시가 끊었으면 시간 초과, 아니면 보고 없음이다. 종료 코드가 0 이 아닌데 실패가 하나도 없으면 단계 줄을 더한다.
export function reconcile(
  files: string[],
  reported: Set<string>,
  failures: number,
  exit: { code: number | null; signal: string | null },
  stalled: boolean,
): Line[] {
  const lines: Line[] = files.filter((file) => !reported.has(file)).map((name) => ({ ok: false, name, why: stalled ? "시간 초과" : "보고 없음" }));
  if (exit.code !== 0 && failures + lines.length === 0) {
    lines.push({ ok: false, name: "node 단계", why: exit.signal ? `신호 ${exit.signal}` : `종료 코드 ${exit.code}` });
  }
  return lines;
}

async function nodePhase(r: Runner, files: string[], concurrency: number) {
  const log = join(r.out, "node.log");
  writeFileSync(log, "");
  const fd = openSync(log, "a");
  const args = [
    "--test",
    `--test-concurrency=${concurrency}`,
    `--test-timeout=${r.timeout * 1000}`,
    `--test-reporter=${REPORTER}`,
    "--test-reporter-destination=stdout",
    "--test-reporter=spec",
    "--test-reporter-destination=stderr",
    ...files,
  ];
  const env = childEnv({
    RUN_TESTS_FILES: JSON.stringify(files),
    ...(process.env.NODE_COMPILE_CACHE ? {} : { NODE_COMPILE_CACHE: join(cacheHome(), "fos-skills", "node-compile-cache") }),
  });
  const child = spawn(process.execPath, args, { cwd: r.cwd, detached: true, stdio: ["ignore", "pipe", fd], env });
  r.running.add(child);
  const reported = new Set<string>();
  let failures = 0;
  let stalled = false;
  let exited = false;
  let timer: NodeJS.Timeout;
  // 무진행 감시: 파일 완료 사건이 --timeout 초 동안 오지 않으면 그룹을 끝낸다.
  // stdio 를 쥔 손자 프로세스가 남으면 --test-timeout 으로도 node --test 가 끝나지 않는다.
  const arm = () => {
    clearTimeout(timer);
    if (exited) return;
    timer = setTimeout(() => {
      stalled = true;
      killGroup(child);
    }, r.timeout * 1000);
  };
  arm();
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    let event: { file: string; passed: boolean; ms: number; failureType: string | null; exitCode: number | null; signal: string | null; timedOut: boolean };
    try {
      event = JSON.parse(line);
    } catch {
      event = null as any;
    }
    if (!event || typeof event !== "object") {
      appendFileSync(log, line + "\n");
      return;
    }
    if (!files.includes(event.file) || reported.has(event.file)) return;
    arm();
    reported.add(event.file);
    const reason = event.signal
      ? `신호 ${event.signal}`
      : event.timedOut
        ? "시간 초과"
        : event.failureType === "subtestsFailed"
          ? "테스트 실패"
          : `종료 코드 ${event.exitCode}`;
    if (!event.passed) failures++;
    r.record(event.passed, event.file, event.ms / 1000, reason, log);
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.on("error", () => done({ code: null, signal: null }));
    child.on("exit", (code, signal) => done({ code, signal }));
  });
  exited = true;
  clearTimeout(timer!);
  // 손자 프로세스가 stdout 을 쥐고 있으면 끝나지 않으므로 그룹을 정리하고 남은 줄을 읽는다.
  killGroup(child);
  await new Promise<void>((done) => {
    if (child.stdout!.readableEnded || child.stdout!.destroyed) return done();
    const giveUp = setTimeout(() => {
      child.stdout!.destroy();
      done();
    }, 5000);
    lines.on("close", () => {
      clearTimeout(giveUp);
      done();
    });
  });
  r.running.delete(child);
  closeSync(fd);
  for (const line of reconcile(files, reported, failures, exit, stalled)) r.record(false, line.name, 0, line.why, log);
}

async function pythonPhase(r: Runner, suites: string[], concurrency: number) {
  let next = 0;
  let missing = false;
  const one = async (suite: string, index: number) => {
    const log = join(r.out, `py-${String(index + 1).padStart(2, "0")}-${suite.replace(/[^A-Za-z0-9._-]+/g, "_")}.log`);
    if (missing) return r.record(false, suite, 0, "python3 가 없다");
    const started = Date.now();
    const exit = await runGroup(r, "python3", ["-m", "unittest", "discover", "-s", suite], log);
    if (exit.error?.code === "ENOENT") {
      missing = true;
      return r.record(false, suite, 0, "python3 가 없다");
    }
    const ok = exit.code === 0 && !exit.timedOut && !exit.error;
    r.record(ok, suite, seconds(started), exit.error ? `실행 실패 ${exit.error.code}` : why(exit), log);
  };
  const worker = async () => {
    while (next < suites.length) {
      const index = next++;
      await one(suites[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, suites.length) }, worker));
}

// 다른 실행기가 남긴 임시 설치 폴더는 그 pid 가 죽었을 때만 지운다. worker 여럿이 함께 돌기 때문이다.
function sweepStaleInstalls(dir: string) {
  const parent = dirname(dir);
  const prefix = `${basename(dir)}.tmp-`;
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length));
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !alive(pid)) rmSync(join(parent, name), { recursive: true, force: true });
  }
}

export function tscDir() {
  if (process.env.FOS_TSC_DIR) return resolve(process.env.FOS_TSC_DIR);
  const hash = createHash("sha256").update(`${TYPESCRIPT} ${NODE_TYPES}`).digest("hex").slice(0, 12);
  return join(cacheHome(), "fos-skills", "tsc", hash);
}

async function tscPhase(r: Runner) {
  const log = join(r.out, "tsc.log");
  writeFileSync(log, "");
  const started = Date.now();
  const dir = tscDir();
  const bin = (root: string) => join(root, "node_modules", ".bin", "tsc");
  sweepStaleInstalls(dir);
  if (!existsSync(bin(dir))) {
    const tmp = `${dir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const install = await runGroup(r, "npm", ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", tmp, TYPESCRIPT, NODE_TYPES], log);
    if (install.error || install.code !== 0 || !existsSync(bin(tmp))) {
      rmSync(tmp, { recursive: true, force: true });
      const reason = install.error?.code === "ENOENT" ? "npm 이 없다" : `TypeScript 설치 실패: ${install.error ? install.error.code : why(install)}`;
      return r.record(false, "tsc", seconds(started), reason, log);
    }
    try {
      // 같은 파일 시스템의 rename 은 원자적이다. 다른 실행기가 먼저 옮겼으면 그쪽을 쓰고 내 것을 지운다.
      renameSync(tmp, dir);
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(bin(dir))) return r.record(false, "tsc", seconds(started), `TypeScript 설치 폴더를 옮기지 못했다. ${dir} 를 지우고 다시 돌린다`, log);
    }
  }
  const exit = await runGroup(r, bin(dir), ["-p", "tsconfig.json", "--typeRoots", join(dir, "node_modules", "@types")], log);
  const ok = exit.code === 0 && !exit.timedOut && !exit.error;
  r.record(ok, "tsc", seconds(started), exit.error ? `실행 실패 ${exit.error.code}` : why(exit), log);
}

async function run(opts: Options, cwd: string): Promise<number> {
  const started = Date.now();
  let targets: Targets;
  if (opts.patterns.length) targets = expand(opts.patterns, cwd);
  else {
    const found = discover(cwd);
    if (!found) {
      console.error(`git 저장소가 아니다: ${cwd}. 인자 없이 부르면 git 의 파일 목록에서 묶음을 찾는다`);
      return 2;
    }
    targets = found;
  }
  if (!targets.node.length && !targets.python.length) {
    console.error(`돌릴 테스트 파일이 없다: ${opts.patterns.length ? opts.patterns.join(" ") : "tests/ 아래 *.spec.ts 와 test_*.py"}`);
    return 2;
  }
  const out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), "run-tests-"));
  mkdirSync(out, { recursive: true });
  const summary = join(out, SUMMARY);
  writeFileSync(summary, "");
  writeFileSync(join(out, PID_FILE), String(process.pid));
  const pyConcurrency = Math.ceil(opts.concurrency / 2);
  console.log(
    `결과 폴더: ${out} (node 파일 ${targets.node.length}개, Python 묶음 ${targets.python.length}개${targets.tsc ? ", tsc" : ""}, 동시 ${opts.concurrency}개)`,
  );

  const stop = () => {
    for (const child of running) killGroup(child);
    process.exit(2);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let passed = 0;
  let failed = 0;
  const record = (ok: boolean, name: string, secs: number, reason?: string, log?: string) => {
    if (ok) passed++;
    else failed++;
    const line = ok ? `통과 ${name} ${secs.toFixed(1)}s` : `실패 ${name} ${secs.toFixed(1)}s (${reason})${log ? ` 로그: ${log}` : ""}`;
    appendFileSync(summary, line + "\n");
    console.log(line);
  };
  const r: Runner = { cwd, out, timeout: opts.timeout, running, record };
  await Promise.all([
    targets.tsc ? tscPhase(r) : undefined,
    targets.node.length ? nodePhase(r, targets.node, opts.concurrency) : undefined,
    targets.python.length ? pythonPhase(r, targets.python, pyConcurrency) : undefined,
  ]);
  const end = `${END_PREFIX}통과 ${passed}, 실패 ${failed}, 전체 ${passed + failed}, 걸린 시간 ${seconds(started).toFixed(1)}s`;
  appendFileSync(summary, end + "\n");
  console.log(end);
  return failed ? 1 : 0;
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
      // 요약을 읽은 뒤 실행기가 끝 줄을 쓰고 끝났을 수 있다. 한 번 더 읽는다.
      const again = readFileSync(summary, "utf8").split("\n").filter(Boolean);
      const late = again.find((line) => line.startsWith(END_PREFIX));
      if (late) {
        console.log(again.join("\n"));
        return / 실패 0,/.test(late) ? 0 : 1;
      }
      console.log(lines.join("\n"));
      console.error(`실행기(pid ${pid})가 끝 줄 없이 멈췄다. 로그: ${join(dir, "runner.log")}`);
      return 2;
    }
    if (Date.now() >= deadline) {
      console.log(`아직 끝나지 않았다: 끝난 항목 ${lines.length}개. 같은 명령으로 다시 기다린다`);
      return 3;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function background(argv: string[], opts: Options): number {
  const out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), "run-tests-"));
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
  console.log(`기다리기: node scripts/run-tests.ts --wait "${out}"`);
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
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      for (const child of running) killGroup(child);
      console.error(`실행기가 멈췄다: ${(error as Error).stack ?? error}`);
      process.exit(2);
    },
  );
}
