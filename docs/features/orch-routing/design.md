# orch: worker 모델 선택 지침과 routing 기록 기술 설계

스펙: [`spec.md`](spec.md). 근거 표: [`evidence.md`](evidence.md).

## 요구사항 연결

| ID | 해결 방법 | PR |
| --- | --- | --- |
| REQ1 | `lib/spec.ts` 의 `selectionsOf` 가 `high 근거:` 조각을 읽는다. 판정은 새 공용 함수 `selectionVerdict`(`lib/selection.ts`) 하나가 한다. Opus 에 `high`, `xhigh`, `max` 면 근거를 요구하고, `medium 실패 <dispatch>` 는 띄우기 이력(`lib/launch-history.ts`)에서 그 dispatch 가 Opus `medium` 인지 대조한다. `spec-lint` 의 `선택` 발견과 `launch-worker` 의 차례 0(`selectionReject`)이 같은 함수를 부른다. 차례 0 은 `--lint-ack` 으로 넘길 수 없고, `--effort` 도 지시서와 대조한다 | PR-B |
| REQ2 | `agent-selection.md` 의 모델 표에 행 id 열, Opus `high` 허용 조건, Codex 행 조건을 더하고, 「비교 근거」 표에 `모델 id` 열을 더하며, 「실측 기록」 절을 근거 링크와 측정일·표본 수로 고친다 | PR-A |
| REQ3 | 공통 지시서 틀에 새 `orch-rule: no-reconfirm` 항목과, `status-only` 항목 뒤 새 `orch-rule: status-not-escalation` 항목을 더한다. `spec-lint` 의 `공통` 경고는 표지를 틀에서 읽으므로 코드 변경이 없다 | PR-A |
| REQ4 | `lib/launched.ts` 의 `Launch` 에 `agent`, `model`, `effort`, `effective`, `experiment` 를 더한다. `launch-worker` 가 `recordLaunch` 와 같은 자리에서 이력에도 한 줄을 더한다 | PR-B |
| REQ5 | 새 `lib/routing-log.ts` 가 한 줄을 모으고 쓴다. `finish-pr` 가 MERGED 확인 직후·정리 전에, `cleanup-sweep` 이 CLOSED PR 을 만났을 때 부른다 | PR-C |
| REQ6 | `spec-writing.md` 의 `experiment:` 줄 안내와 `lib/spec.ts` 의 `experimentOf` 를 함께 더한다. 꼴과 「`worker 선택:` 이 후보 안」, 다음 후보 대조를 `selectionVerdict` 가 한다. 다음 후보 대조는 이력이 필요해 `launch-worker` 차례 0 에서만 본다. 안내를 PR-A 에 먼저 두면 배정 도구 없이 Opus `high` 근거 면제만 열려 우회 길이 되므로 PR-B 에 함께 둔다 | PR-B |
| REQ7 | 새 진입 명령 `orch routing report` 가 저장소 여럿의 `routing-log.jsonl` 을 모아 표를 낸다 | PR-D |
| REQ8 | `agent-selection.md` 모델 표의 `id` 열을 원본으로 두고, `lib/spec.ts` 가 `행:` 조각을 읽고 `spec-lint` 가 번들의 표에서 id 를 읽어 대조한다 | 문서 PR-A, 검사 PR-B |

## 책임과 경계

