// adr-docs.ts 를 임시 git 저장소 표본에서 명령으로 돌려 stdout 줄과 종료 코드를 본다.
// plan 은 팀으로 내보내는 스킬이라 Node 내장 모듈과 자기 폴더만 import 한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { anchorsOf, idPattern, parseAdrName, renderIndex, slugify } from "../scripts/adr-docs.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/adr-docs.ts", import.meta.url));
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  const done = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
}

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "adr-docs-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init", "--allow-empty");
  return root;
}

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function run(root: string, ...args: string[]) {
  const done = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  return { code: done.status, out: done.stdout.split("\n").filter(Boolean), err: done.stderr };
}

function adr(id: string, title: string, extra = "", status = "accepted") {
  return `## ${id}: ${title}\n\n- **status**: \`${status}\`\n${extra}- **결정**: 본문\n`;
}

describe("순수 함수", () => {
  test("한글 제목과 코드 스팬, 링크 글의 슬러그", () => {
    assert.equal(slugify("대체한 뒤 검사"), "대체한-뒤-검사");
    assert.equal(slugify("`adr-docs.ts` 의 [옵션](x.md)!"), "adr-docsts-의-옵션");
    assert.equal(slugify("PR 크기 (예외)"), "pr-크기-예외");
  });

  test("번호를 붙인 앵커와 겹치는 뒤 제목은 번호를 하나 더 붙인다", () => {
    assert.deepEqual([...anchorsOf("# foo\n# foo\n# foo-1\n# foo\n")].sort(), ["foo", "foo-1", "foo-1-1", "foo-2"]);
  });

  test("중복 제목은 -1 을 붙이고 코드 블록 안 제목은 뺀다", () => {
    const anchors = anchorsOf("# 절\n\n## 절\n\n```\n# 안\n```\n");
    assert.deepEqual([...anchors].sort(), ["절", "절-1"]);
  });

  test("식별자 세 꼴", () => {
    assert.deepEqual(parseAdrName("007-use-cloud.md"), { kind: "number", id: "ADR-007" });
    assert.deepEqual(parseAdrName("ADR-M01-money.md"), { kind: "area", id: "ADR-M01" });
    assert.deepEqual(parseAdrName("ADR-20261007-slug-a.md"), { kind: "date", id: "ADR-20261007 / slug-a", date: "ADR-20261007" });
    assert.equal(parseAdrName("INDEX.md"), null);
  });

  test("저장소에 없는 꼴은 찾지 않는다", () => {
    const re = new RegExp(idPattern(new Set(["area"]))!, "g");
    assert.deepEqual("ADR-M01 와 ADR-003".match(re), ["ADR-M01"]);
  });

  test("빈 절은 없음 한 줄이다", () => {
    const text = renderIndex([{ id: "ADR-001", link: "001-a.md", title: "가", status: "accepted", replacedBy: [] }]);
    assert.match(text, /## 대체됨\n\n없음\n$/);
    assert.match(text, /\| \[ADR-001\]\(001-a\.md\) \| 가 \| accepted \| - \|/);
  });
});

describe("BROKEN_LINK", () => {
  test("없는 파일, 이미지, 참조 정의를 낸다. 코드 블록·코드 스팬 안은 통과한다", () => {
    const root = repo({
      "README.md": "[없음](missing.md)\n\n![그림](img/none.png)\n\n[ref]: gone.md\n\n`[코드](x.md)`\n\n```\n[블록](y.md)\n```\n\n[밖](https://example.com) [루트](/abs.md) [메일](mailto:a@b.c)\n",
    });
    const r = run(root, "check");
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, ["README.md:1: BROKEN_LINK missing.md", "README.md:3: BROKEN_LINK img/none.png", "README.md:5: BROKEN_LINK gone.md"]);
    assert.match(r.err, /검사한 Markdown: 1개, ADR 폴더: 0개\n$/);
    assert.match(r.err, /ADR 폴더를 찾지 못해/);
  });

  test("대상이 있으면 0 이다", () => {
    const root = repo({ "README.md": "[가이드](docs/guide.md)\n", "docs/guide.md": "# 가이드\n" });
    assert.deepEqual(run(root, "check"), { code: 0, out: [], err: "ADR 폴더를 찾지 못해 ADR 검사를 건너뛴다: docs/adr\n검사한 Markdown: 2개, ADR 폴더: 0개\n" });
  });
});

