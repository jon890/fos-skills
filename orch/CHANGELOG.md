# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 5.21.0 (2026-11-02)

- `spec-lint` 와 `launch-worker` 가 지시서의 `## 할 일` 아래 첫 줄을 본다. `루프를 쓴다(스펙: <경로>)`, `루프를 쓴다(스펙: 새로 쓴다)`, `루프 없이: <이유>` 가 아니면 `루프` 발견으로 막고 종료 코드 5 로 멈춘다
- `루프를 쓴다(스펙: <경로>)` 는 그 스펙에 `확인: YYYY-MM-DD` 줄이 있어야 통과한다. 상대경로 스펙은 `origin/<base>` 에서 읽으므로 커밋하지 않은 스펙은 절대경로로 적는다
- `리뷰 PR:`, `중간 과정:` 줄이 있는 지시서와 이미 떠 있는 worker 의 지시서는 보지 않는다
- `launch-worker` 가 `--base` 를 `spec-lint` 에 넘긴다. `루프 없이` 로 띄우면 사용자에게 보내는 띄우기 보고에 이유를 한 줄로 적는다

## 5.20.0 (2026-11-02)

- 루프가 크레딧 소진 등 사용 한도로 멈춘 worker 를 dispatch 마다 한 번 알린다
- 다시 띄운 worker 의 완료와 끝난 dispatch 의 질문을 같은 Task 의 앞선 PR 준비 상태나 같은 워크트리 브랜치의 PR 종료로 판정한다
- PR 과 같은 워크플로의 base 실행도 실패하면 worker 에게 수정을 보내지 않고 코디네이터에게만 알린다

## 5.19.0 (2026-11-02)

- 상주 루프가 틱마다 워크트리 파일, 브랜치 커밋, 화면이 `pipeline.idle_min`(기본 30분) 넘게 그대로이거나 프로세스가 끝난 열린 dispatch 를 `WORKER-IDLE` 로 알린다. 화면 상태를 읽지 못하는 structured worker 도 잡는다
- 보드의 `doing` 항목에 끝나지 않은 단계가 있는데 그 항목의 worker 가 없으면 `STAGE-STALLED` 로 알린다
- 같은 판정을 지금 바로 보는 `stalled-workers` 명령을 더한다. 루프가 없는 저장소는 정기 점검에서 이 명령을 부른다
- Run 을 주지 않은 `merge-with-finish` 의 정리가 `--close-own-taken-over 는 --run 과 함께 쓴다` 로 실패하지 않게 `finish.run` 을 넘긴다

## 5.18.0 (2026-11-02)

- Orca 1.4.246 의 줄인 보기로 비던 판정을 고친다. 모든 `orca orchestration` 조회에 `--full` 을 붙인다. 직접 조회할 때도 붙인다
- `launch-worker` 는 일하는 흔적이 있으면 abandon 하지 않고, `worker-ask` 는 바로 돌아온 ask 의 답을 기다리며 닿지 않은 질문은 2 로 끝난다
- 대기와 요약이 턴만 끝낸 멈춤 보고를 기본으로 빼고(`--stop-reports` 로 본다), 프로세스가 끝난 열린 dispatch 는 `WORKER_LOST` 로 알린다
- 루프가 머지된 PR 의 열린 dispatch 에 머지를 알리고, 마무리 없이 머지된 PR(`FINISH-MISSING`)과 대기 없음(`NO-WAIT`)을 알린다
- 정리는 끝난 reclaimable dispatch 를 반납하고, 공통 지시서 틀에 status 는 PR, 막힘, 범위 변경 때만 보낸다는 규칙을 더한다

## 5.17.0 (2026-11-02)

- `remove-worktree` 가 워크트리를 지운 직후 compose `working_dir` 가 그 워크트리 아래인 컨테이너와 그 프로젝트 네트워크를 지운다
- `cleanup-sweep` 이 `config.json` 의 `docker` 절에 선언한 임시 컨테이너(이름의 PID 가 없는 것)와 이미지 태그(최근 `keep` 개와 쓰는 것을 뺀 것)를 지운다
- 이름 있는 볼륨, build cache, 귀속 없는 dangling 자원은 지우지 않는다. Docker 를 쓸 수 없으면 경고 한 줄로 넘어간다