- **지침 문서가 값의 원본이다.** 행 id 는 `agent-selection.md` 모델 표의 첫 열 하나에만 둔다. 번들 루트는 깊이가 고정된 `lib/bundle.ts` 에 새 함수 `bundleRoot()` 로 풀고, `spec-lint` 의 `TEMPLATE` 과 표 경로를 모두 그 함수로 읽는다. 스크립트 폴더 이동(orch-cli PR3) 뒤 `scripts/<묶음>/` 깊이가 바뀌어도 맞는다. 코드에 id 목록을 복제하면 표와 어긋난다. 표를 읽지 못하면 `selectionVerdict` 가 「표를 읽지 못했다」 로 거부한다. `launch-worker` 는 `spec-lint` 의 종료 코드 2 를 경고로만 넘기므로(`launch-worker.ts` 의 `lintGate`), 차례 0 이 직접 거부해야 검사가 조용히 꺼지지 않는다.
- **선택 검사는 ack 으로 넘기지 않는다.** `--lint-ack` 은 겹침처럼 의도한 발견을 넘기는 길이다(`references/launch.md`). 지금도 `worker 선택:` 대조(차례 0)는 ack 으로 넘기지 못한다. 새 검사를 그 자리에 두어 같은 성질을 갖게 한다. `--effort` 대조는 지시서 effort 와 `--effort` 가 다르면 거부한다. Haiku 행처럼 effort 를 지정하지 않는 지시서는 effort 를 `기본` 으로 적고 `--effort` 를 주지 않는다.
- **다시 띄우기를 `launch-worker` 로 모은다.** 지금 지침은 같은 Task 를 다른 모델로 다시 띄울 때 `worker-start --task --retry-of` 를 직접 부른다(`references/launch.md` 「시작 직후 실패」, `waiting.md`, `replying.md`). 그 길은 이력도 선택 검사도 거치지 않아, medium 실패 뒤 high 로 올리는 바로 그 띄우기가 REQ1 밖에 있다. `launch-worker` 에 다시 띄우기 꼴(`--task <id> --retry-of <dispatch> --spec <지시서>`)을 더한다. 워크트리는 이력의 그 dispatch 의 것을 쓰고, 선택 검사와 이력 쓰기는 새 띄우기와 같다. 지침의 직접 호출은 이 꼴로 바꾸고, `hooks/require-spec-line.ts` 옆에 `worker-start --task` 직접 호출을 거부하는 hook 조건을 더한다. 바꾼 모델은 지시서의 `worker 선택:` 줄을 먼저 고친 뒤 띄운다(지금 「사용 한도에 걸렸을 때」 규칙과 같다).
- **지시서 읽기는 `lib/spec.ts` 한 곳이다.** `worker 선택:` 줄의 새 조각(`행:`, `high 근거:`)과 `experiment:` 줄 해석을 여기 둔다. `spec-lint` 와 `launch-worker` 가 같은 함수를 쓴다(지금 `selectionsOf` 와 같다).
- **띄우기 이력은 새 `lib/launch-history.ts` 가 소유한다.** `<orch 루트>/state/launch-history.jsonl` 에 띄울 때마다 한 줄을 더하고 지우지 않는다. 자동으로 abandon 하고 다시 띄운 dispatch(`launch-worker` 의 `worktree_creating` 멈춤 처리)는 마지막 dispatch 한 줄만 남긴다. 한 `launch-worker` 호출은 이력 한 줄이다. `launched-workers/` 는 지금처럼 정리용 기록으로 남는다. 둘을 합치지 않는 이유: `launched-workers` 는 「정리가 지워야 끝난 것」 이라는 뜻을 이미 갖고 있다(`cleanup-sweep` 의 `forgetLaunch`). 오래 남길 기록을 같은 파일에 두면 그 뜻이 깨진다.
- **routing 기록은 새 `lib/routing-log.ts` 가 소유한다.** 모으기(수집기 묶음)와 쓰기(PR 번호로 한 줄, 원자적 다시 쓰기)를 둔다. `finish-pr` 와 `cleanup-sweep` 은 PR 번호와 결과만 넘긴다. `cleanup-sweep` 은 머지 없이 닫힌 PR 과, 마무리가 빠진 머지 PR(`FINISH-MISSING`)을 쓴다. 두 쓰는 쪽이 같은 PR 에 두 번 써도 멱등이다. 쓰기 실패는 마무리와 정리를 막지 않는다. stderr 에 `ROUTING-LOG-FAIL <PR> <이유>` 한 줄을 남긴다. 기록은 판정이 아니라 관측이라, 기록 실패로 머지 뒤 정리가 멈추면 안 된다.
- **수집기는 출처마다 나눈다.** 하나가 실패하면 그 키만 `null` 이고 나머지는 쓴다.
  - GitHub(`lib/gh.ts` 의 `ghJson`): 리뷰, 커밋, head 별 CI 실행, 머지·닫힘 시각.
  - Orca(`lib/orca.ts` 의 `orcaJson`, `--full`): dispatch 별 받은 메시지(`inbox --terminal dispatch:<id>`)와 그 dispatch 의 이력 줄에 남은 `run` 의 메시지에서 그 dispatch 가 보낸 질문·escalation, 질문 스레드의 답 시각. PR 의 dispatch 들이 서로 다른 Run 에 있어도 dispatch 마다 자기 Run 으로 읽는다. 조회 한도에 닿아 다 읽었다고 증명하지 못하면 그 키를 `null` 로 둔다. `lib/questions.ts` 가 한도를 다루는 방식과 같다.
  - 토큰: Orca 의 사용량 파일(`orca-claude-usage.json`, `orca-codex-usage.json`). 자리는 `ORCA_USAGE_DIR`, 없으면 macOS 의 Orca 앱 데이터 폴더다. 세션의 워크트리와 시작 시각으로 dispatch 에 잇는다(근거 표의 `analyze.py` 와 같은 규칙: 같은 워크트리에서 그 dispatch 를 띄운 때부터 다음 dispatch 를 띄울 때까지 시작한 세션). 공개 계약이 아닌 파일이라 형식이 다르면 `tokens: null` 이다.
  - 지시서: 이력에 남은 지시서 경로에서 `행:` 과 `experiment:` 를 다시 읽지 않는다. 띄울 때 이력에 값으로 남긴다. 머지 때는 지시서가 이미 지워졌을 수 있다.
