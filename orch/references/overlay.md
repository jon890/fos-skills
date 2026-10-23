# 저장소 오버레이

`<repo-root>/.orch/overlay.md` 는 이 스킬의 코어가 모르는 저장소 고유 사정을 담는다.
코디네이터가 그 저장소의 worker 를 띄우기 전에 먼저 읽고, 코어와 어긋나면 오버레이를 따른다.
없으면 코어 기본값으로 동작한다. `.orch/` 폴더의 구조는 아래 「orch 작업 폴더」 가 소유한다.

**오버레이에는 저장소마다 달라지는 값과 절차만 둔다.** 코어의 단계와 규칙을 옮겨 적지 않는다.
옮겨 적으면 코어가 바뀔 때 오버레이의 사본이 낡는다.

## 적을 것

| 항목 | 담는 것 | 쓰는 단계 |
| --- | --- | --- |
| 기준 브랜치 | PR 의 base, `--base-branch` 에 줄 원격 브랜치 | 3, 7 |
| 공통 지시서 위치 | `templates/spec-common.md` 를 채운 파일 경로 | 2 |
| 검증 명령 | worker 와 코디네이터가 돌릴 포맷, lint, 테스트 명령 | 2, 6 |
| 머지 조건 | 필수 체크 이름(`--required` 로 넘길 값), base 최신을 품게 할지(`--require-up-to-date`), 관리자 우회 가능 여부, 머지 방식(merge, squash) | 7 |
| 합친 사본 검사 | 같은 파일을 고친 PR 을 base 와 합친 사본에서 돌릴 명령(`--verify-merged`)과 사본 폴더(`--copy-dir`), 겹치지 않아도 검사할지(`--verify-merged-when`), 검사 없이 머지할 문서 glob(`--docs-glob`). 폴더는 저장소 hook 이 워크트리를 허용하는 곳이다 | 6, 7 |
| draft 로 CI 미루기 | draft PR 에서 CI 를 돌리지 않는 저장소인지. 켜면 worker 는 PR 을 draft 로 열고, 코디네이터가 검증 뒤 `ci-ready.py` 로 ready 로 바꾼다 | 2, 7 |
| 머지 전 명령 | DB 마이그레이션이 든 PR 앞의 백업 명령과 인자, 보관 개수 | 7 |
| 머지 뒤 명령 | 머지 뒤 한 번 돌릴 배포 명령(`--after-merged`). 문서 PR 만 머지했을 때 건너뛸지(`CODE_PRS`) | 7 |
| draft 때 건너뛴 체크 | draft 에서 CI 를 건너뛰게 둔 저장소면 `--skipped-is-missing` | 7 |
| 마이그레이션 순서 | 마이그레이션 PR 끼리의 머지 순서, 모듈별 선후, 공유 DB 에 적용하지 않는 규칙 | 2, 7 |
| CI runner 장애 대응 | runner 가 offline 이 됐을 때 누가 무엇을 하는지, 끊긴 실행을 다시 돌리는 명령 | 4, 7 |
| 원격 접속 규칙 | 개발 서버 조회에 쓸 접속 설정, 읽기만 허용하는지 | 2 |
| 비밀값 규칙 | 읽지 않을 파일, 비밀값을 넘기는 방법 | 2 |
| 업무 시스템 연동 | 업무 등록 양식, 상태 전환 시점, 링크 규칙 | 7 |
| 머지 뒤 정리에서 지울 문서 위치 | 지시서 사본, 설계 메모, PR 본문을 두는 폴더 | 7 |
| 지시서 폴더 | `cleanup-sweep.py --specs-dir` 에 줄 경로. worktree 이름과 같은 지시서와, 그 부모 폴더의 PR 본문 파일 `pr-<이름>.md` 를 지운다 (예: `.orch/specs/`) | 4, 7 |
| spec-lint | `## spec-lint` 절에 코디네이터 소유 경로, 소유 계약, 금지 문구. 형식은 `scripts/spec-lint.py` 머리 주석. 오버레이가 가리키는 경로는 `--check-overlay` 가 `origin/<base>` 와 대조한다 | 2 |
| 진행 보드 | 보드 파일 위치, 목표 항목 id 와 추적 항목 파일(`board-sync.py --goal --goal-items`) | 4, 7 |
| 머지 뒤 마무리 | `<repo>/.orch/config.json` 의 `finish` 절. gh 호스트, Run id, 배포 워크플로 파일과 브랜치, 업무 번호를 PR 제목에서 뽑는 정규식, 업무 완료 명령 틀, 보드 파일과 지시서 폴더. 키는 아래 표가 소유한다 | 7 |
| 산출물 정리 | 같은 파일의 `cleanup` 절. 함께 정리할 미리보기 폴더, 보드 파일, 휴지통 폴더, 기준 일수 | 7 |
| 머지 큐 기본 옵션 | 같은 파일의 `queue` 절. 머지 큐에 매번 붙일 필수 체크, 머지 전 명령, 합친 사본 검사, 문서 glob, 머지 방식 | 7 |