## 5.16.0 (2026-11-02)

- 공부 후보를 `study/candidates.md` 표 한 줄 대신 후보마다 `study/<slug>.md` 파일 하나로 둔다. 머리에 주제, 질문, 생긴 곳, 참고, 상태, 적은 날을 두고 본문에 메모를 쌓는다
- 사용자가 뜻을 물은 개념을 나올 때마다 `후보` 로 적고, 하루 끝에 그날 적은 후보를 보여 사용자가 뺄 것만 `뺌` 으로 바꾼다
- `study-candidates` 의 `add`, `set` 이 `--row` 대신 `--slug` 를 받고, `list` 가 `--today`, `--date` 로 그날 적은 후보를 낸다. 출력의 첫 칸이 번호에서 slug 로 바뀌고 적은 날 칸이 더해졌다
- 옛 표 파일을 옮기는 `study-candidates migrate` 를 더했다. 옮긴 뒤 옛 파일은 휴지통으로 간다
- `orch-doctor` 의 `STUDY-OPEN` 이 파일 대신 폴더를 내고, 옛 표 파일과 머리 없는 파일은 세지 않고 stderr 에 알린다

## 5.15.0 (2026-11-02)

- 기능 루프를 쓸지 정하는 기준(새 동작·계약·여러 PR 은 루프, 버그 수정·정리·설정·측정은 바로 구현)을 코어에 둔다
- worker 의 spec 인터뷰를 코디네이터가 4개씩 나눠 사용자에게 묻고, 스펙 확인도 사용자에게 받아 돌려준다
- 공통 지시서 틀에 spec 인터뷰 규칙(`spec-interview` 표지)을 넣는다. 이 규칙이 빠진 공통 지시서는 `spec-lint` 가 경고한다
- `worker-ask --decision` 이 결정 블록 여러 개를 한 질문으로 받고 블록마다 형식을 검사한다

## 5.14.0 (2026-11-02)

- 공통 지시서 틀에 기능 루프와 검증·후보 추출 뒤의 PR 생성 순서를 넣고, 이 규칙이 빠진 공통 지시서를 경고한다

## 5.13.0 (2026-11-02)

- 자동 머지의 리뷰 판정이 지금 HEAD 의 리뷰만 센다. 리뷰 뒤에 기준 브랜치를 합친 merge 커밋만 더했으면 앞 리뷰를 인정한다
- 지금 HEAD 에 판정 문구가 든 리뷰가 없으면 자동 머지에 걸지 않고 `AUTO-MERGE-NO-REVIEW` 로 HEAD 마다 한 번 알린다. 독립 리뷰 결과를 그 HEAD 에 `pass` 문구로 남기면 다음 틱이 건다
- `wait-important` 가 같은 Task 에 살아 있는 다른 dispatch 가 있으면 앞 dispatch 의 끊김을 처리한 것으로 본다. 알린 뒤 다시 띄운 dispatch 는 `handled` 로 적고 경고하지 않는다
- `adopt-sessions` 가 사용 한도 안내에서 멈춘 worker 를 `LIMITED`, Task 가 `ready` 인데 마지막 dispatch 가 `failed` 인 worker 를 `RESTART` 로 내고 다시 띄울 명령을 붙인다
- `launch.md` 「끊긴 worker 다시 띄우기」 표에 재부팅 뒤 `ready` 와 `failed` 가 겹친 경우를 더했다

## 5.12.0 (2026-11-02)

- `launch-worker` 는 띄울 지시서와 무관한 활성 지시서끼리의 겹침을 경고로만 낸다
- `worker-ask` 는 Orca 대기 시간 상한을 적용하고 `--max-wait` 로 같은 질문의 답을 다시 기다린다
- 자동 리뷰 workflow 를 바꾼 worker 는 Ready 뒤 코디네이터에게 독립 리뷰를 요청한다

