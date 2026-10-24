# Phase 01. 단위 겹침 판정, ready 전환, 충돌 알림을 옮기고 충돌 판정을 하나로 합친다

**Execution profile**: deep

## 목표

`overlap_units`, `ci-ready`, `notify-conflicts` 를 TypeScript 로 옮긴다. 충돌 판정을 `lib/git.ts` 의 merge-tree 한 벌로 합치고, 열린 PR 의 충돌 찾기와 알린 기록을 `lib/conflicts.ts` 에 둔다. `before-ready`, `pr-ready`, `pr-conflict` 를 낸다.

**범위 외**: 상주 루프가 틱마다 충돌을 보는 일. 상주 루프는 이 phase 가 만든 `lib/conflicts.ts` 를 함께 쓸 뿐이다. 충돌 PR 에 새 워크트리나 새 worker 를 따로 띄우는 일은 어디서도 하지 않는다(docs/code-architecture.md 「사용자 결정」 의 충돌한 PR 줄). `overlap_units.py` 를 shim 으로 바꾸는 일은 phase 02 가 한다.

## 컨텍스트

시작 조건: `orch/scripts/send-to-worker.ts` 와 `orch/scripts/lib/events.ts` 가 있다. 없으면 `PHASE_BLOCKED: send-to-worker.ts 나 lib/events.ts 가 없다` 를 내고 멈춘다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/overlap_units.py` | 판정은 `orch/scripts/lib/overlap.ts`, 명령은 `orch/scripts/overlap_units.ts` | `orch/tests/test_overlap_units.py` 의 사례 → `orch/tests/overlap-units.spec.ts`. 원본 테스트는 phase 02 에서 지운다 |
| `orch/scripts/ci-ready.py` | `orch/scripts/ci-ready.ts` | `orch/tests/test_ci_ready.py` → `orch/tests/ci-ready.spec.ts` |
| `orch/scripts/notify-conflicts.py` | `orch/scripts/notify-conflicts.ts`, 충돌 찾기와 알린 기록은 `orch/scripts/lib/conflicts.ts` | `orch/tests/test_launch_send.py` 의 `NotifyConflictsTest` → `orch/tests/notify-conflicts.spec.ts` |

`merge_queue.py` 는 아직 Python 이고 `overlap_units.py` 를 import 하고 명령으로도 부른다. 그래서 이 phase 는 `overlap_units.py` 와 `orch/tests/test_overlap_units.py` 를 그대로 둔다.
`ci-ready.py` 는 GitHub 의 `mergeable` 로 충돌을 보고, `notify-conflicts.py` 는 merge-tree 로 본다. 두 명령 모두 `lib/git.ts` 의 `conflicts(repo, base, head)` 를 쓴다. PR HEAD 를 받는 방법은 `notify-conflicts.py` 의 `def conflicts` 와 같다. 로컬에 그 커밋이 없으면 cross repo PR 은 `refs/pull/<번호>/head` 를, 아니면 `headRefName` 을 origin 에서 fetch 한다.

「내 PR」 판정은 `lib/gh.ts` 의 `isOwnPr` 이다. 작성자 목록은 `config.json` 의 `pipeline.authors`, 없으면 `currentUser(host)` 다.
`lib/config.ts` 의 `section` 은 `known` 에 없는 키에 ConfigError 를 낸다. 그래서 pipeline 절은 아는 키 전부를 `PIPELINE_KEYS` 로 넘긴다. `authors` 하나만 넘기면 `pipeline.enabled` 를 둔 저장소에서 사용법 오류로 멈춘다.
`host` 는 PR URL 에서 읽는다. `gh api` 는 origin 을 보지 않고 기본 호스트로 가므로(`ci-ready.py` 머리 주석, `def api_target`) GitHub Enterprise 저장소에서 다른 사용자가 오거나 null 이 된다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/send-to-worker.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 만 부른다. node 22.18 확인(낮으면 `NODE-TOO-OLD` 줄과 종료 코드 127), stderr 의 `DEPRECATED python3 <이름>.py → node --disable-warning=ExperimentalWarning <대상>` 줄, exec 는 `orch/scripts/ts_shim.py` 가 맡는다. `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `ci-ready.py`, `notify-conflicts.py` 다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `before-ready`, `pr-ready`, `pr-conflict` 줄과 「갈래」, `docs/data-schema.md` 의 「이벤트별 필드」 와 「config.json 에 더하는 절」, `docs/code-architecture.md` 의 「배치」, 「코어와 저장소의 경계」 의 충돌 판정 줄과 충돌한 PR 줄, 「공통 안전 장치」 의 다른 사람 PR 제외 줄, `orch/references/replying.md` 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」

