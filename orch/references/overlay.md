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
| 합친 사본 검사 | 같은 파일을 고친 PR 을 base 와 합친 사본에서 돌릴 `hooks/verify-merged.ts`, 사본 폴더(`--copy-dir`), 겹치지 않아도 검사할지(`--verify-merged-when`), 검사 없이 머지할 문서 glob(`--docs-glob`). 폴더는 저장소 hook 이 워크트리를 허용하는 곳이다 | 6, 7 |
| draft 로 CI 미루기 | draft PR 에서 CI 를 돌리지 않는 저장소인지. 켜면 worker 는 PR 을 draft 로 열고, 코디네이터가 검증 뒤 `ci-ready.ts` 로 ready 로 바꾼다 | 2, 7 |
| 무거운 검사 분류 | 같은 PC 에서 혼자 돌아야 하는 전체 검사와 브라우저 검사 명령, 대기열을 거치지 않아도 되는 가벼운 명령 | 6 |
| 문서 PR 의 CI | 문서만 바꾼 PR 이 CI 를 생략하는지, 그때 머지 큐에 줄 `--docs-glob` | 7 |
| 머지 전 명령 | DB 마이그레이션이 든 PR 앞의 백업 명령과 인자, 보관 개수 | 7 |
| 머지 뒤 명령 | `hooks/after-queue.ts`가 머지 뒤 한 번 돌릴 배포 명령. 문서 PR 만 머지했을 때 건너뛸지(`CODE_PRS`) | 7 |
| draft 때 건너뛴 체크 | draft 에서 CI 를 건너뛰게 둔 저장소면 `--skipped-is-missing` | 7 |
| 마이그레이션 순서 | 마이그레이션 PR 끼리의 머지 순서, 모듈별 선후, 공유 DB 에 적용하지 않는 규칙. 번호는 SQL 예약 폴더인 `migrations.dirs` 에 `reserve-migration.ts` 로 예약하고, Java 같은 추가 경로는 `migrations.watch` 로 감시한다 | 2, 7 |
| CI runner 장애 대응 | runner 가 offline 이 됐을 때 누가 무엇을 하는지, 끊긴 실행을 다시 돌리는 명령 | 4, 7 |
| 원격 접속 규칙 | 개발 서버 조회에 쓸 접속 설정, 읽기만 허용하는지 | 2 |
| 비밀값 규칙 | 읽지 않을 파일, 비밀값을 넘기는 방법 | 2 |
| 업무 시스템 연동 | 업무 등록 양식, 상태 전환 시점, 링크 규칙 | 7 |
| 머지 뒤 정리에서 지울 문서 위치 | 지시서 사본, 설계 메모, PR 본문을 두는 폴더 | 7 |
| 지시서 폴더 | `cleanup-sweep.ts --specs-dir` 에 줄 경로. worktree 이름과 같은 지시서와, 그 부모 폴더에 남은 옛 위치의 PR 본문 파일 `pr-<이름>.md` 를 지운다. 새 PR 본문 파일은 worker 세션 임시 폴더에 있어 이 폴더에 생기지 않는다 (예: `.orch/specs/`) | 4, 7 |
| spec-lint | `## spec-lint` 절에 코디네이터 소유 경로, 소유 계약, 금지 문구. 형식은 `scripts/spec-lint.ts` 머리 주석. 오버레이가 가리키는 경로는 `--check-overlay` 가 `origin/<base>` 와 대조한다 | 2 |
| 진행 보드 | 보드 파일 위치, 목표 항목 id(`board-sync.ts --goal`). `--goal-items` 는 하위 호환 옵션이라 새 설정에 쓰지 않는다 | 4, 7 |
| 머지 뒤 마무리 | `<repo>/.orch/config.json` 의 `finish` 절. gh 호스트, Run id, 배포 워크플로 파일과 브랜치, 업무 번호를 PR 제목에서 뽑는 정규식, 업무 완료 명령 틀, 보드 파일과 지시서 폴더. 키는 아래 표가 소유한다 | 7 |
| 산출물 정리 | 같은 파일의 `cleanup` 절. 함께 정리할 미리보기 폴더, 보드 파일, 휴지통 폴더, 기준 일수 | 7 |
| 머지 큐 기본 옵션 | 같은 파일의 `queue` 절. 머지 큐에 매번 붙일 필수 체크, 머지 전 명령, 합친 사본 검사, 문서 glob, 머지 방식 | 7 |

