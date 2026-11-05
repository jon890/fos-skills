#!/usr/bin/env node
// 저장소에 남은 Python·셸 파일과 JS 진입을 정책 파일(scripts/runtime-policy.json)과 대조한다.
//
// 왜 필요한가:
//   이 저장소의 스크립트와 테스트는 TypeScript(Node 24) 하나로 둔다(docs/code-architecture.md 「저장소 실행 규칙」).
//   옮기는 동안 남은 파일은 영역별 경로 접두(pending)로 허용하고, 그 밖에 새로 생긴 Python·셸 파일과 허용하지 않은
//   JS 진입을 파일 이름과 함께 막는다. 영역을 옮긴 PR 은 pending 에서 그 영역 줄만 지운다.
//
// 사용법 (cwd: 저장소 안 어디서나. 저장소 루트는 git rev-parse --show-toplevel 로 찾는다)
//   node scripts/runtime-policy.ts             위반을 찾는다
//   node scripts/runtime-policy.ts --pending   영역마다 남은 파일 수도 낸다
//
// 판정 (classify)
//   .ts 는 shebang 과 상관없이 대상이 아니다.
//   첫 줄이 #! 이면 해석기가 먼저다. 해석기는 #! 뒤 첫 낱말이고, 그것이 env 로 끝나면 - 로 시작하는 낱말(-S 포함)을
//   건너뛴 다음 낱말이다. 이름이 python 으로 시작하면 python, sh·bash·zsh 면 shell, node 면 js-entry 다.
//   그 밖의 해석기와 shebang 이 없는 파일은 확장자로 정한다: .py 는 python, .sh·.bash·.zsh 는 shell,
//   .js·.mjs·.cjs 는 js-entry, 나머지는 대상이 아니다.
//
// 출력 줄
//   NEW <경로> <종류>               python·shell 파일이 pending 접두 밖에 있거나, js-entry 가 entry_js·legacy 에 없다
//   STALE pending <영역> <접두>     그 접두 아래 python·shell 파일이 없다. 영역을 옮겼으면 그 줄을 지운다
//   STALE <entry_js|legacy> <경로>  적은 경로가 추적 파일에 없거나 js-entry 가 아니다
//   MIN-NODE <경로>:<줄> <값>       줄 머리의 `const MIN_NODE = [a, b]` 가 min_node 와 다르다(js-entry 와 tests/ 밖 .ts)
//   DOC <경로>:<줄> <내용>          migrated_docs 접두 아래 .md 가 `python3 ` 나 `bash "$SKILL_DIR/...sh` 로 부른다
//                                   (CHANGELOG.md 와 changes/ 아래는 보지 않는다)
//   PENDING <영역> <남은 파일 수>   --pending 일 때만
//   OK pending <영역 수>            위반이 없을 때 끝 줄
//
// 종료 코드
//   0  위반이 없다
//   1  위반이 있다
//   2  실행하지 못했다. 모르는 인자, git 저장소 밖, 정책 파일을 읽지 못하거나 형식이 틀렸다(이유는 stderr)

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type Kind = "python" | "shell" | "js-entry";
export type PendingEntry = { area: string; prefix: string };
export type Policy = {
  pending: PendingEntry[];
  legacy: string[];
  entry_js: string[];
  migrated_docs: string[];
  min_node: [number, number];
};
export type FileHead = { path: string; firstLine: string };
export type FileText = { path: string; text: string };

const SHELLS = new Set(["sh", "bash", "zsh"]);
const BY_EXTENSION: Record<string, Kind> = {
  ".py": "python",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".js": "js-entry",
  ".mjs": "js-entry",
  ".cjs": "js-entry",
};

function extension(path: string) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function interpreter(firstLine: string): string | null {
  if (!firstLine.startsWith("#!")) return null;
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let name = basename(words[0]);
  if (name.endsWith("env")) {
    const next = words.slice(1).find((word) => !word.startsWith("-"));
    if (!next) return null;
    name = basename(next);
  }
  return name;
}

export function classify(path: string, firstLine: string): Kind | null {
  const ext = extension(path);
  if (ext === ".ts") return null;
  const name = interpreter(firstLine);
  if (name !== null) {
    if (name.startsWith("python")) return "python";
    if (SHELLS.has(name)) return "shell";
    if (name === "node") return "js-entry";
  }
  return BY_EXTENSION[ext] ?? null;
}

function isScript(kind: Kind | null) {
  return kind === "python" || kind === "shell";
}

export function checkPolicy(policy: Policy, files: FileHead[]): string[] {
  const lines: string[] = [];
  const kinds = new Map<string, Kind | null>();
  for (const file of files) kinds.set(file.path, classify(file.path, file.firstLine));
  const allowedJs = new Set([...policy.entry_js, ...policy.legacy]);
  for (const [path, kind] of kinds) {
    if (isScript(kind) && !policy.pending.some((entry) => path.startsWith(entry.prefix))) lines.push(`NEW ${path} ${kind}`);
    if (kind === "js-entry" && !allowedJs.has(path)) lines.push(`NEW ${path} js-entry`);
  }
  for (const entry of policy.pending) {
    const covered = [...kinds].some(([path, kind]) => isScript(kind) && path.startsWith(entry.prefix));
    if (!covered) lines.push(`STALE pending ${entry.area} ${entry.prefix}`);
  }
  for (const key of ["entry_js", "legacy"] as const) {
    for (const path of policy[key]) {
      if (kinds.get(path) !== "js-entry") lines.push(`STALE ${key} ${path}`);
    }
  }
  return lines;
}