## 5.11.0 (2026-11-01)

- 기능 스펙부터 구현·독립 검증·공통 후보 추출까지 이어 주는 루프를 더한다

## 5.10.0 (2026-11-01)

- 일하다 사용자가 뜻을 물은 개념을 `<orch 루트>/study/candidates.md` 에 공부 후보로 모으고, 다시 본 뒤 글로 쓰는 절차를 더했다
- `study-candidates` 명령이 후보를 더하고(`add`) 상태를 바꾸고(`set`) 목록을 낸다(`list`). 표의 행만 고치고 파일 머리의 글은 그대로 둔다
- `orch-doctor` 가 상태가 `후보` 나 `리뷰함` 인 후보 수를 `STUDY-OPEN` 으로 낸다. 종료 코드는 바꾸지 않는다
- 오버레이에 글쓰기 스킬과 글이 놓일 저장소, 하루 끝 정리를 묻는 방식을 적는 「공부 후보」 칸을 더했다

## 5.9.0 (2026-11-01)

- Codex worker 를 띄울 때 `SSH_AUTH_SOCK` 이 있으면 `launch-worker` 가 그 워크트리에만 `core.sshCommand`(`ssh -o IdentityAgent=<소켓>`)를 둔다
- Codex 의 `inherit = "core"` 설정 때문에 worker 의 `git fetch`·`git push` 가 `Permission denied (publickey)` 로 막히던 것을 막는다
- 사용자가 이미 정한 `core.sshCommand` 는 덮지 않는다. Claude worker 에는 설정하지 않는다

## 5.8.0 (2026-11-01)

- `reserve-migration --kind java` 가 그 모듈의 `migrations.watch` 폴더(여럿이면 `--dir` 로 고른 것)에 `V<버전>__<이름>.java` 경로를 예약한다. 이름은 대소문자를 지키고 Java 식별자가 아니면 사용법 오류다
- 머지 큐, 마무리, 예약 명령은 `--repo` 가 git 작업 트리가 아니면 무엇을 만들기 전에 종료 코드 2 로 멈춘다. `owner/name` 모양이면 로컬 경로를 달라고 안내한다
- 완료 계약이 `준비됨 #N, head <SHA> (설명)` 처럼 SHA 뒤에 같은 줄로 붙인 설명도 근거로 인정한다. 공통 지시서 틀은 설명을 다음 줄에 쓰라고 안내한다
- `wait-important` 가 완료 근거를 `check --all --types status` 로 찾고, 없으면 `inbox` 에서 그 Run 의 행을 다시 찾는다. 긴 실행에서 heartbeat 에 밀려 정상 완료가 종료 코드 6 으로 끝나지 않는다
- 코디네이터가 겪은 스킬 개선 후보도 `<orch 루트>/feedback/coordinator-<YYYYMMDD>.md` 에 쌓는다

## 5.7.0 (2026-10-31)

- `worker-ask` 가 ask 를 기다리는 동안 30초마다 status 답을 찾아, 오면 시간 제한을 기다리지 않고 3 으로 끝난다
- 무거운 검사 자리를 상한(기본 30분, `HEAVY_HOLD_MAX`)보다 오래 쥐면 상주 루프가 `HEAVY-SLOT-HELD` 로 알린다. 끊지는 않는다
- 지시서의 `리뷰 PR: #N` 줄을 보고 `launch-worker` 가 PR head 를 받아 리뷰 워크트리를 그 커밋에 두고 `review.prepare` 를 한 번 돌린다. worker 는 fetch 하지 않는다
- 정리와 `remove-worktree --delete-branch` 가 MERGED, CLOSED PR 의 `pr-N`, `review/pr-N` 브랜치와 리뷰 지시서를 모든 Run 의 리뷰 dispatch 가 끝난 뒤 지운다
- `orch-doctor` 가 열린 개선 후보 수를 `FEEDBACK-OPEN` 으로 낸다. 공통 지시서에 worker-ask 규칙이나 개선 후보 절이 없으면 `spec-lint` 가 경고한다

