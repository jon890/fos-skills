---
name: mac-cleanup
description: |
  macOS 개발 머신의 디스크, 메모리, 스왑을 조사해 정리하고, 오래된 에이전트 세션과 머지된 브랜치, 끝난 워크트리까지 정리한다.
  worker PR 의 머지 뒤 워크트리, 브랜치 정리는 `orch` 가 맡는다. 이 스킬은 orch 가 띄운 워크트리를 지우지 않는다.
  "디스크 정리", "메모리 정리", "스왑", "용량 부족", "맥 느려", "캐시 정리", "도커 정리",
  "오래된 세션 정리", "머지된 브랜치 정리", "워크트리 정리", "disk cleanup" 같은 요청이면 이 스킬을 쓴다.
  컨테이너 런타임은 머신에 깔린 것을 감지해 런타임마다 조사하고 정리한다.
  하네스 지침(CLAUDE.md, 스킬 문서) 정리는 `harness-cleanup` 이 맡는다.
metadata:
  version: "2.1.1"
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
| 1 | 조사 | 조사 스크립트가 모두 종료 코드 0 으로 끝났고(`survey_docker.ts` 가 1 이면 실패한 런타임을 조사하지 않았다고 적는다), 정리 전 수치(디스크 여유, 스왑 사용량, 메모리 여유 비율)를 적어 두었다. 런타임마다 켜짐 여부와 VM 디스크 크기가 `$RUNTIMES` 파일에 있고, 켜진 런타임마다 이미지·volume 조사 결과가 있다. 꺼진 런타임은 조사하지 않았다고 적고 VM 디스크 크기를 확인했다 | `references/runtimes.md` |
| 2 | 후보 분류 | 모든 후보에 크기와 등급(안전 / 확인 필요 / 유지)이 붙었다 | `references/targets.md` |
| 3 | 승인 | 사용자가 묶음별로 고른 답이 있다. 꺼진 런타임마다 「켜서 조사하기」 가 따로 묶음에 들어 있었고, Docker 정리도 런타임마다 따로 물었다 | |
| 4 | 실행 | 승인한 묶음의 명령만 돌렸고 각 명령의 종료 코드와 확보량을 기록했다. 승인한 런타임만 켰다 | `references/targets.md`, `references/git-and-sessions.md` |
| 5 | 재측정과 보고 | 정리 전후 표(확보량은 호스트 디스크 여유 전후)가 있고, 런타임별 디스크 파일 전후 크기를 참고 줄로, 정리하지 않은 런타임을 크기와 함께, 사용자가 직접 할 일을 따로 적었다 | `references/runtimes.md` |

## 1. 조사

`$SKILL_DIR` 은 이 스킬 번들 경로이고, `$SURVEY`, `$ORPHANS` 는 브랜치, 워크트리가 사라진 대화 기록 조사 JSON 을 저장할 파일 경로다.
`$RUNTIMES` 는 컨테이너 런타임 조사 JSON 을 저장할 파일 경로이고, `$DOCKER_DIR` 은 런타임별 이미지·volume 조사 파일을 둘 폴더다. 아래 조사 스크립트는 모두 읽기 전용이고 cwd 는 어디든 된다.
`survey_system.ts` 는 `du` 때문에 1분에서 5분 걸리므로 백그라운드로 돌리고, 나머지를 그동안 돌린다.

```bash
node "$SKILL_DIR/scripts/survey_system.ts"
node "$SKILL_DIR/scripts/container_runtimes.ts" --json-out "$RUNTIMES"
node "$SKILL_DIR/scripts/survey_docker.ts" "$RUNTIMES" --out-dir "$DOCKER_DIR"
node "$SKILL_DIR/scripts/survey_sessions.ts" --json-out "$ORPHANS"
node "$SKILL_DIR/scripts/survey_git.ts" --json-out "$SURVEY"
node "$SKILL_DIR/scripts/survey_gradle.ts"
```