## 의도 메모

- GitHub `mergeable` 은 계산이 늦어 `UNKNOWN` 이 나오고, 두 명령이 같은 PR 을 다르게 판정하는 일이 생겼다. 로컬 merge-tree 는 원격을 fetch 한 뒤 바로 답한다. 그래서 `ci-ready` 의 `UNKNOWN` 재시도와 `ORCH_READY_RETRY_SECONDS` 는 없어진다.
- 같은 워크트리에서 터미널을 바꿔 다시 띄우는 send-to-worker 의 `agent_unconfigured` 경로도 이어 받기로 본다. 워크트리와 터미널 수가 늘지 않는다(`orch/references/replying.md` 의 같은 절). 그래서 `send-to-worker.ts` 는 고치지 않는다.
- `send-to-worker.ts` 의 종료 코드 1 은 경로마다 뜻이 다르다. 살아 있는 dispatch 에서는 reply 를 남기고 깨우지 못한 것이고, 끝난 dispatch 에서는 다시 띄우기가 실패한 것이다. 원본 `notify-conflicts.py` 는 `DELIVERED = {0, 1, 4}` 로 reply 가 남은 1 을 기록했다. 살아 있는 경로의 1 을 기록하지 않으면 다음 실행이 같은 reply 를 또 보낸다.
- 지시서 이름 규칙은 `spec-<이름>.md` 이고 정리 경로(`cleanup-sweep.py`, `handoff-cleanup.py`, `finish-pr.py`)는 이 이름만 본다. 그래서 후속 지시서 이름을 `spec-conflict-...` 로 둔다.

## 작업 항목

### 1. `orch/scripts/lib/config.ts` 에 `PIPELINE_KEYS`

`export const PIPELINE_KEYS: readonly string[]` 를 더한다. 값은 `docs/data-schema.md` 「config.json 에 더하는 절」 표의 pipeline 행 키 전부다. 명령은 `section(config, 'pipeline', PIPELINE_KEYS)` 로 읽는다. 머리 주석의 「hooks 절만 HOOKS_KEYS 를 쓴다」 를 pipeline 절과 함께 고친다.

`orch/tests/lib-config.spec.ts` 에 더한다: pipeline 절에 `enabled` 와 `authors` 가 함께 있으면 `section` 이 통과한다. 모르는 키(`authorz`)는 ConfigError 다.

### 2. `orch/scripts/lib/gh.ts` 에 PR URL 풀이와 작성자 목록

- `apiTarget(url: string): { host: string; slug: string } | null`. `ci-ready.py` 의 `def api_target` 을 옮긴다
- `ownAuthors(repo: string, host: string): string[] | null`. `loadConfig(repo)` 의 `section(…, 'pipeline', PIPELINE_KEYS).authors` 가 비지 않은 문자열 목록이면 그것, 없으면 `currentUser(host)` 하나다. 둘 다 없으면 null 이다. 타입이 틀리면 ConfigError 다

명령은 null 을 조회 실패(종료 코드 2)로 다룬다. 누가 내 PR 인지 모른 채 다른 사람 PR 에 알리거나 ready 로 바꾸지 않는다.
`orch/tests/lib-gh.spec.ts` 에 더한다: GHE URL 에서 호스트와 `owner/repo`, 깨진 URL 은 null. `pipeline.authors` 가 있으면 gh 를 부르지 않는다. 없으면 `GH_HOST=<host>` 로 `api user` 를 부른다.

### 3. `orch/scripts/lib/py.ts` 에 `pyRegExp`