## 5.6.0 (2026-10-31)

- 지시서의 `보드 항목 id:` 줄은 백틱 안의 글이나 공백 앞 첫 토큰만 id 로 읽는다. 뒤에 설명이 붙어도 가짜 보드 항목이 생기지 않는다. 설명이 붙었는데 그 id 가 보드에 없으면 항목을 만들지 않고 `보드를 갱신하지 못했다` 로 알린다
- `spec-lint` 가 id 줄에 설명이 붙으면 `보드` 경고를 낸다. 종료 코드는 바꾸지 않는다
- 상주 루프는 실패한 체크가 모두 `CANCELLED` 이면 worker 에게 고치라고 보내지 않고 `CI-FAILED` 에 `취소만 있음` 을 적어 코디네이터에게만 알린다
- worker 권한 안내에 자동 모드 허용 기준(`autoMode.allow`)을 더했다. 워크트리의 `.claude/settings.local.json` 에서는 듣지 않는다
- push, PR, 리뷰 회신을 worker 에게 맡기는 저장소는 worker 프로필의 사용자 `settings.json` 에 저장소를 한정한 허용 기준을 둔다. `link-claude-profile --help` 에도 같은 안내가 있다

## 5.5.0 (2026-10-30)

- 지시서 하나의 완료 기준은 PR 하나의 MERGED 다. 계획이 PR 여럿이면 지시서는 PR1 만 맡고, 앞 PR 이 머지되면 코디네이터가 다음 지시서를 써 새 worker 와 새 워크트리로 띄운다
- `spec-lint` 가 완료 기준에 PR 이 둘 이상이면 `완료` 경고를 낸다. 종료 코드는 바꾸지 않는다
- 정리가 지시서의 `브랜치:` 줄이 머지된 브랜치를 가리키면 이름이 워크트리와 달라도 그 지시서를 지운다. 후속 지시서가 `.orch/specs/` 에 남지 않는다

## 5.4.0 (2026-10-30)

- 호환성: 기존 사용자 결정 `REMINDER`는 `DECISION-PENDING`으로 바뀐다. 저장소의 `worker-question` 핸들러로 결정 재알림을 받았다면 `decision-pending` 핸들러로 옮긴다
- `send-to-worker` 가 최신 미답변 질문에 먼저 답한다. 별도 지시는 `--no-reply` 로 보내고 재전송 질문은 뒤 질문에 답하면 보드와 감시에서 함께 해결된다
- `wait-important` 가 다음 대기 명령을 안내한다. 코디네이터는 메시지를 처리한 직후 다시 대기한다
- 상주 루프가 새 사용자 결정과 보드의 남은 결정 줄을 찾으면 `decision-pending` 기본 핸들러로 현재 코디네이터에게 묻기를 요청한다. 같은 결정은 반복해서 깨우지 않는다
- `migrations.watch` 로 감시 전용 폴더를 더한다. 예약 파일은 계속 `migrations.dirs` 의 폴더에 만든다

## 5.3.0 (2026-10-30)

- 체크 스냅샷은 PR HEAD 별로 공유한다. 진행 중이면 짧게, 완료됐으면 길게 캐시하고 멈춤·머지 직전에 다시 읽는다
- HEAD, 충돌, 리뷰, ready 판정 조회는 공유 캐시를 건너뛴다
- 같은 HEAD 와 워크플로에 더 늦게 시작한 실행이 있으면 옛 취소 실행을 실패로 세지 않는다. 체크 조회 중 HEAD 가 바뀌면 머지를 멈춘다

## 5.2.0 (2026-10-30)

- 호환성: 5.0.0의 major 정리에 이어 옛 설정 칸과 옵션을 지운다. `migrate-orch-dir --hooks`로 변환한다
- 호환성: `queue.before`, `queue.verify_merged`, `queue.after_merged`, `finish.complete_cmd` 설정을 지웠다
- 호환성: `--before`, `--verify-merged`, `--after-merged`, `--complete-cmd` 옵션을 지웠다
- `before-merge` 입력에 `has_pr_command`를 더했다. 변환한 기본 명령은 PR별 명령이나 빈 `PR:`이 있으면 건너뛴다