describe("Markdown 꼴", () => {
  test("각주, 들여 쓴 펜스, setext 제목, HTML 앵커, 단축 참조 링크", () => {
    const root = repo({
      "docs/adr/001-a.md": adr("ADR-001", "가"),
      "a.md": "제목\n===\n\n<a id=\"Custom\"></a>\n",
      "README.md": [
        "본문[^1] 과 [ADR-001] 을 본다.",
        "",
        "[^1]: 각주 설명이다.",
        "[ADR-001]: docs/adr/001-a.md",
        "",
        "- 목록",
        "",
        "      ```",
        "      [안](nope.md)",
        "      ```",
        "",
        "[가](a.md#제목) [나](a.md#custom)",
      ].join("\n"),
    });
    const r = run(root, "check");
    assert.deepEqual(r.out, []);
    assert.equal(r.code, 0);
  });

  test("들여 쓴 코드 블록과 여러 줄 코드 스팬 안은 보지 않는다. 목록 안 들여쓴 줄은 본문이다", () => {
    const root = repo({
      "docs/adr/001-a.md": adr("ADR-001", "가"),
      "README.md": [
        "문단",
        "",
        "    [example](missing.md) ADR-001",
        "",
        "앞 `",
        "[span](missing2.md) ADR-001",
        "` 뒤",
        "",
        "- 목록",
        "",
        "    [이어짐](missing3.md)",
      ].join("\n"),
    });
    const r = run(root, "check");
    assert.deepEqual(r.out, ["README.md:11: BROKEN_LINK missing3.md"]);
  });

  test("대소문자가 다른 링크는 대소문자를 가리지 않는 파일 시스템에서도 깨진 링크다", () => {
    const root = repo({ "Guide.md": "# 가\n", "README.md": "[가이드](guide.md)\n" });
    assert.deepEqual(run(root, "check").out, ["README.md:1: BROKEN_LINK guide.md"]);
  });

  test("파이프로 받아도 큰 출력이 잘리지 않는다", () => {
    const body = Array.from({ length: 3000 }, (_, i) => `[깨짐](missing-${i}-${"x".repeat(20)}.md)`).join("\n");
    const root = repo({ "README.md": `${body}\n` });
    const r = run(root, "check");
    assert.equal(r.out.length, 3000);
    assert.equal(r.code, 1);
  });
});

describe("BROKEN_ANCHOR", () => {
  test("한글 앵커, 중복 제목 -1, 퍼센트 인코딩은 통과하고 없는 앵커는 낸다", () => {
    const root = repo({
      "docs/a.md": "# 대체한 뒤 검사\n\n## 절\n\n## 절\n",
      "README.md":
        "[가](docs/a.md#대체한-뒤-검사) [나](docs/a.md#절-1) [다](docs/a.md#%EB%8C%80%EC%B2%B4%ED%95%9C-%EB%92%A4-%EA%B2%80%EC%82%AC)\n[라](docs/a.md#없는-절)\n[마](#여기)\n\n## 여기\n",
    });
    const r = run(root, "check");
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, ["README.md:2: BROKEN_ANCHOR docs/a.md#없는-절"]);
  });
});

