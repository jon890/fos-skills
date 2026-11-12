// check_references 의 명령 경계 테스트. HOME 을 임시 폴더로 바꿔 설치된 스킬과 홈 경로 검사를 고정한다.

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { homeEnv, Repo, type Result, write } from './helpers.ts'

class Case {
  readonly home = tempDir('hc-home-')
  readonly repo: Repo
  constructor(gitInit = false) {
    this.repo = new Repo('hc-ref-', gitInit)
  }
  check(...extra: string[]): Result {
    return this.repo.run('check_references', [this.repo.root, ...extra], { env: homeEnv(this.home) })
  }
  claude(text: string): void {
    this.repo.file('CLAUDE.md', text)
  }
  doc(rel: string, text: string): void {
    this.repo.file(rel, text)
  }
  // 홈의 플러그인 아래 스킬
  homeSkill(rel: string): void {
    write(join(this.home, '.claude/plugins', rel, 'SKILL.md'), '---\nname: x\n---\n')
  }
  repoSkill(rel: string, ...files: string[]): void {
    this.repo.file(`${rel}/SKILL.md`, '---\nname: x\n---\n')
    for (const f of files) this.repo.file(`${rel}/${f}`, '# 문서\n')
  }
}

const ok = (done: Result) => assert.equal(done.code, 0, done.stdout + done.stderr)
const broken = (done: Result) => assert.equal(done.code, 1, done.stdout + done.stderr)

describe('스킬 참조', () => {
  test('루트에 놓인 플러그인의 스킬을 찾는다', () => {
    const c = new Case()
    c.homeSkill('cache/fos-skills/fos-skills/0123456789ab/plan')
    c.claude('# 지침\n\n`plan` 스킬을 쓴다.\n')
    const done = c.check()
    ok(done)
    assert.ok(done.stdout.includes('깨진 참조 0건'))
  })

  test('skills 아래에 놓인 플러그인의 스킬을 찾는다', () => {
    const c = new Case()
    c.homeSkill('cache/m/p/1.0.0/skills/brain-add')
    c.claude('`brain-add` 스킬을 쓴다.\n')
    ok(c.check())
  })

  test('스킬 폴더가 없으면 깨진 참조다', () => {
    const c = new Case()
    mkdirSync(join(c.home, '.claude/plugins'), { recursive: true })
    c.claude('# 지침\n\n`no-such-skill` 스킬을 쓴다.\n')
    const done = c.check()
    broken(done)
    assert.equal(done.stdout, '깨진 참조 1건\n\n  CLAUDE.md:3  [스킬] no-such-skill\n')
  })

  test('스킬 표기는 skill 과 스킬 둘 다 본다', () => {
    const c = new Case()
    c.claude('`aaa-bb` skill 과 `ccc-dd` 스킬\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[스킬] aaa-bb') && done.stdout.includes('[스킬] ccc-dd'))
  })

  test('홈과 저장소의 스킬 폴더 이름을 설치된 스킬로 본다', () => {
    const c = new Case()
    write(join(c.home, '.claude/skills/from-home/x'), '')
    write(join(c.home, '.codex/skills/from-codex/x'), '')
    c.repo.file('.claude/skills/from-repo/x')
    c.repo.file('.agents/skills/from-agents/x')
    c.repo.file('skills/from-skills/x')
    c.claude('`from-home` 스킬 `from-codex` 스킬 `from-repo` 스킬 `from-agents` 스킬 `from-skills` 스킬\n')
    ok(c.check())
  })

  test('저장소의 SKILL.md 폴더 이름도 스킬이다', () => {
    const c = new Case()
    c.repoSkill('plugins/p/skills/inner')
    c.claude('`inner` 스킬\n')
    ok(c.check())
  })

  test('플러그인 디렉터리 이름과 plugin.json 의 name 은 스킬 참조로 읽지 않는다', () => {
    const c = new Case()
    c.repoSkill('plugins/nhn-dev/skills/dooray-cli')
    c.repo.file('.claude-plugin/plugin.json', '{"name": "my-plugin"}')
    c.claude('`nhn-dev` 스킬 과 `my-plugin` skill\n')
    ok(c.check())
  })

  test('스킬 표기 사이의 공백은 Python 이 공백으로 보는 글자만이다', () => {
    const c = new Case()
    c.claude('`aaa-bb`\x1f스킬\n')
    broken(c.check())
    c.claude('`aaa-bb`\ufeff스킬\n')
    ok(c.check())
    c.claude('`aaa-bb`\u3000스킬\n')
    broken(c.check())
  })

  test('알 수 없는 이름은 플러그인이 있어도 보고한다', () => {
    const c = new Case()
    c.repoSkill('plugins/nhn-dev/skills/dooray-cli')
    c.claude('`no-such-skill` 스킬\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[스킬] no-such-skill'))
  })

  test('깨진 plugin.json 은 건너뛴다', () => {
    const c = new Case()
    c.repo.file('.claude-plugin/plugin.json', '{깨짐')
    c.repo.file('plugins/q/.claude-plugin/plugin.json', '[1]')
    c.claude('`zzz-yy` 스킬\n')
    broken(c.check())
  })
})

