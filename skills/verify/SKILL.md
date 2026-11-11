---
name: verify
description: |
  구현한 기능을 스펙·코드·문서와 실제 실행 결과로 독립 검증한다. "기능 검증", "인수 검증", "구현 확인", "verify" 요청이나 orch 의 구현 다음 단계에 쓴다. 구현 수정은 implementation 로 돌려보낸다.
metadata:
  version: "1.6.1"
---

# verify

**목표: 이번 PR 이 맡은 요구사항을 실제로 만족하는지 판정한다.**

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 입력 확인 | 입력 커밋과 실제 HEAD 가 같고 미커밋 변경이 없다. 이번 PR 의 `requirements` 를 적었다 | |
| 2 | 검증 계획 대조 | index 의 verification_plan 이 스펙·설계·이번 PR 범위와 대조됐고 누락 사례는 보완됐다 | [`verification-plan.md`](../plan/templates/verification-plan.md) |
| 3 | 독립 검토 | 구현자가 아닌 검토자의 코드·문서 검토 결과가 있다(코드 리뷰를 PR 자동 리뷰에 맡겼으면 그렇게 적었다) | [`role-code-reviewer.md`](../implementation/references/role-code-reviewer.md), [`role-docs-verifier.md`](../implementation/references/role-docs-verifier.md) |
| 4 | 실행 검증 | 요구사항마다 정한 경계에서 테스트 방법을 실행했다 | |
| 5 | 증거 기록 | 요구사항별로 기대값, 실제값, 명령·환경·검증 커밋이 기록됐다 | [`verification-result.md`](templates/verification-result.md) |
| 6 | 반환 판정 | 완료를 막는 결함마다 돌려보낼 단계가 정해졌다 | |
| 7 | 회신 | 첫 줄이 `완료:` 나 `미완료:` 이고 양식의 증거를 orch 에 넘겼다 | |

[기능 문서와 단계 인계](../spec/references/feature-docs.md)를 읽는다.
입력은 스펙, 기술 설계, plan, 인수 검증 계획, 작업 공간, 기준 브랜치, 검증할 커밋, 개발 검증 결과와 원격 검증 목록이다.
`.claude/verify-overlay.md`, 없으면 `.claude/implementation-overlay.md` 와 저장소 지침에서 검증 환경·명령을 읽는다. 옛 이름 오버레이의 읽기 호환은 [레포 설정 탐색](../plan/references/monorepo.md)이 소유한다.

작성 전에 [검증 결과 양식](templates/verification-result.md)을 읽는다. 인수 검증 계획의 표 형식은 [plan 의 양식](../plan/templates/verification-plan.md)이 소유한다.
계획과 결과의 수명은 [계획 수명 규칙](../plan/references/plan-lifecycle.md)을 따른다.

## 절차

번호는 위 개요 표의 단계와 같다.

1. 입력 커밋과 실제 HEAD, 미커밋 변경을 확인한다. 스펙·인수 조건·관련 공유 계약과 누적 diff 를 읽는다.
   plan 의 `requirements` 가 이번 PR 의 범위다. 스펙 전체 완료와 부분 PR 통과를 구분한다.
2. index 의 verification_plan 을 읽고 스펙·설계·이번 PR 범위와 대조한다.
   필수 사례 누락·개발 테스트만으로 관측하지 못하는 효과·실행 환경·선행 조건을 확인한다.
   기존 요구사항을 확인하는 누락 사례는 검증 계획에 보완하고 영향받는 계획 검토를 갱신한다. 기대 동작이 불분명하면 spec/technical-design 으로 반환한다.
   구현자의 검증 목록을 그대로 통과 기준으로 삼지 않는다. 기존 계획에 표가 없으면 구현 전에 받은 인수 조건에서 같은 형식의 검증 계획을 먼저 복원한다.
