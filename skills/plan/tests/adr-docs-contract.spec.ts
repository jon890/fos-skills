// spec, technical-design, review-fix, docs-audit 가 같은 검사기 adr-docs.ts 를 부르고,
// 지운 옛 ADR 검사기를 부르는 문서가 남지 않았는지 본다. 스킬 문서는 이 번들의 형제 폴더에 있다.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SKILLS = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${SKILLS}${path}`, "utf8");
const OLD = "check_adr_layout";

describe("adr-docs.ts 를 부르는 스킬 문서", () => {
  const callers: [string, RegExp][] = [
    ["spec/SKILL.md", /adr-docs\.ts" check --changed-since "\$BASE"/],
    ["technical-design/SKILL.md", /adr-docs\.ts" write-index[\s\S]*adr-docs\.ts" check --changed-since "\$BASE"/],
    ["technical-design/references/adr-rules.md", /adr-docs\.ts" write-index[\s\S]*adr-docs\.ts" check --changed-since "\$BASE"/],
    ["review-fix/SKILL.md", /adr-docs\.ts" check --changed-since "\$BASE"/],
    ["docs-audit/SKILL.md", /adr-docs\.ts" check --scope "\$SCOPE"/],
  ];
  for (const [path, call] of callers) {
    test(`${path} 가 검사기를 부르고 옛 검사기를 부르지 않는다`, () => {
      const text = read(path);
      assert.match(text, call);
      assert.ok(!text.includes(OLD), `${path} 에 ${OLD} 가 남았다`);
    });
  }

  test("review-fix 결과 보고에 PR 밖 위반 자리가 있다", () => {
    assert.match(read("review-fix/references/finish.md"), /PR 밖 위반/);
  });

  test("인자 만드는 법은 plan 의 monorepo.md 한 곳에 있다", () => {
    const text = read("plan/references/monorepo.md");
    assert.match(text, /^### ADR 문서 검사$/m);
    for (const row of ["ADR 폴더", "ADR 색인 생성", "ADR 대체 배치"]) assert.match(text, new RegExp(`^\\| ${row} \\|.*adr-docs\\.ts`, "m"));
    assert.ok(!text.includes(OLD));
  });

  test("옛 검사기 파일이 없다", () => {
    assert.equal(existsSync(`${SKILLS}plan/scripts/${OLD}.py`), false);
  });
});
