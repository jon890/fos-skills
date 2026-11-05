#!/usr/bin/env node
// 저장소 Markdown 의 링크·앵커, 링크 없는 ADR 식별자, ADR 색인, 번호 중복, 대체된 ADR 위치를 검사하고 색인을 만든다.
//
// 왜 필요한가:
//   같은 규칙을 저장소 스크립트, docs-audit, plan 이 따로 갖고 조금씩 다르게 판정했다. 이 파일 하나가 규칙의
//   원본이다. spec, technical-design, review-fix, docs-audit 가 작성 단계에서 부르고, 저장소 CI 에 사본을 두지 않는다
//   (docs/features/docs-check-ownership/spec.md DECISION1, DECISION5).
//
// 사용법 (cwd: 대상 저장소 안. 루트는 git rev-parse --show-toplevel 로 찾는다)
//   node adr-docs.ts check [--adr-dir GLOB]... [--flat] [--index generated|ids] [--changed-since REF] [--scope PATH]
//   node adr-docs.ts write-index [--adr-dir GLOB]...
//
// 옵션
//   --adr-dir GLOB      ADR 폴더. 저장소 루트 기준이고 `*` 는 경로 한 층만 맞춘다. 여러 번 준다 (기본 docs/adr).
//                       맞는 폴더가 없으면 ADR 검사를 건너뛰고 링크 검사만 한다
//   --flat              대체된 ADR 을 superseded/ 로 옮기지 않는 저장소. ADR_PLACEMENT 를 하지 않는다
//   --index MODE        generated: INDEX.md 가 write-index 결과와 글자까지 같아야 한다.
//                       ids (기본): 파일 이름의 식별자 집합과 INDEX.md 가 링크로 가리키는 ADR 집합만 맞춘다.
//                       INDEX.md 가 없는 폴더는 ids 에서 건너뛰고, generated 에서 INDEX_STALE 이다.
//                       generated 에서는 ADR 폴더의 INDEX.md 에 링크·식별자 검사를 하지 않는다(INDEX_STALE 이 보증한다)
//   --changed-since REF `git diff --name-status REF...HEAD` 와 작업 트리 변경(미추적 포함)을 바뀐 파일로 본다.
//                       바뀐 파일의 위반을 먼저 내고 나머지는 `PR 밖 위반:` 줄 뒤에 낸다. 종료 코드는 바뀐 쪽만 센다.
//                       색인·중복 위반은 그 ADR 폴더 안 파일이 하나라도 바뀌었으면, 깨진 링크·앵커는 링크 대상이
//                       지워졌거나 옮겨졌거나 바뀌었으면 바뀐 쪽으로 센다
//   --scope PATH        결과를 그 경로 아래 문서로 좁힌다. 링크 대상은 범위 밖이어도 찾는다
//   write-index 는 --flat, --index 를 받기만 하고 쓰지 않는다. 부르는 쪽이 같은 인자 묶음을 넘길 수 있게 한다.
//
// 검사 대상: git 이 추적하거나, 추적하지 않았어도 무시하지 않는 .md 파일. 코드 블록(들여 쓴 펜스 포함)과 코드 스팬 안은 보지 않는다.
//   각주 정의(`[^1]:`)는 링크가 아니다. 저장소 안 링크 대상은 대소문자까지 맞아야 한다.
//   앵커는 # 제목, setext 제목, <a id|name=...> 에서 만든다.
//
// ADR 파일: ADR 폴더와 그 하위 폴더에서 이름이 아래 꼴인 .md
//   NNN-slug.md              식별자 ADR-NNN
//   ADR-YYYYMMDD-slug.md     식별자 ADR-YYYYMMDD / slug (같은 날 ADR 은 slug 로 갈린다)
//   ADR-M01-slug.md          식별자 ADR-M01 (영역 글자 꼴)
//   본문에서는 저장소에 있는 꼴의 식별자만 찾는다.
//
// 출력 (stdout, 위반마다 한 줄. 경로는 저장소 루트 기준, 줄 번호를 모르면 1)
//   <경로>:<줄>: BROKEN_LINK <대상>               상대 링크(이미지, 참조 정의 포함)의 대상이 없다
//   <경로>:<줄>: BROKEN_ANCHOR <대상>             #앵커 가 대상 Markdown 의 제목에 없다
//   <경로>:<줄>: ADR_UNLINKED <식별자> → 후보: a.md, b.md   링크 글 밖에 식별자를 적었다(후보가 없으면 `→ 후보 없음`).
//                                                 ADR 제목 줄과 계획서 폴더(tasks/, planNNN) 안은 보지 않는다
//   <폴더>/INDEX.md:1: INDEX_STALE ...            generated 모드에서 색인이 write-index 결과와 다르다
//   <폴더>/INDEX.md:1: INDEX_DESYNC ...           ids 모드에서 식별자 집합이 다르다
//   <경로>:1: ADR_DUPLICATE ...                   한 ADR 폴더 안에서 같은 식별자가 두 파일에 있다
//   <경로>:<줄>: ADR_PLACEMENT ...                superseded 인 ADR 이 superseded/ 밖에 있거나 그 반대다
//   stderr 마지막 줄: `검사한 Markdown: N개, ADR 폴더: M개`
//
// 앵커 슬러그: GitHub 규칙. 제목에서 링크는 글만, 코드 스팬은 백틱만 남기고 소문자로 바꾼 뒤
//   \p{L}\p{N}\p{M}, 공백, _, - 밖의 문자를 지우고 공백을 - 로 바꾼다. 같은 슬러그가 다시 나오면 -1, -2 를 붙인다.
//
// 색인 (write-index): ADR 폴더마다 INDEX.md 를 「현행」·「대체됨」 두 표로 쓴다. 열은 번호, 결정, 상태, 대체 관계다.
//   status 가 superseded 면 「대체됨」, 그 밖은 「현행」 이다. 대체 관계는 `- **대체된 부분**:` 항목 안의 링크 가운데
//   링크 글에 ADR 식별자가 들어 있고 대상이 ADR 파일인 것이며, 링크 글이 아니라 대상 파일의 식별자를 적는다.
//   내용이 같으면 파일을 다시 쓰지 않는다. check 는 어떤 파일도 쓰지 않는다.
//
// 종료 코드
//   0  위반 없음 (write-index 는 썼거나 쓸 것이 없었다)
//   1  위반 있음 (--changed-since 면 바뀐 쪽 위반만 센다)
//   2  실행하지 못했다. 인자 오류, git 저장소 밖, 기준 ref 를 읽지 못함, 읽기·쓰기 실패, write-index 할 폴더가 없음

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type IndexMode = "generated" | "ids";
export type Options = {
  command: "check" | "write-index";
  adrDirs: string[];
  flat: boolean;
  index: IndexMode;
  changedSince?: string;
  scope?: string;
};
export type AdrKind = "number" | "date" | "area";
export type AdrName = { kind: AdrKind; id: string; date?: string };
export type AdrFile = AdrName & { path: string; dir: string };
export type Violation = {
  path: string;
  line: number;
  code: string;
  message: string;
  // --changed-since 의 귀속에 쓴다
  adrDir?: string;
  target?: string;
};

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "write-index") throw new UsageError(`하위 명령은 check 나 write-index 다: ${command ?? "(없음)"}`);
  const opts: Options = { command, adrDirs: [], flat: false, index: "ids" };
  const value = (i: number, name: string) => {
    const v = rest[i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} 에 값이 없다`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--adr-dir") opts.adrDirs.push(value(++i, arg));
    else if (arg === "--flat") opts.flat = true;
    else if (arg === "--index") {
      const mode = value(++i, arg);
      if (mode !== "generated" && mode !== "ids") throw new UsageError(`--index 는 generated 나 ids 다: ${mode}`);
      opts.index = mode;
    } else if (arg === "--changed-since" && command === "check") opts.changedSince = value(++i, arg);
    else if (arg === "--scope" && command === "check") opts.scope = value(++i, arg);
    else throw new UsageError(`모르는 옵션: ${arg}`);
  }
  if (opts.adrDirs.length === 0) opts.adrDirs.push("docs/adr");
  return opts;
}

// ---------- Markdown 읽기 ----------

// 목록 안에 4칸 넘게 들여 쓴 펜스도 펜스로 본다. 들여쓴 블록 안 예시 링크를 본문으로 읽지 않게 한다.
const FENCE = /^\s*(`{3,}|~{3,})/;