describe("ADR_UNLINKED", () => {
  const files = {
    "docs/adr/001-a.md": adr("ADR-001", "가"),
    "docs/adr/002-b.md": adr("ADR-002", "나", "- **맥락**: ADR-001 을 이어받는다\n"),
    "modules/api/docs/adr/001-x.md": adr("ADR-001", "모듈 가"),
    "modules/api/docs/note.md": "ADR-001 을 본다\n",
    "README.md": "[ADR-001](docs/adr/001-a.md) 와 `ADR-002` 는 통과\nADR-002 는 위반, ADR-099 도 위반\n",
    "docs/features/x/tasks/plan/phase-01.md": "ADR-001 은 계획서라 통과\n",
    "docs/plan012-old/note.md": "ADR-001 도 계획서다\n",
  };

  test("본문 식별자에 후보를 붙이고 같은 폴더 후보가 앞에 온다", () => {
    const root = repo(files);
    const r = run(root, "check", "--adr-dir", "docs/adr", "--adr-dir", "modules/*/docs/adr");
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, [
      "README.md:2: ADR_UNLINKED ADR-002 → 후보: docs/adr/002-b.md",
      "README.md:2: ADR_UNLINKED ADR-099 → 후보 없음",
      "docs/adr/002-b.md:4: ADR_UNLINKED ADR-001 → 후보: docs/adr/001-a.md, modules/api/docs/adr/001-x.md",
      "modules/api/docs/note.md:1: ADR_UNLINKED ADR-001 → 후보: modules/api/docs/adr/001-x.md, docs/adr/001-a.md",
    ]);
    assert.match(r.err, /ADR 폴더: 2개/);
  });

  test("check 는 파일을 고치지 않는다", () => {
    const root = repo(files);
    const before = git(root, "status", "--porcelain");
    run(root, "check", "--adr-dir", "docs/adr", "--adr-dir", "modules/*/docs/adr");
    run(root, "check", "--index", "generated");
    assert.equal(git(root, "status", "--porcelain"), before);
  });

  test("영역 글자 꼴과 날짜 꼴, 날짜 꼴 제목 줄", () => {
    const root = repo({
      "docs/adr/ADR-M01-money.md": adr("ADR-M01", "돈"),
      "docs/adr/ADR-20261007-alpha.md": "## ADR-20261007 / alpha: 가\n\n- **status**: `accepted`\n",
      "docs/adr/ADR-20261007-beta.md": "## ADR-20261007 / beta: 나\n\n- **status**: `accepted`\n",
      "README.md": "ADR-M01 과 ADR-20261007 / beta, ADR-20261007 을 적었다. ADR-003 은 이 저장소 꼴이 아니다\n",
    });
    const r = run(root, "check");
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, [
      "README.md:1: ADR_UNLINKED ADR-M01 → 후보: docs/adr/ADR-M01-money.md",
      "README.md:1: ADR_UNLINKED ADR-20261007 / beta → 후보: docs/adr/ADR-20261007-beta.md",
      "README.md:1: ADR_UNLINKED ADR-20261007 → 후보: docs/adr/ADR-20261007-alpha.md, docs/adr/ADR-20261007-beta.md",
    ]);
  });
});

describe("ADR_DUPLICATE 와 ADR_PLACEMENT", () => {
  test("한 폴더에 같은 번호 둘은 중복이다. 다른 폴더의 같은 번호는 아니다", () => {
    const root = repo({
      "docs/adr/001-a.md": adr("ADR-001", "가"),
      "docs/adr/001-b.md": adr("ADR-001", "나"),
      "modules/m/docs/adr/001-c.md": adr("ADR-001", "다"),
    });
    const r = run(root, "check", "--adr-dir", "docs/adr", "--adr-dir", "modules/*/docs/adr");
    assert.deepEqual(r.out, ["docs/adr/001-b.md:1: ADR_DUPLICATE ADR-001 가 docs/adr/001-a.md 와 겹친다"]);
    assert.equal(r.code, 1);
  });

  test("대체됨이 폴더 밖이면 위반이고 --flat 이면 통과한다", () => {
    const root = repo({
      "docs/adr/001-a.md": adr("ADR-001", "가", "", "superseded"),
      "docs/adr/superseded/002-b.md": adr("ADR-002", "나"),
    });
    const r = run(root, "check");
    assert.deepEqual(r.out, [
      "docs/adr/001-a.md:3: ADR_PLACEMENT 대체된 ADR 은 docs/adr/superseded/ 로 옮긴다",
      "docs/adr/superseded/002-b.md:3: ADR_PLACEMENT superseded/ 아래 ADR 의 status 는 superseded 여야 한다 (현재: accepted)",
    ]);
    assert.equal(run(root, "check", "--flat").code, 0);
  });
});

