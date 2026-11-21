# Phase 02. 홈서버 조사와 등급 매기기

**Execution profile**: standard

## 목표

홈서버에서 도는 `hs_survey.ts` 가 디스크 후보, 메모리·스왑, git 저장소, 대화 기록, Hermes 세션을 JSON 으로 내고, 이 맥의 `hs_classify.ts` 가 그 JSON 과 오버레이 값으로 등급, 원인 판정, 승인 묶음 후보, 제안을 낸다.

**범위 외**: 삭제(phase 03).

## 컨텍스트

**요구사항**: REQ5, REQ6, REQ8, REQ9, REQ10

**근거 문서**: 스펙 REQ5~REQ10, 설계 「등급 매기기」, 「홈서버 워크트리 사용 확인」, 「Hermes 세션 판정」, fos-home-infra `homeserver-cleanup` 의 조사 스크립트와 정리 대상 규칙

- Hermes 세션은 profile 마다 SQLite `sessions` 테이블(id, source, parent_session_id, started_at, ended_at, last_activity_at)에 있다. 호스트 사용자가 읽을 수 있어 `node:sqlite` 읽기 전용으로 연다.
- `/proc/<pid>/cwd` 는 다른 사용자 프로세스면 권한 거부다. 같은 uid 만 본다.

## 작업 항목

1. `scripts/hs_survey.ts`: 조사 JSON 을 표준 출력에 낸다. 아무것도 지우지 않는다. 운영 checkout 의 fetch 만 `flock -E 75 -w 300` 으로 감싸고 75 면 그 저장소만 「fetch 하지 못함」 으로 둔다. `/proc` 자리는 테스트용 환경 변수로 바꿀 수 있다.
2. 이미지 이름 풀기, 설정이 가리키는 이미지, 백업 보관 규칙 읽기를 `homeserver-cleanup` 에서 옮기고 그 테스트 사례를 옮긴다.
3. `scripts/hs_classify.ts`: 등급(유지, 안전, 확인 필요), 유지인데 규칙보다 많이 남은 것의 원인 판정, 표에 없는 백업 용도, sudo 대상의 사용자 터미널 명령, 메모리 제안, 조사만 하는 저장소 표시, Hermes 후보(트리 단위, 연결이나 30일 안 활동이 있으면 트리 전체를 뺌)를 낸다. 브랜치 삭제와 대화 기록 삭제 입력 파일을 맥 스크립트 형식으로 쓴다.
4. `references/homeserver-targets.md`: 등급 규칙. 경로와 이미지 이름 같은 값은 두지 않는다.

## 의도 메모

- 등급 매기기를 이 맥에서 하는 이유는 설계 DECISION6 이다.