`pyRegExp(source: string): RegExp` 를 더한다. Python `re` 의 정규식 글자를 같은 뜻의 JS RegExp 로 바꾼다.

- `(?P<이름>` 은 `(?<이름>`, `(?P=이름)` 은 `\k<이름>`, `\A` 는 `^`, `\Z` 는 `$` 로 바꾼다. 앞의 역슬래시가 짝수 개면 이스케이프된 글자라 바꾸지 않는다
- 바꾼 글자를 `new RegExp` 가 거부하면(인라인 플래그 `(?i)` 같은 것) 원문과 이유를 담은 Error 를 낸다

새 `orch/tests/lib-py.spec.ts` 를 만든다: 바꾸는 글자마다 하나, `\\A` 는 그대로, `(?i)abc` 는 Error.

### 4. `orch/scripts/lib/overlap.ts` 와 `orch/scripts/overlap_units.ts`

`overlap_units.py` 의 판정(`unit_of`, `group_map`, `is_doc`, `judge`)은 `lib/overlap.ts` 로, git 조회와 명령줄은 `overlap_units.ts` 로 옮긴다. 옵션, 출력 한 줄(`바로 머지`, `갱신 필요(이유)`), 종료 코드(0, 1, 2)는 원본 머리 주석과 같다.
`--shared-paths` 는 `pyRegExp` 로 읽는다. Error 면 원본의 잘못된 정규식과 같이 `오류: ...` 와 종료 코드 2 다.

### 5. `orch/scripts/lib/conflicts.ts`

`notify-conflicts.py` 의 충돌 찾기와 알린 기록을 옮긴다. 상주 루프가 함께 쓰므로 명령에 두지 않는다.

- `fetchPrHead(repo, pr)`: 위 「컨텍스트」 의 PR HEAD 받기. `ci-ready.ts` 도 쓴다
- `findConflicts(repo, base)`: `git fetch -q origin`, `origin/<base>` 의 SHA, 열린 PR 목록(`number,title,headRefName,headRefOid,isCrossRepository,isDraft,author,url`), PR 마다 `fetchPrHead` 와 `conflicts`. fetch 실패, base 없음, gh 실패, 합쳐 보지 못함은 `{ ok: false, error }` 다
- 알린 기록: 파일은 원본과 같은 `state/notify-conflicts.json` 이고 키도 원본과 같은 `<PR>@<base SHA>` 다. 값은 notified 와 resumed 면 dispatch id, orphan 이면 `orphan` 이다. 쓰기는 `lib/paths.ts` 의 `makeParent` 를 거친다

### 6. `orch/scripts/ci-ready.ts`

옵션, 출력 줄, 종료 코드(0 모두 ready, 1 보류, 2 사용법 오류나 조회 실패)는 원본 머리 주석과 같다. PR 마다 받은 순서대로 판정한다.
`gh pr view` 필드에 `title,author,headRefName,headRefOid,isCrossRepository` 를 더한다. 작성자 목록은 PR URL 의 호스트로 `ownAuthors` 에서 받고, null 이면 조회 실패다.

1. OPEN 이 아니면 보류, 이미 ready 면 건너뛴다
2. 내 PR 이 아니면 `<PR> 보류: 내 PR 이 아니다(작성자 <login>)`
3. `git fetch -q origin` 과 `origin/<baseRefName>` 확인. 실패하면 조회 실패(종료 코드 2)
4. `fetchPrHead` 와 `conflicts`. 충돌이면 원본 문구 `보류: base 와 충돌한다. worker 가 base 를 합친 뒤 다시 돌린다` 다. `ok: false` 면 `보류: 충돌 여부를 판정하지 못했다: <error>` 이고 종료 코드는 원본의 보류(1)다
5. 파일 수 한도와 ready PR 겹침은 원본 그대로다. 겹침은 작성자와 관계없이 같은 base 의 ready PR 모두와 본다
6. `before-ready` 를 낸다. 거부, 실패, 시간 초과면 `HOOK-*` 줄에 더해 `<PR> 보류: before-ready 가 막았다` 다
7. `gh pr ready` 뒤 `pr-ready` 를 낸다. 실패는 `HOOK-FAIL` 줄만 남기고 종료 코드에 반영하지 않는다(작업 항목 8)