## 마무리 설정 파일

`merge-with-finish.py`, `finish-pr.py`, `handoff-cleanup.py` 는 `<repo>/.orch/config.json` 이 있으면 읽는다.
`--config FILE` 로 다른 파일을 줄 수 있고, 명령줄 옵션이 파일 값보다 우선한다. 파일에 없는 값은 옵션이나 기본값을 쓴다.
스크립트마다 자기 절만 읽는다. `finish` 절은 `finish-pr.py` 가, `cleanup` 절은 `handoff-cleanup.py` 가, `queue` 절은 `merge-with-finish.py` 가 읽는다.
절 안에 모르는 키가 있으면 사용법 오류로 멈춘다. 키 이름은 옵션 이름의 하이픈을 밑줄로 바꾼 것이다.

| 절 | 키 | 담는 것 |
| --- | --- | --- |
| `finish` | `gh_host` | gh 에 줄 호스트. github.com 이 아닌 저장소에서만 |
| `finish` | `run` | worker 를 찾을 Orca Run id |
| `finish` | `base_branch` | `cleanup-sweep.py` 의 기준 브랜치. 없으면 origin/HEAD |
| `finish` | `deploy_workflow`, `deploy_branch` | 배포 워크플로 파일 이름과 배포가 도는 브랜치. 둘 다 주면 배포 성공까지 기다린다 |
| `finish` | `task_pattern` | PR 제목에서 업무 번호를 뽑는 정규식. 첫 그룹이 번호다 |
| `finish` | `complete_cmd` | 업무 완료 명령 틀. `{number}` 가 업무 번호로 바뀌고 셸을 거치지 않는다 |
| `finish` | `board`, `board_bin` | 보드 파일과 보드 명령. 보드 항목은 `pr` 필드에 그 PR 이 든 항목을 `merge-with-finish.py` 가 찾아 업무의 마지막 PR(`!`)에서만 done 으로 바꾼다. 직접 줄 때는 `--board-item 101=ITEM` 이다 |
| `finish` | `specs_dir` | 지시서 폴더. 그 PR 브랜치의 지시서를 지운다 |
| `cleanup` | `orch_dir`, `previews`, `board` | orch 작업 폴더, 함께 정리할 미리보기 폴더, 보드 파일. 미리보기는 content-preview 의 산출물이라 주지 않으면 보지 않는다 |
| `cleanup` | `trash` | 휴지통 폴더. 기본은 `~/.Trash/orch-cleanup-<날짜>` |
| `cleanup` | `queue_days`, `folder_days`, `data_days`, `data_ext` | 큐 로그, 폴더, 데이터 파일의 기준 일수와 데이터 확장자 |
| `queue` | `required`, `before`, `method` | `merge_queue.py` 의 `--required`, `--before`, `--method`. `required` 는 문자열 목록도 받는다 |
| `queue` | `verify_merged`, `verify_merged_when`, `docs_glob` | `--verify-merged`, `--verify-merged-when`, `--docs-glob`. `docs_glob` 은 문자열 목록도 받는다 |
| `queue` | `after_merged`, `skipped_is_missing` | `--after-merged` 와 `--skipped-is-missing`. `skipped_is_missing` 은 true 나 false 다 |
| `queue` | `require_up_to_date`, `up_to_date_when` | `--require-up-to-date` 와 `--up-to-date-when`. `require_up_to_date` 는 true 나 false 이고, `up_to_date_when` 은 `always` 나 `overlap` 이다 |
| `queue` | `shared_paths`, `unit_prefix` | `--shared-paths` 와 `--unit-prefix`. `shared_paths` 는 정규식 목록도 받아 `\|` 로 잇는다. 의미는 [`cleanup.md`](cleanup.md) 의 「겹치지 않는 PR 은 최신화하지 않기」 가 소유한다 |
| `queue` | `unit_groups` | 한 단위로 세는 단위 이름의 목록의 목록(`[["web", "bff"]]`). 안쪽 목록마다 `--unit-group a,b` 가 된다 |
| `queue` | `sweep_args` | 머지 뒤 정리(`cleanup-sweep.py`)에 넘길 인자의 문자열 목록. 항목마다 `--sweep-arg` 가 된다. 명령줄에 `--sweep-arg` 가 있으면 쓰지 않는다 |
| `queue` | `update_docs_on_overlap` | true 면 `--update-docs-on-overlap`. CLEAN 인 문서 PR 의 겹침은 base 를 합친 뒤 필수 CI 로 확인한다 |

