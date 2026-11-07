// scripts/run-tests.ts 의 묶음 찾기, 요약 줄, 끝 줄, 종료 코드, 대조와 감시를 임시 폴더의 테스트로 본다.
// 실행기는 실제 npm 설치를 하지 않게 FOS_TSC_DIR 에 가짜 tsc 를 둔 폴더로 돌린다.

import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, reconcile } from "../run-tests.ts";

const RUNNER = fileURLToPath(new URL("../run-tests.ts", import.meta.url));

const PASS = "import test from 'node:test';\ntest('ok', () => {});\n";
const FAIL = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('no', () => { assert.equal(1, 2); });\n";
const SLOW = "import test from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 4000)); });\n";
const TEST_TIMEOUT = "import test from 'node:test';\ntest('slow', { timeout: 100 }, async () => { await new Promise((r) => setTimeout(r, 3000)); });\n";
const EXIT3 = "import test from 'node:test';\ntest('exit', () => { process.exit(3); });\n";
// 자기 프로세스 그룹 전체에 신호를 보낸다. node --test 가 끊겨 남은 파일의 보고가 오지 않는다.
const KILLER = "import test from 'node:test';\ntest('kill group', async () => { await new Promise((r) => setTimeout(r, 300)); process.kill(0, 'SIGTERM'); });\n";
// stdio 를 쥔 손자를 남긴다. --test-timeout 으로도 node --test 가 끝나지 않는다.
const LEAK = "import test from 'node:test';\nimport { spawn } from 'node:child_process';\ntest('leak', () => { spawn('sleep', ['30'], { stdio: 'inherit' }).unref(); });\n";
const PY_OK = "import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n";
const PY_BAD = "import unittest\n\nclass T(unittest.TestCase):\n    def test_bad(self):\n        self.fail('no')\n";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix = "run-tests-spec-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function write(root: string, file: string, body: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

function fakeTsc(code: number) {
  const dir = tempDir("run-tests-tsc-");
  write(dir, "node_modules/.bin/tsc", `#!/bin/sh\nexit ${code}\n`);
  chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
  return dir;
}

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]) {
  const done = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
}

function gitRepo(files: Record<string, string>) {
  const root = tempDir();
  git(root, "init", "-q");
  for (const [file, body] of Object.entries(files)) write(root, file, body);
  return root;
}

type Done = { code: number | null; out: string; err: string; ms: number };

function runner(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Promise<Done> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [RUNNER, ...args], { cwd, env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - started }));
  });
}

function summary(out: string) {
  return readFileSync(join(out, "summary.txt"), "utf8");
}

