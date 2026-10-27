# fos-skills

Claude Code 로 일할 때 매번 되풀이하는 절차를 스킬로 묶은 플러그인이에요.
설계를 합의하고, 구현을 맡기고, 리뷰를 쓰고 반영하고, 머지한 뒤 정리하는 일까지 같은 순서로 돌아가요.

## 만든 이유

에이전트에게 일을 맡기면 결과는 빨리 나오지만, 같은 실수가 저장소마다 되풀이됐어요.

- 「끝났어요」 라는 보고를 믿고 머지했는데 테스트가 돌지 않았거나 완료 기준이 빠져 있었어요
- 사람이 정해야 할 것을 에이전트가 대신 정하고 지나갔어요
- 머지한 뒤 워크트리, 브랜치, 터미널이 남아 디스크와 화면을 채웠어요
- 저장소마다 스킬 사본을 고치다 보니 사본끼리 내용이 갈라졌어요

이 저장소는 그 절차를 한곳에 모아 둔 단일 소스예요.
여기서 고쳐 main 에 머지하면 플러그인을 설치한 모든 프로젝트가 갱신으로 받아요.

## 핵심 가치

- **보고 대신 확인:** worker 의 완료 보고를 근거로 삼지 않고 diff 를 읽고 검사를 다시 돌려요
- **결정은 사람에게:** 사람이 정할 것은 배경과 권장안을 붙여 묻고, 고른 답만 worker 에게 전해요
- **흔적 없는 마무리:** 머지가 끝나면 워크트리, 브랜치, worker 터미널, 끝난 지시서를 지워요
- **코어는 하나, 차이는 오버레이:** 절차는 여기 한 벌만 두고, 저장소마다 다른 값은 그 저장소의 오버레이 파일에 둬요

## 화면

worker 여럿에게 일을 맡기면 `/board` 창에서 오늘 목표, 정할 것, 진행 중인 일을 한눈에 볼 수 있어요.
버튼이나 단축키를 누르면 「오늘 시작」, 「정할 것 묻기」 요청이 입력란에 채워져요.

![/board 창. 전체 진행률, 단축키, 오늘 목표, 결정 필요 항목이 보인다](docs/images/board.png)

데모 저장소에서 2026-10-27 에 찍은 화면이에요. 실제 저장소의 설정과 대화 예시는 [`orch/README.md`](orch/README.md) 에 있어요.

## 스킬 목록

**여기에는 여러 번 써서 절차가 굳은 스킬만 둬요.**
아직 쓰임이 굳지 않은 스킬은 `~/.claude/skills/` 에서 다듬은 뒤 옮겨요.

| 스킬 | 하는 일 |
| --- | --- |
| [`planning`](planning/README.md) | 사용자와 합의한 것을 `docs/` 에 남기고, 그것만 읽고 구현할 수 있는 `tasks/` 를 만들어요 |
| [`build-with-teams`](build-with-teams/README.md) | planning 이 만든 task 를 읽어 plan 하나를 구현까지 끝내요 |
| [`orch`](orch/README.md) | Orca worker 를 띄워 PR 머지까지 맡기고, 머지 뒤 워크트리와 브랜치를 남기지 않아요 |
| [`pr-review`](pr-review/README.md) | 남의 PR 에 코드 리뷰를 쓰고 등록해요 |
| [`review-fix`](review-fix/README.md) | PR 에 이미 달린 리뷰를 읽고 코드에 반영해요 |
| [`docs-check`](docs-check/README.md) | 저장소 문서가 코드와 맞는지 감사하고, 승인받은 것만 고쳐요 |
| [`harness-cleanup`](harness-cleanup/README.md) | 하네스 지침이 현재 설정과 실행 결과에 맞는지 감사하고, 승인받은 것만 고쳐요 |
| [`mac-cleanup`](mac-cleanup/README.md) | 맥의 디스크, 메모리, 스왑과 오래된 세션, 머지된 브랜치를 조사하고 승인받은 것만 정리해요 |

플러그인은 위 표의 스킬과 `/board` 창을 함께 실어요.
[`content-preview`](content-preview/README.md) 와 [`korean-check`](korean-check/README.md) 의 원본도 여기 있지만, 스킬로는 팀 저장소의 플러그인으로 받아요.
그 플러그인을 받을 수 없는 환경에서는 두 스킬이 목록에 뜨지 않아요.

## 처음 써 보기

**1.** Claude Code 플러그인으로 설치해요.

```bash
claude plugin marketplace add jon890/fos-skills
claude plugin install fos-skills@fos-skills
```

**2.** 스킬은 `fos-skills:` 접두사로 불러요. 이름을 몰라도 하려는 일을 말하면 맞는 스킬이 떠요.

```text
/fos-skills:planning 로그인 실패 횟수 제한을 설계해 보자
이 PR 리뷰해 줘
리뷰 달린 거 반영해 줘
```