```json
{
  "finish": {
    "gh_host": "github.example.com",
    "run": "run_0123456789ab",
    "deploy_workflow": "deploy-dev.yml",
    "deploy_branch": "develop",
    "task_pattern": "^\\[?(PROJ-[0-9]+)",
    "complete_cmd": "task-cli workflow PROJ {number} Done",
    "specs_dir": ".orch/specs"
  },
  "cleanup": {
    "gh_host": "github.example.com",
    "previews": ".omc/previews",
    "trash": "~/.Trash/orch-cleanup"
  },
  "queue": {
    "required": ["backend", "frontend"],
    "verify_merged": "cd \"$1\" && ./gradlew test",
    "verify_merged_when": "code",
    "docs_glob": ["docs/*", "*.md"]
  }
}
```

## orch 작업 폴더

orch 의 파일은 주 checkout 의 `.orch/` 아래에 둔다. 워크트리에서 불러도 같은 폴더다.
경로는 `scripts/orch_paths.py` 가 정하고, 셸과 문서에서는 `python3 "$SKILL_DIR/scripts/orch_paths.py" specs` 처럼 이름으로 받는다.
루트를 옮기려면 `ORCH_DIR` 을 orch 스크립트를 부르는 모든 환경(코디네이터 셸, 훅)에 같은 값으로 둔다.

| 경로 | 담는 것 |
| --- | --- |
| `overlay.md` | 이 문서가 다루는 저장소 규칙 |
| `config.json` | 위 「마무리 설정 파일」 |
| `specs/` | 지시서와 `spec-common.md`. PR 본문 `pr-<이름>.md` 는 그 부모인 `.orch/` 에 둔다 |
| `queue/` | 머지 큐와 마무리(`finish-<PR>.out`, `.pid`) 출력 |
| `state/` | `wait-important.py`, `notify-conflicts.py` 가 기억하는 것. 무거운 검사 대기열은 `state/heavy-slot/` 을 쓴다 |
| `bin/` | 저장소 포장 스크립트 |

보드(`board.json`)는 work-board 소유라 여기 두지 않는다. 위치는 `work-board/README.md` 가 정하고, 다른 곳이면 `finish.board` 로 준다.

스크립트가 `.orch/` 아래를 처음 만들 때 `.git/info/exclude` 에 `/.orch/` 를 더해 git 이 무시하게 한다. 저장소의 `.gitignore` 는 바꾸지 않는다.
오버레이와 설정을 저장소에 커밋해 함께 쓰려면 `git add -f .orch/overlay.md` 로 추적한다.
공개 저장소에 올리면 안 되는 값(서버 이름, 접속 설정 경로, 호스트 이름, 프로젝트 코드)이 있으면 추적하지 않는다.

## 옛 구조에서 옮기기

