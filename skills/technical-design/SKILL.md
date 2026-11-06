---
name: technical-design
description: |
  확인한 기능 스펙을 실제 코드와 대조해 모듈 책임, 데이터 소유권, 상호작용과 검증 전략을 설계한다.
  "기술 설계", "아키텍처 설계", "모듈 경계", "스펙을 어떻게 구현할지 설계" 요청이나 spec 다음 단계에 쓴다.
  사용자 동작은 spec, PR 작업 분해는 plan, 구현은 implementation 이 맡는다.
metadata:
  version: "1.6.1"
---

# technical-design

**목표: 요구사항을 구현할 구조와 책임을 정해, plan 이 중요한 기술 결정을 추측하지 않게 한다.**

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 경로 읽기 | 요구사항 ID 마다 호출·데이터 변경 경로를 읽었고, 기존 경계를 재사용할지 바꿀지 적었다 | [`ownership-boundaries.md`](references/ownership-boundaries.md) |
| 2 | 설계 | 책임·경계, 인터페이스·데이터, 실패·일관성, 검증 전략, 도메인 규칙 각각에 설계나 「해당 없음과 이유」 가 있다 | |
| 3 | 원칙 대조 | 기존 원칙·공유 계약·ADR 과 대조한 결과와 선택 이유가 설계에 있다 | |
| 4 | 결정 분류 | 사용자가 정할 결정은 spec 으로 반환했거나 확인받았고, 나머지는 근거가 적혀 있다 | |
| 5 | 설계 문서 | `design.md` 또는 스펙의 `## 기술 설계` 절이 양식의 필수 절을 채웠다 | [`templates/design.md`](templates/design.md) |
| 6 | 독립 검토와 검사 | 검토자의 발견이 모두 해결됐고 아래 검사 명령의 종료 코드가 모두 0 이다. 검토자를 실행하지 못했으면 「독립 검토 미완료」 가 인계에 적혀 있다 | [`team-spawn.md`](../implementation/references/team-spawn.md) |

[기능 문서와 단계 인계](../spec/references/feature-docs.md)를 읽는다.
[설정 탐색](../plan/references/monorepo.md)으로 `.claude/technical-design-overlay.md` 와 저장소 지침을 읽는다.
입력은 사용자가 확인한 스펙, 관련 코드와 기존 공유 계약·ADR 이다.

작성 전에 [설계 양식](templates/design.md)을 읽는다. ADR 을 남기거나 대체할 때는 [ADR 규칙](references/adr-rules.md)(남길 조건, 대체와 이동 규약)과 [ADR 양식](templates/adr.md)을 읽는다.
[결정 기록 샘플](references/adr-examples.md)로 종류와 원본 연결을 확인한다. 정책 결정이 열려 있으면 spec 으로 반환하고, 분류를 이유로 ADR 을 늘리지 않는다.
시스템 공통 흐름 문서가 실제로 필요할 때는 [flow 기본 양식](templates/system-flow.md), 결과를 쓰는 쪽과의 계약은 [출력 계약 양식](templates/output-contract.md)을 참고한다. 기존 저장소 양식이 우선이다.
[문서 소유권](../spec/references/document-ownership.md)으로 이번 기능이 바꾸는 책임 문서만 식별한다. 영향 없는 전역 문서는 수정하지 않는다.

## 절차

번호는 위 개요 표의 단계와 같다.

1. 스펙의 REQ1 같은 요구사항과 실제 호출·데이터 변경 경로를 읽는다. 기존 경계를 재사용할지 바꿀지 정한다.
   새 업무 영역이면 [소유 경계 검토](references/ownership-boundaries.md)의 분리 신호를 대조하고, 신호가 있으면 ADR 초안·독립 검토 뒤 사용자에게 선택을 확인받는다.