**3.** 일을 worker 에게 나눠 맡기려면 Orca 앱과 `gh` 로그인이 필요해요. 준비물은 [`orch/README.md`](orch/README.md) 의 「준비」 에 있어요.

### 갱신

플러그인에 버전을 쓰지 않아서, 버전을 올리지 않아도 main 의 새 커밋을 받아요.

```bash
claude plugin update fos-skills@fos-skills
```

### 링크로 설치

플러그인 시스템이 없는 에이전트에서는 스킬 디렉터리를 글로벌 스킬 디렉터리에 심링크해요.

```bash
ln -sfn ~/personal/fos-skills/planning ~/.claude/skills/planning
```

플러그인과 같은 이름의 링크를 함께 두면 스킬이 둘씩 떠요.
링크에서 플러그인으로 옮기는 순서는 [링크 설치에서 옮기기](docs/flow.md#링크-설치에서-옮기기) 를 따라요.

공용 도구를 전역에서도 부르려면 함께 걸어요.

```bash
ln -sfn ~/personal/fos-skills/tools/browser-driver/browser_driver.py ~/.claude/scripts/browser-driver
```

## 공용 도구

`tools/` 에는 스킬이 아닌 공용 도구를 둬요.
스킬 하나가 소유하기에는 다른 스킬도 쓰고, 전역에 두기에는 이 저장소가 관리해야 하는 것이에요.

| 도구 | 하는 일 | 쓰는 스킬 |
| --- | --- | --- |
| `tools/browser-driver` | 브라우저 백엔드가 달라도 같은 명령으로 조작해요. 실패를 종료 코드로 드러내요 | `content-preview` |

스킬은 이 도구를 저장소 안에서 찾고, 없으면 개인이 걸어 둔 것으로 내려가요.
이 플러그인은 `bin/` 을 두지 않아 `browser-driver` 를 PATH 명령으로 싣지 않아요. 근거는 [ADR-004](docs/adr/004-no-plugin-bin.md) 에 있어요.

`work-board/` 는 작업 현황 창 `/board` 를 그리는 mod 예요.
orch 스킬이 보드를 고치는 `work-board/bin/board.ts` 도 여기 있어요. 동작은 [`work-board/README.md`](work-board/README.md) 에 있어요.

`scripts/` 에는 이 저장소를 관리하는 명령과, 어느 스킬도 소유하지 않는 검사기를 둬요.

| 스크립트 | 하는 일 |
| --- | --- |
| `scripts/export-to-team.sh` | 공용 스킬을 팀 저장소로 내보내고 어긋남을 판정해요. 커밋을 고르는 `--source-ref` 는 머리 주석에 있어요 |
| `scripts/install-hooks.sh` | `hooks/` 의 훅을 `.git/hooks` 에 걸어요 |
| `scripts/test-plugin-install.sh` | 격리된 설정 폴더에서 플러그인 설치를 테스트해요 |
| `scripts/check-shell-korean.py` | 셸 스크립트에서 `$변수` 뒤에 한글이 붙은 자리를 찾아요. 셸에 따라 죽는 이식성 결함이에요 |
| `scripts/check-skill-docs.py` | 스킬 README 와 CHANGELOG 가 아래 「스킬 README」, 「버전과 변경 이력」 의 형식을 따르는지 검사해요 |

`check-shell-korean.py` 가 `korean-check` 에 없는 것은 그 스킬이 마크다운 전용으로 경계를 정해 두었기 때문이에요.
판정 근거는 그 파일의 docstring 에 있어요.

## 기여

PR 은 draft 없이 열어요. CI 가 PR 과 main push 에서 돌아요.

CI 는 Claude Code CLI 2.1.309 를 npm 으로 설치해 저장소 루트에서 `claude plugin test .` 를 실행해요.
이 명령은 `claude-code/testing` 을 쓰는 TypeScript 테스트를 실행하며, 로그인이나 API 키가 필요하지 않아요.
Python 테스트는 저장소 루트에서 `python3 -m unittest discover -s mac-cleanup/tests` 처럼 각 `tests/` 폴더를 주어 실행해요. 다른 위치에서 상대 경로로 부르면 `ImportError` 로 끝나는 스킬이 있어요.
orch 와 work-board 의 TypeScript 테스트는 Node 24 이상에서 `node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"` 로 실행해요.
저장소별 PR 설정은 [orch 오버레이](.orch/overlay.md)에 둬요.

### 고치는 동안

설치본은 main 에 push 한 뒤에만 바뀌어요.
그래서 고치는 동안에는 작업 트리를 그 세션에만 로드해요.

```bash
claude --plugin-dir "$(git rev-parse --show-toplevel)"
```

로드가 맞는지 판정하는 방법은 [고치는 동안의 확인](docs/flow.md#고치는-동안의-확인) 에 있어요.

### 스킬을 더할 때

아래를 함께 고쳐요.

- `.claude-plugin/plugin.json` 의 `skills` 배열
- `.codex-plugin/plugin.json` 의 `skills` 배열. Codex 가 읽는 매니페스트라 hook 은 싣지 않아요([ADR-007](docs/adr/007-codex-manifest-without-hooks.md))
- 이 README 의 스킬 목록 표
- 팀에도 내보낼 스킬이면 `scripts/export-to-team.sh` 의 `SHARED_SKILLS`

두 `skills` 배열 가운데 하나라도 빠뜨리면 `python3 -m unittest discover -s scripts/tests` 가 실패해요.
내보내기 전용 원본은 [`scripts/export-only-skills.json`](scripts/export-only-skills.json) 에 적고 배열에서 빼요.

### 코어와 오버레이

- **코어**(이 저장소): 도메인과 무관한 워크플로예요. 단계 뼈대, 핵심 원칙, 검증기가 여기 있어요.
- **오버레이**(각 프로젝트의 `.claude/planning-overlay.md`, `.orch/overlay.md` 같은 파일): 저장소 고유의 단계 변형, 문서 관례, 검증 경로, 실행 명령이 여기 있어요.

코어 SKILL 이 시작할 때 현재 저장소의 오버레이를 읽어 채워요.
오버레이가 없으면 코어 기본값으로 동작해요.

## 스킬 README

스킬 README 의 독자는 스킬을 쓰는 사람이에요.
이 스킬이 무엇을 덜어 주는지, 언제 부르는지, 부르면 무엇이 오가는지를 알려요.
절은 아래 순서로 둬요. 필요하면 다른 절을 더해도 돼요.

| 절 | 담는 것 |
| --- | --- |
| 첫 문단 | 이 스킬이 덜어 주는 수고. 제목 바로 밑에 절 제목 없이 둬요 |
| `## 이럴 때 쓴다` | 쓰는 상황과 스킬을 부르는 말 |
| `## 사용 예시` | 요청, 스킬이 하는 일, 받는 결과를 짧은 대화로 보여요 |
| `## 받는 것` | 끝났을 때 사용자에게 남는 것 |
| `## 준비` | 설치, 로그인, 개인 설정이 필요할 때만 둬요 |
| `## 함께 쓰는 스킬` | 이 스킬이 맡지 않는 일과 그 일을 맡는 스킬 |

**파일 목록(`## 구성`)은 두지 않아요.**
실행 절차는 `SKILL.md`, 스크립트 동작은 각 파일의 docstring 과 `--help` 가 소유해요. README 에 한 벌 더 두면 한쪽만 고쳐져요.
테스트 실행 명령은 「기여」 절에 둬요.

## 버전과 변경 이력

각 스킬은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 디렉터리의 `CHANGELOG.md` 로 이력을 남겨요.

**이 버전은 배포 핀이 아니에요.** 플러그인에는 버전을 쓰지 않아 커밋 SHA 가 버전이 되고, 설치한 쪽은 main 의 새 커밋을 갱신으로 받아요.
스킬 버전은 무엇이 언제 왜 바뀌었는지 추적하는 데만 써요.
이 점을 잊으면 태그와 릴리스까지 붙는 과설계로 가요. 근거는 [ADR-002](docs/adr/002-plugin-version-is-commit-sha.md) 에 있어요.

올리는 기준은 아래 표를 따라요.

| 등급 | 언제 | 예 |
| --- | --- | --- |
| major | 워크플로 단계가 바뀌어 기존 오버레이나 task 형식과 안 맞아요 | 단계 수를 8에서 6으로 줄여요 |
| minor | 지시를 추가하거나 제거해요 | 스폰 폴백 단계화를 넣어요 |
| patch | 문구만 다듬어요 | 표현을 고치고 오타를 바로잡아요 |

**CHANGELOG 에는 스킬을 쓰는 사람이 알아야 할 변화만 적어요.**

- 버전 하나는 `## X.Y.Z (YYYY-MM-DD)` 제목 밑에 목록 항목 몇 개로 써요. 새 명령, 바뀐 동작, 고친 문제가 여기 들어가요.
- 기존 사용법이 깨지면 그 항목을 `호환성:` 으로 시작해요.
- 경위, 실측 수치, 내부 리팩터링, 테스트 추가는 적지 않아요. 커밋 메시지와 PR 본문이 이것을 가져요.
- major 를 올리면 이전 major 의 버전들을 `## N.x` 한 절로 줄여요.

항목 수와 줄 길이의 상한은 `scripts/check-skill-docs.py` 가 소유하고, `python3 -m unittest discover -s scripts/tests` 가 README 형식과 함께 검사해요.

이력을 두는 자리와 태그는 아래를 따라요.

- 저장소 루트에는 CHANGELOG 를 두지 않아요. 갱신 지점이 갈려 한쪽이 먼저 낡아요.
- git 태그는 만들지 않아요. 설치한 쪽이 main 의 커밋을 받으므로 태그가 아무것도 고정하지 못해요.
