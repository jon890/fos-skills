# Phase 04. 옮기기 명령에 설정 칸을 핸들러로 바꾸는 기능을 더하고 머지 문서를 맞춘다

**Execution profile**: standard

## 목표

`migrate-orch-dir` 를 TypeScript 로 옮기고 `--hooks` 를 더한다. `config.json` 의 옛 셸 명령 칸을 같은 동작의 핸들러 파일로 바꾼다.
머지 단계 문서가 새 명령, 이벤트, 지울 설정 키를 가리키게 한다.

**범위 외**: 정리 명령과 상주 루프.

## 컨텍스트

시작 조건: 이 plan 의 phase 03 이 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/migrate-orch-dir.py` | `orch/scripts/migrate-orch-dir.ts` | `orch/tests/test_migrate_orch_dir.py` → `orch/tests/migrate-orch-dir.spec.ts` |

원본의 막는 조건은 `merge-queue.sh`, `merge-with-finish.py`, `finish-pr.py` 프로세스를 찾는다. 새 명령은 `.py` 와 `.ts` 이름을 모두 찾고 `merge-queue.sh` 는 뺀다(앞 phase 에서 지웠다).
`orch_paths.py` 가 이 명령의 `.py` 경로를 안내 문구에 쓴다. shim 이 있으므로 그 안내는 계속 동작한다.

옛 칸, 이벤트, 환경 변수 대응은 `docs/data-schema.md` 의 대응 표가 소유한다. `--hooks` 가 만드는 핸들러는 그 대응대로 입력 JSON 에서 환경 변수를 채워 옛 명령을 `bash -c` 로 부른다. 동작이 옮기기 전과 같아야 사용자가 나중에 핸들러를 고칠 수 있다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `migrate-orch-dir.py` 에 둔다.

**근거 문서**: `docs/data-schema.md` 의 「config.json 에 더하는 절」 의 지울 키 표와 대응 표, `docs/flow.md` 의 「갈래」 의 옛 셸 명령 칸 두 줄, `docs/code-architecture.md` 의 「orch 문서가 소유하는 것」

## 의도 메모

- `--hooks` 는 기본이 미리보기다. `--apply` 와 함께 줄 때만 핸들러 파일을 쓰고 설정에서 그 키를 지운다. 핸들러 파일이 이미 있으면 덮지 않고 겹침으로 알린다(종료 코드 1).
- 설정 파일과 핸들러를 저장소에 추적하는지(`git ls-files`)에 따라 `git add -f` 명령을 보인다. 공개 저장소에 올리면 안 되는 값이 있을 수 있어 직접 커밋하지 않는다.

## 작업 항목

### 1. `migrate-orch-dir.ts` 와 `--hooks`

| 키 | 만드는 파일 |
| --- | --- |
| `queue.before` | `hooks/before-merge.ts` |
| `queue.verify_merged` | `hooks/verify-merged.ts`. `queue.verify_merged_when` 은 남긴다 |
| `queue.after_merged` | `hooks/after-queue.ts` |
| `finish.complete_cmd`, `finish.task_pattern` | `hooks/after-deploy.ts`. `last_of_task` 이고 `deploy` 가 `failure` 가 아닐 때만 `pr.title` 에서 번호를 뽑아 명령을 인자 목록으로 실행한다 |

만든 핸들러의 머리에 「`migrate-orch-dir --hooks` 가 `<키>` 에서 만들었다」 주석을 단다.

### 2. 문서

- `orch/references/cleanup.md`, `overlay.md`, `SKILL.md` 7단계, `README.md` 에서 `merge_queue`, `merge-with-finish`, `finish-pr`, `ci-ready`, `notify-conflicts`, `overlap_units`, `migrate-orch-dir` 의 호출을 `node "$SKILL_DIR/scripts/<이름>.ts"` 로 바꾼다
- `overlay.md` 「마무리 설정 파일」 표의 지울 키마다 「다음 major 에서 지운다. `migrate-orch-dir.ts --hooks` 로 옮긴다」 를 붙인다. `hooks` 절을 더한다
- `orch/references/hooks.md` 에 이 plan 이 낸 이벤트(`before-ready`, `pr-ready`, `pr-conflict`, `before-merge`, `verify-merged`, `after-merge`, `after-queue`, `after-deploy`)와 옛 칸에서 옮기는 순서를 더한다
- `orch/CHANGELOG.md` 에 이 plan 을 한 항목으로 적고 minor 를 올린다

### 3. 테스트를 옮긴다

`orch/tests/migrate-orch-dir.spec.ts` 를 만든다.
표의 사례를 모두 옮기고 원본을 지운다.
더할 사례: `--hooks` 미리보기는 파일을 쓰지 않는다. `--hooks --apply` 가 `queue.before` 에서 만든 `before-merge.ts` 를 `lib/events.ts` 의 `fire` 로 돌리면 옛 명령이 `PR`, `BRANCH` 환경 변수를 받는다. 핸들러가 이미 있으면 덮지 않고 종료 코드 1.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/migrate-orch-dir.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/README.md orch/references/*.md
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
| `orch/references/hooks.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/README.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