export function checkMinNode(min: [number, number], sources: FileText[]): string[] {
  const lines: string[] = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(/^const MIN_NODE = \[(\d+), (\d+)\]/gm)) {
      if (Number(match[1]) === min[0] && Number(match[2]) === min[1]) continue;
      const line = source.text.slice(0, match.index).split("\n").length;
      lines.push(`MIN-NODE ${source.path}:${line} [${match[1]}, ${match[2]}]`);
    }
  }
  return lines;
}

const OLD_CALL = /(?:^|[\s`])(?:python3 |bash "\$SKILL_DIR\/[^"\s]*\.sh)/;

function isCheckedDoc(path: string, prefix: string) {
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return false;
  if (basename(path) === "CHANGELOG.md") return false;
  return !path.slice(prefix.length).split("/").slice(0, -1).includes("changes");
}

export function checkDocs(prefixes: string[], docs: FileText[]): string[] {
  const lines: string[] = [];
  for (const doc of docs) {
    if (!prefixes.some((prefix) => isCheckedDoc(doc.path, prefix))) continue;
    doc.text.split("\n").forEach((text, index) => {
      if (OLD_CALL.test(text)) lines.push(`DOC ${doc.path}:${index + 1} ${text.trim()}`);
    });
  }
  return lines;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

// 형식이 틀리면 이유를 담은 Error 를 던진다. 다른 키는 다른 검사가 쓸 수 있어 막지 않는다.
export function parsePolicy(text: string): Policy {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("최상위가 객체가 아니다");
  const pending = data.pending;
  if (
    !Array.isArray(pending) ||
    !pending.every((entry) => entry && typeof entry.area === "string" && entry.area && typeof entry.prefix === "string" && entry.prefix)
  ) {
    throw new Error("pending 은 { area, prefix } 문자열 객체의 배열이어야 한다");
  }
  for (const key of ["legacy", "entry_js", "migrated_docs"]) {
    if (!isStringList(data[key])) throw new Error(`${key} 는 빈 문자열이 없는 문자열 배열이어야 한다`);
  }
  const min = data.min_node;
  if (!Array.isArray(min) || min.length !== 2 || !min.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error("min_node 는 [major, minor] 정수 둘이어야 한다");
  }
  return data as unknown as Policy;
}

function firstLineOf(path: string) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(512);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, size).toString("utf8").split("\n")[0];
  } finally {
    closeSync(fd);
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fail(message: string): never {
  process.stderr.write(`runtime-policy: ${message}\n`);
  process.exit(2);
}

function main(argv: string[]) {
  let showPending = false;
  for (const arg of argv) {
    if (arg === "--pending") showPending = true;
    else fail(`모르는 인자: ${arg} (사용법: node scripts/runtime-policy.ts [--pending])`);
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.error || top.status !== 0) fail("git 저장소 안에서 실행해야 한다");
  const root = top.stdout.trim();

  let policy: Policy;
  try {
    policy = parsePolicy(readFileSync(join(root, "scripts/runtime-policy.json"), "utf8"));
  } catch (error) {
    fail(`scripts/runtime-policy.json 을 읽지 못했다: ${(error as Error).message}`);
  }

  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) fail("git ls-files 가 실패했다");
  // 추적되지만 작업 트리에 없는 파일(지웠지만 아직 커밋하지 않은 것)은 뺀다.
  const paths = listed.stdout.split("\0").filter((path) => path && isFile(join(root, path)));
  const heads = paths.map((path) => ({ path, firstLine: firstLineOf(join(root, path)) }));

  const kinds = new Map(heads.map((file) => [file.path, classify(file.path, file.firstLine)]));
  const sources = paths
    .filter((path) => kinds.get(path) === "js-entry" || (path.endsWith(".ts") && !path.includes("/tests/") && !path.startsWith("tests/")))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const docs = paths
    .filter((path) => policy.migrated_docs.some((prefix) => isCheckedDoc(path, prefix)))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));

  const areas = [...new Set(policy.pending.map((entry) => entry.area))];
  if (showPending) {
    for (const area of areas) {
      const prefixes = policy.pending.filter((entry) => entry.area === area).map((entry) => entry.prefix);
      const count = heads.filter((file) => isScript(kinds.get(file.path) ?? null) && prefixes.some((prefix) => file.path.startsWith(prefix))).length;
      process.stdout.write(`PENDING ${area} ${count}\n`);
    }
  }

  const violations = [
    ...checkPolicy(policy, heads),
    ...checkMinNode(policy.min_node, sources),
    ...checkDocs(policy.migrated_docs, docs),
  ];
  if (violations.length > 0) {
    process.stdout.write(`${violations.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`OK pending ${areas.length}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