describe("run-tests", { concurrency: true }, () => {
  test("기본 동시 수는 사용 가능한 CPU 이하이고 상한이 있으며 명시 옵션이 우선한다", () => {
    for (const [cpu, expected] of [[1, 1], [2, 2], [6, 6], [8, 8], [12, 8], [64, 8]]) {
      assert.equal(parseArgs([], cpu).concurrency, expected);
    }
    const actual = parseArgs([]).concurrency;
    assert.ok(actual >= 1 && actual <= 8 && actual <= availableParallelism());
    assert.equal(parseArgs(["--concurrency", "12"], 2).concurrency, 12);
    assert.equal(parseArgs(["--concurrency", "2"], 12).concurrency, 2);
  });

  test("인자 없이 git 이 추적하거나 무시하지 않는 묶음과 tsc 를 함께 돈다", async () => {
    const root = gitRepo({
      ".gitignore": "ignored/\n",
      "a/tests/ok.spec.ts": PASS,
      "a/tests/bad.spec.ts": FAIL,
      "b/tests/test_ok.py": PY_OK,
      "ignored/tests/x.spec.ts": PASS,
      "c/tests/test_gone.py": PY_OK,
    });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    rmSync(join(root, "c"), { recursive: true });
    const out = join(root, "..", `${root.split("/").pop()}-out`);
    roots.push(out);
    const done = await runner(root, ["--out", out], { FOS_TSC_DIR: fakeTsc(0) });
    assert.equal(done.code, 1, done.out + done.err);
    const text = summary(out);
    assert.match(text, /^통과 a\/tests\/ok\.spec\.ts [\d.]+s$/m);
    assert.match(text, /^실패 a\/tests\/bad\.spec\.ts [\d.]+s \(테스트 실패\) 로그: .+node\.log$/m);
    assert.match(text, /^통과 b\/tests [\d.]+s$/m);
    assert.match(text, /^통과 tsc [\d.]+s$/m);
    assert.match(text, /^결과: 통과 3, 실패 1, 전체 4, 걸린 시간 [\d.]+s$/m);
    assert.doesNotMatch(text, /ignored|c\/tests/);
    assert.equal(done.out.trim().split("\n").at(-1), text.trim().split("\n").at(-1));
  });

  test("실패하는 Python 묶음을 인자로 주면 그 폴더가 실패다", async () => {
    const root = tempDir();
    write(root, "d/tests/test_bad.py", PY_BAD);
    const done = await runner(root, ["d/tests/test_bad.py"]);
    assert.equal(done.code, 1, done.out + done.err);
    assert.match(done.out, /^실패 d\/tests [\d.]+s \(종료 코드 1\) 로그: /m);
    assert.match(done.out, /^결과: 통과 0, 실패 1, 전체 1, /m);
  });

  test("--test-timeout 에 걸린 테스트가 든 파일은 시간 초과 실패다", async () => {
    const root = tempDir();
    write(root, "t/slow.spec.mjs", TEST_TIMEOUT);
    write(root, "t/ok.spec.mjs", PASS);
    const done = await runner(root, ["t/*.spec.mjs"]);
    assert.equal(done.code, 1, done.out + done.err);
    assert.match(done.out, /^실패 t\/slow\.spec\.mjs [\d.]+s \(시간 초과\) 로그: /m);
    assert.match(done.out, /^통과 t\/ok\.spec\.mjs /m);
  });

  test("모두 통과면 0 이고 인자로 준 파일만 돌며 tsc 는 돌지 않는다", async () => {
    const root = tempDir();
    write(root, "t/a.spec.mjs", PASS);
    write(root, "t/b.spec.mjs", FAIL);
    write(root, "py/tests/test_ok.py", PY_OK);
    const done = await runner(root, ["t/a.spec.mjs"]);
    assert.equal(done.code, 0, done.out + done.err);
    assert.match(done.out, /^통과 t\/a\.spec\.mjs [\d.]+s$/m);
    assert.doesNotMatch(done.out, /b\.spec|tsc|py\/tests/);
    assert.match(done.out, /^결과: 통과 1, 실패 0, 전체 1, 걸린 시간 [\d.]+s$/m);
  });

  test("폴더를 인자로 주면 Python 묶음이거나 그 아래 *.spec.ts 다", async () => {
    const root = tempDir();
    write(root, "x/tests/a.spec.ts", PASS);
    write(root, "x/tests/deep/b.spec.ts", PASS);
    write(root, "y/tests/test_ok.py", PY_OK);
    write(root, "z/one.spec.mjs", PASS);
    const done = await runner(root, ["x/tests/", "y/tests", join(root, "z/one.spec.mjs")]);
    assert.equal(done.code, 0, done.out + done.err);
    assert.match(done.out, /^통과 x\/tests\/a\.spec\.ts /m);
    assert.match(done.out, /^통과 x\/tests\/deep\/b\.spec\.ts /m);
    assert.match(done.out, /^통과 y\/tests /m);
    const absolute = join(root, "z/one.spec.mjs");
    assert.ok(done.out.split("\n").some((line) => line.startsWith(`통과 ${absolute} `)), done.out);
    assert.match(done.out, /^결과: 통과 4, 실패 0, 전체 4, /m);
  });

  test("process.exit 로 끝나는 파일과 그룹에 신호를 보내 끊긴 실행은 실패 0 이 아니다", async () => {
    const root = tempDir();
    write(root, "t/exit.spec.mjs", EXIT3);
    write(root, "t/kill.spec.mjs", KILLER);
    write(root, "t/slow.spec.mjs", SLOW);
    const done = await runner(root, ["--concurrency", "3", "t/*.spec.mjs"]);
    assert.equal(done.code, 1, done.out + done.err);
    // 신호 전달 시점에 따라 Node가 파일 실패를 보고하거나 보고 전에 끝난다. 둘 다 실패여야 한다.
    assert.match(done.out, /^실패 t\/slow\.spec\.mjs [\d.]+s \((?:보고 없음|신호 SIGTERM)\) 로그: /m);
    assert.match(done.out, /^실패 t\/kill\.spec\.mjs /m);
    assert.doesNotMatch(done.out, /^결과: .* 실패 0,/m);
    assert.match(done.out, /^결과: 통과 0, 실패 3, 전체 3, /m);
  });

  test("stdio 를 쥔 손자를 남기면 무진행 감시가 --timeout 뒤 시간 초과로 끊는다", async () => {
    const root = tempDir();
    write(root, "t/leak.spec.mjs", LEAK);
    const done = await runner(root, ["--timeout", "2", "t/leak.spec.mjs"]);
    assert.equal(done.code, 1, done.out + done.err);
    assert.match(done.out, /^실패 t\/leak\.spec\.mjs [\d.]+s \(시간 초과\) 로그: /m);
    assert.ok(done.ms < 20000, `${done.ms}ms`);
  });

  test("python3 를 띄우지 못하면 Python 묶음이 실패다", async () => {
    const root = tempDir();
    write(root, "b/tests/test_ok.py", PY_OK);
    write(root, "e/tests/test_ok.py", PY_OK);
    write(root, "f/tests/test_ok.py", PY_OK);
    // 실행기는 node 를 process.execPath 로 띄우고 인자 모드는 git 이 필요 없어 빈 PATH 로 돈다.
    const done = await runner(root, ["--concurrency", "2", "b/tests", "e/tests", "f/tests"], { PATH: tempDir("run-tests-bin-") });
    assert.equal(done.code, 1, done.out + done.err);
    for (const suite of ["b", "e", "f"]) assert.match(done.out, new RegExp(`^실패 ${suite}/tests 0\\.0s \\(python3 가 없다\\)`, "m"));
  });

  test("tsc 가 실패하면 실패 tsc 와 1 이다", async () => {
    const root = gitRepo({ "a/tests/ok.spec.ts": PASS });
    const done = await runner(root, [], { FOS_TSC_DIR: fakeTsc(1) });
    assert.equal(done.code, 1, done.out + done.err);
    assert.match(done.out, /^실패 tsc [\d.]+s \(종료 코드 1\) 로그: .+tsc\.log$/m);
    assert.match(done.out, /^통과 a\/tests\/ok\.spec\.ts /m);
  });

  test("TypeScript 가 없고 npm 도 없으면 실패 tsc 의 이유가 npm 이 없다는 것이다", async () => {
    const root = gitRepo({ "a/tests/ok.spec.ts": PASS });
    const empty = tempDir("run-tests-empty-");
    const bin = tempDir("run-tests-bin-");
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const done = await runner(root, [], { FOS_TSC_DIR: empty, PATH: bin });
    assert.equal(done.code, 1, done.out + done.err);
    assert.match(done.out, /^실패 tsc [\d.]+s \(npm 이 없다\)/m);
    assert.deepEqual(readdirSync(dirname(empty)).filter((name) => name.startsWith(`${basename(empty)}.tmp-`)), []);
  });

  test("--background 뒤 --wait 가 끝 줄을 읽고, 덜 끝났으면 3 이다", async () => {
    const root = tempDir();
    const out = join(root, "out");
    write(root, "t/a.spec.mjs", PASS);
    write(root, "t/slow.spec.mjs", SLOW);
    const started = await runner(root, ["--background", "--out", out, "t/*.spec.mjs"]);
    assert.equal(started.code, 0, started.err);
    assert.ok(started.out.includes(`node scripts/run-tests.ts --wait "${out}"`), started.out);
    const early = await runner(root, ["--wait", out, "--max-wait", "1"]);
    assert.equal(early.code, 3, early.out + early.err);
    assert.match(early.out, /같은 명령으로 다시 기다린다/);
    const done = await runner(root, ["--wait", out, "--max-wait", "60"]);
    assert.equal(done.code, 0, done.out + done.err);
    assert.match(done.out, /^결과: 통과 2, 실패 0, 전체 2, 걸린 시간 [\d.]+s$/m);
  });

  test("실행기가 끝 줄 없이 죽었으면 --wait 는 2 다", async () => {
    const root = tempDir();
    const out = join(root, "out");
    mkdirSync(out);
    writeFileSync(join(out, "summary.txt"), "통과 t/a.spec.mjs 0.1s\n");
    const dead = spawnSync("true");
    writeFileSync(join(out, "runner.pid"), String(dead.pid));
    const done = await runner(root, ["--wait", out, "--max-wait", "5"]);
    assert.equal(done.code, 2, done.out + done.err);
    assert.match(done.err, /끝 줄 없이 멈췄다/);
  });

  test("사용법 오류와 대상 없음, git 밖에서 인자 없이 부르면 2 다", async () => {
    const root = tempDir();
    const cases = [
      ["--bogus"],
      ["--out"],
      ["--concurrency", "0"],
      ["--wait", join(root, "missing")],
      ["t/none.spec.mjs"],
    ];
    for (const args of cases) {
      const done = await runner(root, args);
      assert.equal(done.code, 2, `${args.join(" ")}: ${done.out}${done.err}`);
    }
    const outside = await runner(root, [], { GIT_CEILING_DIRECTORIES: dirname(root) });
    assert.equal(outside.code, 2, outside.out + outside.err);
    assert.match(outside.err, /git 저장소가 아니다/);
  });

  test("부모 환경에 NODE_TEST_CONTEXT 가 있어도 요약 줄이 나온다", async () => {
    const root = tempDir();
    write(root, "t/a.spec.mjs", PASS);
    const done = await runner(root, ["t/a.spec.mjs"], { NODE_TEST_CONTEXT: "child-v8" });
    assert.equal(done.code, 0, done.out + done.err);
    assert.match(done.out, /^통과 t\/a\.spec\.mjs [\d.]+s$/m);
  });
});

