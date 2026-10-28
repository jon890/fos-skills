---
name: mac-cleanup
description: |
  macOS 개발 머신의 디스크, 메모리, 스왑을 조사해 정리하고, 오래된 에이전트 세션과 머지된 브랜치, 끝난 워크트리까지 정리한다.
  worker PR 의 머지 뒤 워크트리, 브랜치 정리는 `orch` 가 맡는다. 이 스킬은 orch 가 띄운 워크트리를 지우지 않는다.
  "디스크 정리", "메모리 정리", "스왑", "용량 부족", "맥 느려", "캐시 정리", "도커 정리",
  "오래된 세션 정리", "머지된 브랜치 정리", "워크트리 정리", "disk cleanup" 같은 요청이면 이 스킬을 쓴다.
  하네스 지침(CLAUDE.md, 스킬 문서) 정리는 `harness-cleanup` 이 맡는다.
metadata:
  version: "1.11.1"
---

# mac-cleanup

**목표: 정리 전후 수치를 비교할 수 있도록, 사용자가 묶음별로 승인한 후보만 정리하고 확보량과 사용자가 직접 할 일을 보고한다.**

- 조사는 읽기 전용이다. 지우거나 종료하는 명령은 승인 뒤에만 돈다.
- 되돌릴 수 없는 것(데이터 volume, 대화 기록, 미커밋 변경)은 기본 등급을 "확인 필요"로 둔다.
- 지시와 실제가 어긋나면(예: 캐시 디렉터리 일부가 캐시가 아님) 실행 전에 계획을 고치고 사용자에게 알린다.

## 개인 오버레이

`~/.claude/mac-cleanup-overlay.md` 가 있으면 조사를 시작하기 전에 **먼저 읽고** 겹치는 판단은 코어보다 우선한다.
오버레이는 이 머신에만 해당하는 예외, 곧 정리 후보에서 뺄 앱과 그 이유를 소유한다. 공개 저장소인 이 스킬에는 개인 목록을 적지 않는다.
오버레이가 정리 후보에서 빼라고 한 항목은 2단계 후보 분류와 3단계 승인 질문에 올리지 않는다.
없으면 코어 기본값으로 동작한다.

## 실행 절차

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 조사 | 조사 스크립트가 모두 종료 코드 0 으로 끝났고, 정리 전 수치(디스크 여유, 스왑 사용량, 메모리 여유 비율)를 적어 두었다. Colima 가 꺼져 `docker_images.py` 와 `docker_volumes.py` 만 1 이면 Docker 를 조사하지 않았다고 적고 VM 디스크 크기를 확인했다 | |
| 2 | 후보 분류 | 모든 후보에 크기와 등급(안전 / 확인 필요 / 유지)이 붙었다 | `references/targets.md` |
| 3 | 승인 | 사용자가 묶음별로 고른 답이 있다. 꺼진 Colima 를 켜서 조사할지도 묶음에 들어 있었다 | |
| 4 | 실행 | 승인한 묶음의 명령만 돌렸고 각 명령의 종료 코드와 확보량을 기록했다 | `references/targets.md`, `references/git-and-sessions.md` |
| 5 | 재측정과 보고 | 정리 전후 표가 있고, 사용자가 직접 할 일을 따로 적었다 | |

## 1. 조사

`$SKILL_DIR` 은 이 스킬 번들 경로이고, `$SURVEY` 와 `$VOLUMES` 는 브랜치와 익명 volume 조사 JSON 을 저장할 파일 경로다. 아래 조사 스크립트는 모두 읽기 전용이고 cwd 는 어디든 된다.
`survey_system.py` 는 `du` 때문에 1분에서 5분 걸리므로 백그라운드로 돌리고, 나머지를 그동안 돌린다.

```bash
python3 "$SKILL_DIR/scripts/survey_system.py"
python3 "$SKILL_DIR/scripts/survey_sessions.py"
python3 "$SKILL_DIR/scripts/survey_git.py" --json-out "$SURVEY"
bash "$SKILL_DIR/scripts/survey_gradle.sh"
python3 "$SKILL_DIR/scripts/docker_images.py"
python3 "$SKILL_DIR/scripts/docker_volumes.py" --peek all --json-out "$VOLUMES"
```