describe('형제 스킬의 파일 참조', () => {
  test('플러그인 이름을 붙인 형제 스킬의 경로는 깨진 참조가 아니다', () => {
    const c = new Case()
    c.repoSkill('plugins/nhn-dev/skills/dooray-cli', 'references/mention-link.md')
    c.repoSkill('plugins/ai-sdt/skills/weekly-report')
    c.doc('plugins/ai-sdt/skills/weekly-report/references/format.md', '`nhn-dev:dooray-cli` 스킬의 `references/mention-link.md` 가 소유한다.\n')
    ok(c.check())
  })

  test('이름만 쓴 형제 스킬의 경로도 아니다', () => {
    const c = new Case()
    c.repoSkill('skills/alpha', 'references/shared.md')
    c.repoSkill('skills/beta')
    c.doc('skills/beta/SKILL.md', '`alpha` 스킬의 `references/shared.md` 를 읽는다.\n')
    ok(c.check())
  })

  test('이름 붙인 형제 스킬에 파일이 없으면 깨진 참조다', () => {
    const c = new Case()
    c.repoSkill('plugins/nhn-dev/skills/dooray-cli', 'references/other.md')
    c.repoSkill('plugins/ai-sdt/skills/weekly-report')
    c.doc('plugins/ai-sdt/skills/weekly-report/references/format.md', '`nhn-dev:dooray-cli` 스킬의 `references/mention-link.md` 가 소유한다.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[경로] references/mention-link.md'))
  })

  test('모르는 접두는 형제 지명이 아니다', () => {
    const c = new Case()
    c.repoSkill('plugins/nhn-dev/skills/dooray-cli', 'references/mention-link.md')
    c.repoSkill('plugins/ai-sdt/skills/weekly-report')
    c.doc('plugins/ai-sdt/skills/weekly-report/references/format.md', '`foo:dooray-cli` 의 `references/mention-link.md` 가 소유한다.\n')
    broken(c.check())
  })

  test('형제 이름이 없는 경로는 깨진 참조다', () => {
    const c = new Case()
    c.repoSkill('skills/alpha', 'references/shared.md')
    c.repoSkill('skills/beta')
    c.doc('skills/beta/SKILL.md', '`references/shared.md` 를 읽는다.\n')
    broken(c.check())
  })

  test('한글 바로 뒤에 붙은 plugin:skill 꼴은 지명으로 읽지 않는다', () => {
    const c = new Case()
    c.repoSkill('plugins/nhn-dev/skills/dooray-cli', 'references/mention-link.md')
    c.repoSkill('plugins/ai-sdt/skills/weekly-report')
    c.doc('plugins/ai-sdt/skills/weekly-report/references/format.md', '한글nhn-dev:dooray-cli 의 `references/mention-link.md` 가 소유한다.\n')
    broken(c.check())
  })
})

