# Phase 01. 공용 판정을 옮기고 홈서버 오버레이와 원격 실행을 만든다

**Execution profile**: standard

## 목표

맥의 브랜치·워크트리 판정과 대화 기록 판정을 orca 를 부르지 않는 `scripts/lib/` 모듈로 옮기고, fos-home-infra 오버레이를 읽어 검사하는 `hs_overlay.ts` 와 홈서버로 스크립트를 보내 돌리는 `remote.ts` 를 만든다.

**범위 외**: 홈서버 조사 내용(phase 02), 삭제(phase 03).

## 컨텍스트

**요구사항**: REQ11, REQ12

**근거 문서**: `docs/features/machine-cleanup/design.md` 「책임과 경계」, 「홈서버 실행 방식」, 「fos-home-infra 오버레이」

- 홈서버는 Node 24(형식 제거 지원), util-linux `flock`, GNU tar, `mktemp` 가 있다(코디네이터 사전 확인 2026-11-21).
- 맥 스크립트의 옵션, 출력, 종료 코드는 바꾸지 않는다. 옮긴 함수는 원래 파일에서 다시 내보내 기존 테스트 import 를 그대로 둔다.

## 작업 항목

1. `scripts/lib/git_survey.ts`: `survey_git.ts` 의 판정과 `surveyRepo` 를 옮긴다. cwd 목록이 null 이면 워크트리 `in_use` 를 「확인하지 못함」 으로 둔다.
2. `scripts/lib/session_survey.ts`: `survey_sessions.ts` 의 ps·lsof 해석, 기록 폴더 크기, 워크트리가 사라진 기록 찾기를 옮긴다. 기록 폴더 목록은 인자로 받는다.
3. `scripts/hs_overlay.ts`: 개인 오버레이의 `fos-home-infra 오버레이: <경로>` 줄을 따라가 JSON 블록을 읽고 검사한다. 키와 형식은 머리 주석이 소유한다.
4. `scripts/remote.ts`: import 를 따라간 파일과 입력 파일을 ustar tar 로 묶어 ssh 표준 입력으로 보내고, 임시 폴더에서 돌린 뒤 지운다. `--lock` 이면 `flock -E 75 -w 300` 으로 감싼다. 255 는 접속 실패, 75 는 잠금 실패로 알린다.
5. 테스트: 가짜 `ssh`(받은 명령을 이 맥의 `sh` 로 돌림)와 가짜 `flock` 으로 왕복, 입력 파일, 잠금 실패, 접속 실패를 본다. 오버레이 없음·형식 오류의 종료 코드를 본다.
6. REQ11: 스킬 폴더(tests 제외)에 홈서버 고유 값의 꼴(`/home/<이름>/`, `/opt/`)이 없는지 보는 테스트. 실제 값 목록은 커밋하지 않는다.

## 의도 메모

- 홈서버의 `orca` 는 화면 낭독기라 홈서버 쪽 코드가 부르면 안 된다. 테스트가 `hs_*.ts` 의 import 를 따라가 `orca` 호출과 맥 전용 모듈이 없는지 본다.