describe("색인 생성", () => {
  const files = {
    "docs/adr/superseded/001-a.md": adr("ADR-001", "처음 결정", "- **대체된 부분**: 전체를 [analysis-api ADR-003](../003-c.md) 가 바꿨다.\n", "superseded"),
    "docs/adr/002-b.md": adr("ADR-002", "일부 대체 | 파이프", "- **대체된 부분**: 한 줄은\n  [ADR-003](003-c.md) 이 바꿨다. [설명](../../README.md)\n"),
    "docs/adr/003-c.md": adr("ADR-003", "새 결정", "- **대체**: [ADR-001](superseded/001-a.md) 전체\n"),
    "README.md": "# 저장소\n",
  };
  const expected = [
    "# ADR 목록",
    "",
    "결정이 필요하면 이 목록을 먼저 읽고 필요한 파일만 연다. 이 파일은 plan 스킬의 `adr-docs.ts write-index` 가 만든다. 직접 고치지 않는다.",
    "",
    "## 현행",
    "",
    "| 번호 | 결정 | 상태 | 대체 관계 |",
    "| --- | --- | --- | --- |",
    "| [ADR-002](002-b.md) | 일부 대체 \\| 파이프 | accepted | [ADR-003](003-c.md) |",
    "| [ADR-003](003-c.md) | 새 결정 | accepted | - |",
    "",
    "## 대체됨",
    "",
    "| 번호 | 결정 | 상태 | 대체 관계 |",
    "| --- | --- | --- | --- |",
    "| [ADR-001](superseded/001-a.md) | 처음 결정 | superseded | [ADR-003](003-c.md) |",
    "",
  ].join("\n");

  test("두 표와 접두 링크 글의 대체 관계, 다시 돌리면 쓰지 않는다", () => {
    const root = repo(files);
    const w = run(root, "write-index");
    assert.equal(w.code, 0, w.err);
    const index = join(root, "docs/adr/INDEX.md");
    assert.equal(readFileSync(index, "utf8"), expected);
    assert.deepEqual(run(root, "check", "--index", "generated").out, []);
    assert.equal(run(root, "check", "--index", "generated").code, 0);

    // 읽기 전용으로 막아 두면 다시 쓰려 할 때 2 로 끝난다. mtime 해상도에 기대지 않는다
    chmodSync(index, 0o444);
    assert.equal(run(root, "write-index").code, 0);
    chmodSync(index, 0o644);
  });

  test("제목에 다른 식별자와 링크가 든 ADR 도 생성 색인 뒤 검사가 0 이다", () => {
    const root = repo({
      "docs/adr/001-a.md": adr("ADR-001", "가"),
      "docs/adr/002-b.md": adr("ADR-002", "ADR-001 을 [README](../../README.md) 대로 되돌린다"),
      "README.md": "# 가\n",
    });
    run(root, "write-index");
    const r = run(root, "check", "--index", "generated");
    assert.deepEqual(r.out, []);
    assert.equal(r.code, 0);
  });

  test("「대체된 부분」 뒤 빈 줄과 일반 문단의 링크는 대체 관계가 아니다", () => {
    const root = repo({
      "docs/adr/001-a.md": "## ADR-001: 가\n\n- **status**: `superseded`\n- **대체된 부분**: [ADR-002](002-b.md)\n\n참고: [ADR-003](003-c.md)\n",
      "docs/adr/002-b.md": adr("ADR-002", "나"),
      "docs/adr/003-c.md": adr("ADR-003", "다"),
    });
    run(root, "write-index");
    const text = readFileSync(join(root, "docs/adr/INDEX.md"), "utf8");
    assert.match(text, /\| superseded \| \[ADR-002\]\(002-b\.md\) \|/);
  });

  test("직접 고친 색인과 없는 색인은 INDEX_STALE 이다", () => {
    const root = repo(files);
    let r = run(root, "check", "--index", "generated");
    assert.deepEqual(r.out, ["docs/adr/INDEX.md:1: INDEX_STALE INDEX.md 가 없다. write-index 를 돌린다"]);
    assert.equal(r.code, 1);
    run(root, "write-index");
    const index = join(root, "docs/adr/INDEX.md");
    writeFileSync(index, readFileSync(index, "utf8").replace("새 결정", "고친 결정"));
    r = run(root, "check", "--index", "generated");
    assert.deepEqual(r.out, ["docs/adr/INDEX.md:1: INDEX_STALE write-index 결과와 다르다. write-index 를 돌린다"]);
  });

  test("ADR 폴더가 없으면 write-index 는 2 다", () => {
    const root = repo({ "README.md": "# 가\n" });
    assert.equal(run(root, "write-index").code, 2);
  });
});

