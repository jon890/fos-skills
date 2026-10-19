---
name: mac-cleanup
description: |
  macOS 개발 머신의 디스크, 메모리, 스왑을 조사해 정리하고, 오래된 에이전트 세션과 머지된 브랜치, 끝난 워크트리까지 정리한다.
  "디스크 정리", "메모리 정리", "스왑", "용량 부족", "맥 느려", "캐시 정리", "도커 정리",
  "오래된 세션 정리", "머지된 브랜치 정리", "워크트리 정리", "disk cleanup" 같은 요청이면 이 스킬을 쓴다.
  하네스 지침(CLAUDE.md, 스킬 문서) 정리는 `harness-cleanup` 이 맡는다.
metadata:
  version: "1.6.0"
---

# mac-cleanup

**목표: 정리 전후 수치를 비교할 수 있도록, 사용자가 묶음별로 승인한 후보만 정리하고 확보량과 사용자가 직접 할 일을 보고한다.**

- 조사는 읽기 전용이다. 지우거나 종료하는 명령은 승인 뒤에만 돈다.
- 되돌릴 수 없는 것(데이터 volume, 대화 기록, 미커밋 변경)은 기본 등급을 "확인 필요"로 둔다.
- 지시와 실제가 어긋나면(예: 캐시 디렉터리 일부가 캐시가 아님) 실행 전에 계획을 고치고 사용자에게 알린다.

## 실행 절차

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 조사 | `--fetch`, `--check-prs` 사용 여부를 사용자에게 물어 정했고, 조사 스크립트가 그 옵션으로 모두 종료 코드 0 으로 끝났고, 정리 전 수치(디스크 여유, 스왑 사용량, 메모리 여유 비율)를 적어 두었다. Colima 가 꺼져 `docker_images.py` 와 `docker_volumes.py` 만 1 이면 Docker 항목을 건너뛰었다고 적었다 | |
| 2 | 후보 분류 | 모든 후보에 크기와 등급(안전 / 확인 필요 / 유지)이 붙었다 | `references/targets.md` |
| 3 | 승인 | 사용자가 묶음별로 고른 답이 있다 | |
| 4 | 실행 | 승인한 묶음의 명령만 돌렸고 각 명령의 종료 코드와 확보량을 기록했다 | `references/targets.md`, `references/git-and-sessions.md` |
| 5 | 재측정과 보고 | 정리 전후 표가 있고, 사용자가 직접 할 일을 따로 적었다 | |

## 1. 조사

`$SKILL_DIR` 은 이 스킬 번들 경로다. 스크립트는 모두 읽기 전용이고 cwd 는 어디든 된다.
`survey_system.sh` 는 `du` 때문에 1분에서 5분 걸리므로 백그라운드로 돌리고, 나머지를 그동안 돌린다.

조사를 돌리기 전에 아래 두 옵션을 사용자에게 먼저 묻는다.
승인 뒤에 옵션을 바꿔 다시 돌리면 후보가 새로 나와 승인을 다시 받아야 한다.
고른 옵션으로 돌린 결과로 2단계 분류를 한다.

```bash
bash "$SKILL_DIR/scripts/survey_system.sh"
python3 "$SKILL_DIR/scripts/survey_sessions.py"
python3 "$SKILL_DIR/scripts/survey_git.py"
bash "$SKILL_DIR/scripts/survey_gradle.sh"
python3 "$SKILL_DIR/scripts/docker_images.py"
python3 "$SKILL_DIR/scripts/docker_volumes.py"
```

- `survey_git.py` 는 기본으로 원격 ref 를 갱신하지 않는다. 마지막 fetch 이후의 머지는 보이지 않으므로, 후보를 믿기 전에 `--fetch` 로 돌릴지 이 단계에서 묻는다.
- squash 머지는 `--is-ancestor` 로 보이지 않는다. `--check-prs` 를 함께 쓸지도 이 단계에서 묻는다. 머지 판정이 안 된 브랜치마다 `gh` 원격 호출이 생기므로 브랜치가 많으면 오래 걸린다.
- `docker_images.py` 와 `docker_volumes.py` 는 Docker 가 떠 있을 때만 돈다. 종료 코드 1 이면 먼저 `colima status` 를 본다. 시작 중이면 올라온 뒤 다시 돌리고, 떠 있지 않을 때만 Docker 항목을 건너뛴다.
- `docker_volumes.py` 는 후보를 정하는 기준 시간 안에 생긴 volume 을 "최근" 으로 따로 보인다. 내용을 열어 보려면 `--peek N` 으로 다시 돌린다.
- `survey_system.sh` 의 Docker 절이 같은 이유로 건너뛰었다면 Colima 가 올라온 뒤 그 절만 다시 보면 된다.
- 정리 전 수치는 `survey_system.sh` 첫 절의 디스크 여유, 스왑 사용량, `memory_pressure` 의 여유 비율이다.
  5단계에서 같은 값을 다시 읽으므로 지금 적어 둔다.

## 2. 후보 분류

조사 결과의 후보마다 크기와 등급을 붙인다. 등급의 근거와 명령은 `references/targets.md` 가 소유한다.
`targets.md` 에 없는 후보는 "확인 필요"로 둔다.

## 3. 승인

처음 보는 판단은 배경과 권장 이유를 먼저 설명한 뒤 묻는다.
구조화 질문 도구가 있으면 여러 개를 고르는 방식으로 묶음 단위로 묻고, 권장 묶음을 첫째에 둔다.
각 선택지에 확보 예상량과 되돌릴 수 있는지를 적는다.

묶음 예: 안전한 도구 캐시, Docker 정리, Gradle 미사용 버전, 머지된 워크트리와 브랜치, 오래된 대화 기록, 사용자가 직접 닫을 세션.

## 4. 실행

승인한 묶음의 명령만 돌리고, 명령마다 종료 코드와 확보량을 기록한다.
세션, 브랜치, 워크트리 정리는 `references/git-and-sessions.md` 의 절차를 따른다.
브랜치 삭제는 `survey_git.py --json` 결과를 `delete_branches.py` 에 넘겨 먼저 dry-run 으로 보인 뒤, 승인한 묶음만 `--apply` 로 돈다. `PR 확인 필요(-D)` 브랜치는 `check_pr_branches.py` 에 같은 조사 JSON 을 넘겨 판정을 보이고, 지울지는 사용자가 정한다. 익명 volume 은 `docker_volumes.py` 가 보인 후보 중 내용을 열어 확인한 것만 이름을 지정해 지운다.
reference 가 처리 절차를 정한 거절(`branch -d` 의 `not fully merged`)을 빼고는, 명령이 실패하면 멈추고 원인을 보고한다.

## 5. 재측정과 보고

1단계에서 적은 세 수치를 같은 방법으로 다시 읽고, 정리 전후 표로 보고한다.
Docker 를 Colima 에서 정리했다면 `fstrim` 까지 돌아야 호스트 디스크가 늘어난다(`targets.md`).

사용자가 직접 할 일을 따로 적는다.

- 오래된 에이전트 세션 닫기
- 스왑이 큰 채 오래 켜 둔 머신이면 재부팅. 재부팅하면 스왑 파일과 `/private/var/folders` 임시 파일이 정리된다
- 권한이 없어 건너뛴 시스템 영역 정리