## 5.1.0 (2026-10-30)

- `adopt-sessions` 로 살아 있는 dispatch 에서 떨어진 터미널과 지시서·PR·화면 상태를 찾고, `--apply` 로 선택한 에이전트를 새 Run 에 이어 붙인다. 기본 실행은 조회만 한다
- 끊긴 worker 알림에서 이어받기 명령을 안내한다. 압축이나 계정 전환 뒤에도 이전 세션을 찾는다
- 입력 hook 이 끝난 dispatch 의 남은 터미널도 찾아 바로 차단하고 이어받기를 안내한다. 조회 시간이 초과되면 조회 횟수와 마지막 명령을 함께 알린다
- 설치 기록과 다른 캐시 번들의 스크립트를 직접 부르면 현재 진입점 경로를 경고한다

## 5.0.0 (2026-10-30)

- 호환성: `orch/scripts` 의 `orch-doctor.py`, `ts_shim.py` 외의 옛 `.py` 진입점과 `merge-queue.sh` 를 지웠다. 명령은 `"$SKILL_DIR/bin/orch.ts" <이름>` 이나 같은 이름의 `.ts` 로 부른다
- 호환성: 옛 `.py` 이름으로 부르던 저장소 스크립트와 기억한 명령은 `bin/orch.ts <이름>` 으로 바꾼다
- `orch-doctor.py` 는 공식 점검 진입점으로 남는다. `ts_shim.py` 가 Node 24 미만이면 `NODE-TOO-OLD` 로 멈춘다
- 옛 구조 안내가 옮기는 명령을 `node --disable-warning=ExperimentalWarning <경로>/migrate-orch-dir.ts` 로 알린다

## 4.x

- 상주 루프가 여러 세션의 Run 을 함께 맡고, 자동 머지(`queue.auto_merge`)와 마이그레이션 번호 검사, 예약(`reserve-migration.ts`)을 한다
- 보드 항목의 단계는 마일스톤 단계다. `[pr]`, `[merge]`, `[deploy]`, `[release]` 와 줄 끝 사건 꼬리표를 사건에 맞춰 끝낸다
- `launch-worker` 가 띄우기 전에 `spec-lint`, `worker 선택:` 줄 대조, codex 모델 검사, Claude 프로필 판정을 한다. 프로필은 `link-claude-profile.ts` 로 맞춘다
- worker 상태 판정을 `lib/worker-state.ts` 한 곳이 정하고 `cleanup-sweep`, `orch-doctor`, `wait-important` 가 함께 쓴다
- 진입점 `bin/orch.ts <이름>` 이 설치 기록의 현재 번들에서 스크립트를 찾아 실행한다. 문서의 명령 예시가 이 꼴이다
- 읽기 전용 gh 조회가 프로세스 사이에서 캐시를 공유하고 `gh-usage.ts` 가 호출 수를 낸다
- `finish-pr` 이 업무의 마지막 PR 인지 스스로 판정하고, 머지 큐가 충돌한 PR 을 빼고 뒤 PR 을 잇는다
- 지시서 하나는 PR 하나다. 에이전트 고르기에 제공자 절과 라우팅표, 사용 한도 대응표를 두었다

## 3.x