- **저장소 고유 값은 `config.json` 의 새 `routing` 절에 둔다.** `lib/config.ts` 의 `SECTIONS` 에 `routing` 을, 새 `ROUTING_KEYS` 에 아래 키를 더한다. 모르는 절은 설정 오류라(`loadConfig`), 번들을 올린 뒤에 저장소 설정에 절을 더하라고 `references/overlay.md` 와 PR-C 본문에 적는다. `review_author`(CI 자동 리뷰의 GitHub 로그인), `review_pattern`(첫 리뷰 본문에서 P1~P5 수를 읽는 표 꼴. 기본은 `P1 | P2 | P3 | P4 | P5` 머리의 Markdown 표), `size_pattern`(첫 리뷰 본문에서 크기 등급을 읽는 정규식, 예 `PR 크기 등급: \**([A-D])`). 절이 없으면 `first_review` 와 `size_grade` 가 `null` 이다. `docs/data-schema.md` 의 「config.json 에 더하는 절」 에 적고, 새 상태 파일(`launch-history.jsonl`, `routing-log.jsonl`, `routing-log.lock`)은 같은 문서의 「orch 루트에 더하는 파일」 에 적는다.

## 인터페이스와 데이터

### `worker 선택:` 줄과 `experiment:` 줄

```text
worker 선택: `claude` `claude-opus-5-5` effort `high`. 행: hard-design. high 근거: medium 실패 ctx_ab12cd34. 비교: gpt-6.1-sol high. 이유: ...
worker 선택: `claude` `claude-opus-5-5` effort `high`. 행: hard-design. high 근거: 사용자 지정 2026-11-05. 비교: ... 이유: ...
experiment: review-fix-small. 후보: `claude` `claude-sonnet-5-5` effort `medium` / `codex` `gpt-6.1-sol` effort `medium`.
```

- `Selection` 에 `row: string | null`, `highReason: { kind: 'dispatch', id } | { kind: 'user', date } | null` 을 더한다. `problems` 에 「행」 과 「high 근거」 를 더한다. 「행」 은 모든 새 지시서에 필수다(REQ8). 「high 근거」 는 모델이 `claude-opus-*` 이고 effort 가 `high`, `xhigh`, `max` 이며 실험 후보가 아닐 때만 필수다.
- 백틱 값 해석은 지금과 같다(첫째 에이전트, 둘째 모델). `행:` 과 `high 근거:` 값은 백틱 밖 낱말이라 에이전트·모델 해석에 끼지 않는다.
- `experimentOf(text)` 는 `{ no, name, candidates: {agent, model, effort}[], problems }` 를 낸다. 후보는 `/` 로 나누고 둘 이상이어야 한다. 지시서에 둘 이상이면 `선택` 발견이다.
- `--active` 지시서는 지금처럼 선택 검사를 하지 않는다. 이미 떠 있는 worker 의 옛 지시서가 새 띄우기를 막지 않는다(스펙 REQ8).

### 띄우기 이력 `state/launch-history.jsonl`

