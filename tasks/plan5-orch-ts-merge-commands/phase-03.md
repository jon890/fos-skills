# Phase 03. 머지 큐가 before-merge, verify-merged, after-merge, after-queue 를 내고 쌓인 PR 의 base 를 옮긴다

**Execution profile**: deep

## 목표

phase 02 가 옮긴 `merge_queue.ts` 에 이벤트를 더한다. 머지 전 명령, 합친 사본 검사, 머지 뒤 명령을 이벤트 실행기로 돌리고, 머지를 확인한 자리에서 쌓인 내 PR 의 base 를 옮긴 뒤 원격 브랜치를 지운다.

**범위 외**: `config.json` 의 `queue` 절을 명령줄 옵션으로 바꾸는 일과 `!` 를 `--last-of-task` 로 넘기는 일(phase 04 의 `merge-with-finish`). 상주 루프의 `after-queue` 묶기(`pipeline.after_queue_interval_sec`)와 틱의 원격 브랜치 정리.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다(`orch/scripts/merge_queue.ts` 와 `orch/scripts/lib/queue-options.ts` 가 있다).

`merge_queue` 는 `config.json` 을 읽지 않는다. `queue` 절을 `--before`, `--verify-merged`, `--after-merged` 같은 명령줄 옵션으로 바꾸는 것은 `merge-with-finish` 다(`merge-with-finish.py` 의 `QUEUE_KEYS` 와 `def queue_defaults`). 그래서 이 phase 의 `merge_queue.ts` 는 명령줄 값만 legacy 로 넘긴다.
이벤트 실행기는 `lib/events.ts` 의 `fire` 다. 옛 칸은 `ctx.legacy = { key, argv, env }` 로 넘긴다. 같은 이벤트의 핸들러 파일과 legacy 가 함께 있으면 `fire` 가 ConfigError 를 내고 명령은 종료 코드 2 로 바꾼다. 시간 제한은 `EVENTS` 의 기본값이고 `hooks.timeouts.<이벤트>` 가 덮는다. legacy 도 같은 제한, 가드 PATH, `DEPRECATED <key> → hooks/<이벤트>.ts` 줄을 받는다.
옛 칸, 이벤트, 환경 변수와 입력 필드의 대응은 `docs/data-schema.md` 「이벤트별 필드」 아래 대응 표가 소유한다.

`merge-with-finish.py` 는 아직 Python 이고 자기 `VALUE_OPTIONS` 를 가진다. phase 02 가 고친 `test_merge_with_finish.py` 가 그 집합을 `lib/queue-options.ts` 와 비교하므로, 값 옵션을 더하면 두 곳을 함께 고친다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」, 「운영 공백을 막는 곳」 의 원격 브랜치 줄, 「갈래」, `docs/data-schema.md` 의 「이벤트별 필드」 와 대응 표, `docs/code-architecture.md` 의 「코어와 저장소의 경계」 의 원격 브랜치 줄, `docs/adr/009-orch-event-handlers.md`

## 의도 메모

- 핸들러와 legacy 가 함께 있는지는 큐를 시작하기 전에 본다. `after-queue` 는 머지가 끝난 뒤에 나므로 `fire` 의 판정에만 맡기면 앞 PR 이 머지된 뒤에야 사용법 오류로 멈춘다.
- `PR:명령` 은 이벤트가 아니다. 원본처럼 그 PR 에서는 legacy `--before` 를 대신하고, `before-merge` 핸들러와는 별개로 그 뒤에 돈다. 시간 제한 없이 `bash -c` 로 도는 것도 원본과 같다.
- 쌓인 PR: 지우려는 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면 머지한 PR 의 base 로 옮긴 뒤 브랜치를 지운다. 다른 사람의 PR 이 하나라도 있거나 조회가 실패하면 원본처럼 지우지 않는다. GitHub 이 이미 base 를 옮긴 PR 은 `--base <브랜치>` 목록에 나오지 않으므로 따로 다루지 않는다.
- 옛 칸의 시간 제한은 원본에 없던 제약이다. 30분이 넘는 로컬 검사나 배포는 `hooks.timeouts` 로 늘린다. 호환성 안내는 phase 05 의 CHANGELOG 가 적는다.

## 작업 항목

### 1. 이벤트와 legacy

