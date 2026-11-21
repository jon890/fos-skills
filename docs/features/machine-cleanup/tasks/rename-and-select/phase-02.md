# Phase 02. 개인 오버레이 자리 고르기와 머신 고르기

**Execution profile**: standard

## 목표

개인 오버레이를 새 자리 먼저, 없으면 옛 두 자리 순서로 고르는 `scripts/overlay_path.ts` 를 더하고, SKILL.md 에 단계 앞 절 「머신 고르기」 를 둔다. 홈서버를 고르면 PR2 에서 지원한다고 알리고 맥만 돈다.

**범위 외**: 홈서버 조사·정리 코드(PR2).

## 컨텍스트

**요구사항**: REQ2, REQ3

**근거 문서**: `docs/features/machine-cleanup/spec.md` REQ2·REQ3·DECISION10·DECISION17·DECISION21, `docs/features/machine-cleanup/design.md` 「머신 고르기」, 「인터페이스와 데이터」, 결정 DECISION1·DECISION2

- 지금 SKILL.md 「개인 오버레이」 절은 두 자리(`~/.claude/overlays/mac-cleanup.md`, `~/.claude/mac-cleanup-overlay.md`)를 문장으로 읽는다.
- 명령 경계 테스트는 `tests/helpers.ts` 의 `Sandbox`(임시 홈)와 `command()` 를 쓴다.

## 작업 항목

1. `scripts/overlay_path.ts`: 설계 「인터페이스와 데이터」 대로. 머리 주석에 사용법, 찾는 순서, 종료 코드.
2. `tests/overlay-path.spec.ts`: 세 자리 각각만 있을 때, 새 자리와 옛 자리가 함께 있을 때, 아무것도 없을 때, 인자를 줬을 때.
3. SKILL.md 「개인 오버레이」: 스크립트를 부르고, 경로가 나오면 그 파일을 읽는다. 「옛 자리는 다음 major 에서 읽기를 끝낸다」 문장을 지운다(스펙 REQ2 가 옛 자리를 계속 읽는다고 정했다).
4. SKILL.md 「머신 고르기」 절: 판정 순서, 「둘 다」 면 머신마다 1~5단계와 승인 질문, 전후 표를 따로 두는 것, 지금은 홈서버를 PR2 에서 지원하므로 조사하지 않고 보고에 그 줄을 남기는 것.
5. `tests/skill-doc.spec.ts`: 「머신 고르기」 절의 판정 낱말, 「둘 다」 분리, 홈서버 막기 문장과, 「개인 오버레이」 절이 `overlay_path.ts` 를 부르는지 본다.
6. README 「준비」 의 오버레이 자리와 스킬 설명을 새 이름과 순서에 맞춘다.

## 의도 메모

- 오버레이 고르기를 스크립트로 둔 이유는 설계 DECISION2 다.
- 홈서버 판정 낱말은 스펙 DECISION17 의 목록 그대로 쓴다.
