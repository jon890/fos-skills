# 문서마다 담을 것과 가독성 검사

원본과 맞춘 뒤에도 문서가 읽히지 않으면 고친 것이 아니다. 4단계에서 이 문서로 본다.
원본과의 대조는 [`sources.md`](sources.md) 가, 한국어 표현은 korean-check 가 소유한다.

## 문서마다 담을 것

| 문서 | 독자 | 담는 것 | 담지 않는 것과 옮길 곳 |
| --- | --- | --- | --- |
| 루트 `README.md` | 이 저장소를 처음 보는 사람 | 한 줄 소개, 흐름 그림과 단계 한 줄씩, 스킬 표(이름과 언제 쓰나), 설치·갱신 명령, 대화 예시 하나, 보드 화면 한 장, 기여 3~4줄 | 단계별 기준과 문서 배치는 `docs/flow.md`, 테스트 옵션·저장소 구조·버전 규칙은 `docs/contributing.md`, 스킬 사용법은 스킬 README |
| `docs/contributing.md` | 이 저장소를 고치는 사람 | 테스트 명령과 옵션, 저장소 구조, 공용 도구, 스킬을 더할 때 고칠 곳, 스킬 README 규칙, 버전과 변경 이력 | 스킬을 쓰는 법 |
| `docs/flow.md` | 흐름을 자세히 보려는 사람 | 단계마다 넘어가는 기준, 설치·갱신·고치는 동안의 확인, orch 이벤트 | 파일 배치는 `docs/code-architecture.md` |
| 스킬 README, 보드 README | 그 스킬을 처음 쓰는 사람 | `docs/contributing.md` 「스킬 README」 의 절 | 판정 규칙, 조회 한도, 저장 형식은 그 스킬의 `references/` |

README 의 절 뼈대는 사용자가 정했다(2026-11-20). `check-drift.ts` 의 `checkReadmeOutline` 이 절 이름, 순서, `###` 하위 절을 자동으로 본다.
뼈대를 바꿔야 할 것 같으면 고치지 않고 PR 본문 「따로 볼 것」 에 적는다.

## 고치는 규칙

- **새 사실은 README 에 절을 더하지 않고 위 표의 「옮길 곳」 에 둔다.** README 에는 링크 한 줄만 둔다. README 가 다시 길어지면 처음 보는 사람이 핵심을 찾지 못한다.
- **한 문단에 한 가지만 담는다.** 명령 옵션, 도구 버전, 동시 수처럼 세부가 셋 이상 한 문단에 모이면 표나 목록으로 나눈다. 2026-11-20 에 README 「기여」 가 테스트 옵션과 CI 버전을 한 문단에 담아 「테스트를 어떻게 돌리나」 가 보이지 않았다.
- **옮길 때 지우지 않는다.** 옮긴 뒤 그 절을 가리키던 곳을 고친다. 아래 명령이 찾는다.

```bash
# cwd: 저장소 루트. TITLE 은 옮긴 절 제목이다
TITLE="버전과 변경 이력"
git grep -nE "README( 의)? [「\"]$TITLE" -- ':!docs/features'
```

`docs/features/` 는 그때의 기록이라 고치지 않는다. 팀으로 내보내는 스킬의 문서는 팀 저장소에서도 뜻이 통하게 `fos-skills 저장소 docs/contributing.md` 처럼 저장소 이름을 붙인다.

## 검사

고친 Markdown 파일마다 돈다.

```bash
# cwd: 저장소 루트. DOC 은 고친 파일이다
DOC="README.md"
node export-only-skills/korean-check/scripts/check-readability.ts "$DOC"
node export-only-skills/korean-check/scripts/check.ts "$DOC"
```

- `check-readability.ts` 는 TILDE 에서만 1 로 끝난다. 나머지 경고(NEST, SECT, DASH)도 고친다.
- 스크립트가 못 보는 분량과 나누는 방식은 korean-check 의 `references/writing-structure.md` 「분량 구간」, 「긴 문서에서 나누는 방식」, 「내용 점검」 으로 판정한다. 이 저장소의 설명 문서는 훑어 찾는 글이라 「긴 문서」 다.
