# ADR 링크·색인·번호 검사를 fos-skills 가 소유한다

확인: 2026-11-05

## 목표

문서를 쓰거나 고치는 단계(spec, technical-design, review-fix, docs-audit)에서 fos-skills 의 검사기 하나가 ADR 색인을 다시 만들고, 링크 없는 ADR 번호 참조와 깨진 링크·앵커, 번호 중복을 잡는다. 저장소는 같은 규칙을 따로 유지하지 않고 CI 에서 다시 검사하지 않는다(DECISION5).

- 배경: ai-analysis 코디네이터의 개선 요청(사용자 2026-11-05). 11-05 검사 검토에서 ai-analysis CI 가 실제로 막은 횟수가 가장 많은 검사가 이 넷이었다. 작성 단계에서 끝내면 이 실패가 CI 까지 가지 않는다(ai-analysis CI 실패 1405266, 1337249, 1281159, 1405588).
- 선행: PR 347 「결정 기록 종류와 단계 책임」 머지 뒤 시작한다(사용자 결정 2026-11-05, 머지됨).

## 실측 (2026-11-05, fos-skills c3fce4d, ai-analysis 11fb91b85)

세 검사기가 같은 일을 조금씩 다르게 한다.

| 검사 | ai-analysis `scripts/check/check-docs.py` | docs-audit `static_check.py` | plan `check_adr_layout.py` |
| --- | --- | --- | --- |
| 링크 대상 파일이 없다 | 저장소 문서 전체 | 범위 안 Markdown 전체 | ADR 폴더를 가리키는 링크만 |
| 앵커가 없는 제목을 가리킨다 | 있음(`\w` 기준 슬러그) | 있음(`isalnum` 기준 슬러그) | 없음 |
| 링크 없이 적은 `ADR-NNN` | 있음. `tasks/` 와 ADR 제목 줄은 뺀다 | 없음 | 없음 |
| 색인(`INDEX.md`) | 생성 결과와 글자까지 같은지 본다. `--write-index` 로 만든다 | 본문 제목의 번호 집합과 색인의 번호 집합만 맞춘다 | 없음 |
| 폴더 안 번호 중복 | 있음 | 없음 | 없음 |
| 대체된 ADR 위치(`superseded/`)와 status | 없음 | 없음 | 있음. `--flat` 이면 건너뛴다 |
| ADR 폴더 | `docs/adr`, `modules/*/docs/adr` 고정 | 인자 하나 | 인자 하나 |
| 저장소 고유 검사 | `docs/` 맨 위 허용 파일, `data-schema.md` 이력 표현, `code-architecture.md` 목록·절 | 표 열 수, 제목 단계, 코드 펜스, 계획서 번호 참조, 책임 설명 목록 | 없음 |

- 알려진 버그: ai-analysis 색인 생성기는 `[analysis-api ADR-057](...)` 처럼 접두가 붙은 링크 글을 대체 관계 열에서 뺀다(`check-docs.py:58-66`, 링크 글을 `ADR_REFERENCE.fullmatch` 로 본다).
- 저장소마다 ADR 배치가 다르다.
  - ai-analysis: 루트와 모듈 6곳에 폴더가 있고 번호를 폴더마다 매긴다. 다른 폴더의 ADR 을 `[analysis-api ADR-017](...)` 처럼 접두를 붙여 가리킨다. 대체된 ADR 도 제자리에 둔다(`.claude/plan-overlay.md:8` 「폴더 없음」).
  - fos-accountbook: `ADR-M01` 처럼 영역 글자가 붙은 번호, 루트와 `frontend/`, `backend/` 세 폴더. 자체 검사기 `scripts/check-adr-links.py` 를 CI(`docs-ci.yml`)가 돈다.
  - fos-assistant: 네 폴더, 날짜 식별자(`ADR-20261007 / slug`)도 받는다. 자체 테스트 `test/unit/adr-index.test.ts`.
  - fos-skills: 목록형 색인(`- [ADR-001](...): 제목 (`status`)`).
  - 병렬 PR 저장소용 날짜 식별자와 「현행」·「대체됨」 두 표 색인은 [technical-design 의 adr-parallel.md](../../../skills/technical-design/references/adr-parallel.md) 가 정한다.
