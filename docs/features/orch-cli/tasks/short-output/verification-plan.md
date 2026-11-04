# 짧은 출력과 orch status 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ4 | 이 체크아웃(`ORCH_SCRIPTS_DIR=skills/orch/scripts`), 임시 저장소 | `orch loop status`, `orch doctor --skip-version`, `orch spec lint`, `orch queue ready <PR> --dry-run`(가짜 gh) 을 기본과 `--full` 로 돌리고 줄을 비교 | 기본 출력의 모든 줄이 대문자 판정 낱말로 시작하거나(doctor 는 들여 쓴 고칠 줄 포함) 데이터 줄이다. `--full` 출력이 같은 입력의 직접 실행 출력과 같다 | 로컬 셸, node 24 | 없음 | PR 전 |
| REQ4 | 같다 | `orch wait --ack <id> …` 가 낸 `NEXT_WAIT` 를 확인 | PR1 꼴 그대로(`orch wait --ack <id> --loop-repo <저장소>`) | 테스트(`wait-important.spec.ts`) | 없음 | PR 전 |
| REQ4 | 가짜 gh 와 가짜 머지 큐, 가짜 정리(`merge-with-finish.spec.ts`, `merge-queue.spec.ts`) | 짧은 출력의 `orch queue merge` 가 띄운 마무리 로그(`finish-<PR>.out`)와, 상주 루프처럼 경로로 부른 `merge-with-finish` 의 출력을 본다 | 경로로 부른 자식과 마무리 로그는 지금 출력 그대로(스펙 DECISION16)이고 stdio 를 이어 받는 자식(머지 큐, 정리)만 짧은 출력이다 | 테스트 | 없음 | PR 전 |
| REQ5 | 가짜 번들(`orch-entry.spec.ts`) | 옛 꼴 `orch.ts <옛 이름>` 과 새 꼴을 같은 입력으로 부른다 | 둘 다 짧은 출력 신호를 받고 stdout 과 종료 코드가 같다. 옛 꼴 stderr 에 새 꼴 안내가 한 줄 있다. `--full` 이면 둘 다 신호가 없다 | 테스트 | 없음 | PR 전 |
| REQ11 | 가짜 orca 의 처리할 묶음(worker_done, 근거 없는 worker_done, escalation, question, heartbeat) | 짧은 출력의 대기를 돌리고 `RAW` 파일을 `orch wait triage` 로 읽는다 | 메시지 줄 차례가 `DONE-SUSPECT`, `DONE`, `ESCALATION`, `QUESTION` 이고 마지막 두 줄이 `RAW …`, `LAST_DELIVERY …`. triage 의 짧은 메시지 줄이 대기의 메시지 줄과 같다 | 테스트(`wait-important.spec.ts`) | 없음 | PR 전 |
| REQ10 | 임시 저장소의 루프 기록, 등록 Run 둘, 보드, 가짜 orca worker-list | `orch status` 와 `orch status --run <id>` | 한 번의 호출로 `LOOP-ALIVE`, Run 마다 `RUN … workers=… stalled=…`, `BOARD doing=… decide=…`, 멈춘 worker 의 `STALLED` 가 나오고 파일이 바뀌지 않는다. `--run` 이면 그 Run 만 | 테스트(`orch-status.spec.ts`) | 없음 | PR 전 |
| REQ10 | 이 머신의 실제 저장소(`/Users/nhn/personal/fos-skills`) | `ORCH_SCRIPTS_DIR=<체크아웃>/skills/orch/scripts node skills/orch/bin/orch.ts status`(스크립트 `orch-status.ts`) | 실제 루프와 보드의 판정 줄이 나오고 종료 코드 0 또는 1(조회 실패만) | 로컬 셸 | 없음 | PR 전 |

전체 회귀는 `node scripts/run-node-tests.ts` 와 `python3 -m unittest discover -s scripts/tests` 다.
