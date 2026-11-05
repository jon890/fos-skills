# ADR-026: 문서 링크와 ADR 검사는 plan 번들 검사기 하나가 작성 단계에서 맡는다

- **status**: `accepted`
- **decision-type**: `engineering-process`
- **areas**: `documentation, quality`
- **현재 규칙의 원본**: [`adr-docs.ts` 머리 주석](../../skills/plan/scripts/adr-docs.ts), 인자와 부르는 법은 [plan 의 monorepo.md 「ADR 문서 검사」](../../skills/plan/references/monorepo.md#adr-문서-검사), 부르는 단계는 spec·technical-design·review-fix·docs-audit 의 `SKILL.md`
- **결정**: 깨진 링크·앵커, 링크 없는 ADR 번호, ADR 색인, 번호 중복, 대체된 ADR 위치는 plan 번들의 TypeScript 검사기 `adr-docs.ts` 하나가 판정한다.
  문서를 쓰거나 고치는 네 스킬(spec, technical-design, review-fix, docs-audit)이 이 검사기를 부르고, 색인 생성을 켠 저장소에서는 ADR 을 바꾼 스킬이 색인을 다시 만든다.
  저장소 CI 에는 같은 검사의 사본을 두지 않는다. 스킬 밖에서 고친 문서의 위반은 다음 review-fix 나 docs-audit 가 잡는다.
  사용자 결정 2026-11-05([docs-check-ownership 스펙](../features/docs-check-ownership/spec.md) DECISION1, DECISION5).
- **맥락**: 같은 규칙을 저장소 스크립트(ai-analysis `check-docs.py`), docs-audit `static_check.py`, plan 의 ADR 위치 검사기가 따로 갖고 조금씩 다르게 판정했다.
  앵커 슬러그 규칙과 검사 범위가 서로 달랐고, 저장소 생성기에는 접두가 붙은 링크 글을 대체 관계에서 빼는 버그도 있었다.
  ai-analysis CI 가 가장 자주 막은 검사가 이 넷이었다. 작성 단계에서 끝내면 그 실패가 CI 까지 가지 않는다.
- **대안 기각**:
  - 저장소 CI 에 얇은 사본을 둔다: 작성 단계에서 이미 같은 검사를 통과한 문서를 한 번 더 검사한다. 사본이 원본과 어긋나는 문제가 다시 생긴다.
  - CI 가 공개 저장소에서 검사기를 받아 돈다: 사내 self-hosted 러너가 외부 저장소에 기대게 되고, 버전 고정을 저장소마다 따로 관리해야 한다.
  - 저장소마다 검사 스크립트를 유지한다: 지금 겪는 규칙 중복과 판정 차이가 그대로 남는다.
  - 스킬마다 검사기를 둔다: 네 스킬이 같은 규칙을 네 벌로 갖는다. 스킬은 자기 폴더 밖을 import 하지 않으므로 한 번들(plan)에 두고 자식 프로세스로 부른다.
- **결과**:
  - 얻는 것: 판정 규칙의 원본이 한 파일이고, 저장소는 ADR 폴더와 색인 생성 여부만 오버레이에 적는다. 링크 없는 번호는 후보 경로와 함께 나와 작성자가 바로 고친다.
  - 감당할 것: 스킬을 거치지 않고 고친 문서의 깨진 링크는 다음 스킬 실행까지 남는다. 검사기를 바꾸면 이를 쓰는 모든 저장소의 판정이 함께 바뀐다.
- **확인 방법**: `skills/plan/tests/adr-docs.spec.ts` 가 검사 코드마다 위반과 통과 표본을 보고, `scripts/tests/adr-docs-contract.spec.ts` 가 네 스킬 문서의 호출을 본다. 이 저장소는 `node skills/plan/scripts/adr-docs.ts check --index generated` 가 0 이다.