// 코드 블록 줄을 빈 줄로, 코드 스팬을 빈 글로 바꾼다. 줄 번호는 그대로다.
export function prose(text: string, stripSpans = true): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = FENCE.exec(line);
    if (m) {
      const token = m[1];
      if (fence === null) fence = token;
      else if (token[0] === fence[0] && token.length >= fence.length && line.trim() === token) fence = null;
      out.push("");
    } else if (fence !== null) out.push("");
    else out.push(stripSpans ? line.replace(/(`+)[\s\S]*?\1/g, "") : line);
  }
  return out;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const INLINE_LINK = /\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
// 각주 정의(`[^1]: 설명`)는 링크가 아니다
const REFERENCE_DEF = /^ {0,3}\[(?!\^)([^\]\n]+)\]:\s*(<[^>]+>|\S+)/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const HTML_ANCHOR = /<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi;
// setext 밑줄 앞 줄이 될 수 없는 줄: 빈 줄, 제목, 목록, 표, 인용
const NOT_PARAGRAPH = /^\s*$|^ {0,3}(?:#|[-*+]\s|\d+[.)]\s|\||>)/;

export function slugify(heading: string): string {
  const text = heading
    .replace(/\s+#+\s*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}\p{M} _-]/gu, "").replace(/ /g, "-");
}

// 그 파일이 내는 앵커. 코드 블록 안 제목은 빼고, 같은 슬러그는 GitHub 처럼 번호를 붙인다.
export function anchorsOf(text: string): Set<string> {
  const found = new Set<string>();
  const counts = new Map<string, number>();
  const lines = prose(text, false);
  lines.forEach((line, i) => {
    for (const a of line.matchAll(HTML_ANCHOR)) found.add(a[1].toLowerCase());
    let heading: string | null = null;
    const m = HEADING.exec(line);
    if (m) heading = m[2];
    else if (i > 0 && SETEXT.test(line) && !NOT_PARAGRAPH.test(lines[i - 1]) && !SETEXT.test(lines[i - 1])) heading = lines[i - 1].trim();
    if (heading === null) return;
    const base = slugify(heading);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    found.add(n === 0 ? base : `${base}-${n}`);
  });
  return found;
}

export type Link = { line: number; text: string | null; target: string };

export function linksOf(lines: string[]): Link[] {
  const links: Link[] = [];
  lines.forEach((line, i) => {
    const def = REFERENCE_DEF.exec(line);
    if (def) links.push({ line: i + 1, text: null, target: def[2].replace(/^<|>$/g, "") });
    for (const m of line.matchAll(INLINE_LINK)) links.push({ line: i + 1, text: m[1], target: m[2].replace(/^<|>$/g, "") });
  });
  return links;
}

// 로컬 파일 링크면 [경로, 앵커] 를 낸다. URL 스킴, //, / 로 시작하는 경로는 로컬 파일이 아니다.
export function splitLocal(target: string): [string, string] | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("/")) return null;
  const hash = target.indexOf("#");
  const pathPart = (hash < 0 ? target : target.slice(0, hash)).replace(/\?.*$/, "");
  const anchor = hash < 0 ? "" : target.slice(hash + 1);
  return [decode(pathPart), anchor];
}

function decode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ---------- ADR 식별자 ----------

const DATE_NAME = /^ADR-(\d{8})-(.+)\.md$/;
const AREA_NAME = /^(ADR-[A-Za-z]*\d+)-.+\.md$/;
const NUMBER_NAME = /^(\d{3,})-.+\.md$/;

export function parseAdrName(name: string): AdrName | null {
  let m = DATE_NAME.exec(name);
  if (m) return { kind: "date", id: `ADR-${m[1]} / ${m[2]}`, date: `ADR-${m[1]}` };
  m = AREA_NAME.exec(name);
  if (m) return { kind: "area", id: m[1] };
  m = NUMBER_NAME.exec(name);
  if (m) return { kind: "number", id: `ADR-${m[1]}` };
  return null;
}

// 저장소에 있는 꼴만 찾는 식별자 정규식. 없으면 null.
export function idPattern(kinds: Set<AdrKind>): string | null {
  const parts: string[] = [];
  if (kinds.has("date")) parts.push(String.raw`ADR-\d{8}(?:\s*/\s*[A-Za-z0-9][A-Za-z0-9_-]*)?`);
  if (kinds.has("area")) parts.push(String.raw`ADR-[A-Za-z]+\d+`);
  if (kinds.has("number")) parts.push(String.raw`ADR-\d+`);
  if (parts.length === 0) return null;
  return String.raw`(?<![\w-])(?:${parts.join("|")})(?![A-Za-z0-9])`;
}

function normalizeId(raw: string) {
  return raw.replace(/\s*\/\s*/, " / ");
}

// 링크 글에서 찾은 식별자가 그 ADR 을 가리키는가. 날짜만 적었으면 같은 날의 ADR 모두다.
function matchesId(adr: AdrFile, id: string) {
  return adr.id === id || (adr.kind === "date" && adr.date === id);
}

// 계획서 폴더: 경로 조각이 tasks 이거나 static_check.py 의 PLAN_DIR 꼴(하위 프로젝트 접두 포함)
const PLAN_DIR = /^(?:[A-Za-z0-9]+-)?plan[-_]?\d{2,}(?:-.*)?$/;
export function inPlanDir(path: string) {
  return path.split("/").slice(0, -1).some((part) => part === "tasks" || PLAN_DIR.test(part));
}

// ---------- 저장소 ----------

function git(root: string, args: string[]) {
  const done = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (done.error || done.status !== 0) return null;
  return done.stdout;
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// `*` 한 층만 맞추는 glob 을 폴더 목록으로 푼다.
export function expandDirGlob(root: string, glob: string): string[] {
  const parts = glob.split("/").filter((p) => p && p !== ".");
  let current = [""];
  for (const part of parts) {
    const next: string[] = [];
    for (const base of current) {
      if (!part.includes("*")) {
        next.push(base ? `${base}/${part}` : part);
        continue;
      }
      const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
      let names: string[] = [];
      try {
        names = readdirSync(join(root, base)).sort();
      } catch {
        continue;
      }
      for (const name of names) if (re.test(name) && !name.startsWith(".")) next.push(base ? `${base}/${name}` : name);
    }
    current = next;
  }
  return current.filter((p) => p && isDir(join(root, p)));
}

function rel(root: string, abs: string) {
  return relative(root, abs).split(sep).join("/");
}

type Repo = {
  root: string;
  markdown: string[];
  adrDirs: string[];
  adrs: AdrFile[];
  text: Map<string, string>;
  dirs: Map<string, Set<string>>;
};

function loadRepo(root: string, globs: string[]): Repo {
  const listed = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (listed === null) throw new Error("git ls-files 를 읽지 못했다");
  const markdown = [...new Set(listed.split("\0"))].filter((p) => p.endsWith(".md") && isFile(join(root, p))).sort();
  const adrDirs = [...new Set(globs.flatMap((g) => expandDirGlob(root, g)))].sort();
  const adrs: AdrFile[] = [];
  for (const path of markdown) {
    // 폴더가 겹치면 가장 깊은 ADR 폴더에 둔다
    const dir = adrDirs.filter((d) => path.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
    if (!dir) continue;
    const parsed = parseAdrName(posix.basename(path));
    if (parsed) adrs.push({ ...parsed, path, dir });
  }
  return { root, markdown, adrDirs, adrs, text: new Map(), dirs: new Map() };
}

function read(repo: Repo, path: string) {
  let text = repo.text.get(path);
  if (text === undefined) {
    text = readFileSync(join(repo.root, path), "utf8");
    repo.text.set(path, text);
  }
  return text;
}

// ---------- ADR 메타데이터와 색인 ----------

const STATUS = /^- \*\*status\*\*:\s*`([^`]+)`/;
const REPLACED_PART = /^- \*\*대체된 부분\*\*:/;

export type AdrMeta = { title: string; status: string; statusLine: number; replacedBy: AdrFile[] };

function metaOf(repo: Repo, adr: AdrFile, byPath: Map<string, AdrFile>): AdrMeta {
  const lines = prose(read(repo, adr.path), false);
  let title: string | null = null;
  let status: string | null = null;
  let statusLine = 1;
  const replacedBy: AdrFile[] = [];
  let inReplaced = false;
  lines.forEach((line, i) => {
    if (title === null) {
      const h = /^ {0,3}#{1,2}\s+ADR-[^:]*:\s*(.+?)\s*$/.exec(line);
      if (h) title = h[1];
    }
    if (status === null) {
      const s = STATUS.exec(line);
      if (s) {
        status = s[1];
        statusLine = i + 1;
      }
    }
    if (REPLACED_PART.test(line)) inReplaced = true;
    else if (/^- /.test(line) || /^#{1,6}\s/.test(line)) inReplaced = false;
    // 빈 줄 뒤 들여쓰지 않은 문단은 목록 항목 밖이다
    else if (i > 0 && lines[i - 1].trim() === "" && /^\S/.test(line)) inReplaced = false;
    if (!inReplaced) return;
    // 코드 스팬 안 링크는 링크가 아니다
    const visible = line.replace(/(`+)[\s\S]*?\1/g, "");
    for (const m of visible.matchAll(INLINE_LINK)) {
      if (!/ADR-[A-Za-z]*\d/.test(m[1])) continue;
      const local = splitLocal(m[2].replace(/^<|>$/g, ""));
      if (!local || !local[0]) continue;
      const target = byPath.get(rel(repo.root, resolve(repo.root, posix.dirname(adr.path), local[0])));
      if (target && !replacedBy.includes(target)) replacedBy.push(target);
    }
  });
  return { title: title ?? "제목 확인 필요", status: status ?? "accepted", statusLine, replacedBy };
}

const INDEX_HEAD =
  "# ADR 목록\n\n결정이 필요하면 이 목록을 먼저 읽고 필요한 파일만 연다. 이 파일은 plan 스킬의 `adr-docs.ts write-index` 가 만든다. 직접 고치지 않는다.\n";

function cell(text: string) {
  return text.replace(/\|/g, "\\|");
}

export type IndexRow = { id: string; link: string; title: string; status: string; replacedBy: { id: string; link: string }[] };

export function renderIndex(rows: IndexRow[]): string {
  const table = (items: IndexRow[]) => {
    if (items.length === 0) return "없음\n";
    const body = items.map((r) => {
      const relation = r.replacedBy.map((x) => `[${x.id}](${x.link})`).join(", ") || "-";
      return `| [${r.id}](${r.link}) | ${cell(r.title)} | ${cell(r.status)} | ${relation} |\n`;
    });
    return `| 번호 | 결정 | 상태 | 대체 관계 |\n| --- | --- | --- | --- |\n${body.join("")}`;
  };
  const current = rows.filter((r) => r.status !== "superseded");
  const superseded = rows.filter((r) => r.status === "superseded");
  return `${INDEX_HEAD}\n## 현행\n\n${table(current)}\n## 대체됨\n\n${table(superseded)}`;
}

function linkFrom(dir: string, path: string) {
  return posix.relative(dir, path).split("/").map(encodeLinkPart).join("/");
}

function encodeLinkPart(part: string) {
  return part.replace(/[ ()<>]/g, (c) => encodeURIComponent(c));
}

function byName(a: AdrFile, b: AdrFile) {
  const x = posix.basename(a.path);
  const y = posix.basename(b.path);
  return x < y ? -1 : x > y ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function indexFor(repo: Repo, dir: string, metas: Map<string, AdrMeta>) {
  const rows = repo.adrs
    .filter((a) => a.dir === dir)
    .sort(byName)
    .map((adr) => {
      const meta = metas.get(adr.path)!;
      return {
        id: adr.id,
        link: linkFrom(dir, adr.path),
        title: meta.title,
        status: meta.status,
        replacedBy: meta.replacedBy.map((t) => ({ id: t.id, link: linkFrom(dir, t.path) })),
      };
    });
  return renderIndex(rows);
}

// ---------- 검사 ----------

// 저장소 안 경로는 조각마다 실제 이름과 대소문자까지 맞춘다. macOS 는 대소문자를 가리지 않아
// existsSync 만 보면 GitHub 에서 깨지는 링크를 통과시킨다. 저장소 밖은 existsSync 로 본다.
function existsExact(repo: Repo, abs: string) {
  if (!existsSync(abs)) return false;
  const relPath = relative(repo.root, abs);
  if (!relPath || relPath.startsWith("..")) return true;
  let dir = repo.root;
  for (const part of relPath.split(sep)) {
    let names = repo.dirs.get(dir);
    if (!names) {
      try {
        names = new Set(readdirSync(dir));
      } catch {
        names = new Set();
      }
      repo.dirs.set(dir, names);
    }
    if (!names.has(part)) return false;
    dir = join(dir, part);
  }
  return true;
}

function checkLinks(repo: Repo, path: string, lines: string[], anchors: Map<string, Set<string>>): Violation[] {
  const out: Violation[] = [];
  for (const link of linksOf(lines)) {
    const local = splitLocal(link.target);
    if (!local) continue;
    const [file, anchor] = local;
    let targetPath = path;
    if (file) {
      const abs = resolve(repo.root, posix.dirname(path), file);
      targetPath = rel(repo.root, abs);
      if (!existsExact(repo, abs)) {
        out.push({ path, line: link.line, code: "BROKEN_LINK", message: link.target, target: targetPath });
        continue;
      }
      if (!anchor || !targetPath.endsWith(".md") || !isFile(abs)) continue;
    } else if (!anchor) continue;
    let set = anchors.get(targetPath);
    if (!set) {
      try {
        set = anchorsOf(readFileSync(join(repo.root, targetPath), "utf8"));
      } catch {
        set = new Set();
      }
      anchors.set(targetPath, set);
    }
    if (!set.has(decode(anchor).toLowerCase())) out.push({ path, line: link.line, code: "BROKEN_ANCHOR", message: link.target, target: targetPath });
  }
  return out;
}

// 참조한 문서와 공유하는 상위 폴더가 긴 후보를 앞에 둔다.
function commonDepth(a: string, b: string) {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

function checkUnlinked(repo: Repo, path: string, lines: string[], pattern: string): Violation[] {
  if (inPlanDir(path)) return [];
  const out: Violation[] = [];
  const heading = new RegExp(String.raw`^ {0,3}#{1,6}\s+(?:${pattern})\s*:`);
  const find = new RegExp(pattern, "g");
  const docDir = posix.dirname(path);
  // 단축 참조 링크(`[ADR-001]` 와 `[ADR-001]: 경로`)도 링크다
  const defs = new Set(lines.map((l) => REFERENCE_DEF.exec(l)?.[1].toLowerCase()).filter((x): x is string => !!x));
  lines.forEach((line, i) => {
    if (heading.test(line)) return;
    const outside = line
      .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, "")
      .replace(/\[[^\]\n]*\]\[[^\]\n]*\]/g, "")
      .replace(REFERENCE_DEF, "")
      .replace(/\[([^\]\n]+)\]/g, (all, name: string) => (defs.has(name.toLowerCase()) ? "" : all));
    for (const m of outside.matchAll(find)) {
      const id = normalizeId(m[0]);
      const candidates = repo.adrs
        .filter((a) => matchesId(a, id))
        .map((a) => a.path)
        .sort((a, b) => commonDepth(docDir, posix.dirname(b)) - commonDepth(docDir, posix.dirname(a)) || (a < b ? -1 : 1));
      const hint = candidates.length ? `→ 후보: ${candidates.join(", ")}` : "→ 후보 없음";
      out.push({ path, line: i + 1, code: "ADR_UNLINKED", message: `${id} ${hint}` });
    }
  });
  return out;
}

function checkAdrDirs(repo: Repo, opts: Options): Violation[] {
  const out: Violation[] = [];
  const byPath = new Map(repo.adrs.map((a) => [a.path, a]));
  const metas = new Map<string, AdrMeta>();
  for (const adr of repo.adrs) metas.set(adr.path, metaOf(repo, adr, byPath));
  for (const dir of repo.adrDirs) {
    const files = repo.adrs.filter((a) => a.dir === dir).sort(byName);
    const index = `${dir}/INDEX.md`;
    const indexAbs = join(repo.root, index);

    if (opts.index === "generated") {
      const want = indexFor(repo, dir, metas);
      const have = isFile(indexAbs) ? readFileSync(indexAbs, "utf8") : null;
      if (have !== want)
        out.push({ path: index, line: 1, code: "INDEX_STALE", message: have === null ? "INDEX.md 가 없다. write-index 를 돌린다" : "write-index 결과와 다르다. write-index 를 돌린다", adrDir: dir });
    } else if (isFile(indexAbs)) {
      const listed = new Set<string>();
      for (const link of linksOf(prose(readFileSync(indexAbs, "utf8")))) {
        const local = splitLocal(link.target);
        if (!local || !local[0]) continue;
        const target = rel(repo.root, resolve(repo.root, dir, local[0]));
        if (!target.startsWith(`${dir}/`)) continue;
        const parsed = parseAdrName(posix.basename(target));
        if (parsed) listed.add(parsed.id);
      }
      const ids = new Set(files.map((f) => f.id));
      for (const id of [...ids].filter((x) => !listed.has(x)).sort())
        out.push({ path: index, line: 1, code: "INDEX_DESYNC", message: `색인에 없다: ${id}`, adrDir: dir });
      for (const id of [...listed].filter((x) => !ids.has(x)).sort())
        out.push({ path: index, line: 1, code: "INDEX_DESYNC", message: `파일이 없는 등재: ${id}`, adrDir: dir });
    }

    const seen = new Map<string, AdrFile>();
    for (const adr of files) {
      const first = seen.get(adr.id);
      if (first) out.push({ path: adr.path, line: 1, code: "ADR_DUPLICATE", message: `${adr.id} 가 ${first.path} 와 겹친다`, adrDir: dir });
      else seen.set(adr.id, adr);
    }

    if (opts.flat) continue;
    for (const adr of files) {
      const meta = metas.get(adr.path)!;
      const archived = adr.path.startsWith(`${dir}/superseded/`);
      if (meta.status === "superseded" && !archived)
        out.push({ path: adr.path, line: meta.statusLine, code: "ADR_PLACEMENT", message: `대체된 ADR 은 ${dir}/superseded/ 로 옮긴다` });
      else if (archived && meta.status !== "superseded")
        out.push({ path: adr.path, line: meta.statusLine, code: "ADR_PLACEMENT", message: `superseded/ 아래 ADR 의 status 는 superseded 여야 한다 (현재: ${meta.status})` });
    }
  }
  return out;
}

export type Changes = { changed: Set<string>; gone: Set<string> };

// git diff --name-status -z 와 status --porcelain -z 를 읽는다.
export function parseNameStatus(text: string, changes: Changes) {
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const from = parts[++i];
      const to = parts[++i];
      if (status[0] === "R" && from) changes.gone.add(from);
      if (to) changes.changed.add(to);
    } else {
      const path = parts[++i];
      if (!path) continue;
      if (status[0] === "D") changes.gone.add(path);
      else changes.changed.add(path);
    }
  }
}

export function parsePorcelain(text: string, changes: Changes) {
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const from = parts[++i];
      if (xy.includes("R") && from) changes.gone.add(from);
      changes.changed.add(path);
    } else if (xy.includes("D")) changes.gone.add(path);
    else changes.changed.add(path);
  }
}

function changesSince(root: string, ref: string): Changes {
  const changes: Changes = { changed: new Set(), gone: new Set() };
  const diff = git(root, ["diff", "--name-status", "-z", "--no-renames", `${ref}...HEAD`]);
  if (diff === null) throw new UsageError(`기준 ref 를 읽지 못했다: ${ref}`);
  parseNameStatus(diff, changes);
  const renamed = git(root, ["diff", "--name-status", "-z", "-M", `${ref}...HEAD`]);
  if (renamed !== null) parseNameStatus(renamed, changes);
  const status = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (status === null) throw new Error("git status 를 읽지 못했다");
  parsePorcelain(status, changes);
  return changes;
}

export function isChanged(v: Violation, changes: Changes) {
  if (changes.changed.has(v.path)) return true;
  if (v.adrDir) {
    const prefix = `${v.adrDir}/`;
    for (const p of [...changes.changed, ...changes.gone]) if (p.startsWith(prefix)) return true;
  }
  if (v.target && (v.code === "BROKEN_LINK" || v.code === "BROKEN_ANCHOR")) {
    if (changes.gone.has(v.target) || changes.changed.has(v.target)) return true;
    // 폴더째 옮겼으면 대상 아래 경로가 지워진 목록에 있다
    for (const p of changes.gone) if (p.startsWith(`${v.target}/`)) return true;
  }
  return false;
}

function format(v: Violation) {
  return `${v.path}:${v.line}: ${v.code} ${v.message}`;
}

function inScope(path: string, scope: string | undefined) {
  return !scope || scope === "." || path === scope || path.startsWith(`${scope}/`);
}

export type CheckResult = { lines: string[]; failed: boolean; checked: number; adrDirs: number; notice: string[] };

export function runCheck(root: string, opts: Options): CheckResult {
  const repo = loadRepo(root, opts.adrDirs);
  const notice: string[] = [];
  if (repo.adrDirs.length === 0) notice.push(`ADR 폴더를 찾지 못해 ADR 검사를 건너뛴다: ${opts.adrDirs.join(", ")}`);
  const scope = opts.scope === undefined ? undefined : rel(root, resolve(process.cwd(), opts.scope)) || ".";
  if (scope !== undefined && !existsSync(join(root, scope))) throw new UsageError(`범위를 찾을 수 없다: ${opts.scope}`);
  const changes = opts.changedSince ? changesSince(root, opts.changedSince) : null;

  const kinds = new Set(repo.adrs.map((a) => a.kind));
  const pattern = idPattern(kinds);
  const anchors = new Map<string, Set<string>>();
  const violations: Violation[] = [];
  let checked = 0;
  // 생성 색인은 INDEX_STALE 이 보증한다. ADR 제목에 다른 식별자나 링크가 있으면 색인 칸이
  // ADR_UNLINKED·BROKEN_LINK 로 걸리는데, 색인은 직접 고치지 않으므로 풀 길이 없다.
  const generated = new Set(opts.index === "generated" ? repo.adrDirs.map((d) => `${d}/INDEX.md`) : []);
  for (const path of repo.markdown) {
    if (!inScope(path, scope)) continue;
    checked++;
    if (generated.has(path)) continue;
    const lines = prose(read(repo, path));
    violations.push(...checkLinks(repo, path, lines, anchors));
    if (pattern) violations.push(...checkUnlinked(repo, path, lines, pattern));
  }
  violations.push(...checkAdrDirs(repo, opts).filter((v) => inScope(v.path, scope)));
  violations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  if (!changes) return { lines: violations.map(format), failed: violations.length > 0, checked, adrDirs: repo.adrDirs.length, notice };
  const mine = violations.filter((v) => isChanged(v, changes));
  const others = violations.filter((v) => !mine.includes(v));
  const lines = mine.map(format);
  if (others.length) lines.push("PR 밖 위반:", ...others.map(format));
  return { lines, failed: mine.length > 0, checked, adrDirs: repo.adrDirs.length, notice };
}

export function runWriteIndex(root: string, opts: Options): string[] {
  const repo = loadRepo(root, opts.adrDirs);
  if (repo.adrDirs.length === 0) throw new UsageError(`색인을 쓸 ADR 폴더가 없다: ${opts.adrDirs.join(", ")}`);
  const byPath = new Map(repo.adrs.map((a) => [a.path, a]));
  const metas = new Map<string, AdrMeta>();
  for (const adr of repo.adrs) metas.set(adr.path, metaOf(repo, adr, byPath));
  const written: string[] = [];
  for (const dir of repo.adrDirs) {
    const content = indexFor(repo, dir, metas);
    const abs = join(root, dir, "INDEX.md");
    const have = isFile(abs) ? readFileSync(abs, "utf8") : null;
    if (have === content) continue;
    writeFileSync(abs, content);
    written.push(`${dir}/INDEX.md`);
  }
  return written;
}

function main(argv: string[]) {
  try {
    const opts = parseArgs(argv);
    const top = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    if (top === null) throw new UsageError("git 저장소 안에서 실행한다");
    const root = top.trim();
    if (opts.command === "write-index") {
      for (const path of runWriteIndex(root, opts)) process.stderr.write(`썼다: ${path}\n`);
      process.exitCode = 0;
      return;
    }
    const result = runCheck(root, opts);
    if (result.lines.length) process.stdout.write(`${result.lines.join("\n")}\n`);
    for (const line of result.notice) process.stderr.write(`${line}\n`);
    process.stderr.write(`검사한 Markdown: ${result.checked}개, ADR 폴더: ${result.adrDirs}개\n`);
    // process.exit 는 파이프에 아직 쓰지 못한 출력을 버린다. 종료 코드만 두고 이벤트 루프가 비우게 한다
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`adr-docs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

// import.meta.main 은 Node 24.2 부터 있다. 24.0·24.1 에서 아무것도 하지 않고 0 으로 끝나지 않게 경로로도 본다.
const isMain = import.meta.main || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2));