- `survey_git.ts` 는 기본으로 `git fetch --prune` 과 머지된 PR 조회를 한다. 묻지 않고 켠 채로 돈다. 승인 뒤에 옵션을 바꿔 다시 돌리면 후보가 새로 나와 승인을 다시 받아야 하기 때문이다. 옵션은 스크립트 머리 주석이 소유한다.
- `survey_system.ts` 는 기본 절 말고 설치 대기 업데이트가 든 updater 캐시, `~/.cache` 의 큰 하위 디렉터리, Codex 이전 버전, Cursor snapshots, `mise prune --dry-run` 후보(버전별 크기와 실행중 표시)를 절로 보인다. 등급과 지우는 조건은 `targets.md` 가 소유한다.
- `container_runtimes.ts` 는 설치된 컨테이너 런타임을 모두 감지해 런타임마다 이름, 켜짐 여부, docker context, VM 디스크 파일 경로와 점유 크기를 보인다. 어떤 런타임을 직접 지원하고 런타임마다 무엇이 다른지는 `references/runtimes.md` 의 표 한곳이 소유한다. 이 스킬의 문서와 절차는 런타임 이름을 쓰지 않고 그 표를 가리킨다.
  표에 없는 이 맥의 엔진은 「알 수 없는 런타임」 이고, ssh·tcp 엔드포인트는 크기만 보이는 「이 맥 밖의 엔진」 이다. 맥 밖의 엔진은 승인 묶음과 삭제에 넣지 않는다.
- `survey_docker.ts` 는 켜진 런타임마다 context 를 지정해 이미지(`docker_images.ts`)와 volume(`docker_volumes.ts --peek all --json-out`)을 따로 조사한다. 같은 소켓을 가리키는 context 는 런타임 하나로 합쳐 한 번만 본다. 사용자의 현재 docker context 는 바꾸지 않는다.
  한 런타임의 조사가 실패해도 나머지를 계속하고 종료 코드 1 로 끝난다. 실패한 런타임은 조사하지 않았다고 적는다.
  `docker_volumes.ts` 의 옵션(`--peek all`, `--json-out`)과 후보 기준은 머리 주석이 소유한다. 사용자에게 보인 목록과 `delete_volumes.ts` 에 넘길 목록이 한 번의 조사에서 나오므로 따로 `--json` 을 돌리지 않는다.
- **꺼진 런타임을 건너뛰고 끝내지 않는다.** 꺼진 채로 건너뛴 실제 세션에서 켜 보니 전체 확보량의 절반이 Docker 에서 나왔다(실측은 `references/runtimes.md`). `container_runtimes.ts` 가 꺼진 런타임의 VM 디스크 크기와 켜는 명령을 보이므로 3단계에서 런타임마다 켜서 조사할지 묻는다.
- 정리 전 수치는 `survey_system.ts` 첫 절의 디스크 여유, 스왑 사용량, `memory_pressure` 의 여유 비율이다.
  5단계에서 같은 값을 다시 읽으므로 지금 적어 둔다.
- `$RUNTIMES` 파일은 5단계에서 런타임별 디스크 파일 정리 전 크기의 기준이 된다. 정리하는 동안 같은 경로로 `container_runtimes.ts` 를 다시 돌리지 않는다.

## 2. 후보 분류

조사 결과의 후보마다 크기와 등급을 붙인다. 등급의 근거와 명령은 `references/targets.md` 가 소유한다.
`targets.md` 에 없는 후보는 "확인 필요"로 둔다.

## 3. 승인

처음 보는 판단은 배경과 권장 이유를 먼저 설명한 뒤 묻는다.
구조화 질문 도구가 있으면 여러 개를 고르는 방식으로 묶음 단위로 묻고, 권장 묶음을 첫째에 둔다.
각 선택지에 확보 예상량과 되돌릴 수 있는지를 적는다.

묶음 예: 안전한 도구 캐시, Docker 정리(켜진 런타임마다 따로 한 묶음, 이름에 런타임 id 를 붙인다), 「켜서 조사하기」(꺼진 런타임마다 따로 한 묶음, 런타임 id 와 VM 디스크 크기를 적는다), Gradle 미사용 버전, 머지된 워크트리와 브랜치, 오래된 대화 기록, 사용자가 직접 닫을 세션.

런타임은 묶음을 합치지 않고 하나씩 묻는다. 쓰지 않는 런타임까지 켜지 않기 위해서다. 승인하지 않은 런타임은 켜지도 지우지도 않는다.
켜는 명령이 없는 알 수 없는 런타임은 「켜서 조사하기」 에 넣지 않고, 이 맥 밖의 엔진은 어떤 묶음에도 넣지 않는다.

