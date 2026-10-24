# Phase 05. 옮기기 명령에 설정 칸을 핸들러로 바꾸는 기능을 더하고 머지 문서를 맞춘다

**Execution profile**: deep

## 목표

`migrate-orch-dir` 를 TypeScript 로 옮기고 `--hooks` 모드를 더한다. `config.json` 의 옛 셸 명령 칸을 같은 동작의 핸들러 파일로 바꾼다.
머지 단계 문서와 CHANGELOG 가 이 plan 의 새 명령, 이벤트, 지울 설정 키, 호환성 변경을 가리키게 한다.

**범위 외**: 정리 명령과 상주 루프. `orch/scripts/lib/paths.ts` 의 `MIGRATE` 는 shim 경로(`migrate-orch-dir.py`)를 그대로 가리킨다.

## 컨텍스트

시작 조건: 이 plan 의 phase 04 가 커밋됐다(`merge-with-finish.ts`, `finish-pr.ts` 가 있다).

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/migrate-orch-dir.py` | `orch/scripts/migrate-orch-dir.ts` | `orch/tests/test_migrate_orch_dir.py` → `orch/tests/migrate-orch-dir.spec.ts` |

원본의 막는 조건(`def blockers`, 종료 코드 3)은 살아 있는 dispatch, 워크트리 터미널을 쥔 worker, orca 조회 실패, `BUSY` 정규식에 맞는 프로세스다. `BUSY` 는 `merge-queue.sh`, `merge_queue.py`, `merge-with-finish.py`, `finish-pr.py` 다. 옮긴 명령의 ps 명령줄은 `node … <이름>.ts` 이므로 새 명령은 같은 이름의 `.ts` 도 찾는다. `merge-queue.sh` 는 남아 있으므로 빼지 않는다.
옛 구조 판정은 `lib/paths.ts` 의 `legacyPaths` 다. 옛 위치의 설정은 `.claude/orch-finish.json` 이다.

옛 칸, 이벤트, 환경 변수 대응은 `docs/data-schema.md` 의 대응 표가 소유한다. 옛 칸을 legacy 로 돌리는 곳은 phase 03 의 `merge_queue.ts` 와 phase 04 의 `finish-pr.ts` 다. `--hooks` 가 만드는 핸들러는 그 legacy 실행과 같은 argv, 환경 변수, 작업 디렉터리로 옛 명령을 부른다. 동작이 옮기기 전과 같아야 사용자가 나중에 핸들러를 고칠 수 있다.
만든 핸들러는 사용자 저장소의 `.orch/hooks/` 에 있고 설치 캐시의 경로가 바뀌므로 `orch/scripts/lib/` 를 import 하지 않는다. 필요한 값은 만들 때 풀어 파일에 적는다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/send-to-worker.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 만 부른다. node 22.18 확인(낮으면 `NODE-TOO-OLD` 줄과 종료 코드 127), stderr 의 `DEPRECATED python3 <이름>.py → node --disable-warning=ExperimentalWarning <대상>` 줄, exec 는 `orch/scripts/ts_shim.py` 가 맡는다. `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `migrate-orch-dir.py` 다. `orch_paths.py` 와 `lib/paths.ts` 가 이 경로를 안내 문구에 쓰고, shim 이 있으므로 그 안내는 계속 동작한다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다.
`scripts/tests/test_doc_script_refs.py` 는 문서가 부르는 `$SKILL_DIR/scripts/*` 경로가 실제로 있는지 본다. 이 phase 가 문서의 호출을 `.ts` 로 바꾸므로 검증에 넣는다.

**근거 문서**: `docs/data-schema.md` 의 「config.json 에 더하는 절」 의 지울 키 표와 대응 표, `docs/flow.md` 의 「갈래」 의 옛 셸 명령 칸 두 줄, `docs/code-architecture.md` 의 「orch 문서가 소유하는 것」, `docs/adr/008-orch-own-dir.md`

## 의도 메모

- `--hooks` 는 폴더 옮기기와 따로 도는 모드다. 둘을 한 번에 하면 옮기다 멈췄을 때 어느 쪽이 끝났는지 가리기 어렵다.
- 기본은 미리보기다. `--apply` 와 함께 줄 때만 핸들러 파일을 쓰고 설정에서 그 키를 지운다. 핸들러 파일이 이미 있으면 덮지 않고 겹침으로 알린다(종료 코드 1).
- 설정 파일과 핸들러를 저장소에 추적하는지(`git ls-files`)에 따라 `git add -f` 명령을 보인다. 공개 저장소에 올리면 안 되는 값이 있을 수 있어 직접 커밋하지 않는다.

## 작업 항목

### 1. `migrate-orch-dir.ts`

원본 옵션, 출력, 종료 코드(0, 1, 2, 3)를 옮긴다. 막는 조건의 프로세스 정규식에 `.ts` 이름을 더하고 머리 주석을 맞춘다.

### 2. `--hooks` 모드

`migrate-orch-dir.ts --hooks [--repo DIR] [--run RUN] [--apply]`. `--move` 와 함께 주면 사용법 오류(2)다.