## 마무리 설정 파일

`merge-with-finish.ts`, `finish-pr.ts`, `handoff-cleanup.ts` 는 `<repo>/.orch/config.json` 이 있으면 읽는다.
`--config FILE` 로 다른 파일을 줄 수 있고, 명령줄 옵션이 파일 값보다 우선한다. 파일에 없는 값은 옵션이나 기본값을 쓴다.
스크립트마다 자기 절만 읽는다. `finish` 절은 `finish-pr.ts` 가, `cleanup` 절은 `handoff-cleanup.ts` 가, `queue` 절은 `merge-with-finish.ts` 가 읽는다.
`hooks` 절은 이벤트를 내는 모든 명령이, `pipeline` 절은 아래 표의 명령이, `migrations` 절은 상주 루프가 읽는다.
`board` 절은 `launch-worker`, `board-sync.ts`, `finish-pr.ts`, `board-release.ts` 가 읽는다.
상주 루프(`orch-loop.ts`)는 `finish` 절의 `run`, `specs_dir`, `queue` 절의 `required`, `skipped_is_missing`, `auto_merge`, `auto_review`, `pipeline` 절을 읽는다.
절 안에 모르는 키가 있으면 사용법 오류로 멈춘다. 키 이름은 옵션 이름의 하이픈을 밑줄로 바꾼 것이다.

