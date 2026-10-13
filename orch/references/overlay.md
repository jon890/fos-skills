# 저장소 오버레이

`<repo-root>/.claude/orch-overlay.md` 는 이 스킬의 코어가 모르는 저장소 고유 사정을 담는다.
코디네이터가 그 저장소의 worker 를 띄우기 전에 먼저 읽고, 코어와 어긋나면 오버레이를 따른다.
없으면 코어 기본값으로 동작한다.

**오버레이에는 저장소마다 달라지는 값과 절차만 둔다.** 코어의 단계와 규칙을 옮겨 적지 않는다.
옮겨 적으면 코어가 바뀔 때 오버레이의 사본이 낡는다.

## 적을 것

| 항목 | 담는 것 | 쓰는 단계 |
| --- | --- | --- |
| 기준 브랜치 | PR 의 base, `--base-branch` 에 줄 원격 브랜치 | 3, 7 |
| 공통 지시서 위치 | `templates/spec-common.md` 를 채운 파일 경로 | 2 |
| 검증 명령 | worker 와 코디네이터가 돌릴 포맷, lint, 테스트 명령 | 2, 6 |
| 머지 조건 | 필수 체크 이름(`--required` 로 넘길 값), base 최신을 품게 할지(`--require-up-to-date`), 관리자 우회 가능 여부, 머지 방식(merge, squash) | 7 |
| 머지 전 명령 | DB 마이그레이션이 든 PR 앞의 백업 명령과 인자, 보관 개수 | 7 |
| 마이그레이션 순서 | 마이그레이션 PR 끼리의 머지 순서, 모듈별 선후, 공유 DB 에 적용하지 않는 규칙 | 2, 7 |
| CI runner 장애 대응 | runner 가 offline 이 됐을 때 누가 무엇을 하는지, 끊긴 실행을 다시 돌리는 명령 | 4, 7 |
| 원격 접속 규칙 | 개발 서버 조회에 쓸 접속 설정, 읽기만 허용하는지 | 2 |
| 비밀값 규칙 | 읽지 않을 파일, 비밀값을 넘기는 방법 | 2 |
| 업무 시스템 연동 | 업무 등록 양식, 상태 전환 시점, 링크 규칙 | 7 |
| 머지 뒤 정리에서 지울 문서 위치 | 지시서 사본, 설계 메모, PR 본문을 두는 폴더 | 7 |
| 지시서 폴더 | `cleanup-sweep.py --specs-dir` 에 줄 경로. worktree 이름과 같은 지시서를 지운다 (예: `.omc/handoffs/specs/`) | 4, 7 |
| worktree 루트 | `board-sync.py --worktree-root` 에 줄 디렉터리. 보드의 worktree 칸이 이름만 적혀 있을 때 붙인다 | 4 |
| 진행 보드 | 보드 파일 위치, 목표 항목 id 와 추적 항목 파일(`board-sync.py --goal --goal-items`) | 4, 7 |

서버 이름, 접속 설정 파일 경로처럼 공개되면 안 되는 값이 있으면 오버레이를 공개 저장소에 커밋하지 않는다.
로컬 전용 위치에 두고 `.git/info/exclude` 로 뺀다.

## 예시

```markdown
# orch 오버레이

- 기준 브랜치: develop. 필수 체크 `backend`, 관리자 우회 불가
- 머지 큐는 `--require-up-to-date --required backend` 로 돌린다
- 공통 지시서: `.omc/handoffs/spec-common.md`
- 검증: `scripts/verify.sh format`, `scripts/verify.sh test`
- 머지 전 명령: DB 마이그레이션이 든 PR 은 `PR:./bin/backup-db.sh <db> "before-pr-$PR"`. DB 마다 최근 2개만 보관
- CI runner 가 offline 이면 묻지 않고 runner 호스트를 재부팅하고, 끊긴 실행은 `gh run rerun --failed` 로 다시 돌린다
```