describe('링크 문구의 경로', () => {
  test('문구가 실재하는 대상을 다시 적으면 깨진 참조가 아니다', () => {
    const c = new Case()
    c.repoSkill('skills/plan', 'references/monorepo.md')
    c.repoSkill('skills/beta')
    c.doc('skills/beta/SKILL.md', '[plan 의 `references/monorepo.md`](../plan/references/monorepo.md) 가 소유한다.\n')
    ok(c.check())
  })

  test('대상이 없으면 링크와 문구의 경로를 함께 본다', () => {
    const c = new Case()
    c.repoSkill('skills/plan')
    c.repoSkill('skills/beta')
    c.doc('skills/beta/SKILL.md', '[plan 의 `references/monorepo.md`](../plan/references/monorepo.md) 가 소유한다.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[링크] ../plan/references/monorepo.md'))
  })

  test('문구가 대상과 달라도 대상이 실재하면 건너뛴다', () => {
    const c = new Case()
    c.repoSkill('skills/plan', 'references/monorepo.md')
    c.repoSkill('skills/beta')
    c.doc('skills/beta/SKILL.md', '[`references/other.md`](../plan/references/monorepo.md) 가 소유한다.\n[`scripts/run.py` 와 `references/other.md` 절](../plan/references/monorepo.md) 를 본다.\n')
    ok(c.check())
  })

  test('링크 밖의 코드 경로는 그대로 본다', () => {
    const c = new Case()
    c.repoSkill('skills/plan', 'references/monorepo.md')
    c.repoSkill('skills/beta')
    c.doc('skills/beta/SKILL.md', '[절](../plan/references/monorepo.md) 와 `references/other.md` 를 본다.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[경로] references/other.md'))
  })
})

