# orch

일을 worker 에게 맡길 때 지시서를 쓰고, 띄우고, 기다리고, 머지한 뒤 치우는 일을 하나하나 챙기는 수고를 덜어 준다.
코디네이터 세션이 Orca worker 를 띄워 PR 이 머지될 때까지 맡기고, worker 가 보고한 완료를 diff 와 검사로 다시 확인한 뒤 머지 큐로 머지한다.
머지가 끝나면 워크트리, 로컬과 원격 브랜치, worker 터미널, 끝난 지시서를 지우고 배포 성공을 기다린 뒤 업무와 진행 보드를 마무리한다.
진행 보드는 worker 를 띄울 때 항목을 만들고, 루프가 PR 연결과 머지를 반영하며 결정이 바뀌면 코디네이터를 깨운다. [갱신 담당 표](references/board.md#갱신-담당)에서 자동 반영과 코디네이터가 할 일을 볼 수 있다.
기다리는 동안에는 저장소마다 상주 루프 하나가 질문 확인, 정리, 내 PR 의 CI 감시, 충돌 PR 알림을 맡고, 코디네이터는 알릴 일이 생길 때만 깨어난다.

머지는 코디네이터만 한다. worker 의 워크트리에는 `gh pr merge` 를 막는 권한 규칙이 들어간다.
PR 생성은 사용자가 미리 허락한 경우에만 worker 에게 맡기고, 사용자가 정할 질문은 코디네이터가 대신 답하지 않고 권장안을 붙여 사용자에게 올린다.

## 이럴 때 쓴다

- 지금 연 저장소가 아닌 곳의 파일을 고치고 커밋해야 한다
- 현재 저장소에서 구현부터 PR, 머지까지 가는 독립적이고 큰 작업이 있다
- 여러 작업을 worker 여럿에게 나눠 맡기고, Orca 화면에서 어느 worker 가 어느 워크트리에서 무엇을 하는지 보고 싶다
- 준비된 PR 여러 개를 차례로 머지하고 뒷정리까지 끝내고 싶다

"worker 띄워", "병렬로 맡겨", "머지 큐", "PR 머지하고 정리" 처럼 말하거나 `/orch` 로 부르면 이 스킬이 뜬다.

## 사용 예시

작업 내용, PR 번호, 에이전트 배정은 예시다.

```text
나:   결제 취소 API 와 알림 설정 화면을 병렬로 맡겨 줘. PR 까지 열어도 돼

스킬: 코드를 확인했습니다. 부분 취소의 수수료 처리는 정해 주셔야 합니다.
        결정: 부분 취소 수수료
        - 취소 금액에 비례해 돌려준다
        - 돌려주지 않는다
        권장: 비례해 돌려준다. 전액 취소가 이미 그렇게 처리한다

나:   권장대로

스킬: 지시서 검사를 통과해 worker 둘을 띄웠습니다.
        결제 취소 API     Claude   feat/partial-cancel
        알림 설정 화면     Codex    feat/notify-settings
      PR 이 준비되면 diff 를 읽고 검사를 다시 돌립니다.

      (worker 가 #512, #513 준비됨을 보낸다)

스킬: 두 PR 의 diff 와 테스트를 확인하고 머지 큐로 머지했습니다.
        배포    성공
        정리    워크트리 2개, 로컬과 원격 브랜치, worker 터미널, 지시서를 지웠습니다
      열린 PR #520 이 이번 머지로 base 와 충돌해, 그 PR 을 만든 worker 에게 base 를 합치라고 보냈습니다.
```

## 받는 것

- 띄우기 전에 담당 경로 겹침과 금지 문구를 검사한 지시서. 저장소 공통 지시서 하나와 worker 마다 범위, 완료 기준, 브랜치, 허락 범위를 적은 파일이다
- 사용자가 정할 결정. 배경과 권장안이 붙어 올라온다
- 머지된 PR. 체크, 미해결 리뷰 스레드, 원격 HEAD 를 확인한 뒤 머지 큐가 차례로 머지한다
- 머지 뒤 정리된 작업 공간. 워크트리, 로컬과 원격 브랜치, worker 터미널과 dispatch, 그 작업만의 지시서가 남지 않는다
- 머지 커밋이 든 배포의 성공 확인. 저장소에 설정이 있으면 업무 완료 처리와 진행 보드 done 까지 한다
- 이번 머지로 base 와 충돌하게 된 열린 PR 의 목록. 그 PR 을 만든 worker 에게 base 를 합치라고 알린다

## 준비

- Orca 앱과 `orca` CLI 가 필요하다. worker 는 Orca orchestration 으로 띄운다
- PATH 에 node 24 이상과 `python3` 가 있어야 한다. node 가 낮으면 스킬을 열 때 `NODE-TOO-OLD` 로 알린다
- `gh` 에 로그인돼 있어야 PR 을 확인하고 머지한다
- 같은 PC 의 무거운 검사를 대기열로 돌리는 `heavy-slot` 은 perl 이 PATH 에 있어야 한다
- 스킬을 열 때 설치본이 원본 main 보다 낡았으면 갱신 명령을 보여 준다
- 저장소마다 다른 기준 브랜치, 검증 명령, 머지 조건은 `<저장소>/.orch/overlay.md` 에, 배포 워크플로와 보드 위치는 `.orch/config.json` 에, 업무 완료 같은 저장소 고유 동작은 `.orch/hooks/<이벤트>.ts` 에 둔다. 없으면 기본값으로 동작한다

## 설정한 저장소의 예

모듈이 여러 개인 Gradle 저장소에서 실제로 쓰는 설정과 흐름이다. 저장소, 모듈, 업무 번호, PR 번호는 바꿨다.

`.orch/config.json` 발췌:

```json
{
  "finish": {
    "base_branch": "develop",
    "deploy_workflow": "cd-dev.yml",
    "deploy_branch": "develop",
    "task_pattern": "^#SHOP/([0-9]+)",
    "board": ".omc/board.json",
    "specs_dir": ".orch/specs"
  },
  "queue": {
    "required": ["backend", "frontend"],
    "method": "merge",
    "require_up_to_date": true,
    "up_to_date_when": "overlap",
    "shared_paths": ["^modules/common/", "^build\\.gradle\\.kts$"],
    "unit_prefix": "modules/",
    "auto_merge": true,
    "auto_review": { "pass": "\\*\\*머지 가능\\*\\*", "block": "\\*\\*머지 전 반영 필요\\*\\*" }
  },
  "migrations": {
    "dirs": { "order-api": "modules/order-api/src/main/resources/db/migration" },
    "before": { "order-api": ".orch/bin/backup-db.sh order pre-auto" }
  }
}
```

| 설정 | 바뀌는 동작 |
| --- | --- |
| `finish.deploy_workflow`, `deploy_branch` | 머지 뒤 `develop` 의 dev 배포가 성공할 때까지 기다린 다음 업무와 보드를 마무리한다 |
| `queue.auto_merge`, `auto_review` | 필수 체크가 통과하고, 미해결 스레드가 없고, 자동 리뷰의 마지막 판정이 `pass` 문구인 PR 을 상주 루프가 스스로 머지 큐에 건다 |
| `queue.up_to_date_when: overlap` | 앞 PR 과 바꾼 모듈이 겹치지 않으면 base 를 다시 합치지 않고 바로 머지한다. `shared_paths` 를 건드린 PR 은 늘 겹친 것으로 본다 |
| `migrations.dirs`, `before` | 마이그레이션이 든 PR 은 번호 순서를 지켜 머지하고, 머지 직전에 그 모듈의 DB 를 백업한다 |

`.orch/overlay.md` 에는 검증 명령(`./gradlew :<모듈>:build` 와 통합 테스트), 마이그레이션 파일을 고치지 않는 규칙, CI runner 장애 대응처럼 설정 값으로 적을 수 없는 절차를 둔다.
`.orch/hooks/after-deploy.ts` 는 dev 배포가 끝나면 업무 상태를 바꾸고 태그를 단다.
키 전체는 [`references/overlay.md`](references/overlay.md) 가 소유한다.

이렇게 설정하면 worker 를 띄운 뒤에는 코디네이터에게 알릴 일이 있을 때만 대화가 이어진다.

```text
나:   주문 이력 조회 API 와 정산 내역 화면을 맡겨 줘. PR 까지 열어도 돼

스킬: worker 둘을 띄웠습니다.
        주문 이력 조회 API   Claude   feature/SHOP/118-order-history
        정산 내역 화면       Codex    feature/SHOP/121-settlement-view

      (worker 가 마이그레이션 번호를 예약하고 PR #301, #302 를 연다.
       #302 의 frontend 체크가 실패하자 그 worker 가 고쳐 다시 올린다)

스킬: 상주 루프가 두 PR 을 머지했습니다.
        #301   order-api 마이그레이션이 있어 머지 직전에 DB 를 백업했습니다
        #302   #301 과 모듈이 겹치지 않아 base 를 다시 합치지 않고 머지했습니다
        배포    dev 성공
        업무    SHOP/118, SHOP/121 상태를 바꾸고 DEV 태그를 달았습니다
        보드    두 항목 done
        정리    워크트리, 브랜치, worker 터미널, 지시서를 지웠습니다
```

진행 보드는 코디네이터 세션의 `/board` 창으로 본다. 아래는 같은 구성의 데모 저장소에서 2026-10-27 에 찍은 화면이다.
목표와 결정 필요가 맨 위에 오고, 항목마다 막대와 지금 단계, 그 항목을 맡은 worker 가 보인다.

![데모 저장소의 /board 창. 오늘 목표 1/4, 결정 필요 항목 둘이 보인다](../docs/images/board.png)

## 함께 쓰는 스킬

- orca 명령 문법과 worker lifecycle 은 Orca 의 `orchestration` 스킬이 맡는다
- 감독 없이 작업을 통째로 넘기는 handoff 는 `orca-cli` 가 맡는다
- 결과만 받으면 되는 짧은 조사, 판정, 리뷰는 이 스킬 대신 하위 에이전트에게 맡긴다
- 범위가 큰 일은 worker 가 `planning` 으로 설계를 확정하고 `build-with-teams` 로 구현하도록 지시서에 적는다
- 미해결 리뷰 스레드 세기와 리뷰 회신은 `review-fix` 의 스크립트를 쓴다