- 색인 형식이 저장소마다 다르다. ai-analysis 는 표 하나에 `번호 | 결정 | 상태 | 대체 관계`, [adr-rules.md 「대체와 이동」](../../../skills/technical-design/references/adr-rules.md#대체와-이동)은 「현행」과 「대체됨」 으로 나눠 적으라고 한다.
- CI: ai-analysis 는 사내 self-hosted 러너에서 `bash scripts/verify.sh docs` 로 `check-docs.py` 를 돈다(`.github/workflows/ci.yml:182`). 러너에 플러그인이 없고, Node 24.22.1 이 있다(`.tool-versions`). fos-skills 는 공개 GitHub 저장소(`jon890/fos-skills`)다.
- 작성 단계 연결: spec·technical-design 은 `run_doc_checks.py` 로 오버레이의 「문서 검사 명령」 을 돈다. ai-analysis 오버레이에는 그 값이 없다. technical-design 은 ADR 을 대체한 뒤 `check_adr_layout.py` 를 돈다([adr-rules.md 「대체한 뒤 검사」](../../../skills/technical-design/references/adr-rules.md#대체한-뒤-검사)).
- 함께 얽힌 작업: node-runtime 은 모든 Python 을 TypeScript 로 옮긴다. docs-audit 는 영역 3, plan 은 영역 7 이다([node-runtime 스펙 「선행 조건과 순서」](../node-runtime/spec.md#선행-조건과-순서)). 구현 시작 조건은 testkit 과 orch PR3 머지다. orch PR3 는 orch 스크립트만 옮긴다([orch-cli 스펙 「범위」](../orch-cli/spec.md#범위)).

## 범위

이번 범위:

- 공용 ADR 문서 검사기: 링크·앵커, 링크 없는 ADR 번호 참조, 색인 생성과 대조, 폴더 안 번호 중복, 대체된 ADR 위치
- 저장소별 ADR 배치(여러 폴더, 접두 번호, 날짜 식별자)를 받는 설정
- spec, technical-design, review-fix, docs-audit 가 이 검사기를 부르는 자리와 작성 단계에서 고치는 것. review-fix 에는 이 검사기를 부르는 단계를 새로 더한다(DECISION5)
- `check_adr_layout.py` 를 지우고 `static_check.py` 에서 링크·색인 검사를 덜어 낸다(DECISION1)
- ai-analysis `check-docs.py` 의 일반 검사를 지우고 색인을 새 형식으로 다시 만든다(DECISION6)

범위 밖:

- 저장소 고유 결정(yml 기본값 금지, 운영 스위치 키, `scripts/` 배치, `docs/` 맨 위 허용 파일, `data-schema.md` 이력 표현, `code-architecture.md` 목록·절). 저장소에 남는다.
- `static_check.py` 의 Markdown 구조 검사(표 열 수, 제목 단계, 코드 펜스)와 계획서 번호 참조, 책임 설명 목록 경고. 그대로 둔다.
- ADR 본문의 의미 검사(남길 조건, 담을 것). docs-audit 의 의미 검사가 맡는다.
- CI 의 ADR·링크 검사. 스킬 밖에서 고친 문서의 깨진 링크는 다음 review-fix 나 docs-audit 가 잡는다(DECISION5).
- fos-accountbook `scripts/check-adr-links.py`, fos-assistant `test/unit/adr-index.test.ts` 의 이전. 보드 후보로 남긴다(DECISION6).

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | 검사기 하나가 링크·앵커, 링크 없는 ADR 번호, 색인, 번호 중복, 대체된 ADR 위치를 판정한다 | 임시 저장소 표본마다 위반 줄(`경로:줄: 내용`)과 종료 코드 1 이 나오고, 위반이 없으면 0 이다. ai-analysis `check-docs.py` 의 같은 검사와 같은 문서에 돌린 결과가 같다(접두 링크 버그는 고친 쪽) |
| REQ2 | 저장소마다 다른 ADR 배치를 설정으로 받는다 | ai-analysis(모듈 폴더 7곳), fos-accountbook(`ADR-M01`), 날짜 식별자 표본에서 설정만 바꿔 오탐 없이 돈다 |
| REQ3 | 색인 생성을 켠 저장소에서 작성 단계가 색인을 다시 만든다 | technical-design 이 ADR 을 만들거나 대체한 뒤 쓰기 모드를 돌리고, 그 뒤 검사 모드가 0 이다. 색인은 「현행」·「대체됨」 두 표이고 두 표 모두 대체 관계 열이 있다. 접두 링크 글(`analysis-api ADR-057`)이 대체 관계에 들어간다. 생성을 켜지 않은 저장소는 본문과 색인의 번호 집합만 맞춘다 |
| REQ4 | spec·technical-design·review-fix·docs-audit 가 같은 검사기를 부른다 | 네 스킬 문서가 이 검사기를 부르는 단계를 갖고, `check_adr_layout.py` 가 없으며 `static_check.py` 에 링크·색인 검사가 없다. 링크 없는 번호 참조는 후보 경로와 함께 위반으로 나오고 본문은 고쳐지지 않는다. review-fix 결과 보고에 PR 밖 위반이 따로 적힌다 |
| REQ5 | 기존 두 검사기의 호출자가 깨지지 않는다 | `check_adr_layout.py`, `static_check.py` 를 부르던 이 저장소 문서와 다른 저장소 오버레이(구현 PR 이 검색해 목록을 남긴다)가 새 검사기나 줄어든 `static_check.py` 를 부르고, 바뀐 명령이 해당 스킬 변경 조각의 호환성 항목에 있다 |
| REQ6 | ai-analysis 가 일반 검사를 따로 유지하지 않는다 | 이전 PR 뒤 `check-docs.py` 에 링크·앵커·ADR 번호·색인·번호 중복 코드가 없고 저장소 고유 검사만 남는다. 오버레이에 ADR 폴더와 색인 생성 값이 있고, 새 검사기의 쓰기 모드로 다시 만든 색인 7개가 커밋돼 있다. `scripts/verify.sh docs` 가 통과한다 |
| REQ7 | fos-skills 자기 색인을 생성한다 | fos-skills 오버레이가 색인 생성을 켜고, `docs/adr/INDEX.md` 가 쓰기 모드로 만든 두 표이며 검사 모드가 0 이다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 검사 소유 구조 | 공용 검사기 하나(plan 번들, TypeScript)에 다섯 검사를 모은다. `check_adr_layout.py` 는 지우고 `static_check.py` 는 구조 검사만 남긴다 | 사용자 2026-11-05 | 규칙 중복이 요청의 원인이다. 새 코드를 TypeScript 로 쓰면 node-runtime 이 옮길 양이 준다(권장안) |
| DECISION2 | 작성 단계에서 자동으로 고치는 것 | 색인만 쓰기 모드로 다시 만든다. 링크 없는 번호 참조는 후보 경로와 함께 보고만 하고 작성 에이전트가 고친다 | 사용자 2026-11-05 | 번호가 폴더마다 겹쳐(ai-analysis ADR-017) 자동 링크가 틀린 파일을 고를 수 있다. 본문 고침은 작성자가 diff 로 확인한다(권장안) |
| DECISION3 | 저장소별 ADR 배치를 받는 방법 | 오버레이 값 「ADR 폴더」(glob 여러 개, 기본 `docs/adr`). 번호 형식은 파일 이름에서 읽고 대체 배치는 기존 「ADR 대체 배치」 값을 읽는다 | 사용자 2026-11-05 | 여러 폴더 저장소만 값을 적고, 자동 탐지가 예시·임시 폴더를 잡는 일을 피한다(권장안) |
| DECISION4 | 생성하는 색인의 형식과 생성하지 않는 저장소 | 오버레이로 켠 저장소만 생성한다. 형식은 「현행」·「대체됨」 두 표이고 두 표 모두 대체 관계 열을 둔다. 켜지 않은 저장소는 번호 집합만 맞춘다 | 사용자 2026-11-05 | 「현행 대체됨도 있어야 빠르게 탐색이 가능」(사용자 원문). adr-rules 「대체와 이동」 과 맞는다 |
| DECISION5 | CI 에 남길 얇은 검사의 배포 방식 | CI 사본을 두지 않는다. 검사기는 spec·technical-design·review-fix·docs-audit 에서만 돈다. review-fix 에 이 검사 단계를 더한다 | 사용자 2026-11-05 | 「스킬 실행시 이미 규칙을 잘 지켜서 만들면 사본을 또 둬서 두 번 검사하는 꼴」(사용자 원문). 스킬 밖 수정의 깨진 링크는 다음 review-fix 나 docs-audit 가 잡는다 |
| DECISION6 | 기존 저장소 스크립트를 걷어 내는 대상과 순서 | ai-analysis 만 옮긴다. fos-accountbook, fos-assistant 는 보드 후보로 남긴다 | 사용자 2026-11-05 | 요청한 저장소에서 먼저 검증한다(권장안) |
| DECISION7 | 기존 두 검사기의 처리와 node-runtime·orch PR3 과의 순서 | orch PR3 머지 뒤, node-runtime 영역 3 전에 구현한다. node-runtime 계획의 영역 3·7 목록에서 지운 검사기를 뺀다 | 사용자 2026-11-05 | 같은 코드를 두 번 옮기지 않는다. orch PR3 와 파일이 겹치지 않는다(권장안) |
| DECISION8 | PR 단위 | PR 둘. fos-skills PR 하나, 그 머지 뒤 ai-analysis PR 하나를 orch worker 로 연다 | 사용자 2026-11-05 | 저장소마다 리뷰 하나(권장안) |
| DECISION13 | 링크 없는 ADR 번호 참조의 판정 | 위반(종료 코드 1). 후보 경로와 함께 낸다 | 사용자 2026-11-05 | CI 검사가 없어져 작성 단계가 마지막 관문이다(권장안) |
| DECISION14 | review-fix·docs-audit 의 검사 범위 | review-fix 는 저장소 전체를 검사하되 PR 이 바꾼 파일의 위반만 고치고, 나머지는 결과 보고에 「PR 밖 위반」 으로 적는다. docs-audit 는 감사 범위 전체를 리포트에 올린다 | 사용자 2026-11-05 | 이름 바뀐 ADR 을 가리키던 다른 문서의 깨진 링크를 놓치지 않으면서 리뷰 반영 PR 에 무관한 변경을 섞지 않는다(권장안) |
| DECISION15 | fos-skills 자기 ADR 색인 | 생성을 켜고 두 표로 다시 만든다. fos-skills PR 에 넣는다 | 사용자 2026-11-05 | ai-analysis 이전 전에 생성 결과를 이 저장소에서 검증한다(권장안) |
| DECISION9 | 검사기 언어 | TypeScript(Node 24, 내장 모듈만) | 작성자 | node-runtime 스펙 DECISION9 와 [ADR-010](../../adr/010-orch-typescript.md). 새 Python 을 만들면 node-runtime 이 다시 옮겨야 한다. ai-analysis CI 에 Node 24.22.1 이 있다 |
| DECISION10 | 접두 링크 글의 대체 관계 | 링크 글 안에 ADR 식별자가 있으면 대체 관계로 받는다(전체 일치가 아니라 포함) | 작성자 | `check-docs.py:58-66` 버그. 링크 대상 파일이 ADR 이면 접두와 상관없이 같은 관계다 |
| DECISION11 | 앵커 슬러그 규칙 | GitHub 규칙: 소문자, 유니코드 글자·숫자·공백·`-`·`_` 만 남기고 공백을 `-` 로, 중복은 `-1` 을 붙인다. 코드 블록 안 제목은 뺀다 | 작성자 | 두 기존 구현이 같은 규칙을 다르게 쓴다. JS `\w` 는 한글을 잡지 않아 `\p{L}\p{N}` 을 쓴다(node-runtime DECISION11 근거) |
| DECISION12 | 링크 없는 번호 참조의 예외 | 코드 블록·코드 스팬, ADR 제목 줄(`## ADR-NNN:`), 계획서 폴더(`tasks/` 등 계획서 디렉터리) 안은 보지 않는다 | 작성자 | `check-docs.py` 의 현재 예외. 계획서는 구현 뒤 지워져 링크를 강제할 이유가 없다 |
| DECISION16 | REQ1 의 「같은 결과」 범위 | 링크·앵커, 링크 없는 번호 참조, 번호 중복의 위반 줄 목록이 같다. 색인은 형식이 바뀌어(DECISION4) 비교에서 빼고 REQ3 로 본다 | 작성자 | 독립 검토 발견 1. 색인은 글자 대조라 형식이 바뀌면 항상 다르다 |
| DECISION17 | 「현행」·「대체됨」 을 나누는 기준과 열 | `status` 가 `superseded` 면 「대체됨」, 그 밖(없음 포함)은 「현행」. 일부만 대체된 `accepted` 는 「현행」 이다. 두 표의 열은 `번호 \| 결정 \| 상태 \| 대체 관계` 다 | 작성자 | adr-rules 「구조」 의 status 두 값과 「대체와 이동」(일부 대체는 옮기지 않는다). 폴더 위치로 나누면 대체 배치 「폴더 없음」 저장소에서 갈린다 |
| DECISION18 | ADR 식별자와 검사 대상 문서 | 식별자는 설정한 ADR 폴더의 파일 이름에서 읽은 형식(`ADR-NNN`, `ADR-M01`, `ADR-YYYYMMDD`)만 잡는다. 검사 대상은 git 이 추적하거나 무시하지 않는 저장소의 모든 Markdown 이다 | 작성자 | 독립 검토 발견 3. 저장소 형식 밖 패턴을 잡으면 오탐이 는다. 두 기존 fos-skills 검사기가 같은 대상(git 추적·미추적 Markdown)을 쓴다. ai-analysis 는 지금보다 범위가 넓어져 이전 PR 에서 새 위반을 함께 고친다 |
| DECISION19 | 번호 참조의 후보 경로 | 그 식별자를 가진 모든 ADR 폴더의 파일을 낸다. 참조한 문서와 같은 모듈 폴더의 파일을 맨 앞에 둔다 | 작성자 | 독립 검토 발견 4. 하나만 고르면 틀린 파일을 권할 수 있다 |
| DECISION20 | 색인 쓰기 모드를 도는 때 | ADR 을 만들거나 대체하거나 이름을 바꾼 스킬(technical-design, 승인된 수정을 한 docs-audit, ADR 을 고친 review-fix)이 쓴 뒤 검사한다. spec 은 ADR 을 쓰지 않아 검사만 한다 | 작성자 | 독립 검토 발견 6. 쓰기는 ADR 이 바뀐 때만 필요하다 |
| DECISION21 | 대체 배치 「폴더 없음」 저장소의 위치 검사 | 건너뛴다. 지금 `--flat` 과 같다 | 작성자 | 독립 검토 발견 7. 기존 오버레이 값의 뜻을 바꾸지 않는다 |
| DECISION22 | 색인 생성을 켜지 않은 저장소의 번호 집합 | ADR 폴더와 그 하위 폴더(`superseded/` 포함) 파일 이름에서 읽고 색인의 등재 번호와 맞춘다 | 작성자 | 독립 검토 발견 8. DECISION18 과 같은 출처를 쓴다. 지금 static_check 는 본문 제목을 읽어 제목 없는 ADR 을 놓친다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: 문서 검사 도구의 소유와 배포만 바꾼다. ADR 을 남기는 조건과 대체 규약은 [adr-rules.md](../../../skills/technical-design/references/adr-rules.md) 그대로다.