| 절 | 키 | 담는 것 |
| --- | --- | --- |
| `finish` | `gh_host` | gh 에 줄 호스트. github.com 이 아닌 저장소에서만 |
| `finish` | `run` | worker 를 찾을 Orca Run id |
| `finish` | `base_branch` | `cleanup-sweep.ts` 의 기준 브랜치. 없으면 origin/HEAD |
| `finish` | `deploy_workflow`, `deploy_branch` | 배포 워크플로 파일 이름과 배포가 도는 브랜치. 둘 다 주면 배포 성공까지 기다린다 |
| `finish` | `task_pattern` | PR 제목에서 업무 번호를 뽑는 정규식. 첫 그룹이 번호다. 마지막 PR 판정([`cleanup.md`](cleanup.md) 의 「마지막 PR 판정」)이 쓴다 |
| `finish` | `spec_task_pattern` | 지시서의 줄에서 업무 번호를 뽑는 정규식. 첫 그룹이 번호다. 마지막 PR 판정이 같은 업무의 남은 지시서를 찾는다. `specs_dir` 를 두면 함께 둔다 |
| `finish` | `complete`, `intermediate` | true 면 모든 PR 을 판정 없이 마지막(`--complete`)이나 중간(`--intermediate`)으로 본다. 보통은 두지 않는다 |
| `finish` | `board`, `board_bin` | 보드 파일과 보드 명령. 마무리가 `pr` 필드나 브랜치로 그 PR 의 항목을 찾아 마지막 PR 에서만 done 으로 바꾼다. 직접 줄 때는 `--board-item 101=ITEM` 이다 |
| `finish` | `specs_dir` | 지시서 폴더. 마지막 PR 이면 그 PR 브랜치의 지시서를 지운다. 마지막 PR 판정이 같은 업무의 남은 지시서를 여기서 찾는다 |
| `cleanup` | `orch_dir`, `previews`, `board` | orch 작업 폴더, 함께 정리할 미리보기 폴더, 보드 파일. 미리보기는 content-preview 의 산출물이라 주지 않으면 보지 않는다 |
| `cleanup` | `trash` | 휴지통 폴더. 기본은 `~/.Trash/orch-cleanup-<날짜>` |
| `cleanup` | `queue_days`, `folder_days`, `data_days`, `data_ext` | 큐 로그, 폴더, 데이터 파일의 기준 일수와 데이터 확장자 |
| `queue` | `required`, `method` | `merge_queue.ts` 의 `--required`, `--method`. `required` 는 문자열 목록도 받는다 |
| `queue` | `verify_merged_when`, `docs_glob` | `--verify-merged-when`, `--docs-glob`. `docs_glob` 은 문자열 목록도 받는다 |
| `queue` | `skipped_is_missing` | `--skipped-is-missing`. true 나 false 다 |
| `queue` | `require_up_to_date`, `up_to_date_when` | `--require-up-to-date` 와 `--up-to-date-when`. `require_up_to_date` 는 true 나 false 이고, `up_to_date_when` 은 `always` 나 `overlap` 이다 |
| `queue` | `shared_paths`, `unit_prefix` | `--shared-paths` 와 `--unit-prefix`. `shared_paths` 는 정규식 목록도 받아 `\|` 로 잇는다. 의미는 [`cleanup.md`](cleanup.md) 의 「겹치지 않는 PR 은 최신화하지 않기」 가 소유한다 |
| `queue` | `unit_groups` | 한 단위로 세는 단위 이름의 목록의 목록(`[["web", "bff"]]`). 안쪽 목록마다 `--unit-group a,b` 가 된다 |
| `queue` | `sweep_args` | 머지 뒤 정리(`cleanup-sweep.ts`)에 넘길 인자의 문자열 목록. 항목마다 `--sweep-arg` 가 된다. 명령줄에 `--sweep-arg` 가 있으면 쓰지 않는다 |
| `queue` | `update_docs_on_overlap` | true 면 `--update-docs-on-overlap`. CLEAN 인 문서 PR 의 겹침은 base 를 합친 뒤 필수 CI 로 확인한다 |
| `queue` | `auto_merge`, `auto_review` | 상주 루프의 자동 머지. 키 뜻은 저장소 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이 소유한다 |
| `hooks` | `timeouts` | 이벤트 이름에서 초(양수)로 가는 객체. 핸들러의 시간 제한을 바꾼다. 기본값과 모르는 이벤트 처리는 `scripts/lib/events.ts` 머리 주석이 소유한다 |
| `pipeline` | `authors` | 「내 PR」 로 볼 작성자의 문자열 목록. 없으면 gh 의 현재 사용자다. 머지 큐의 쌓인 PR base 옮기기, `notify-conflicts.ts`, `ci-ready.ts`, 상주 루프가 이 PR 만 본다 |
| `pipeline` | `ready_slots` | 동시에 ready 로 둘 내 PR 수. 1 이상의 정수이고 기본 1 이다. `ci-ready.ts` 가 읽는다 |
| `pipeline` | `tick_sec` | 상주 루프의 틱 간격(초)이다. 양수이고 기본 300 이다. `orch-loop.ts` 가 읽는다 |
| `pipeline` | `enabled`, `docs_merge`, `after_queue_interval_sec`, `ci_missing_after_sec`, `update_behind_drafts` | 상주 루프의 자동 진행에 쓸 값이다. 키는 사용법 오류 없이 받지만 아직 읽는 명령이 없다 |
| `heavy` | `exclusive`, `normal`, `light`, `wait_idle` | 정규식 목록이다. `heavy-slot.ts` 가 읽는다. 사용법은 [`heavy-checks.md`](heavy-checks.md) 가 소유한다 |
| `migrations` | `dirs`, `watch`, `before`, `blocked_after_sec` | SQL 예약 폴더, 모듈별 추가 감시 경로 목록, 자동 머지의 머지 전 명령, 막힘 알림 시간 |
| `board` | `steps` | 띄울 때 만드는 보드 마일스톤 단계의 문자열 목록. 줄 앞 꼬리표 `[pr]`, `[merge]`, `[deploy]`, `[release]` 가 그 단계를 끝낼 사건이다. 없으면 `[pr] PR`, `[merge] 머지` 다. 규칙은 [`board.md`](board.md) 의 「마일스톤 단계」 가 소유한다 |
| `board` | `done_after` | 보드 항목을 done 으로 바꾸는 사건. `merge`, `deploy`, `release` 중 하나이고 기본은 `merge` 다 |

```json
{
  "finish": {
    "gh_host": "github.example.com",
    "run": "run_0123456789ab",
    "deploy_workflow": "deploy-dev.yml",
    "deploy_branch": "develop",
    "specs_dir": ".orch/specs"
  },
  "cleanup": {
    "gh_host": "github.example.com",
    "previews": ".omc/previews",
    "trash": "~/.Trash/orch-cleanup"
  },
  "queue": {
    "required": ["backend", "frontend"],
    "verify_merged_when": "code",
    "docs_glob": ["docs/*", "*.md"]
  },
  "hooks": {
    "timeouts": { "verify-merged": 3600 }
  }
}
```

