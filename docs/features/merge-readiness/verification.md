# 머지 판단 하나로 모으기 검증 기록

- 상태: 스펙의 REQ1부터 REQ6까지와 DECISION1부터 DECISION15까지의 인수 조건이 모두 통과했다. 스펙과 어긋나 고쳐야 할 결함은 찾지 못했다. 판단이 필요한 관찰 1건과 문서가 지금 동작과 어긋난 곳 4건은 아래 「남은 것」 에 있다.
- 원본: [스펙](spec.md), [기술 설계](technical-design.md), [ADR-037](../../adr/037-orch-merge-readiness.md), 구현 PR 일곱 개(#632, #636, #640, #643, #646, #647, #651).
- 검증 커밋: main `66dfa4d7`(플러그인 20.9.0). 구현 PR 일곱 개가 모두 들어간 상태다.
- 환경: macOS, node 24.22.1. gh, git, orca 는 테스트 fixture 의 가짜 실행 파일이고 저장소는 임시 폴더다. 이 저장소의 열린 PR 과 실제 머지 큐는 건드리지 않았다. 설치본 orch 가 20.7.0 이라 `orch` 를 직접 돌린 사례는 `ORCH_SCRIPTS_DIR` 로 이 checkout 의 scripts 를 가리켰다.

## 실행한 검증

| 구분 | 명령 | 결과 |
| --- | --- | --- |
| 관련 테스트 | `node scripts/run-tests.ts` 에 `core-merge-readiness`, `lib-merge-readiness`, `core-checks`, `queue-gate`, `queue-gate-integration`, `merge-queue`, `orch-loop-auto-merge`, `lib-auto-merge`, `core-review-checks`, `core-boundary` 를 준 것 | 파일 10개 통과, 실패 0 |
| 전체 테스트 | `node scripts/run-tests.ts`(tsc 포함) | node 파일 362개와 tsc 통과, 실패 0(679초) |
| 추가 사례 | 임시 spec 세 개(저장소에 넣지 않음)를 `skills/orch/tests/` 에 두고 기존 fixture 로 관문, 머지 큐, 루프를 실제 명령으로 돌렸다 | 테스트 15개 통과, 실패 0. 처음 돌릴 때 입력이 틀린 두 사례는 아래 「확인 중 나온 실패」 에 적었다 |
| 폐기 옵션 | `orch queue ready`, `orch doctor` 를 옛 설정이 든 임시 저장소에서 실행 | 안내와 경고가 설계대로 나왔다 |

추가 사례의 상태 파일은 기존 테스트가 쓰는 `FAKE_STATE` 한 벌이다. 같은 입력을 관문, 머지 큐, 루프에 넣어 출력 줄과 종료 코드를 읽었다.

## 요구사항별 증거

### REQ1부터 REQ6까지

| 요구사항 | 실행한 절차 | 기대 결과 | 실제 결과 | 판정 |
| --- | --- | --- | --- | --- |
| REQ1 같은 PR 에 같은 답 | 같은 PR 상태 8가지(draft, 체크 실패, 체크 진행 중, 스레드 3개, 충돌, 실패+스레드, draft+실패, 충돌+스레드)를 관문과 머지 큐에 넣고 이유 문구를 읽었다 | 두 호출부의 이유 문구가 같다 | 체크 진행 중만 문구가 다르다. 관문은 `체크가 아직 끝나지 않았다(…)`, 머지 큐는 체크 대기가 낸 `체크 대기 60분 초과(…)` 다. 설계가 「체크 이유는 대기가 낸 것을 쓴다」 로 정한 차이라 같은 조건(진행 중)에 같은 종류로 막힌다. 나머지 7가지는 문구까지 같다 | 통과 |
| REQ1 범위 | 루프에 같은 상태를 넣고 `AUTO-MERGE-WAIT` 문구를 읽었다. 충돌, 통합 테스트, 비공개 낱말은 상태에 넣어도 루프가 묻지 않는지 `core-merge-readiness.spec.ts` 의 범위 대조 사례도 돌렸다 | 루프는 가벼운 범위(draft, 체크, 보류, 스레드, 리뷰)만 묻는다. 범위에 든 조건은 호출부와 관계없이 같은 종류로 막힌다 | draft→`draft`, 체크 실패→`CI failed`, 진행 중→`CI pending`, 스레드 2→`미해결 스레드 2`, 지시서 보류→`지시서 보류: …`, 본문 보류→`PR 본문 보류: …`, 보드 보류→`보드 보류: …`. 관문의 같은 상태와 종류가 같다. 대기 문구와 관문 문구가 다른 것은 설계의 `wait` 와 `text` 구분이다 | 통과 |
| REQ2 보류는 머지 단계에서 막는다 | 지시서 보류, PR 본문 보류, 보드 보류가 한꺼번에 있고 draft 와 체크 실패도 있는 PR 을 관문과 머지 큐에 넣었다 | 관문은 `GATE-FAIL` 아래에 ready 이유만, 보류는 `HOLD` 줄로 낸다. 머지 큐는 머지하지 않는다 | 관문: `GATE-FAIL 1`, 이유 줄 3개(draft, 실패, 스레드), `HOLD 지시서 이유`, `HOLD 본문 이유`, `HOLD 보드 보류: …`. 머지 큐: `GATE-HOLD` 3줄과 `STOP 1 draft PR 이다; 머지 보류: …`, `pr merge` 호출 없음 | 통과 |
| REQ2 보드 보류만 있을 때 | 보드 항목(`branch` 로 찾음)에만 보류를 두고 관문과 머지 큐를 돌렸다. 같은 항목을 `done` 으로 바꿔 다시 관문을 돌렸다 | 관문은 `GATE-OK` 와 `HOLD`(종료 0). 머지 큐는 멈춘다. 끝난 항목의 보류는 막지 않는다 | 관문 종료 0 과 `GATE-OK 1`, `HOLD 보드 보류: 머지 보류 확인 대기`. 머지 큐 종료 1 과 `pr merge` 호출 없음. `done` 항목은 `GATE-OK 1` 만 나왔다 | 통과 |
| REQ3 draft 는 준비 안 됨 | draft PR 을 설정 없음, `queue.allow_no_checks: true`, 옛 키(`queue.skipped_is_missing`, `pipeline.ready_slots`)가 든 설정 세 가지로 관문과 머지 큐에 넣었다 | 세 설정 모두 `GATE-FAIL` 종료 1. 옛 키가 설정 오류(종료 2)를 내지 않는다. 머지 큐는 체크를 읽기 전에 멈춘다 | 세 설정 모두 관문 종료 1 과 `draft PR 이다`, 머지 큐 `STOP 1 draft PR 이다`, `pr merge` 호출 없음. 루프도 `AUTO-MERGE-WAIT #1 draft` | 통과 |
| REQ4 체크 없음 | 체크 목록이 빈 PR 을 관문(`--wait` 없이, 있이), 머지 큐에 넣고 `queue.allow_no_checks` 를 켜고 다시 돌렸다. 체크가 하나 있고 진행 중인 PR 도 설정을 켠 채 돌렸다 | 설정이 없으면 준비 안 됨, 켜면 통과. 체크가 하나라도 있으면 설정과 관계없이 진행 중이면 막는다 | 설정 없음: 관문 `PR 에 CI 체크가 하나도 없다`(종료 1), `--wait --missing-timeout 1` 은 `…CI 체크가 1분째 하나도 나타나지 않는다. CI 가 없는 저장소면 queue.allow_no_checks 를 켠다`, 머지 큐도 같은 문구로 멈춤. 설정 켬: 관문 `GATE-OK`, 머지 큐 머지(`QUEUE-DONE`). 진행 중 체크 1개는 설정을 켜도 `GATE-FAIL`. 필수 체크 이름을 주고 체크가 없으면 `나타나지 않은 필수 체크 Tests` 로 막힌다 | 통과 |
| REQ4 루프 | 루프에서 체크 없는 PR 을 `allow_no_checks` 끈 설정과 켠 설정으로 한 틱씩 돌렸다(필수 체크 규칙은 빈 목록) | 끄면 대기, 켜면 다음 조건으로 넘어간다 | 끔: `AUTO-MERGE-WAIT #1 CI pending`. 켬: 리뷰 체크 조건을 통과해 `AUTO-MERGE-BASIS` 와 큐 호출 | 통과 |
| REQ5 리뷰 설정 없음 | 지시서 브랜치의 PR 둘(하나는 `스펙:` 줄이 있는 기능 지시서)을 `auto_review` 없음, `{}`, 옛 키만(`pass`, `block`)인 설정 세 가지로 루프 한 틱씩 돌렸다 | 기능 PR 인지와 관계없이 모든 PR 이 대기하고 큐 호출이 없다. 스레드와 PR 조회를 부르지 않는다 | 세 설정 모두 두 PR 에 `AUTO-MERGE-WAIT #<n> 자동 머지는 queue.auto_review 의 trusted_bots 나 review_checks 가 필요하다`, 큐 호출 0, 그 PR 의 `gh pr view` 호출 0, 「기능」 단어 없음. 앞선 조건이 있으면(draft, CI 실패, CI 대기) 그 문구가 먼저 나온다 | 통과 |
| REQ5 코디네이터의 직접 머지 | 리뷰 설정이 없는 저장소에서 관문과 머지 큐를 돌렸다 | 막지 않는다 | 모든 관문 사례(`auto_review` 없는 임시 저장소)가 리뷰 조건 없이 통과했고 `NOCHECK allowed queue` 는 머지까지 갔다 | 통과 |
| REQ6 판단 중 HEAD 변경(관문, 머지 큐) | 스레드 명령이 도는 사이 상태 파일의 HEAD 를 바꾸고 mergeable 을 `CONFLICTING` 으로 바꾸게 한 뒤 관문과 머지 큐를 돌렸다 | 통과로 보지 않고, 옛 HEAD 로 읽은 충돌과 스레드 이유는 버리고 HEAD 변경 이유 하나만 낸다 | 관문 종료 1, 이유는 `검사 중 HEAD 가 바뀌었다 checked=aaaaaaaa now=bbbbbbbb` 하나뿐이다. 머지 큐 `STOP 1` 같은 문구, `pr merge` 호출 없음 | 통과 |
| REQ6 루프 | `skills/orch/tests/orch-loop-auto-merge.spec.ts` 의 「PR 조회가 다른 HEAD 를 돌려주면…」 를 돌렸다 | 리뷰 체크가 통과해도 걸지 않고 `HEAD 가 바뀌었다` 로 대기 | 통과(전체 테스트 안) | 통과 |

### DECISION1부터 DECISION15까지

| 결정 | 확인 방법 | 결과 |
| --- | --- | --- |
| DECISION1 조건 목록 하나 | `core/merge-readiness.ts` 의 `CONDITIONS` 한 곳에 조건이 있고 관문(`queue/gate.ts`), 머지 큐, 루프가 모두 `checkReadiness` 를 부른다. `core-boundary.spec.ts` 가 core 의 gh, git, 파일 접근을 막는다 | 통과 |
| DECISION2 보드 보류와 직접 머지 | REQ2 의 보드 보류만 있는 사례. 머지 큐가 머지 직전에 보류를 한 번 더 묻는 `merge-queue.spec.ts` 의 「before-merge 뒤에 생긴 보드 보류도 실제 머지를 막는다」 | 통과 |
| DECISION3 두 단계 | 관문이 `GATE-OK` 와 `HOLD` 를 함께 내고 종료 0, 머지 큐는 멈춘다(REQ2) | 통과 |
| DECISION4 draft | REQ3 | 통과 |
| DECISION5 체크 없음 | REQ4 | 통과 |
| DECISION6 루프의 비용 | 루프가 범위를 가볍게 묻는 것은 REQ1 범위 사례. 리뷰 설정이 없을 때 PR 조회가 0번인 것은 REQ5 | 통과 |
| DECISION7 마이그레이션 순서 | `orch-loop-auto-merge.spec.ts` 의 「마이그레이션」, 「마이그레이션 예약」 묶음이 루프에 남아 통과 | 통과 |
| DECISION8 기능 PR 구분 없음 | REQ5. 지시서에 `스펙:` 줄이 있어도 없어도 같은 문구 | 통과 |
| DECISION9 work-board | `extensions/work-board` 의 이 판단 관련 변경은 「리뷰 설정 없음」 정규식 한 줄뿐이다. `merge-line.spec.ts` 가 전체 테스트 안에서 통과 | 통과 |
| DECISION10 `--allow-fail` | `merge-queue.spec.ts` 의 `--allow-fail` 사례 넷(경고하고 머지, 다른 실패는 못 덮음, 필수 체크는 멈춤)이 통과 | 통과 |
| DECISION11 조회 실패 | 조회 실패가 모든 호출부에서 통과로 읽히지 않는 사례: 스레드 출력이 숫자가 아닐 때 관문과 머지 큐가 `스레드 조회 실패` 로 멈추고, 세 보류 조회가 모두 실패하면 관문이 `HOLD` 3줄로 알린다(`queue-gate.spec.ts`) | 통과 |
| DECISION12 draft 로 CI 미루기 제거 | `orch queue ready` 가 `RETIRED orch queue ready: 없어졌다…` 와 종료 2. 옛 설정(`queue.skipped_is_missing`, `pipeline.ready_slots`, `hooks.timeouts.before-ready`·`pr-ready`), `.orch/hooks/before-ready.ts`, 오버레이의 `orch queue ready`, `gh pr create --draft` 가 든 임시 저장소에서 `orch doctor` 가 종료 0 과 `DRAFT-CI-RETIRED` 7줄을 냈다. `--skipped-is-missing` 은 `모르는 옵션` 으로 종료 2 | 통과 |
| DECISION13 리뷰 설정 없음 문구 | 문구가 `자동 머지는 queue.auto_review … 가 필요하다` 이고 work-board 의 정규식 한 줄이 맞는다는 `merge-line.spec.ts` 와 `core-merge-readiness.spec.ts` 의 `wait` 문구 목록 대조가 통과 | 통과 |
| DECISION14 루프와 마이그레이션 | `MIGRATION-CLASH` 사례(`orch-loop-auto-merge.spec.ts`)가 통과. 루프는 `skip: migration` 으로 묻고 알림은 루프가 따로 낸다 | 통과 |
| DECISION15 앞 리뷰 인정 | 아래 「DECISION15 앞 리뷰 인정」 | 통과 |

### DECISION15 앞 리뷰 인정

`judgeTrustedBotReviews` 를 직접 불러 막는 지적이 오는 네 곳, force-push, 믿는 봇 여럿을 확인했다(앞 영수증은 이전 커밋 OLD, 지금 HEAD 는 그 뒤 커밋).

| 경우 | 기대 | 실제 |
| --- | --- | --- |
| 봇이 연 줄 댓글 스레드, 앞 커밋에 P2 | 기다린다 | `P1·P2 지적을 남겼다` 로 대기 |
| 같은 곳, P3 | 앞 리뷰를 인정한다 | 영수증 `…@bbbb earlier` 로 통과 |
| 리뷰 본문의 배지, P2 / P3 | 기다린다 / 인정 | 대기 / 통과 |
| 이슈 댓글 본문의 배지, P2 / P3 | 기다린다 / 인정 | 대기 / 통과 |
| 리뷰 state `CHANGES_REQUESTED`(본문 지적, 등급을 모름) | 기다린다 | 대기. 같은 사례에 P3 영수증이 있어도 대기 |
| 지워진 커밋(force-push)의 영수증만 있음 | 기다린다 | `리뷰한 커밋이 지금 PR 커밋 목록에 없다` 로 대기 |
| 지워진 커밋의 영수증과 지금 HEAD 의 영수증이 함께 있음 | 통과 | 지금 HEAD 영수증으로 통과 |
| 지워진 커밋에 P1 줄 댓글이 있고 지금 HEAD 영수증도 있음 | 기다린다(같거나 뒤 커밋의 지적) | 대기 |
| 믿는 봇 둘, 한쪽이 앞 영수증 OLD 에 P2 | 기다린다 | 그 봇 이름으로 대기 |
| 믿는 봇 둘, 한쪽 앞 영수증 OLD(깨끗), 다른 쪽 지금 HEAD 영수증 | 통과 | 영수증 둘로 통과 |
| 믿는 봇 둘, 한쪽 앞 영수증 OLD(P3 만), 다른 쪽이 지금 HEAD 를 리뷰 중(PENDING) | 기다린다 | `현재 HEAD 를 리뷰하는 중이다` 로 대기 |
| 믿는 봇 둘, 한쪽 앞 영수증 OLD(깨끗), 다른 쪽은 활동 없음 | 통과 | 통과 |
| 믿는 봇 둘, 다른 쪽이 영수증 없이 해결된 P1 을 남김 / 지금 HEAD 에 P1 을 남김 | 기다린다 | 둘 다 `지적을 남겼다` 로 대기 |
| 같은 봇이 지금 HEAD 에 P1 줄 댓글(새 push 를 리뷰했는데 지적) | 기다린다 | 대기 |
| 사람 계정(`User`)이 봇 login 으로 P1 배지나 영수증 댓글을 씀 | 읽지 않는다 | P1 배지는 무시되고, 영수증 댓글은 영수증으로 세지 않아 리뷰 없음(`review-missing`)이다 |
| 루프에서 앞 영수증 인정 | 같은 결과 | `orch-loop-auto-merge.spec.ts` 가 P2 이면 `P1·P2 지적을 남겼다` 대기, P3 이면 `AUTO-MERGE-BASIS …앞 리뷰 인정(P1·P2 없음)` 과 큐 호출 |

PR 651 본문의 막는 지적 출처 표(줄 댓글, 리뷰 state, 리뷰 본문, 이슈 댓글 본문)와 코드 주석의 표(`lib/review-bot.ts`), 오버레이 설명(`overlay.md` 의 382행부터 384행까지)이 서로 같다. 시각을 쓰는 비교는 코드에 없다.

## 문서 확인

### 호환 표

`compat`, `compat.noDraft`, `compat.oldHolds`, `compat.checksAfterWait`, `checkHeadStop` 은 `skills/orch/scripts`, `skills/orch/tests` 어디에도 없다. 스레드 수 읽기의 호환(숫자가 아닌 출력도 수로 받기)도 `lib/merge-readiness.ts` 의 `threads` 읽기가 `^\d+$` 만 받는 것으로 지워졌다. 코드 쪽은 모두 지워졌다. 문서 쪽에는 아래 두 곳이 남았다(「남은 것」 의 문서 1, 2).

### 설명 문서와 지금 동작

| 문서 | 대조한 것 | 결과 |
| --- | --- | --- |
| `docs/flow.md` | 자동 머지 그림과 표, `ci-passed` 이벤트, 설정 설명 | 일부 어긋남(「남은 것」 문서 3) |
| `docs/data-schema.md` | `queue.allow_no_checks`, `queue.auto_review`, 폐기 키 | 맞음 |
| `skills/orch/references/cleanup.md`, `replying.md`, `spec-writing.md` | `GATE-OK`, `GATE-FAIL`, `HOLD`, draft 실패 | 맞음 |
| `skills/orch/references/feature-loop.md` | 기능 PR 과 일반 PR 을 나누지 않는 리뷰 요구, 앞 리뷰 인정 | 맞음 |
| `skills/orch/references/overlay.md` | 리뷰 설정이 없을 때, 앞 리뷰 인정, 폐기 행 | 한 문장이 부정확(「남은 것」 문서 4) |
| `docs/adr/016-orch-auto-merge.md` | 「감당할 것」 보탬 | 맞음 |
| `skills/orch/CHANGELOG.md` | 호환성 줄 | 맞음 |

## 확인 중 나온 실패

추가 사례 중 두 개가 처음 실패했다. 둘 다 구현 결함이 아니라 내 입력이 틀렸다.

- `queue.auto_review.trusted_bots: []` 와 `review_checks: []` 로 루프를 돌렸더니 종료 2 와 `…비지 않은 목록이어야 한다` 가 나왔다. 빈 목록은 「리뷰 설정 없음」 이 아니라 설정 오류로 막는 것이 `docs/data-schema.md` 의 키 설명과 같은 동작이다.
- `allow_no_checks` 를 켠 루프가 `CI pending` 을 냈다. 가짜 gh 의 기본 필수 체크 규칙이 `test` 라서 그 체크가 나타나지 않은 것이었다. 규칙을 빈 목록으로 바꾸자 통과했다.

## 남은 것

### 판단이 필요한 관찰

**1. force-push 와 믿는 봇 여럿이 겹칠 때의 대기.** 믿는 봇 A 의 마지막 영수증이 force-push 로 지워진 커밋에 있고 봇 B 가 지금 HEAD 영수증을 이미 남겼어도, 판단은 A 때문에 기다린다(`리뷰한 커밋이 지금 PR 커밋 목록에 없다`).
- 재현: 봇 둘을 믿는 설정에서 `judgeTrustedBotReviews(HEAD, { comments: [A 의 GONE 영수증, B 의 HEAD 영수증], commits: [OLD, HEAD], … }, [A, B])` 를 부르면 `ok: false` 다. 임시 spec 에서 확인했다.
- 막는 쪽으로 틀린 동작이라 머지가 잘못 나가지는 않는다. 다만 DECISION15 이전(커밋 `762fa648` 의 앞 코드)에는 지금 HEAD 가 아닌 영수증을 세지 않아 B 의 영수증만으로 통과했다. 지금은 A 가 새 HEAD 를 다시 리뷰하지 않으면 이 PR 은 계속 기다린다.
- 스펙 DECISION15 는 이 경우를 정하지 않았다. 지금 동작(안전한 쪽)을 유지할지, 지금 HEAD 영수증이 있는 봇이 하나라도 있으면 지워진 커밋의 영수증은 무시할지 사용자가 정한다. 믿는 봇을 둘 이상 쓰는 저장소가 아직 없으면 보류해도 된다.

### 문서가 지금 동작과 어긋난 곳

1. [ADR-037](../../adr/037-orch-merge-readiness.md) 의 「결정」 과 「결과」 가 `compat` 값을 「이행 중에 남기고 뒤 PR 이 하나씩 지운다」 고 쓴다. 지금 코드에는 `compat` 이 없다.
2. [기술 설계](technical-design.md) 의 「PR2 와 PR3 이 동작을 그대로 두려면…」 아래 호환 표(`compat.noDraft` 등)는 모두 지워진 항목의 이력이다. 바로 아래 문장이 「PR7 이 `compat` 타입 자체를 지웠다」 고 밝히지만, 표의 「지우는 PR」 열은 현재형으로 읽힌다.
3. `docs/flow.md` 의 「상주 루프의 자동 머지」 표 마지막 근처 행 「리뷰 뒤에 커밋이 더해졌거나…」 는 지금 HEAD 의 리뷰 체크나 영수증이 없으면 걸지 않는다고만 쓴다. DECISION15 로 믿는 봇의 마지막 리뷰에 P1·P2 가 없으면 앞 커밋의 영수증도 인정하는 것이 빠져 있다. 같은 표에 「리뷰 설정이 없으면 모든 PR 을 기다린다」(REQ5) 행도 없다. 두 동작은 `overlay.md` 와 `feature-loop.md` 에만 있다.
4. `skills/orch/references/overlay.md` 357행은 코디네이터가 직접 거는 머지 큐와 `orch queue gate` 가 「리뷰 조건 없이 CI 와 미해결 스레드만 본다」 고 쓴다. 리뷰 조건이 없다는 뜻은 맞지만 draft, 충돌, 통합 테스트 기록, 비공개 낱말도 본다. 「만」 이 틀렸다.

### 사소한 문구

- 관문이 체크가 진행 중이고 필수 체크 이름이 없을 때 `체크가 아직 끝나지 않았다(진행 중 1, 나타나지 않은 필수 체크 0)` 처럼 이름 자리에 개수 `0` 을 쓴다(`core/merge-readiness.ts` 의 `ci` 조건). 머지 큐의 체크 대기 문구는 같은 경우 `나타나지 않은 필수 체크 )` 로 이름 자리가 빈다. 둘 다 사람이 읽으면 뜻은 통하지만 어색하다.
- 머지 큐는 draft 를 차례 시작에서 먼저 보류하므로 draft 이면서 체크가 실패한 PR 은 `draft PR 이다` 만 낸다. 관문은 두 이유를 모두 낸다. 설계가 「base 최신화와 체크 대기 전에 빨리 멈춘다」 로 정한 차이다.