- 명령이 TypeScript 로 돌고 단계마다 이벤트를 낸다. 저장소 고유 일은 `.orch/hooks/<이벤트>.ts` 가 맡고, 옛 `.py` 경로는 shim 으로 남는다
- 업무 완료는 `after-deploy` 핸들러가 한다. `migrate-orch-dir --hooks` 가 옛 셸 명령 칸을 핸들러로 바꾸며 worker 가 작업 중이어도 적용한다. 옛 폴더 옮기기는 다른 저장소의 지시서에 막히지 않는다
- 저장소마다 상주 루프 `orch-loop.ts` 가 질문 확인, 정리, 보드 동기화, 내 PR 의 CI 감시, 충돌 PR 알림을 하고 `wait-important --loop-repo` 를 깨운다
- worker 가 PR 이 머지될 때까지 맡고, 완료 검증은 `준비됨` 을 받은 때 한다. 지시서 하나는 PR 하나로 끝나는 크기로 쓴다
- `cleanup-sweep --remote-branches` 가 머지된 원격 브랜치를 지우고, 머지 큐가 머지한 브랜치를 base 로 둔 내 PR 의 base 를 옮긴다
- worker 를 띄우면 보드 항목을 만들고 루프가 PR 연결과 머지를 반영한다. 결정 필요 항목은 `DECISION-PENDING` notifier가 깨운다
- `heavy` 절로 무거운 검사를 분류하고, 시간 제한과 유예를 `ORCH_*` 환경 변수로 바꿀 수 있다
- node 24 이상이 필요하다. 그보다 낮으면 스킬을 열 때 `NODE-TOO-OLD` 로 멈춘다(ADR-011)

## 2.x

- orch 파일을 `.omc/` 와 `.claude/` 에서 주 checkout 의 `.orch/` 로 옮겼다(`overlay.md`, `config.json`, `specs/`). 옛 위치는 `migrate-orch-dir` 로 옮긴다
- `heavy-slot.py` 가 같은 PC 에서 여러 worker 가 돌리는 무거운 검사를 대기열과 자리 수로 제한한다
- `merge-with-finish --run` 으로 머지 뒤 정리를 그 Run 의 worker 로 한정한다. 다른 코디네이터의 터미널을 닫던 문제를 고쳤다
- `launch-worker`, `make-worktree` 의 `--resume-remote` 로 원격 PR 브랜치를 새 워크트리에서 이어 받는다
- `cleanup-sweep.py --close-own-taken-over` 로 끝난 worker 가 남긴 사용자 보유 셸을 닫는다
- `watch-questions` 가 미답변 질문을 Monitor 로 알리고 10분마다 다시 알린다
- 모든 지시서에 `허락:` 줄이 필수다. `worker-ask --decision` 이 사용자 결정 질문의 형식(`결정:`, 선택지, `권장:`)을 검사한다
- 코디네이터 터미널에서 돌린 정리가 모든 워크트리를 터미널 소유 상태 조회 실패로 건너뛰던 문제를 고쳤다

## 1.x

- 7단계 절차(에이전트 고르기부터 머지와 정리까지)와 단계별 reference, 공통 지시서 틀, 저장소 오버레이를 두었다
- 머지 큐가 필수 체크, 미해결 스레드, HEAD 를 확인해 차례로 머지하고 base 최신화, 합친 사본 검사, `--up-to-date-when overlap` 을 받는다
- `merge-with-finish` 와 `finish-pr` 가 머지 뒤 worker 정리, 배포 성공 대기, 업무 완료, 보드 done 을 함께 건다
- `cleanup-sweep.py` 가 깨어날 때마다 머지된 워크트리, 브랜치, 터미널, 지시서를 지우고 `board-sync.py` 가 보드를 맞춘다
- `launch-worker` 가 지시서의 브랜치와 `허락:` 줄대로 띄우고, `send-to-worker` 가 답을 보내고 입력 대기인 worker 를 깨운다
- `wait-important` 가 heartbeat 를 넘기고 중요한 메시지나 끊긴 worker 에서만 깨어난다. `notify-conflicts` 가 충돌한 PR 의 worker 에게 알린다
- 띄우기 전 `spec-lint`, 스킬을 열 때 `orch-doctor` 가 돌고, worker 워크트리에 `gh pr merge` 와 `pkill` 을 막는 권한 규칙이 들어간다
- PreToolUse hook 이 백그라운드 대기, `cd` 뒤 git 쓰기, worker 터미널 직접 입력, 형식이 다른 `--spec` 을 거부한다