## 4. 실행

승인한 묶음의 명령만 돌리고, 명령마다 종료 코드와 확보량을 기록한다.
세션, 브랜치, 워크트리 정리는 `references/git-and-sessions.md` 의 절차를 따른다.
브랜치 삭제와 `PR 확인 필요(-D)` 판정은 `references/git-and-sessions.md`, 익명 volume 과 워크트리가 사라진 대화 기록 삭제는 `references/targets.md` 가 절차를 소유한다. 둘 다 1단계의 `--json-out` 파일을 입력으로 받아 dry-run 으로 먼저 보인 뒤, 승인한 묶음만 `--apply` 로 돈다.
reference 가 처리 절차를 정한 거절(`branch -d` 의 `not fully merged`)을 빼고는, 명령이 실패하면 멈추고 원인을 보고한다.

**승인한 꺼진 런타임을 켠다.** `$RUNTIME` 은 `$RUNTIMES` 파일의 런타임 id 다. 켜는 명령은 런타임마다 하나이고 `references/runtimes.md` 가 소유한다.
`runtime_start.ts` 가 켜고 `docker info` 가 성공할 때까지 최대 120초 기다린다. 넘으면 종료 코드 1 이고, 그 런타임만 「켜지 못함」 으로 적은 채 나머지를 계속한다.
켜졌으면 그 런타임만 다시 조사하고, 새로 나온 후보는 3단계로 돌아가 그 런타임의 Docker 정리 묶음으로 새로 승인받는다. 정리가 끝나도 런타임을 끄지 않는다.

```bash
node "$SKILL_DIR/scripts/runtime_start.ts" "$RUNTIMES" --runtime "$RUNTIME"
node "$SKILL_DIR/scripts/survey_docker.ts" "$RUNTIMES" --out-dir "$DOCKER_DIR" --runtime "$RUNTIME"
```

Docker 는 승인한 런타임의 엔진에만 지운다. `$CONTEXT` 는 그 런타임의 context(조사 출력의 `context=`)이고, `docker context use` 로 사용자의 현재 context 를 바꾸지 않는다.
이미지와 빌드 캐시는 `docker_cleanup.ts` 가, volume 은 `delete_volumes.ts` 가 보낸다. 둘 다 그 런타임의 context 로만 보내고, 이 맥 밖의 엔진이면 종료 코드 5 로 거부한다. 이미지와 빌드 캐시 명령은 `references/targets.md` 가 소유한다.

## 5. 재측정과 보고

1단계에서 적은 세 수치를 같은 방법으로 다시 읽고, 정리 전후 표로 보고한다.
Docker 를 지운 런타임마다 `runtime_reclaim.ts` 를 돌려 VM 디스크를 회수한다. 회수 방법은 런타임마다 다르고(`references/runtimes.md`) 스크립트가 표대로 고른다.
회수 전에 읽으면 호스트 디스크가 늘지 않은 것처럼 보이므로 회수를 돌린 뒤에 호스트 여유를 읽는다. 종료 코드 2 면 남은 차이를 보고에 적는다.

```bash
node "$SKILL_DIR/scripts/runtime_reclaim.ts" "$RUNTIMES" --runtime "$RUNTIME"
```

보고에는 아래 세 가지를 따로 둔다.

- 확보량: 호스트 디스크 여유 전후 값이다. 런타임별 디스크 파일 크기를 확보량에 더하지 않는다.
- 런타임별 디스크 파일 전후 크기: 참고 줄이다. `runtime_reclaim.ts` 의 출력을 그대로 적는다.
- 정리하지 않은 런타임: 켜지 않았거나 켜지 못한 런타임, 회수하지 못한 런타임을 VM 디스크 크기와 함께 적는다. 꺼진 런타임을 말없이 건너뛰는 것이 이 스킬이 막으려는 빈틈이다.

사용자가 직접 할 일을 따로 적는다.

- 오래된 에이전트 세션 닫기
- 스왑이 큰 채 오래 켜 둔 머신이면 재부팅. 재부팅하면 스왑 파일과 `/private/var/folders` 임시 파일이 정리된다
- 알 수 없는 런타임의 VM 디스크 회수
- 권한이 없어 건너뛴 시스템 영역 정리