- `survey_git.py` 는 기본으로 `git fetch --prune` 과 머지된 PR 조회를 한다. 묻지 않고 켠 채로 돈다. 승인 뒤에 옵션을 바꿔 다시 돌리면 후보가 새로 나와 승인을 다시 받아야 하기 때문이다. 옵션은 스크립트 docstring 이 소유한다.
- `survey_system.py` 는 기본 절 말고 설치 대기 업데이트가 든 updater 캐시, `~/.cache` 의 큰 하위 디렉터리, Codex 이전 버전, Cursor snapshots, `mise prune --dry-run` 후보를 절로 보인다. 등급과 지우는 조건은 `targets.md` 가 소유한다.
- `docker_images.py` 와 `docker_volumes.py` 는 Docker 가 떠 있을 때만 돈다. 종료 코드 1 이면 먼저 `colima status` 를 본다. 시작 중이면 올라온 뒤 다시 돌린다.
  `docker_volumes.py` 의 옵션(`--peek all`, `--json-out`)과 후보 기준은 docstring 이 소유한다. 사용자에게 보인 목록과 `delete_volumes.py` 에 넘길 목록이 한 번의 조사에서 나오므로 따로 `--json` 을 돌리지 않는다.
- **Colima 가 꺼져 있으면 건너뛰고 끝내지 않는다.** 실제 세션에서 건너뛴 뒤 켜 보니 전체 확보량 100Gi 가운데 50.9GiB 가 Docker 에서 나왔다. VM 디스크 파일의 점유 크기를 읽어 3단계에 보이고, 켜서 조사할지를 승인 묶음으로 묻는다. `survey_system.py` 의 Docker 절도 같은 이유로 건너뛰었으면 Colima 가 올라온 뒤 그 절만 다시 본다.

  ```bash
  du -sh ~/.colima/_lima/_disks/colima/datadisk
  ```

- 정리 전 수치는 `survey_system.py` 첫 절의 디스크 여유, 스왑 사용량, `memory_pressure` 의 여유 비율이다.
  5단계에서 같은 값을 다시 읽으므로 지금 적어 둔다.

## 2. 후보 분류

조사 결과의 후보마다 크기와 등급을 붙인다. 등급의 근거와 명령은 `references/targets.md` 가 소유한다.
`targets.md` 에 없는 후보는 "확인 필요"로 둔다.

## 3. 승인

처음 보는 판단은 배경과 권장 이유를 먼저 설명한 뒤 묻는다.
구조화 질문 도구가 있으면 여러 개를 고르는 방식으로 묶음 단위로 묻고, 권장 묶음을 첫째에 둔다.
각 선택지에 확보 예상량과 되돌릴 수 있는지를 적는다.

묶음 예: 안전한 도구 캐시, Docker 정리(Colima 가 꺼져 있으면 「켜서 조사하기」 를 별도 묶음으로 두고 VM 디스크 크기를 적는다), Gradle 미사용 버전, 머지된 워크트리와 브랜치, 오래된 대화 기록, 사용자가 직접 닫을 세션.

## 4. 실행

승인한 묶음의 명령만 돌리고, 명령마다 종료 코드와 확보량을 기록한다.
세션, 브랜치, 워크트리 정리는 `references/git-and-sessions.md` 의 절차를 따른다.
브랜치 삭제와 `PR 확인 필요(-D)` 판정은 `references/git-and-sessions.md`, 익명 volume 삭제는 `references/targets.md` 가 절차를 소유한다. 둘 다 1단계의 `--json-out` 파일을 입력으로 받아 dry-run 으로 먼저 보인 뒤, 승인한 묶음만 `--apply` 로 돈다. Docker 를 지웠다면 마지막에 `colima_trim.py` 를 돈다.
reference 가 처리 절차를 정한 거절(`branch -d` 의 `not fully merged`)을 빼고는, 명령이 실패하면 멈추고 원인을 보고한다.

## 5. 재측정과 보고

1단계에서 적은 세 수치를 같은 방법으로 다시 읽고, 정리 전후 표로 보고한다.
Docker 를 Colima 에서 정리했다면 `colima_trim.py` 까지 돌아야 호스트 디스크가 늘어난다(`targets.md`).
이 스크립트가 trim 결과를 재서 부족하면 다시 돌고, 호스트 확보량을 출력한다. 종료 코드 2 면 남은 차이를 보고에 적는다.

```bash
python3 "$SKILL_DIR/scripts/colima_trim.py"
```

사용자가 직접 할 일을 따로 적는다.

- 오래된 에이전트 세션 닫기
- 스왑이 큰 채 오래 켜 둔 머신이면 재부팅. 재부팅하면 스왑 파일과 `/private/var/folders` 임시 파일이 정리된다
- 권한이 없어 건너뛴 시스템 영역 정리