describe('링크와 경로', () => {
  test('깨진 링크와 앵커와 저장소 밖 링크', () => {
    const c = new Case()
    c.repo.file('docs/a.md', '# a\n')
    c.claude('[ok](docs/a.md#앵커) [없음](docs/none.md) [밖](../../outside.md) [웹](https://x/y.md) [꺾쇠](<a>.md)\n')
    const done = c.check()
    broken(done)
    assert.equal(done.stdout, '깨진 참조 1건\n\n  CLAUDE.md:1  [링크] docs/none.md\n')
  })

  test('백틱 경로는 저장소 루트와 문서의 상위 폴더 기준으로 찾는다', () => {
    const c = new Case()
    c.repo.file('docs/a.md', '# a\n')
    c.repo.file('sub/docs/b.md', '# b\n')
    c.claude('`docs/a.md` `./docs/a.md` `docs/zzz.md` `docs/zzz/`\n')
    c.doc('sub/CLAUDE.md', '`docs/b.md` 와 `docs/a.md`\n')
    const done = c.check()
    broken(done)
    assert.equal(done.stdout, '깨진 참조 2건\n\n  CLAUDE.md:1  [경로] docs/zzz.md\n  CLAUDE.md:1  [경로] docs/zzz/\n')
  })

  test('알려진 접두가 아닌 경로와 자리표시자와 URL 은 보지 않는다', () => {
    const c = new Case()
    c.claude('`foo/bar.md` `docs/<x>.md` `docs/*.md` `$HOME/a/b` `~/a/b` `https://a/b.md` `skills/{a}/x`\n')
    ok(c.check())
  })

  test('스킬 번들 안 문서는 번들 루트 기준 경로를 쓴다', () => {
    const c = new Case()
    c.repoSkill('skills/a', 'scripts/run.sh')
    c.doc('skills/a/references/x.md', '`scripts/run.sh` 를 쓴다.\n')
    ok(c.check())
  })

  test('저장소 루트의 배포용 스킬은 생성할 경로를 계약으로 적는다', () => {
    const c = new Case()
    c.repo.file('mygen/SKILL.md', '---\nname: x\n---\n`docs/generated/out.md` 와 `scripts/none.sh`\n')
    const done = c.check()
    broken(done)
    assert.equal(done.stdout, '깨진 참조 1건\n\n  mygen/SKILL.md:4  [경로] scripts/none.sh\n')
  })

  test('섹션 참조는 대상 파일의 제목 일부와 대조한다', () => {
    const c = new Case()
    c.repo.file('docs/a.md', '# 개요\n## 설치 방법\n')
    c.claude('`docs/a.md` 의 "설치" 섹션\n`docs/a.md` "없는 장" 절\n`docs/a.md` “개요” 표\n`docs/none.md` "x장" 섹션\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('CLAUDE.md:2  [절명] docs/a.md → "없는 장"'), done.stdout)
    assert.ok(!done.stdout.includes('CLAUDE.md:1'))
    assert.ok(!done.stdout.includes('CLAUDE.md:3'))
  })

  test('섹션 이름이 61자이면 섹션 참조로 보지 않는다', () => {
    const c = new Case()
    c.repo.file('docs/a.md', '# 개요\n')
    c.claude(`\`docs/a.md\` "${'가'.repeat(61)}" 섹션\n\`docs/a.md\` "${'가'.repeat(60)}" 섹션\n`)
    const done = c.check()
    broken(done)
    assert.equal(done.stdout.split('\n').filter((l) => l.includes('[섹션명]')).length, 1)
    assert.ok(done.stdout.includes('CLAUDE.md:2'))
  })
})

describe('「제목」 참조', () => {
  function guide(): Case {
    const c = new Case()
    c.repo.file('AGENTS.md', '# 지침\n\n## 머지는 PR 로 한다\n\n## 용어\n\n- **코드 주석은 한국어로 쓴다.**\n')
    return c
  }
  const git = (c: Case, ...files: string[]) => {
    c.repo.git('init', '-q')
    c.repo.git('add', ...files)
  }

  test('모든 파일 표기에서 있는 제목은 통과한다', () => {
    const c = guide()
    c.claude('`AGENTS.md` 「머지는 PR 로 한다」 가 정한다.\n[`AGENTS.md`](AGENTS.md) 의 「용어」 절에 있다.\n{@code AGENTS.md} 「용어」 를 따른다.\n맨 경로 AGENTS.md 에 「머지는 PR 로 한다」 가 있다.\n')
    ok(c.check())
  })

  test('없는 제목은 줄 번호와 함께 보고한다', () => {
    const c = guide()
    c.claude('첫 줄\n`AGENTS.md` 「없는 제목」 을 따른다.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('CLAUDE.md:2  [절 제목] AGENTS.md → 「없는 제목」'))
  })

  test('제목은 글자 그대로 비교한다', () => {
    const c = guide()
    c.claude('`AGENTS.md` 「머지는 PR로 한다」 를 따른다.\n')
    broken(c.check())
  })

  test('이어진 제목은 제목마다 본다', () => {
    const c = guide()
    c.claude('`AGENTS.md` 「용어」 의 「머지는 PR 로 한다」 를 따른다.\n`AGENTS.md` 「용어」 「없는 제목」.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('「없는 제목」'))
    assert.equal(done.stdout.split('[절 제목]').length - 1, 1)
  })

  test('굵은 라벨은 두 번째 이후 제목에서만 인정한다', () => {
    const c = guide()
    c.claude('`AGENTS.md` 「용어」 의 「코드 주석은 한국어로 쓴다」 를 따른다.\n')
    ok(c.check())
    c.claude('`AGENTS.md` 「코드 주석은 한국어로 쓴다」 를 따른다.\n')
    broken(c.check())
  })

  test('파일 표기 없는 「」 와 자리표시자와 못 찾는 파일은 건너뛴다', () => {
    const c = guide()
    c.claude('화면의 「저장」 버튼을 누른다. 「없는 제목」 이라는 문구가 뜬다.\n`AGENTS.md` 의 「...」 절\n`~/AGENTS.md` 「없는 제목」\n`no-such.md` 「없는 제목」\n`AGENTS.md` 「<제목>」\n')
    ok(c.check())
  })

  test('파일 표기 바로 앞이 한글이면 맨 경로로 읽지 않는다', () => {
    const c = guide()
    c.claude('규칙AGENTS.md 「없는 제목」 을 따른다.\n')
    ok(c.check())
  })

  test('유니코드 공백 가운데 Python 이 공백으로 보는 것만 파일 표기와 제목 사이에 둘 수 있다', () => {
    const c = guide()
    c.claude('`AGENTS.md` 「없는 제목」\n')
    broken(c.check())
    c.claude('`AGENTS.md`\u3000「없는 제목」\n')
    broken(c.check())
    c.claude('`AGENTS.md`\x1f「없는 제목」\n')
    broken(c.check())
    c.claude('`AGENTS.md`\ufeff「없는 제목」\n')
    ok(c.check())
  })

  test('코드 주석이 지침을 가리키면 추적 파일에서도 본다', () => {
    const c = guide()
    c.repo.file('src/Rules.java', ' * 근거: {@code AGENTS.md} 「없는 제목」.\n')
    c.repo.file('README.md', '[`AGENTS.md`](AGENTS.md) 「용어」\n')
    git(c, 'AGENTS.md', 'src/Rules.java', 'README.md')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('src/Rules.java:1  [절 제목] AGENTS.md → 「없는 제목」'))
  })

  test('코드 주석의 있는 제목은 통과한다', () => {
    const c = guide()
    c.repo.file('backend/Rules.java', ' * 근거: backend/AGENTS.md 「포맷」 절, ../AGENTS.md 「용어」.\n')
    c.repo.file('backend/AGENTS.md', '## 포맷\n')
    git(c, 'AGENTS.md', 'backend/Rules.java', 'backend/AGENTS.md')
    ok(c.check())
  })

  test('지침이 아닌 파일을 가리키는 추적 파일의 참조와 CHANGELOG 와 추적하지 않는 파일과 바이너리는 보지 않는다', () => {
    const c = guide()
    c.repo.file('docs/notes.md', '# 메모\n')
    c.repo.file('src/Rules.java', ' * {@code docs/notes.md} 「없는 제목」\n')
    c.repo.file('CHANGELOG.md', '`AGENTS.md` 의 「옛 이름」 을 바꿨다.\n')
    c.repo.file('src/Untracked.java', ' * `AGENTS.md` 「없는 제목」\n')
    c.repo.file('blob.bin', '\0`AGENTS.md` 「가」')
    git(c, 'AGENTS.md', 'docs/notes.md', 'src/Rules.java', 'CHANGELOG.md', 'blob.bin')
    ok(c.check())
  })

  test('--scope 는 두 범위 모두 읽는 파일을 제한한다', () => {
    const c = guide()
    c.repo.file('src/Rules.java', ' * `AGENTS.md` 「없는 제목」\n')
    c.repo.file('other/Rules.java', ' * `AGENTS.md` 「없는 제목」\n')
    git(c, 'AGENTS.md', 'src/Rules.java', 'other/Rules.java')
    const done = c.check('--scope', 'other')
    broken(done)
    assert.ok(done.stdout.includes('other/Rules.java:1'))
    assert.ok(!done.stdout.includes('src/Rules.java'))
  })

  test('--scope 인자가 틀리면 2', () => {
    const c = guide()
    const done = c.check('--scope', 'nope')
    assert.equal(done.code, 2)
    assert.equal(done.stderr, '범위 경로가 없다: nope\n')
  })
})

describe('펜스와 브랜치 이름', () => {
  test('펜스 코드 블록 안의 깨진 참조는 건너뛴다', () => {
    const c = new Case()
    c.claude('# 지침\n\n```markdown\n[견본](없다.md)\n`docs/없다.md` 와 `AGENTS.md` 「없는 제목」\n```\n')
    ok(c.check())
  })

  test('틸드 펜스를 건너뛰고 안쪽 백틱 펜스가 닫지 않는다', () => {
    const c = new Case()
    c.claude('~~~\n```\n[견본](없다.md)\n~~~\n')
    ok(c.check())
  })

  test('펜스 밖의 같은 참조는 깨진 참조다', () => {
    const c = new Case()
    c.claude('```\n[견본](없다.md)\n```\n\n[본문](없다.md)\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('CLAUDE.md:5  [링크] 없다.md'))
    assert.ok(!done.stdout.includes('CLAUDE.md:2'))
  })

  test('브랜치를 말하는 줄의 확장자 없는 표기는 경로가 아니다', () => {
    const c = new Case()
    c.claude('작업 브랜치는 `docs/branch-naming` 으로 만든다.\nbranch `docs/a-b` 와 `docs/c-d` checkout\n')
    ok(c.check())
  })

  test('브랜치 줄이 아니면 같은 표기도 깨진 경로다', () => {
    const c = new Case()
    c.claude('규칙은 `docs/branch-naming` 에 있다.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[경로] docs/branch-naming'))
  })

  test('브랜치 줄의 파일 경로와 끝 슬래시 경로는 그대로 본다', () => {
    const c = new Case()
    c.claude('브랜치 규칙은 `docs/branch-naming.md` 에 있다.\n브랜치 `docs/dir/` 도 본다.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[경로] docs/branch-naming.md') && done.stdout.includes('[경로] docs/dir/'))
  })

  test('한글 바로 뒤의 branch 낱말은 브랜치 줄로 보지 않는다', () => {
    const c = new Case()
    c.claude('한글branch 규칙은 `docs/branch-naming` 에 있다.\n')
    broken(c.check())
  })
})

describe('홈 경로', () => {
  test('이 머신 홈에 없는 경로는 실패가 아니라 경고다', () => {
    const c = new Case()
    c.claude('규칙은 `~/.claude/references/missing.md` 가 소유한다.\n')
    const done = c.check()
    ok(done)
    assert.equal(done.stdout, '깨진 참조 0건\n\n경고 1건 — 이 머신의 홈에 없는 경로. 다른 사람의 경로일 수 있어 실패로 세지 않는다\n\n  CLAUDE.md:1  [홈 경로] ~/.claude/references/missing.md\n')
  })

  test('있는 경로는 보고하지 않는다', () => {
    const c = new Case()
    write(join(c.home, '.claude/references/present.md'), '# 문서\n')
    c.claude('규칙은 `~/.claude/references/present.md` 가 소유한다.\n')
    const done = c.check()
    ok(done)
    assert.ok(!done.stdout.includes('홈 경로'))
  })

  test('자리표시자와 펜스 안의 홈 경로는 건너뛴다', () => {
    const c = new Case()
    c.claude('`~/projects/<저장소>/AGENTS.md` 와 `~/.claude/*.md` 를 본다.\n\n```\n`~/nowhere/x.md`\n```\n')
    const done = c.check()
    ok(done)
    assert.ok(!done.stdout.includes('홈 경로'))
  })

  test('한글과 공백이 든 경로도 본다', () => {
    const c = new Case()
    c.claude('`~/문서/내 지침.md` 가 소유한다.\n')
    assert.ok(c.check().stdout.includes('[홈 경로] ~/문서/내 지침.md'))
    write(join(c.home, '문서/내 지침.md'), '# 문서\n')
    assert.ok(!c.check().stdout.includes('홈 경로'))
  })

  test('옵션이 붙은 명령 줄은 경로에서 잘라 본다', () => {
    const c = new Case()
    write(join(c.home, 'bin/run.py'), 'print()\n')
    c.claude('`~/bin/run.py --apply --scope x` 와 `~/bin/run.py -n` 을 돌린다.\n')
    const done = c.check()
    ok(done)
    assert.ok(!done.stdout.includes('홈 경로'))
  })

  test('없는 경로에 옵션이 붙으면 경로만 보고한다', () => {
    const c = new Case()
    c.claude('`~/bin/nowhere.py --apply` 를 돌린다.\n')
    const done = c.check()
    ok(done)
    assert.ok(done.stdout.includes('[홈 경로] ~/bin/nowhere.py\n'))
    assert.ok(!done.stdout.includes('--apply'))
  })

  test('대시로 시작하는 한글 이름은 옵션이 아니라 경로의 일부다', () => {
    const c = new Case()
    write(join(c.home, '문서/내 지침 -초안.md'), '# 문서\n')
    c.claude('`~/문서/내 지침 -초안.md` 가 소유한다.\n')
    assert.ok(!c.check().stdout.includes('홈 경로'))
  })

  test('옵션 앞이 BOM 이면 공백이 아니라 경로의 일부다', () => {
    const c = new Case()
    c.claude('`~/bin/nowhere.py --apply` 를 돌린다.\n`~/bin/nowhere2.py\ufeff--apply`\n')
    const done = c.check()
    assert.ok(done.stdout.includes('[홈 경로] ~/bin/nowhere.py\n'), done.stdout)
    assert.ok(done.stdout.includes('[홈 경로] ~/bin/nowhere2.py\ufeff--apply\n'), done.stdout)
  })

  test('경고는 깨진 참조를 가리지 않는다', () => {
    const c = new Case()
    c.claude('`~/nowhere/x.md` 와 [링크](없다.md) 를 본다.\n')
    const done = c.check()
    broken(done)
    assert.ok(done.stdout.includes('[링크] 없다.md') && done.stdout.includes('[홈 경로] ~/nowhere/x.md'))
  })
})

test('PATH 에 git 이 없으면 한 줄 안내와 종료 코드 2 를 낸다', () => {
  const c = new Case()
  c.claude('# 지침\n')
  const done = c.repo.run('check_references', [c.repo.root], { env: { ...homeEnv(c.home), PATH: '/nonexistent' } })
  assert.equal(done.code, 2)
  assert.equal(done.stderr, 'git 실행 파일을 찾을 수 없다. PATH 를 확인한다.\n')
  assert.equal(done.stdout, '')
})