`.claude/orch-overlay.md`, `.claude/orch-finish.json`, `.omc/orch/`, `.omc/handoffs/specs/` 에 파일이 남은 저장소에서는
설정, 오버레이, 지시서 폴더를 읽는 진입점이 옮기는 명령을 알리고 종료 코드 2 로 멈춘다.
옛 위치를 읽지 않으므로 그대로 돌면 저장소 값이 빠지거나 빈 새 폴더에서 조용히 시작하기 때문이다.

| 진입점 | 멈추는 때 |
| --- | --- |
| `finish-pr.py`, `merge-with-finish.py`, `handoff-cleanup.py` | 설정을 `--config` 로 주지 않았을 때 |
| `spec-lint.py` | `--overlay` 를 주지 않았을 때 |
| `cleanup-sweep.py` | `--specs-dir` 를 주지 않았을 때. 그 저장소만 건너뛴다 |
| `launch-worker.sh` | 늘. 셸 스크립트는 `orch_paths.py check` 로 같은 검사를 한다 |
| `orch_paths.py --ensure` | 늘 |

`wait-important.py` 와 `notify-conflicts.py` 는 알리기만 한다. 대기를 막으면 worker 가 끝나지 않아 옮길 수도 없다.

머지 큐와 worker 가 모두 끝난 때에 옮긴다. 먼저 미리보기로 옮길 것과 옛 경로를 적은 파일을 본다.
`$REPO` 는 대상 저장소의 주 checkout 이다.

```bash
python3 "$SKILL_DIR/scripts/migrate-orch-dir.py" --repo "$REPO"
python3 "$SKILL_DIR/scripts/migrate-orch-dir.py" --repo "$REPO" --apply
```

- 기본으로 옮기는 쌍과 판정은 스크립트 머리 주석과 `orch_paths.py` 의 `DEFAULT_MOVES` 가 소유한다. 다른 곳에 둔 파일은 `--move 옛=새` 로 더한다
- 살아 있는 dispatch, 터미널을 쥔 worker, 돌고 있는 머지 큐나 마무리가 있으면 `--apply` 를 거부한다(종료 코드 3). worker 는 지시서를 절대경로로 읽으므로 그 사이에 옮기면 끊긴다
- 「옛 경로 참조」 로 나온 파일(포장 스크립트, 추적 문서, 로컬 설정)은 바꾸지 않는다. 그 저장소가 고친다
- 「추적 파일」 로 나온 것은 보인 `git mv` 명령으로 옮겨 커밋한다. 대상 폴더는 `--apply` 가 만들어 둔다
- 「스크립트」 가 붙은 옛 경로 참조는 옮긴 뒤 바로 고친다. 그 스크립트가 옛 폴더를 다시 만들면 위 진입점이 다시 멈춘다
- 옮기다 실패하면 그때까지 옮긴 것을 보이고 멈춘다. 원인을 고친 뒤 다시 돌리면 남은 것을 옮기고, 옮긴 뒤 고치는 단계는 `.orch` 전체를 다시 본다

## 예시

```markdown
# orch 오버레이

- 기준 브랜치: develop. 필수 체크 `backend`, 관리자 우회 불가
- 머지 큐는 `--require-up-to-date --required backend` 로 돌린다
- 같은 파일을 고친 PR 은 `--verify-merged 'cd "$1" && ./gradlew test' --copy-dir worktrees/repo` 로 머지한다
- 공통 지시서: `.orch/specs/spec-common.md`
- 검증: `scripts/verify.sh format`, `scripts/verify.sh test`
- draft PR 은 CI 를 돌리지 않는다. worker 는 `gh pr create --draft` 로 열고, 코디네이터가 `ci-ready.py` 로 ready 로 바꾼다
- 머지 전 명령: DB 마이그레이션이 든 PR 은 `PR:./bin/backup-db.sh <db> "before-pr-$PR"`. DB 마다 최근 2개만 보관
- CI runner 가 offline 이면 묻지 않고 runner 호스트를 재부팅하고, 끊긴 실행은 `gh run rerun --failed` 로 다시 돌린다
```