describe("reconcile", () => {
  const files = ["a.spec.ts", "b.spec.ts"];

  test("보고가 없는 파일은 보고 없음, 감시가 끊었으면 시간 초과다", () => {
    assert.deepEqual(reconcile(files, new Set(["a.spec.ts"]), 0, { code: 1, signal: null }, false), [{ ok: false, name: "b.spec.ts", why: "보고 없음" }]);
    assert.deepEqual(reconcile(files, new Set(), 0, { code: null, signal: "SIGKILL" }, true), [
      { ok: false, name: "a.spec.ts", why: "시간 초과" },
      { ok: false, name: "b.spec.ts", why: "시간 초과" },
    ]);
  });

  test("모두 보고됐는데 종료 코드가 0 이 아니고 실패가 없으면 node 단계 줄을 더한다", () => {
    const all = new Set(files);
    assert.deepEqual(reconcile(files, all, 0, { code: 7, signal: null }, false), [{ ok: false, name: "node 단계", why: "종료 코드 7" }]);
    assert.deepEqual(reconcile(files, all, 0, { code: null, signal: "SIGTERM" }, false), [{ ok: false, name: "node 단계", why: "신호 SIGTERM" }]);
    assert.deepEqual(reconcile(files, all, 1, { code: 1, signal: null }, false), []);
    assert.deepEqual(reconcile(files, all, 0, { code: 0, signal: null }, false), []);
  });
});