1. `legacyPaths(repo)` 가 비지 않으면(옛 위치에 `.claude/orch-finish.json` 같은 것이 남았다) 아무것도 고치지 않는다. 「먼저 `--hooks` 없이 `--apply` 로 폴더를 옮긴다」 를 내고 종료 코드 2 다
2. `<orch 루트>/config.json` 의 아래 키를 읽어 만들 핸들러를 정한다. 옮길 것이 없으면 「옮길 칸이 없다」 와 종료 코드 0 이다
3. `--apply` 이고 옮길 것이 있으면 원본의 막는 조건을 본다. 하나라도 있으면 `막음 <이유>` 를 stderr 에 내고 종료 코드 3 이다
4. 핸들러 파일을 쓰고, 쓴 키만 설정에서 지운다. 설정의 나머지 키와 순서는 그대로 둔다

| 키 | 만드는 파일 | 핸들러가 하는 일 |
| --- | --- | --- |
| `queue.before` | `hooks/before-merge.ts` | 입력에서 `PR`, `BRANCH`, `OWNER`, `REPO`, `GH_HOST`(`pr.url` 의 호스트)를 채워 `bash -c <명령>` |
| `queue.verify_merged` | `hooks/verify-merged.ts` | `MERGE_COPY`, `PR`, `PR_HEAD`, `BASE_HEAD`, `CHANGED_FILES`, `OVERLAP_FILES`(줄바꿈으로 잇는다)를 채워 `bash -c <명령> verify-merged <copy>`. 작업 디렉터리는 `copy` 다. `queue.verify_merged_when` 은 설정에 남긴다 |
| `queue.after_merged` | `hooks/after-queue.ts` | `MERGED_PRS`, `CODE_PRS`(공백으로 잇는다)를 채워 `bash -c <명령>` |
| `finish.complete_cmd`, `finish.task_pattern` | `hooks/after-deploy.ts` | `last_of_task` 이고 `deploy` 가 `success` 나 `none` 일 때만 돈다. `pr.title` 에서 번호를 뽑고, 번호 안전 검사를 거쳐, 셸 없이 인자 목록으로 실행한다 |

- 핸들러는 옛 명령의 종료 코드를 그대로 낸다. 실패면 부르는 명령이 legacy 실패와 같이 멈추거나 실패로 적는다
- `after-deploy.ts` 의 정규식은 `lib/py.ts` 의 `pyRegExp` 로 바꾼 결과의 `source` 를 RegExp 리터럴로 적는다. `pyRegExp` 가 Error 면 `finish.complete_cmd` 와 `finish.task_pattern` 을 옮기지 않고 설정에 남긴다. 원문과 이유, 「JS 정규식으로 고쳐 `task_pattern` 에 다시 적고 다시 돌린다」 를 내고 종료 코드 1 이다
- `after-deploy.ts` 의 인자 목록은 `lib/py.ts` 의 `shSplit` 으로 미리 나눠 배열로 적고, 실행할 때 조각마다 `{number}` 를 바꾼다. 번호 안전 검사는 `finish-pr.py` 의 `NUMBER_OK`(`^[A-Za-z0-9._/-]+$`)를 같은 정규식으로 적는다. 번호를 찾지 못하거나 검사에 맞지 않으면 명령을 돌리지 않고 stderr 에 이유를 내고 1 로 끝난다. `finish-pr` 의 업무 번호 없음과 같이 `FINISH-FAIL` 이 된다
- 만든 핸들러의 머리에 「`migrate-orch-dir --hooks` 가 `<키>` 에서 만들었다」 주석을 단다

### 3. 문서

- `orch/references/cleanup.md`, `orch/references/overlay.md`, `orch/references/verification.md`, `orch/SKILL.md` 7단계, `orch/README.md` 에서 `merge_queue`, `merge-with-finish`, `finish-pr`, `ci-ready`, `notify-conflicts`, `overlap_units`, `migrate-orch-dir` 의 호출을 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/<이름>.ts"` 로, 이름을 `.ts` 로 바꾼다. 남은 곳은 `git grep -n` 으로 찾는다
- `orch/README.md`: `scripts/migrate-orch-dir.ts` 줄로 바꾸고 「옛 경로. 다음 major 에서 지운다」 줄에 `scripts/migrate-orch-dir.py` 를 더한다
- `overlay.md` 「마무리 설정 파일」 표의 지울 키마다 「다음 major 에서 지운다. `migrate-orch-dir.ts --hooks` 로 옮긴다」 를 붙인다. `hooks` 절과 `pipeline` 절을 더한다
- `orch/references/hooks.md` 「이벤트 고르기」 에 이 plan 이 낸 이벤트(`before-ready`, `pr-ready`, `pr-conflict`, `before-merge`, `verify-merged`, `after-merge`, `after-queue`, `after-deploy`)를 더하고, 옛 칸에서 옮기는 순서(`--hooks` 미리보기, `--apply`, 만든 핸들러 확인)를 적는다
- `orch/SKILL.md` frontmatter 의 `metadata.version` 의 minor 를 올리고 `orch/CHANGELOG.md` 에 이 plan 을 그 버전 항목 하나로 적는다