업무 완료와 합친 사본 검사 명령은 설정 칸이 아니라 `.orch/hooks/after-deploy.ts`, `.orch/hooks/verify-merged.ts` 에 둔다. 쓰는 법은 [`hooks.md`](hooks.md) 다.

## orch 작업 폴더

orch 의 파일은 주 checkout 의 `.orch/` 아래에 둔다. 워크트리에서 불러도 같은 폴더다.
경로는 `scripts/orch_paths.ts` 가 정하고, 셸과 문서에서는 `"$SKILL_DIR/bin/orch.ts" orch_paths specs` 처럼 이름으로 받는다.
루트를 옮기려면 `ORCH_DIR` 을 orch 스크립트를 부르는 모든 환경(코디네이터 셸, 훅)에 같은 값으로 둔다.

| 경로 | 담는 것 |
| --- | --- |
| `overlay.md` | 이 문서가 다루는 저장소 규칙 |
| `config.json` | 위 「마무리 설정 파일」 |
| `specs/` | 지시서와 `spec-common.md`. 옛 위치의 PR 본문 `pr-<이름>.md` 는 그 부모인 `.orch/` 에 있다. 지금 PR 본문 파일은 worker 세션 임시 폴더에 둔다 |
| `queue/` | 머지 큐와 마무리(`finish-<PR>.out`, `.pid`) 출력 |
| `state/` | `wait-important`, `notify-conflicts.ts` 가 기억하는 것. 상주 루프의 파일(`loop.json`, `loop.lock`, `loop.log`, `loop-events.jsonl`, `loop-events.cursor`)도 여기 있다. 무거운 검사 대기열은 `state/heavy-slot/` 을 쓴다 |
| `hooks/` | 이벤트 핸들러 `<이벤트>.ts`. 쓰는 법은 [`hooks.md`](hooks.md) |
| `bin/` | 저장소 포장 스크립트 |

## 저장소 스크립트에서 orch 부르기

**저장소의 `.orch/bin/` 스크립트와 `.orch/queue-env.sh` 같은 파일은 번들 경로를 박지 않는다.** 플러그인 경로는 프로필과 버전마다 바뀌어(`<설정 폴더>/plugins/cache/<마켓플레이스>/<플러그인>/<해시>/`), 박아 둔 경로는 갱신 뒤 옛 스크립트를 조용히 부른다. 저장소 체크아웃 경로도 그 체크아웃이 다른 브랜치에 있으면 main 과 다른 스크립트가 돈다.
아래 한 줄이 설치 기록에서 진입점의 위치를 풀고, 스크립트는 `"$ORCH" <이름> [인자]` 로 부른다. 진입점이 그 호출의 설치 기록을 다시 읽어 현재 번들의 스크립트를 실행한다. 스크립트마다 새 셸이 뜨면 스크립트마다 이 줄을 둔다.

```bash
ORCH=$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";const e=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"].sort((a,b)=>(a.scope!=="user")-(b.scope!=="user"))[0];console.log(e.installPath+"/orch/bin/orch.ts")') && "$ORCH" mem-gate --help
```

`"$ORCH" --path` 는 현재 번들의 스크립트 폴더를, `--path <이름>` 은 그 스크립트의 파일 경로를 낸다. 스크립트를 `node` 가 아닌 다른 방식으로 불러야 할 때 쓴다.
고치는 중인 체크아웃의 스크립트를 테스트하려면 `ORCH_SCRIPTS_DIR` 에 그 체크아웃의 `orch/scripts` 를 준다. 설치 기록보다 앞선다.
진입점 파일은 Node 내장 모듈만 쓰는 한 파일이라 저장소에 복사해 두고 써도 설치 기록을 따라간다. 복사본은 번들이 아니라 진입점만 고정한다.

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
| `finish-pr.ts`, `handoff-cleanup.ts` | 설정을 `--config` 로 주지 않았을 때 |
| `merge-with-finish.ts` | 설정을 `--finish-config` 로 주지 않았을 때. 머지 큐를 걸지 않는다 |
| `spec-lint` | `--overlay` 를 주지 않았을 때 |
| `cleanup-sweep.ts` | `--specs-dir` 를 주지 않았을 때. 그 저장소만 건너뛴다 |
| `launch-worker` | 늘. 셸 스크립트는 `orch_paths.ts check` 로 같은 검사를 한다 |
| `orch_paths.ts --ensure` | 늘 |