```json
{"dispatch":"ctx_…","task":"task_…","run":"run_…","terminal":"term_…","at":"2026-11-05T10:00:00Z","branch":"feat/x","worktree":"/…","spec":"/…/spec-x.md","title":"…","agent":"claude","model":"claude-opus-5-5","effort":"medium","effective":{"agent":"claude","model":"claude-opus-5-5","effort":"medium"},"row":"hard-design","experiment":null,"retry_of":null}
```

- `--terminal` 이어 띄우기는 `--agent`, `--model`, `--effort` 가 없다. 그 터미널의 가장 최근 이력 줄에서 세 값을 물려받는다. 없으면 `null` 이다.
- `effective` 는 `worker-start` 응답의 `launch.effective` 다. 읽지 못하면 `null` 이다.
- 대조(REQ1): 이력에서 `dispatch` 가 같은 줄을 찾는다. `effective.model`(없으면 `model`)이 `claude-opus-*` 이고 effort 가 `medium` 이면 통과다. 이력에 줄이 없어도 `launched-workers/<dispatch>.json` 이 남아 있으면 이력 도입 전의 「모델이 없는 옛 기록」 으로 보아 통과다(스펙 DECISION1). 둘 다 없거나 모델·effort 가 다르면 막는다.
- 다음 후보(REQ6): 이력에서 `experiment` 가 같은 줄을 후보마다 센다. 가장 적은 후보, 같으면 줄에 먼저 적힌 후보가 다음이다. `--retry-of` 로 같은 Task 를 다시 띄운 줄(위 다시 띄우기 꼴)은 세지 않는다. 새 배정이 아니다. 자동 abandon 뒤 다시 띄운 것은 위처럼 한 줄이라 한 번 센다.

### routing 기록 `state/routing-log.jsonl`

스펙 「기록 항목」 의 키를 그대로 쓴다. 더하는 키: `version`(1), `recorded_at`. `dispatches[]` 는 `{dispatch, at, agent, model, effort, effective, experiment, row, retry_of}` 이고 PR 을 연 dispatch 에 `opened_pr: true` 를 둔다(스펙 DECISION19 의 묶음 열쇠).

- 그 PR 의 dispatch 는 이력에서 `branch` 가 PR 의 `headRefName` 이고, `at` 이 PR 의 `createdAt` 보다 앞서며, 같은 브랜치 이름의 앞 PR 이 있으면 그 PR 이 머지되거나 닫힌 시각 뒤인 줄이다. 브랜치 이름을 다시 쓴 앞 PR 의 dispatch 가 섞이지 않게 한다(`cleanup-sweep` 머리 주석 「PR 찾기」 의 같은 실측). 없으면 쓰지 않는다(스펙 DECISION16). PR 을 연 뒤 띄운 dispatch(리뷰 반영, 충돌 해소)는 `at` 이 `mergedAt`(또는 `closedAt`)보다 앞이면 넣는다.
- PR 을 연 dispatch: Orca 메시지에서 그 PR 번호로 `준비됨` 을 처음 보낸 dispatch. 찾지 못하면 PR 생성 시각 직전에 띄운 dispatch.
- `task_row` 는 PR 을 연 dispatch 의 `row` 다.
- 쓰기: 파일 전체를 읽어 같은 `pr` 줄을 찾는다. 없으면 끝에 더하고, 같은 `outcome` 이면 건너뛰고, `closed` → `merged` 면 그 줄을 바꾼다(스펙 DECISION18). 임시 파일에 쓰고 rename 한다. 동시 쓰기는 `lib/events.ts` 의 `acquireLock`(배타 생성과 pid, 죽은 잠금 회수)으로 `state/routing-log.lock` 을 잡는다(기다림 5초, 못 잡으면 `ROUTING-LOG-FAIL`). 같은 잠금을 `reserve-migration` 과 `orch-loop` 가 쓴다.

### `orch routing report`