CHANGELOG 의 「호환성」 절에는 아래를 모두 적는다.

- `ci-ready` 는 GitHub `mergeable` 대신 로컬 merge-tree 로 충돌을 본다. `--repo` 의 origin 을 fetch 하고, `ORCH_READY_RETRY_SECONDS` 는 읽지 않는다. 다른 사람의 PR 은 보류한다
- `notify-conflicts` 는 내 PR 만 보고, 끝난 dispatch 는 후속 지시서(`spec-conflict-<PR>-<base>.md`)로 남은 터미널에 이어 쓴다. send-to-worker 의 종료 코드 3 과 워크트리나 dispatch 를 찾지 못한 경우는 `CONFLICT-ORPHAN` 줄을 내고 기록해, 같은 (PR, base) 로 다시 알리지 않는다. 원본 테스트 `test_undelivered_message_is_not_recorded` 는 이 규칙으로 바뀌었고, 「기록하지 않는다」 는 종료 코드 5 와 끝난 dispatch 의 1 이 이어 받는다
- `--shared-paths` 와 `finish.task_pattern` 은 JS 정규식으로 읽는다. `(?P<이름>`, `(?P=이름)`, `\A`, `\Z` 는 같은 뜻으로 바꾼다. 인라인 플래그(`(?i)`)처럼 JS 가 받지 않는 문법은 사용법 오류다
- 옛 칸(`queue.before`, `queue.verify_merged`, `queue.after_merged`, `finish.complete_cmd`, 같은 이름의 명령줄 옵션)도 이벤트 실행기로 돈다. 옛 칸도 1800초 제한을 받는다. 더 길면 `hooks.timeouts.<이벤트>` 로 늘린다. 핸들러와 같은 가드 PATH 를 거치고, `DEPRECATED <옵션> → hooks/<이벤트>.ts` 줄을 낸다. `PR:명령` 은 시간 제한 없이 지금처럼 돈다
- 머지 큐는 `after-merge` 나 `after-queue` 가 실패하면 모두 머지했어도 종료 코드 3 이다
- 머지한 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면 머지 큐가 base 를 옮긴 뒤 원격 브랜치를 지운다
- `finish-pr` 의 지시서 삭제는 살아 있는 dispatch 가 쓰는 지시서와 그 목록을 읽지 못한 실행에서는 지우지 않는다. 배포 대기 시간 초과는 `after-deploy` 의 `deploy: timeout` 이다
- `merge-queue.sh` 는 한 버전 뒤 지운다고 했던 것을 바꿔 다음 major 까지 남긴다. 다른 저장소의 포장 스크립트가 이 경로를 부를 수 있어서다
- 옮긴 명령의 옛 `.py` 경로는 남아 `DEPRECATED` 줄을 내고 `.ts` 로 넘긴다. ps 의 명령줄은 `node … <이름>.ts` 다

### 4. 테스트를 옮긴다

`orch/tests/migrate-orch-dir.spec.ts` 를 만든다. 원본 테스트 사례를 모두 옮기고 원본 파일을 지운다.
더할 사례:

- `--hooks` 미리보기는 파일을 쓰지 않고 설정을 바꾸지 않는다
- `--hooks --apply` 가 `queue.before` 에서 만든 `before-merge.ts` 를 `lib/events.ts` 의 `fire` 로 돌리면 옛 명령이 `PR`, `BRANCH` 환경 변수를 받고, 설정에서 `queue.before` 가 사라진다
- `finish.task_pattern` 이 `(?P<n>PROJ-[0-9]+)` 면 만든 `after-deploy.ts` 가 `last_of_task: true`, `deploy: success` 입력에서 번호를 바꾼 인자로 옛 명령을 부른다. `deploy: failure` 면 부르지 않는다. 번호가 `NUMBER_OK` 에 맞지 않으면 부르지 않고 1 이다
- `finish.task_pattern` 이 `(?i)proj-(\d+)` 면 `finish.complete_cmd` 와 `finish.task_pattern` 을 옮기지 않고 설정에 남기며 종료 코드 1 이다
- 핸들러 파일이 이미 있으면 덮지 않고 종료 코드 1 이다
- 옛 위치에 `.claude/orch-finish.json` 이 있으면 아무것도 쓰지 않고 종료 코드 2 다
- 가짜 `PGREP` 이 `node … merge_queue.ts` 줄을 내면 `--hooks --apply` 는 종료 코드 3 이다. 폴더 옮기기 `--apply` 도 같다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/migrate-orch-dir.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/README.md orch/CHANGELOG.md orch/references/*.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/migrate-orch-dir.ts` | 신규 |
| `orch/scripts/migrate-orch-dir.py` | 수정 |
| `orch/tests/migrate-orch-dir.spec.ts` | 신규 |
| `orch/tests/test_migrate_orch_dir.py` | 삭제 |
| `orch/references/cleanup.md` | 수정 |
| `orch/references/overlay.md` | 수정 |
| `orch/references/verification.md` | 수정 |
| `orch/references/hooks.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/README.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