describe("INDEX_DESYNC (--index ids)", () => {
  test("목록형·표형·파일 이름 링크 글을 받고 누락과 남는 등재를 낸다", () => {
    const root = repo({
      "docs/adr/001-a.md": adr("ADR-001", "가"),
      "docs/adr/002-b.md": adr("ADR-002", "나"),
      "docs/adr/superseded/003-c.md": adr("ADR-003", "다", "", "superseded"),
      "docs/adr/004-d.md": adr("ADR-004", "라"),
      "docs/adr/INDEX.md": "# 목록\n\n- [ADR-001](001-a.md): 가\n\n| [002-b.md](002-b.md) | 나 |\n| --- | --- |\n| [ADR-003](superseded/003-c.md) | 다 |\n\n- ADR-004 링크 없는 줄\n- [ADR-009](009-gone.md): 없다\n",
    });
    const r = run(root, "check");
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.filter((l) => !l.includes("ADR_UNLINKED")), [
      "docs/adr/INDEX.md:1: INDEX_DESYNC 색인에 없다: ADR-004",
      "docs/adr/INDEX.md:1: INDEX_DESYNC 파일이 없는 등재: ADR-009",
      "docs/adr/INDEX.md:10: BROKEN_LINK 009-gone.md",
    ]);
  });

  test("영역 글자 꼴과 날짜 꼴 색인, INDEX.md 가 없는 폴더는 통과한다", () => {
    const root = repo({
      "docs/adr/ADR-M01-a.md": adr("ADR-M01", "가"),
      "docs/adr/ADR-20261007-b.md": "## ADR-20261007 / b: 나\n",
      "docs/adr/INDEX.md": "- [ADR-M01](ADR-M01-a.md)\n- [ADR-20261007 / b](ADR-20261007-b.md)\n",
      "frontend/docs/adr/ADR-F01-x.md": adr("ADR-F01", "다"),
    });
    const r = run(root, "check", "--adr-dir", "docs/adr", "--adr-dir", "*/docs/adr");
    assert.deepEqual(r.out, []);
    assert.equal(r.code, 0);
  });
});