`--dry-run` 은 이벤트를 내지 않는다. 핸들러가 바깥에 부작용을 낼 수 있어서다.
이벤트 입력은 `docs/data-schema.md` 의 `before-ready`, `pr-ready` 필드다. `ready_count` 는 같은 base 의 이미 ready 인 내 PR 수, `slots` 는 `pipeline.ready_slots`(없으면 1)다. `run` 은 null 이다.

### 7. `orch/scripts/notify-conflicts.ts`

옵션, 출력 줄, 종료 코드(0 충돌한 내 PR 이 없다, 1 있다, 2 사용법 오류나 조회 실패)는 원본 머리 주석과 같다. 다른 사람 PR 은 줄도 내지 않고 종료 코드에도 세지 않는다.
충돌한 내 PR 마다 원본처럼 `#<PR> CONFLICTING <브랜치>: 파일...` 을 낸다. 기록에 있으면 `이미 알렸다(<값>)` 로 넘어간다. 처음 보면 아래처럼 다룬다.

1. 그 브랜치의 워크트리와 dispatch 를 원본 `def worker_for` 처럼 찾는다(살아 있는 것을 먼저 고른다). 워크트리나 dispatch 가 없으면 orphan 이다
2. dispatch 가 살아 있으면 원본 본문을 `send-to-worker.ts --dispatch <id> --body <본문> [--run]` 으로 보낸다. 살아 있는 dispatch 에 `--spec` 만 주면 send-to-worker 가 종료 코드 2 로 거부한다
3. dispatch 가 끝났으면 후속 지시서를 쓰고 `send-to-worker.ts --dispatch <id> --spec <지시서> [--run]` 로 보낸다. `--body` 는 주지 않는다
4. 아래 표로 기록하고 `pr-conflict` 를 낸다. 기록하지 않은 경우에는 이벤트도 내지 않는다. 다음 실행이 다시 본다

후속 지시서는 `lib/paths.ts` 의 지시서 폴더에 `spec-conflict-<PR>-<base SHA 앞 8자리>.md` 로 쓴다.

- 첫 줄은 공통 지시서 `<지시서 폴더>/spec-common.md` 의 절대경로를 먼저 읽으라는 줄이다. 그 파일이 없으면 이 줄 없이 쓰고 stderr 에 경고 한 줄을 낸다
- `` 브랜치: `<PR 브랜치>` `` 줄과 `허락: push 는 허락됐다. PR 은 이미 있으므로 새로 열지 않는다` 줄을 둔다
- 할 일: `origin/<base>` 를 합쳐 충돌 파일을 풀고, 저장소 검증 명령을 돌리고, push 한 뒤 status 로 알린다. 충돌 파일 목록을 적는다

| send-to-worker 종료 코드 | 살아 있는 dispatch(`--body`) | 끝난 dispatch(`--spec`) | 기록 | 출력 |
| --- | --- | --- | --- | --- |
| 0 | `notified` | `resumed`. `agent_unconfigured` 로 같은 워크트리에 다시 띄운 것도 여기다 | 한다 | `<dispatch> 에 알렸다` |
| 4 | `notified`. 보냈지만 깨우지 못했다 | `resumed`. 이 경로에서는 나지 않는다 | 한다 | 알림 줄 끝에 `(깨우지 못했다, 종료 코드 4)` |
| 1 | `notified`. reply 는 남았고 깨우지 못했다(원본 `DELIVERED`) | 보내지 못했다 | 살아 있는 경로만 한다 | 끝난 경로는 원본의 `보내지 못했다(… 종료 코드 1)` 줄, stderr 에 이유 |
| 3 | `orphan` | `orphan` | 한다. 같은 (PR, base SHA) 로 다시 알리지 않는다 | `CONFLICT-ORPHAN <PR> <이유>` |
| 5 | 보내지 못했다 | 보내지 못했다 | 하지 않는다 | `보내지 못했다(… 종료 코드 5)`, stderr 에 이유 |
| 2 | 사용법 오류 | 사용법 오류 | 하지 않는다 | 그 자리에서 멈추고 명령 종료 코드 2 |

