# 보드 명령 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 보드와 checkout 진입점 | board-edit.spec.ts 의 명령 실행과 --help 사례 실행 | 명령 표에 새 동작, 성공 한 줄, 거절 1, 사용법 2 | Node 24, 임시 git 저장소 | worker | 없음 | PR 전 |
| REQ8 | 임시 보드와 checkout 진입점 | board-edit.spec.ts 의 명령 실행과 --help 사례 실행 | 명령 표에 새 동작, 성공 한 줄, 거절 1, 사용법 2 | Node 24, 임시 git 저장소 | worker | 없음 | PR 전 |
| REQ2 | 주 checkout 과 워크트리, 설정·명시 보드 | board-edit.spec.ts 경로 사례 실행 | 기본은 주 checkout, --repo 는 해당 작업 트리, 상대 --board 는 주 checkout, 설정 보드만 변경 | Node 24, 임시 git 저장소 | worker | 없음 | PR 전 |
| REQ3 | details/next 단계와 decide 항목 | board-edit.spec.ts set/step 사례 실행 | 번호만 선택, 중복·누락·꼬리표 삭제 거절, 상태 자동 전환 출력, 거절 뒤 바이트 유지 | Node 24, 임시 보드 | worker | 없음 | PR 전 |
| REQ4 | details/next 단계와 decide 항목 | board-edit.spec.ts set/step 사례 실행 | 번호만 선택, 중복·누락·꼬리표 삭제 거절, 상태 자동 전환 출력, 거절 뒤 바이트 유지 | Node 24, 임시 보드 | worker | 없음 | PR 전 |
| REQ7 | details/next 단계와 decide 항목 | board-edit.spec.ts set/step 사례 실행 | 번호만 선택, 중복·누락·꼬리표 삭제 거절, 상태 자동 전환 출력, 거절 뒤 바이트 유지 | Node 24, 임시 보드 | worker | 없음 | PR 전 |
| REQ5 | 번호가 흩어진 단계, progress/stages 항목 | board-edit.spec.ts 추가·꼬리표 사례 실행 | 최대 번호 다음 추가, 중복과 done 거절, 꼬리표 교체, 경고 전달 | Node 24, 임시 보드 | worker | 없음 | PR 전 |
| REQ6 | 번호가 흩어진 단계, progress/stages 항목 | board-edit.spec.ts 추가·꼬리표 사례 실행 | 최대 번호 다음 추가, 중복과 done 거절, 꼬리표 교체, 경고 전달 | Node 24, 임시 보드 | worker | 없음 | PR 전 |
| REQ9 | 완료·미완료·참고 줄과 progress 항목 | board-edit.spec.ts show/--full 사례 실행 | 기본은 미완료 단계, full 은 모든 줄, 조회 뒤 바이트 유지 | Node 24, 임시 보드 | worker | 없음 | PR 전 |
| REQ13 | 기존 board.spec.ts | 기존 파일을 바꾸지 않고 실행 | 기존 인자·출력·종료 코드 통과, 저장 꼴 유지 | Node 24 | worker | 없음 | PR 전 |
| REQ14 | 새 문서와 요청문 | docs-contract.spec.ts, lib-commands.spec.ts, check.spec.ts, prompts.spec.ts 실행과 독립 문서 검토 | 직접 수정 금지, 새 명령 안내, mark 유지 | checkout | worker | 없음 | PR 전 |

REQ9 의 BOARD-UNMATCHED 추가 줄은 PR4 에서 검증한다. 전체 테스트와 타입 검사는 push 뒤 CI Tests 로 확인한다.