`wait-important` 와 `notify-conflicts.ts` 는 알리기만 한다. 대기를 막으면 worker 가 끝나지 않아 옮길 수도 없다.

머지 큐와 worker 가 모두 끝난 때에 옮긴다. 먼저 미리보기로 옮길 것과 옛 경로를 적은 파일을 본다.
`$REPO` 는 대상 저장소의 주 checkout 이다.

```bash
"$SKILL_DIR/bin/orch.ts" migrate-orch-dir --repo "$REPO"
"$SKILL_DIR/bin/orch.ts" migrate-orch-dir --repo "$REPO" --apply
```

- 기본으로 옮기는 쌍과 판정은 스크립트 머리 주석과 `scripts/lib/paths.ts` 의 `DEFAULT_MOVES` 가 소유한다. 다른 곳에 둔 파일은 `--move 옛=새` 로 더한다
- 살아 있는 dispatch, 터미널을 쥔 worker, 돌고 있는 머지 큐나 마무리가 있으면 `--apply` 를 거부한다(종료 코드 3). worker 는 지시서를 절대경로로 읽으므로 그 사이에 옮기면 끊긴다
- 「옛 경로 참조」 로 나온 파일(포장 스크립트, 추적 문서, 로컬 설정)은 바꾸지 않는다. 그 저장소가 고친다
- 「추적 파일」 로 나온 것은 보인 `git mv` 명령으로 옮겨 커밋한다. 대상 폴더는 `--apply` 가 만들어 둔다
- 「스크립트」 가 붙은 옛 경로 참조는 옮긴 뒤 바로 고친다. 그 스크립트가 옛 폴더를 다시 만들면 위 진입점이 다시 멈춘다
- 옮기다 실패하면 그때까지 옮긴 것을 보이고 멈춘다. 원인을 고친 뒤 다시 돌리면 남은 것을 옮기고, 옮긴 뒤 고치는 단계는 `.orch` 전체를 다시 본다
- 폴더를 옮긴 뒤 `config.json` 에 5.2.0에서 지운 칸이 남았으면 `--hooks --apply`로 핸들러로 바꾼다. 순서는 [`hooks.md`](hooks.md) 의 「옛 설정 칸 옮기기」 가 소유한다

## 예시

```markdown
# orch 오버레이

- 기준 브랜치: develop. 필수 체크 `backend`, 관리자 우회 불가
- 머지 큐는 `--require-up-to-date --required backend` 로 돌린다
- 같은 파일을 고친 PR 은 `hooks/verify-merged.ts`에서 `cd "$copy" && ./gradlew test`를 돌리고 `--copy-dir worktrees/repo`로 머지한다
- 공통 지시서: `.orch/specs/spec-common.md`
- 검증: `scripts/verify.sh format`, `scripts/verify.sh test`
- draft PR 은 CI 를 돌리지 않는다. worker 는 `gh pr create --draft` 로 열고, 코디네이터가 `ci-ready.ts` 로 ready 로 바꾼다
- 머지 전 명령: DB 마이그레이션이 든 PR 은 `PR:./bin/backup-db.sh <db> "before-pr-$PR"`. DB 마다 최근 2개만 보관
- CI runner 가 offline 이면 묻지 않고 runner 호스트를 재부팅하고, 끊긴 실행은 `gh run rerun --failed` 로 다시 돌린다
```

자동 머지를 켠 저장소의 `config.json` 조각이다.

```json
{
  "queue": { "auto_merge": true, "auto_review": { "pass": "머지 가능", "block": "반영 필요|반영 후 머지" } },
  "migrations": {
    "dirs": { "api": "modules/api/src/main/resources/db/migration" },
    "watch": { "api": ["src/main/java/db/migration"] },
    "before": { "*": ".orch/bin/backup-db.sh {module} \"pre-$PR\"" }
  }
}
```

`dirs`는 `reserve-migration.ts`가 SQL 파일 경로를 만드는 자리이고 자동 감시에도 들어간다. `watch`는 같은 모듈에 더할 감시 전용 폴더 목록이다. 따라서 위 설정은 Java 경로의 Flyway 번호도 SQL 예약과 같은 번호 공간으로 보지만, 예약 파일은 계속 `modules/api/src/main/resources/db/migration`에 만든다. `watch`에만 적은 모듈은 감시는 되지만 예약 폴더가 없어 번호를 예약할 수 없다.