워크트리나 dispatch 를 찾지 못한 경우도 `orphan` 이고 기록한다. 새 worker 는 어느 경우에도 띄우지 않는다.
`--dry-run` 은 후속 지시서를 쓰지 않고, 보내지 않고, 이벤트를 내지 않고, 기록하지 않는다. 원본처럼 `<dispatch> 에 알릴 것: …` 를, 끝난 dispatch 면 `<dispatch> 에 이어 쓸 것: <지시서 경로>` 를 낸다.
`pr-conflict` 입력은 `docs/data-schema.md` 의 필드다. `worker` 는 찾은 dispatch 의 행에서 채우고(`spec` 은 후속 지시서 경로, 없으면 null) 워크트리나 dispatch 가 없으면 null 이다. 실패는 `HOOK-FAIL` 줄만 남긴다(작업 항목 8).

### 8. 알림 이벤트 실패와 종료 코드

`docs/flow.md` 「갈래」 는 알림 이벤트 실패를 명령 종료 코드에 반영하고, 반영하지 않는 명령을 목록으로 둔다. 원본 종료 코드에는 「일부를 처리하지 못했다」 를 뜻하는 값이 없다.

| 명령 | 원본 종료 코드 | 알림 이벤트 | 반영 |
| --- | --- | --- | --- |
| `ci-ready` | 0 모두 ready, 1 보류, 2 사용법 오류나 조회 실패 | `pr-ready` | 하지 않는다. 종료 코드가 코디네이터의 ready 판정 계약이다. 0 을 다른 값으로 바꾸면 이미 ready 로 바뀐 PR 을 보류로 읽는다 |
| `notify-conflicts` | 0 충돌 없음, 1 충돌 있음, 2 사용법 오류나 조회 실패 | `pr-conflict` | 하지 않는다. 이 이벤트는 충돌한 PR 이 있을 때만 나서 종료 코드가 이미 1 이다. 따로 나타낼 값이 없다 |

`docs/flow.md` 「갈래」 의 「나머지 이벤트의 핸들러가 실패하거나 시간을 넘긴다」 줄에서 반영하지 않는 명령 목록에 ready 전환과 충돌 알림을 더하고 위 이유를 한 문장씩 적는다.

### 9. 문서

- `orch/README.md`: `scripts/ci-ready.ts`, `scripts/notify-conflicts.ts`, `scripts/overlap_units.ts` 줄을 더하고 `ci-ready.py`, `notify-conflicts.py` 줄을 그 줄로 바꾼다. 「옛 경로. 다음 major 에서 지운다」 줄에 `scripts/ci-ready.py`, `scripts/notify-conflicts.py` 를 더한다
- `docs/code-architecture.md` 「배치」: `orch/scripts/lib/overlap.ts` 줄(단위 겹침 판정. `overlap_units` 와 머지 큐가 쓴다)을 `lib/conflicts.ts` 줄 앞에 더한다

### 10. 테스트

`orch/tests/overlap-units.spec.ts`, `orch/tests/ci-ready.spec.ts`, `orch/tests/notify-conflicts.spec.ts` 를 만든다. `test_ci_ready.py` 와 `test_launch_send.py` 는 지운다. `test_launch_send.py` 에는 `NotifyConflictsTest` 와 그 바탕 클래스 `FakeBase` 만 남아 있어 파일째 지운다.

`overlap-units.spec.ts`: `test_overlap_units.py` 의 사례를 모두 옮긴다. `--shared-paths '(?P<m>modules/core)/'` 가 공용 경로로 맞는 사례를 더한다.

`ci-ready.spec.ts`: 임시 git 저장소와 bare origin 을 만들고 가짜 gh 의 `headRefOid` 에 실제 커밋을 넣는다. 원본의 `mergeable` 사례(`test_conflict_with_base_is_held`, `test_unknown_mergeable_is_retried_then_readied`, `test_still_unknown_is_held`)은 merge-tree 판정 사례로 바꾼다. 나머지 사례는 그대로 옮긴다.