3. [위임 계약](../implementation/references/team-spawn.md)에 따라 구현자가 아닌 검토자에게
   [코드 검토](../implementation/references/role-code-reviewer.md)와 [문서 정합성](../implementation/references/role-docs-verifier.md)을 맡긴다.
   스펙·설계와 plan 을 함께 넘기고 구현자의 정당화나 예상 판정은 주지 않는다.
   **오버레이가 코드 리뷰를 PR 자동 리뷰에 맡긴다고 정하면**(예: `코드 리뷰: PR 자동 리뷰` 한 줄) 코드 검토자를 띄우지 않고 문서 정합성만 맡긴다. 같은 diff 를 두 번 리뷰하지 않으려는 것이다.
   이때 코드 리뷰 결과는 PR 자동 리뷰의 판정이 대신하고, verify 보고의 「코드·문서 검토」 에 「코드: PR 자동 리뷰에 맡김」 으로 적는다.
   실행 인수 검증과 문서 검토를 마치면 `완료: PR 전 인수 검증 | 독립 코드 리뷰 대기` 로 docs-consolidate 에 넘길 수 있다.
   자동 리뷰 정책 없이 독립 검토를 실행할 수 없으면 미완료로 보고한다. 같은 에이전트의 자기 점검은 독립 리뷰가 아니다.
4. 요구사항별 테스트 방법을 실행한다. 공개 API·저장 상태·외부 효과를 확인하고, UI 는 실제 브라우저 흐름을 확인한다.
   CLI·작업·웹훅이면 해당 경계에서 실행한다. 모든 검증을 브라우저로 대체하지 않는다.
   저장소의 필수 통합 검증과 plan 의 `PR 전` 원격 검증도 수행한다.
5. 기대값과 실제값, 명령·환경·검증 커밋을 요구사항별로 기록한다. 테스트 개수나 리뷰어의 PASS 만으로 인수 조건을 대신하지 않는다.
   도메인 규칙 변경이 있으면 문서, 코드와 지시문, 평가 사례가 같은 규칙을 따르는지 규칙 ID 별로 일치 여부와 실행 근거를 남긴다([문서 소유권의 「단계별 책임」](../spec/references/document-ownership.md#단계별-책임)).
   변경한 ADR 이 있으면 [결정 기록의 단계별 책임](../spec/references/document-ownership.md#결정-기록의-단계별-책임)에 따라 종류·현재 원본·구현의 의미와 대체 관계를 확인한다. 타입이 없는 기존 ADR 을 오류로 만들지 않는다.
6. 완료를 막는 구현 결함은 implementation 으로, 구조·경계 결함은 technical-design 으로, 계획 결함은 plan 으로, 사용자 의도·결정 누락은 spec 으로 돌려보낸다.
   verify 는 코드를 수정하지 않는다. 수정 뒤 영향받는 검증을 다시 실행하고 새 커밋으로 결과를 갱신한다.
7. 회신 첫 줄에 `완료: 이번 PR 인수 검증` 또는 `미완료: 이유와 돌아갈 단계` 를 쓰고 양식의 증거를 orch 에 넘긴다. PR 전 인수 검증·문서 검토가 통과하면 docs-consolidate 의 후보 추출로 간다.

결과는 PR 본문 또는 PR 별 증거 파일에 보존한다. 계획 링크만 남기지 않는다.

## 완료 기준

이번 PR 의 필수 인수 조건에 증거가 있고, 완료를 막는 코드·문서 결함이 없으며 필수 미검증이 없다.
환경이 없어 실행하지 못한 조건은 통과가 아니다. 선행 조건이 머지·배포인 검증은 남은 항목으로 orch 에 넘긴다.
그 항목이 남아도 PR 사전 검증은 통과할 수 있지만 기능 전체 완료는 선언하지 않는다.
보안·데이터 손실·잘못된 결과처럼 완료를 막는 코드 발견은 기존 리뷰 계약의 PASS 여부와 별개로 미완료다.
사소한 범위 밖 개선은 후속으로 남기고 이번 기능의 범위를 넓히지 않는다.

검증 뒤 코드나 계약이 바뀌면 기존 결과로 머지하지 않는다. orch 가 영향받는 검증을 다시 요청한다.

PR 자동 리뷰 대기는 PR 생성까지만 허용한다. 대기 중인 리뷰는 최종 인수 완료가 아니며, 완료 근거에 실제 리뷰 결과와 현재 커밋을 기록하기 전에는 머지하지 않는다. 완료 근거의 양식은 `orch` 스킬이 설치돼 있으면 그 `templates/feature-evidence.md` 가 소유한다.
