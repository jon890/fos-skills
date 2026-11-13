# 상주 루프 자동 재시작 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 설정 폴더의 캐시 사본 두 벌(1.0.0, 2.0.0), 1.0.0 으로 띄운 부모, 마무리 대역 pid 파일 | `node scripts/run-tests.ts skills/orch/tests/orch-loop-self-update.spec.ts` 의 「기다림」 사례 | 설치 기록을 바꾼 다음 틱 뒤 loop.log 에 `LOOP-STALE 1.0.0 2.0.0 <경로>` 한 줄, 기다리는 틱들에 `LOOP-STALE`·`STALE-BUNDLE` 이 더 없음 | 로컬 node, 임시 폴더, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ2 | 위와 같고 Run 두 개 등록 | 같은 파일의 「넘기기」 사례 | `orch-loop --status` 가 `bundle=2.0.0`, 등록 목록이 넘기기 전과 같음, `--foreground` 루프 프로세스 하나, 넘기는 동안 `loopStatus` 가 한 번도 죽음이 아님, 다음 틱 출력에 `STALE-BUNDLE` 없음 | 로컬 node, 임시 폴더, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ3 | 마무리 대역 프로세스, `--repo` 가 다른 저장소인 머지 큐 줄을 내는 가짜 `PS` | 같은 파일의 「기다림」·「설정 오류」 사례와 `skills/orch/tests/loop-self-update.spec.ts` 의 `decide`·`busyReason` 사례 | 마무리가 사는 동안 넘기지 않고 끝난 다음 틱 뒤 넘김, 60분 지남과 종료 코드 2 에서는 기다리지 않음, 다른 저장소의 큐는 세지 않음, 마무리 대역은 신호를 받지 않음 | 로컬 node, 임시 폴더, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ4 | 「넘기기」 사례와 같음 | 가짜 orca CLI 의 전송 기록을 읽는다. 같은 버전 문구는 `loop-self-update.spec.ts` 의 `updatedText` 사례 | `LOOP-UPDATED` 가 Run 마다 하나, 본문에 저장소 폴더 이름과 `1.0.0 → 2.0.0`, 같은 버전이면 두 경로 | 로컬 node, 임시 폴더, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ5 | 2.0.0 사본의 진입점이 곧바로 1 로 끝남 | `orch-loop-self-update.spec.ts` 의 「실패 되돌리기」 사례 | 옛 루프가 계속 틱을 돌고 잠금이 옛 pid, `LOOP-UPDATE-FAIL` 이 Run 마다 하나, 이후 세 틱 동안 다시 시도하지 않음 | 로컬 node, 임시 폴더, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ6 | 부모가 돈 뒤 설정 파일을 모르는 절이 든 내용으로 바꿈 | `node scripts/run-tests.ts skills/orch/tests/loop-tick-failure.spec.ts skills/orch/tests/notice-digest.spec.ts` | 3번째 실패 틱에 원인 줄이 든 `WATCH-ERROR` 바로 알림 하나, 4·5번째는 없음, 성공 뒤 다시 세 번이면 하나 더, 단계 출처도 3번째에 참 | 로컬 node, 임시 폴더, 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ7 | 체크아웃에서 띄운 루프, 키 없는 `loop.json` | `node scripts/run-tests.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/orch-status.spec.ts` | `LOOP-ALIVE … alive_at=… bundle=<plugin.json 버전>`, `orch status` 도 끝에 `bundle=`, 키 없으면 `bundle=-`, 앞 칸 그대로 | 로컬 node, 임시 폴더 | worker | 없음 | PR 전 |
| REQ8 | phase 05 의 문서 | `waiting.md`, `SKILL.md`, 변경 조각을 읽고 korean-check 를 돌린다 | 다시 뜨는 조건, `LOOP-UPDATED`·`LOOP-UPDATE-FAIL`, 「이 버전 전에 띄운 루프는 한 번 `orch loop stop` 뒤 `orch loop start` 로 다시 띄운다」 문장이 있음 | 저장소 체크아웃 | worker | 없음 | PR 전 |
| REQ2 | 이 기능이 든 버전이 배포되고, 그다음 버전이 나옴 | 실제 저장소 루프 하나를 이 기능이 든 버전으로 수동 재시작한 뒤, 다음 플러그인 갱신 후 `orch loop status` 와 Run 메시지를 본다 | 갱신 뒤 사람 손 없이 `bundle=` 가 새 버전이 되고 `LOOP-UPDATED` 한 줄이 옴 | 실제 플러그인 설치와 코디네이터 세션 | 코디네이터 | 머지 뒤 이 기능이 든 버전과 그다음 버전의 배포 | PR 뒤 |