- gh 가 `MERGEABLE` 인데 merge-tree 가 충돌이면 보류하고 `pr ready` 호출이 없다
- gh 가 `CONFLICTING` 인데 merge-tree 가 충돌이 아니면 ready 로 바꾼다
- PR HEAD 가 로컬에 없으면 `refs/pull/<번호>/head` 를 fetch 해 판정한다(cross repo PR, origin 에 그 ref 를 push 해 둔다)
- 받을 수 없는 `headRefOid` 는 `충돌 여부를 판정하지 못했다` 보류와 종료 코드 1
- 다른 작성자 PR 은 보류, `pipeline.authors` 에 든 작성자는 ready
- `hooks/before-ready.ts` 가 10 이면 `HOOK-REJECT` 줄과 보류, `pr ready` 호출이 없다
- `hooks/pr-ready.ts` 가 1 이면 `HOOK-FAIL` 줄이 나고 종료 코드는 0 이다
- `--dry-run` 은 핸들러를 부르지 않는다

`notify-conflicts.spec.ts`: 원본 사례를 옮긴다. `test_undelivered_message_is_not_recorded`(FAKE_EXIT=3)는 위 표로 바뀐다. 3 은 `CONFLICT-ORPHAN` 과 기록이 되어 두 번째 실행이 보내지 않는다. 「기록하지 않는다」 는 다음 두 사례가 이어 받는다. 살아 있는 dispatch 에 5, 끝난 dispatch 에 1 이면 두 번째 실행이 다시 보낸다.

- 살아 있는 dispatch 에 1 이면 기록하고 두 번째 실행이 보내지 않는다
- 끝난 dispatch 만 있으면 `spec-conflict-7-<8자리>.md` 가 생긴다. 그 파일에 브랜치 줄, 허락 줄, 공통 지시서 줄이 있다. send 대역은 `--spec` 과 함께 `--body` 없이 불리고 `pr-conflict` 입력의 `action` 은 `resumed` 다
- 공통 지시서가 없으면 stderr 에 경고가 나고 지시서에 공통 지시서 줄이 없다
- 워크트리가 없으면 send 대역이 불리지 않고 `CONFLICT-ORPHAN` 과 `action: orphan`, `worker: null` 이다
- 다른 작성자 PR 은 줄도 알림도 없고, 그것만 충돌하면 종료 코드 0 이다
- `--dry-run` 은 지시서, 기록 파일, 핸들러 실행을 남기지 않는다
- `hooks/pr-conflict.ts` 가 1 이면 `HOOK-FAIL` 줄이 나고 종료 코드는 1 그대로다

핸들러가 받은 입력은 핸들러가 stdin 을 파일에 적게 해서 본다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-config.spec.ts orch/tests/lib-gh.spec.ts orch/tests/lib-py.spec.ts orch/tests/overlap-units.spec.ts orch/tests/ci-ready.spec.ts orch/tests/notify-conflicts.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_overlap_units.py
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/README.md docs/flow.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/config.ts` | 수정 |
| `orch/scripts/lib/gh.ts` | 수정 |
| `orch/scripts/lib/py.ts` | 수정 |
| `orch/scripts/lib/overlap.ts` | 신규 |
| `orch/scripts/lib/conflicts.ts` | 신규 |
| `orch/scripts/overlap_units.ts` | 신규 |
| `orch/scripts/ci-ready.ts` | 신규 |
| `orch/scripts/notify-conflicts.ts` | 신규 |
| `orch/scripts/ci-ready.py` | 수정 |
| `orch/scripts/notify-conflicts.py` | 수정 |
| `orch/tests/lib-config.spec.ts` | 수정 |
| `orch/tests/lib-gh.spec.ts` | 수정 |
| `orch/tests/lib-py.spec.ts` | 신규 |
| `orch/tests/overlap-units.spec.ts` | 신규 |
| `orch/tests/ci-ready.spec.ts` | 신규 |
| `orch/tests/notify-conflicts.spec.ts` | 신규 |
| `orch/tests/test_ci_ready.py` | 삭제 |
| `orch/tests/test_launch_send.py` | 삭제 |
| `orch/README.md` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