- 명령 표(`lib/commands.ts`)에 묶음 `routing`, 동작 `report` 를 더한다. 인자: `--repo DIR`(여러 번), `--since YYYY-MM-DD`, `--json`.
- 행: (agent/model, effort, task_row). 열: 표본 수, 준비 중앙(시간), 첫 리뷰 P1·P2 평균, 리뷰 뒤 커밋 평균, CI 실패 평균, 질문 평균, 출력 토큰 중앙, 비용 추정 중앙, 다시 띄운 PR 비율(첫 dispatch 기준). 표본 10건 미만 행은 「표본 적음」 표시.
- 비용 추정의 가격 원본은 `agent-selection.md` 「비교 근거」 표다. PR-A 가 그 표에 `모델 id` 열(`claude-opus-5-5`, `gpt-6.1-sol` 같은 `--model` 값)을 더하고, 명령은 그 열로 기록의 모델을 찾아 $/1M 값을 쓴다. 캐시 읽기·쓰기 배수는 공식 가격 문서의 값을 명령 안 상수로 두고 출처 주석을 단다. 표를 읽지 못하거나 모델이 표에 없으면 그 행의 비용 열은 비운다.
- 짧은 출력: `ROUTING-ROW <행 요약>` 줄. `--full` 이면 Markdown 표.

## 실패와 일관성

- 이력 쓰기 실패는 띄우기를 막지 않는다(지금 `recordLaunch` 실패와 같게 stderr 한 줄). 그 dispatch 는 나중에 근거와 실험 수에서 빠진다. 띄운 worker 를 되돌리는 것이 더 비싸다.
- `finish-pr` 의 기록은 2단계(worker 에 머지를 알리고 끝나기를 기다림) 뒤, 3단계(정리) 앞이다. worker 세션이 끝난 뒤라 토큰이 다 모이고, 정리가 오래 걸리거나 실패해도 기록이 남는다. 정리가 `launched-workers` 를 지워도 이력은 남는다.
- 닫힌 PR 과 마무리가 빠진 머지 PR: `cleanup-sweep` 이 `--run` 없이도 이력의 브랜치로 찾아 기록한다. 조회는 `routing-log.jsonl` 에 아직 줄이 없고 이력 줄의 `at` 이 30일 안인 브랜치만 본다. 정리는 깨어날 때마다 돌고, PR 조회가 루프의 제한 시간을 다 쓴 실측이 있다(`cleanup-sweep` 머리 주석 「일하는 중」). 터미널 닫기 같은 지금 동작의 `--run` 조건은 바꾸지 않는다. 기록만 넓힌다.
- 호환: 옛 `launched-workers` 기록(새 키 없음)은 `readLaunch` 가 그대로 읽는다. 옛 지시서(`행:` 없음)는 이미 떠 있으면 `--active` 라 막지 않는다. 새로 띄우는 옛 지시서는 막힌다. PR-B 를 배포하기 전에 PR-A 가 지시서 쓰는 법을 먼저 알린다.
- 공통 지시서 사본 13개는 PR-A 머지 뒤 `공통` 경고로 드러나고 코디네이터가 옮긴다(스펙 범위 밖).
- orch-cli PR3(스크립트 폴더 이동)과의 순서: PR-A 는 문서와 틀만 고쳐 PR3 과 파일이 겹치지 않는다. PR-B~D 는 `scripts/` 아래를 고치므로 PR3 머지 뒤 PR3 의 폴더 배치(`scripts/<묶음>/`)에 맞춰 쓴다. 명령 표의 경로만 PR3 이 정한 꼴을 따른다.

## 검증 전략

