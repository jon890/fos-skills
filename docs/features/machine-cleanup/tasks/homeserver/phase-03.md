# Phase 03. 홈서버 삭제와 SKILL.md 절차

**Execution profile**: standard

## 목표

승인한 묶음만 지우는 `hs_delete.ts`(이미지, 백업 용도, 워크트리, 휴지통, Hermes 세션)를 만들고, SKILL.md 「머신 고르기」 가 홈서버 절차 `references/homeserver.md` 로 가게 한다.

**범위 외**: fos-home-infra 오버레이 파일(PR3), 실제 홈서버 정리(REQ14).

## 컨텍스트

**요구사항**: REQ3, REQ7, REQ10

**근거 문서**: 스펙 REQ3, REQ7, REQ12, 설계 「홈서버 실행 방식」, 「Hermes 세션 판정」, 결정 DECISION5

## 작업 항목

1. `scripts/hs_delete.ts`: 하위 명령마다 dry-run 이 기본이고 `--apply` 에서만 지운다. 지우기 직전에 다시 확인한다(이미지를 쓰는 컨테이너, 워크트리 안의 프로세스와 미커밋 변경, Hermes 트리의 연결과 최근 활동). `docker image prune -a`, `docker system prune -a` 는 쓰지 않는다.
2. Hermes 삭제 뒤 연결된 세션이 모두 남았는지 확인해 낸다.
3. `references/homeserver.md`: 홈서버의 1~5단계 명령, 실패 처리(오버레이 없음, 접속 실패, 조사 실패면 홈서버는 지우지 않음), sudo 넘기기, 보고 꼴.
4. SKILL.md: 「머신 고르기」 의 「아직 지원하지 않는다」 를 홈서버 절차로 바꾸고, 설명(description)에 홈서버 낱말을 넣는다. README, 변경 이력 조각.
5. `tests/skill-doc.spec.ts` 와 문서 테스트: 표에 없는 용도의 두 질문, 실패 처리, 머신별 분리.