describe("--changed-since", () => {
  test("바뀐 파일의 위반만 종료 코드를 정하고 나머지는 PR 밖 위반 아래로 간다", () => {
    const root = repo({ "old.md": "[깨짐](none.md)\n", "docs/adr/001-a.md": adr("ADR-001", "가") });
    git(root, "checkout", "-qb", "feature");
    write(root, { "new.md": "[좋음](old.md)\n" });
    let r = run(root, "check", "--changed-since", "main");
    assert.deepEqual(r.out, ["PR 밖 위반:", "old.md:1: BROKEN_LINK none.md"]);
    assert.equal(r.code, 0);

    write(root, { "new.md": "[깨짐](gone.md)\n" });
    r = run(root, "check", "--changed-since", "main");
    assert.deepEqual(r.out, ["new.md:1: BROKEN_LINK gone.md", "PR 밖 위반:", "old.md:1: BROKEN_LINK none.md"]);
    assert.equal(r.code, 1);
  });

  test("ADR 이름을 바꾼 커밋 뒤 바뀌지 않은 문서의 깨진 링크는 바뀐 쪽이다", () => {
    const root = repo({ "docs/adr/001-a.md": adr("ADR-001", "가"), "guide.md": "[ADR-001](docs/adr/001-a.md)\n" });
    git(root, "checkout", "-qb", "feature");
    git(root, "mv", "docs/adr/001-a.md", "docs/adr/001-renamed.md");
    git(root, "commit", "-qm", "rename");
    const r = run(root, "check", "--changed-since", "main");
    assert.deepEqual(r.out, ["guide.md:1: BROKEN_LINK docs/adr/001-a.md"]);
    assert.equal(r.code, 1);
  });

  test("ADR 을 더한 PR 이 색인을 고치지 않으면 걸린다", () => {
    const root = repo({ "docs/adr/001-a.md": adr("ADR-001", "가"), "docs/adr/INDEX.md": "- [ADR-001](001-a.md)\n" });
    git(root, "checkout", "-qb", "feature");
    write(root, { "docs/adr/002-b.md": adr("ADR-002", "나") });
    const r = run(root, "check", "--changed-since", "main");
    assert.deepEqual(r.out, ["docs/adr/INDEX.md:1: INDEX_DESYNC 색인에 없다: ADR-002"]);
    assert.equal(r.code, 1);
  });

  test("stage 한 이름 바꾸기, 작업 트리 삭제, 대상 제목 변경은 바뀐 쪽이다", () => {
    const root = repo({
      "docs/adr/001-a.md": adr("ADR-001", "가"),
      "gone.md": "# 가\n",
      "target.md": "# 옛 제목\n",
      "a.md": "[ADR-001](docs/adr/001-a.md)\n",
      "b.md": "[가](gone.md)\n",
      "c.md": "[가](target.md#옛-제목)\n",
    });
    git(root, "checkout", "-qb", "feature");
    git(root, "mv", "docs/adr/001-a.md", "docs/adr/001-b.md");
    rmSync(join(root, "gone.md"));
    write(root, { "target.md": "# 새 제목\n" });
    const r = run(root, "check", "--changed-since", "main");
    assert.deepEqual(r.out, ["a.md:1: BROKEN_LINK docs/adr/001-a.md", "b.md:1: BROKEN_LINK gone.md", "c.md:1: BROKEN_ANCHOR target.md#옛-제목"]);
    assert.equal(r.code, 1);
  });

  test("읽지 못하는 ref 는 2 다", () => {
    const root = repo({ "README.md": "# 가\n" });
    assert.equal(run(root, "check", "--changed-since", "no-such-ref").code, 2);
  });
});

describe("--scope 와 실패", () => {
  test("--scope 는 결과를 그 경로 아래로 좁힌다", () => {
    const root = repo({ "a/x.md": "[깨짐](none.md)\n", "b/y.md": "[깨짐](none.md)\n" });
    const r = run(root, "check", "--scope", "b");
    assert.deepEqual(r.out, ["b/y.md:1: BROKEN_LINK none.md"]);
    assert.match(r.err, /검사한 Markdown: 1개/);
  });

  test("git 밖과 모르는 옵션은 2 다", () => {
    const outside = mkdtempSync(join(tmpdir(), "adr-docs-nogit-"));
    roots.push(outside);
    assert.equal(run(outside, "check").code, 2);
    const root = repo({ "README.md": "# 가\n" });
    assert.equal(run(root, "check", "--nope").code, 2);
    assert.equal(run(root, "lint").code, 2);
    assert.equal(run(root, "check", "--index", "table").code, 2);
  });
});