| 이벤트 | 시점 | legacy | 거부와 실패 |
| --- | --- | --- | --- |
| `before-merge` | 체크, 겹침, 합친 사본 검사를 마치고 HEAD 를 대조하기 전. 원본의 머지 전 명령 자리다 | `--before`. 그 PR 이 `PR:명령` 이면 넘기지 않는다 | 거부면 `STOP <PR> HOOK-REJECT`, 실패와 시간 초과면 `STOP <PR> HOOK-FAIL` |
| `verify-merged` | 원본이 합친 사본에서 `--verify-merged` 를 돌리던 자리. 작업 디렉터리는 사본이다 | `--verify-merged` | 거부, 실패, 시간 초과는 원본의 검사 실패와 같은 `STOP` |
| `after-merge` | MERGED 를 확인하고 원격 브랜치 처리(작업 항목 3)를 마친 뒤 | 없음 | `HOOK-FAIL` 줄만 남기고 다음 PR 로 간다 |
| `after-queue` | 원본이 `--after-merged` 를 돌리던 자리. 하나라도 머지했을 때만 | `--after-merged` | `HOOK-FAIL` 줄에 더해 원본의 `AFTER-MERGED-FAILED <종료 코드>` 줄을 낸다. 시간 초과면 `AFTER-MERGED-FAILED timeout` |

legacy 의 `key` 는 옵션 이름(`--before`, `--verify-merged`, `--after-merged`)이다. `argv` 와 `env` 는 원본 실행과 같다.

- `--before`: `['bash', '-c', 명령]`, env 는 `PR`, `BRANCH`, `OWNER`, `REPO`, `GH_HOST`
- `--verify-merged`: `['bash', '-c', 명령, 'verify-merged', <사본>]`, env 는 원본 `def verify_merged` 의 `MERGE_COPY`, `PR`, `PR_HEAD`, `BASE_HEAD`, `CHANGED_FILES`, `OVERLAP_FILES`. `ctx.cwd` 는 사본이다
- `--after-merged`: `['bash', '-c', 명령]`, env 는 `MERGED_PRS`, `CODE_PRS`

`before-merge` 와 `PR:명령` 은 원본의 `p.before_head` 처럼 같은 HEAD 에 한 번만 돈다. base 가 움직여 다시 판정해도 HEAD 가 같으면 다시 내지 않는다.
`hooks/verify-merged.ts` 가 있으면 `--verify-merged` 를 준 것과 같이 겹침 판정을 켜고 `--verify-merged-when code|always` 를 받는다. 핸들러만 있고 옵션이 없을 때 사본 검사가 빠지지 않게 한다.

이벤트 입력은 `docs/data-schema.md` 의 필드다. `pr` 을 채우려고 PR 조회 필드에 `title`, `author`, `isDraft` 를 더한다. `run` 은 null, `base` 는 그 PR 의 base 다.

### 2. 시작 전 검사와 `--last-of-task`

- 큐를 시작하기 전에, 받은 legacy 옵션마다 `lib/events.ts` 의 `handlerFile(<이벤트>, repo)` 가 있으면 `fire` 와 같은 문구를 stderr 에 내고 종료 코드 2 로 끝난다. gh 머지 호출은 없다
- `--last-of-task PR` 을 더한다. 여러 번 준다. `before-merge` 입력의 `last_of_task` 는 그 PR 이 목록에 있을 때 true 다. 큐에 없는 번호면 사용법 오류다
- `--last-of-task` 를 `lib/queue-options.ts` 의 `QUEUE_VALUE_OPTIONS` 와 `merge-with-finish.py` 의 `VALUE_OPTIONS` 에 함께 더한다. `merge-with-finish.py` 는 아직 이 옵션을 만들어 넘기지 않는다

### 3. 쌓인 PR 의 base 옮기기와 원격 브랜치 삭제

원본 `def delete_branch` 의 release 브랜치, fork PR, `--keep-branch` 판정은 그대로다. 그 뒤를 바꾼다.

1. `gh pr list --state open --base <브랜치> --json number,author,url` 로 그 브랜치를 base 로 둔 열린 PR 을 읽는다. 실패하면 원본처럼 남긴다
2. 하나라도 내 PR 이 아니면 남긴다. 작성자 목록은 phase 01 의 `lib/gh.ts` `ownAuthors(repo, <PR URL 의 호스트>)` 다. null 이면 남긴다
3. 모두 내 PR 이면 각각 `gh pr edit <n> --base <머지한 PR 의 base>` 를 부른다. 하나라도 실패하면 남긴다
4. 남은 열린 PR 이 없으면 원본처럼 `git push origin --delete` 와 `fetch --prune` 을 한다