- REQ1, REQ6, REQ8: `spec-lint.spec.ts`, `launch-worker.spec.ts`, `lib-spec.spec.ts` 에 지시서 꼴별 단위 테스트. 이력은 임시 orch 루트(`ORCH_DIR`)에 쓴다. 행 id 표는 실제 `agent-selection.md` 를 읽는 테스트 하나와 가짜 표 테스트.
- REQ2, REQ3: 문서 검사(`scripts/check-skill-docs.py`), `template-script-path.spec.ts` 같은 틀 테스트, `spec-lint` 의 `공통` 경고가 새 표지를 찾는 테스트.
- REQ4: `launch-worker.spec.ts` 의 가짜 `orca` 로 기록과 이력의 키.
- REQ5: `lib-routing-log.spec.ts` 에 가짜 `gh`·`orca`·사용량 파일로 한 줄, 멱등, `closed` → `merged`, 수집기 하나 실패 시 그 키만 `null`. `finish-pr.spec.ts`, `cleanup-sweep-*.spec.ts` 에 부르는 자리.
- REQ7: 고정 `routing-log.jsonl` 두 저장소로 표 값과 「표본 적음」.
- 실제 Orca, 실제 저장소의 PR 로 도는 확인은 PR-C 머지 뒤 첫 머지에서 `routing-log.jsonl` 한 줄을 눈으로 대조한다(인수 검증 계획의 원격 항목).

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 행 id 의 원본 | `agent-selection.md` 모델 표의 `id` 열. `spec-lint` 가 번들의 표를 읽는다 | 작성자 | 값을 한 곳에 둔다. 표를 고치면 검사가 함께 바뀐다 |
| DECISION2 | 오래 남길 띄우기 기록 | 새 `state/launch-history.jsonl`, 지우지 않는다 | 작성자 | 스펙 DECISION15. `launched-workers` 의 「정리가 지운다」 뜻을 지킨다 |
| DECISION3 | 크기 등급과 첫 리뷰를 읽는 법 | `config.json` 의 `routing` 절(`review_author`, `review_pattern`, `size_pattern`). 첫 CI 리뷰 본문에서 읽는다 | 작성자 | 스펙 DECISION13 은 「저장소 크기 기준이 있으면 그 등급」 이다. 등급 계산 규칙이 저장소마다 달라(근거 표의 저장소는 리뷰 본문이 등급을 적는다) orch 가 다시 계산하지 않고 그 저장소가 낸 값을 읽는다. 크기 기준 파일을 orch 가 해석하면 저장소의 계산과 어긋날 수 있다 |
| DECISION4 | 기록 실패의 영향 | 마무리와 정리를 막지 않고 `ROUTING-LOG-FAIL` 한 줄 | 작성자 | 관측 기록이 머지 뒤 정리를 멈추면 안 된다 |
| DECISION5 | 토큰 출처 | Orca 사용량 파일. 형식이 다르면 `null` | 작성자 | 공개 CLI 에 사용량 조회가 없다(`orca orchestration --help`). 근거 표가 같은 파일을 썼다 |
| DECISION6 | PR 나누기 | PR-A 문서·틀, PR-B 지시서 검사·띄우기 이력·다시 띄우기 꼴, PR-C routing 기록 쓰기, PR-D 집계 명령. PR-B 는 orch-cli PR3 머지 뒤 | 작성자 | 지시서(코디네이터 2026-11-05)가 문서 PR 과 PR3 뒤 스크립트 PR 을 나누라고 했다. 스크립트 쪽은 쓰는 쪽(B, C)과 읽는 쪽(D)이 독립이라 PR 하나 크기로 나눈다 |
| DECISION7 | 실험 다시 띄우기 | `--retry-of` 다시 띄우기는 실험 수에 세지 않는다. 자동 abandon 뒤 다시 띄우기는 한 줄이라 한 번 센다 | 작성자 | 같은 Task 다시 띄우기는 배정이 아니다. 독립 검토 발견 4 |
| DECISION8 | 선택 검사 자리 | 공용 `selectionVerdict` 를 `spec-lint` 와 `launch-worker` 차례 0 이 함께 부른다. 차례 0 은 ack 으로 넘기지 못하고 `--effort` 도 대조한다 | 작성자 | 독립 검토 발견 1, 2. `lintGate` 는 ack 과 종료 코드 2 로 넘어간다(`launch-worker.ts` 의 `lintGate`). 스펙 REQ1 은 「launch-worker 가 거부한다」 다 |
| DECISION9 | 같은 Task 다시 띄우기 | `launch-worker` 에 `--task --retry-of` 꼴을 더하고 직접 `worker-start --task` 를 hook 으로 거부한다 | 작성자 | 독립 검토 발견 3. 직접 호출은 이력과 선택 검사를 빠져나가 REQ1 과 「다시 띄운 PR 비율」 이 어긋난다. 우회를 한계로만 적는 안은 REQ1 의 실효를 잃어 고르지 않았다 |
| DECISION10 | 마무리가 빠진 머지 PR | `cleanup-sweep` 이 `FINISH-MISSING` 인 PR 도 `merged` 로 쓴다 | 작성자 | 독립 검토 발견 9. 빠지면 표본이 기운다 |