2. 아래 항목을 이번 기능에 필요한 깊이로 설계한다. 해당하지 않으면 이유를 적는다.
   - 책임과 경계: 소유 모듈, 데이터 변경 주체, 의존 방향. 새 서비스를 만드는 것이 기본값은 아니다.
   - 인터페이스와 데이터: 호출·이벤트, 상태 전이, 원본 스키마 링크. 외부 동작의 의미는 스펙을 참조한다.
   - 실패와 일관성: 필요한 트랜잭션·경쟁·재시도·부분 실패·호환과 배포 순서.
   - 검증 전략: 요구사항을 어느 경계와 환경에서 검증할지. 코드의 테스트 명령과 작업 순서는 plan 이 정한다.
   - 도메인 규칙: 스펙이 바꾼 규칙마다 적용 자리(코드, 프롬프트, 설정, 출력 계약)와 값의 원본. 변경이 없으면 쓰지 않는다. 원본은 [문서 소유권의 「단계별 책임」](../spec/references/document-ownership.md#단계별-책임)이다.
3. 기존 원칙·공유 계약·ADR 과 대조하고 선택 이유를 남긴다. 다른 기능과 합의해야 할 경계는 문서 공통화까지 미루지 않는다.
   불확실한 핵심은 범위를 정한 작은 실험으로 확인한다. 제품 코드를 실험으로 몰래 구현하지 않는다.
4. 사용자 동작·권한·보존·호환·운영 비용을 바꿀 결정은 spec 으로 반환한다. 기존 관례를 따르는 내부 선택은 작성자가 근거를 남긴다.
   되돌리기 어려운 구조 변경은 대안과 영향을 보이고 사용자에게 확인받는다. 모든 내부 배치에 승인을 요구하지 않는다.
5. 기본은 기능 폴더의 `design.md` 다. 작은 변경은 spec 의 `## 기술 설계` 절에 같은 내용을 짧게 쓴다.
   [설계 템플릿](../spec/references/feature-docs.md#기술-설계-템플릿)을 따른다. 전체 시스템을 다시 설계하거나 클래스 전체를 열거하지 않는다.
6. [위임 계약](../implementation/references/team-spawn.md)으로 대화를 모르는 검토자에게 스펙·설계·관련 코드만 준다.
   요구사항의 해결 경로, 소유권, 경계 간 모순, 기존 원칙 위반을 찾게 한다. 발견을 해결한 뒤 구조 검사를 실행한다.

```bash
# cwd: 대상 저장소 루트. PLAN_SKILL_DIR 은 형제 plan 번들이다.
node "$PLAN_SKILL_DIR/scripts/check_feature.ts" "$SPEC" --design "$DESIGN"
node "$PLAN_SKILL_DIR/scripts/run_doc_checks.ts" --skill technical-design "$SPEC" "$DESIGN"
node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" write-index $ADR_DIRS     # ADR 을 만들거나 대체했고 색인 생성을 켠 저장소만
node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" check --changed-since "$BASE" $ADR_ARGS
```

`run_doc_checks.ts` 는 레포 설정의 「문서 검사 명령」 을 돌린다. technical-design 오버레이에 없으면 spec 오버레이의 값을 쓰고, 둘 다 없으면 건너뛴다.
`adr-docs.ts` 는 깨진 링크·앵커, 링크 없는 ADR 번호, ADR 색인과 위치를 본다. 인자를 만드는 법은 [plan 의 monorepo.md 「ADR 문서 검사」](../plan/references/monorepo.md#adr-문서-검사)가 소유한다. `PR 밖 위반:` 아래 줄은 고치지 않는다.
검사 명령의 종료 코드가 모두 0 이어야 plan 으로 넘긴다. 검사는 형식과 요구사항 연결만 확인한다. 아키텍처의 적절성이나 독립 검토를 대신하지 않는다.
검토자를 실행할 수 없으면 설계 작성은 끝내되 독립 검토는 미완료로 인계한다. 독립 검토를 자기 점검으로 통과 처리하지 않는다.

## 인계와 완료 기준

요구사항별 해결 방법, 책임·데이터 소유권·상호작용과 필요한 실패 처리·검증 전략이 정해져야 한다.
기존 계약과 충돌하거나 주요 기술 결정이 열려 있으면 plan 으로 넘기지 않는다.
회신: `완료: 기술 설계 | 미완료: 이유`, 스펙/설계 경로, 결정과 근거, 검사·독립 검토 결과, 남은 항목을 orch 에 넘긴다.
같은 기능의 후속 PR 은 기존 설계를 재사용한다. 영향받는 결정만 수정하고 해당 검토를 다시 받는다.