`after-merge` 입력의 `retargeted` 는 base 를 옮긴 PR 번호 목록, `remote_branch_deleted` 는 지웠는지다.

### 4. 종료 코드

원본 종료 코드는 0 모두 머지, 1 멈춤이나 보류, 2 사용법 오류, 3 모두 머지했지만 `--after-merged` 가 실패다. 3 이 「일부를 처리하지 못했다」 를 뜻하므로 알림 이벤트 실패도 여기에 반영한다.

| 상황 | 종료 코드 |
| --- | --- |
| 모두 머지했고 `after-merge` 나 `after-queue` 가 하나라도 실패하거나 시간을 넘겼다 | 3 |
| 보류한 PR 이 있다 | 1. 3 보다 우선한다 |
| 핸들러와 legacy 가 함께 있다, `--last-of-task` 가 큐에 없는 번호다 | 2 |

머리 주석의 종료 코드와 옵션 설명을 이 표와 `--last-of-task` 에 맞춘다.

### 5. `docs/data-schema.md`

대응 표 아래 「`PR번호:명령` 형식은 그대로 둔다 … `before-merge` 핸들러 다음에 돈다」 문단에 「명령줄 `--before` 가 있으면 그 PR 에서는 `PR번호:명령` 이 대신한다」 를 더한다.

### 6. 테스트

`orch/tests/merge-queue.spec.ts` 에 더한다. 핸들러가 받은 입력은 핸들러가 stdin 을 파일에 적게 해서 본다.

- `hooks/before-merge.ts` 가 10 이면 `STOP <PR> HOOK-REJECT` 이고 gh 머지 호출이 없다
- `--last-of-task 1` 이면 PR 1 의 입력은 `last_of_task: true`, PR 2 는 false 다
- `--before` 와 `hooks/before-merge.ts` 가 함께 있으면 종료 코드 2 이고 gh 머지 호출이 없다
- `--after-merged` 와 `hooks/after-queue.ts` 가 함께 있으면 첫 PR 을 머지하기 전에 종료 코드 2 다
- legacy `--before` 는 `DEPRECATED --before → hooks/before-merge.ts` 줄과 함께 `PR`, `BRANCH`, `OWNER`, `REPO`, `GH_HOST` 를 받는다
- `--before X` 와 `1:Y` 를 함께 주면 PR 1 에서는 Y 만, PR 2 에서는 X 만 돈다
- `hooks/before-merge.ts` 와 `1:Y` 가 있으면 PR 1 에서 핸들러 다음에 Y 가 돈다
- `hooks.timeouts.before-merge` 를 1 로 두고 legacy `--before 'sleep 5'` 면 `HOOK-FAIL before-merge timeout` 과 `STOP` 이다
- `hooks/verify-merged.ts` 만 있고 `--verify-merged` 가 없어도 겹친 PR 의 사본에서 그 핸들러가 돌고, 입력의 `copy` 와 작업 디렉터리가 같다
- 내 PR 이 머지한 브랜치를 base 로 두면 `gh pr edit <n> --base main` 뒤에 `git push -q origin --delete` 가 불리고 `after-merge` 입력이 `retargeted: [<n>]`, `remote_branch_deleted: true` 다
- 다른 사람의 PR 이 base 로 두면 `gh pr edit` 와 원격 삭제가 없고 `remote_branch_deleted: false` 다
- `hooks/after-merge.ts` 가 1 이면 `HOOK-FAIL` 줄이 나고 다음 PR 도 머지하며 종료 코드 3 이다
- `hooks/after-queue.ts` 가 1 이면 `AFTER-MERGED-FAILED 1` 과 종료 코드 3 이다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/merge-queue.spec.ts orch/tests/merge-queue-overlap.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_merge_with_finish.py
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py docs/data-schema.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/merge_queue.ts` | 수정 |
| `orch/scripts/lib/queue-options.ts` | 수정 |
| `orch/scripts/merge-with-finish.py` | 수정 |
| `orch/tests/merge-queue.spec.ts` | 수정 |
| `docs/data-schema.md` | 수정 |
