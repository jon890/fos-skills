# CHANGELOG: build-with-teams

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 5.0.0

### 목표와 순서를 앞에 세운다

- 목표 한 문장과 팀원 넷이 각자 무엇을 보는지를 첫머리에 두었다.
- 실행 순서가 네 곳에 흩어져 있던 것을 0단계부터 7단계까지 한 줄기로 모았다.
  머리말 요약, 흐름도, 단계 본문, 4단계 안의 재설명이 서로를 반복하고 있었다.
- 등급을 정하는 지침을 뒤쪽 절에서 executor 스폰 단계로 옮겼다.

### 모드 분기를 없앤다

- 구현은 규모와 무관하게 executor 에게 위임한다. team-lead 가 겸하는 모드 B 를 제거했다.
- 모드에 따라 갈리는 문구 38줄과 참조 문서 둘의 「두 모드에서 이 문서를 읽는 법」 절이 사라졌다.
- 우회 낱말 「구현자」 를 `executor` 로 되돌렸다.

### 사전 검증을 스크립트로 옮긴다

- `scripts/plan_precheck.py` 를 추가했다. 종료 코드는 0 통과, 1 사용자 결정 필요, 2 실행 불가다.
- 판정 근거가 전부 결정적인 git 과 gh 질의라 산문으로 둘 이유가 없었다.
- 로컬 task, 브랜치에만 있는 task, 브랜치는 있고 task 가 없는 경우, 머지 후 브랜치가 지워진 경우를
  실제 저장소 셋에서 확인했다. 검사 14개를 `tests/test_plan_precheck.py` 에 두었다.

### 실측으로 뒤집은 것

- `run_in_background: true` 를 뺐다. 스폰 도구에 그 인자가 없고 백그라운드가 기본 동작이다.
- `mode: "bypassPermissions"` 를 뺐다. 받아들이되 무시되며, 팀원은 부모 세션의 권한 모드를 따른다.
  executor 가 bypassPermissions 로 돈다는 기술이 거짓이었다.
- `shutdown_request` 를 `TaskStop` 으로 바꿨다. 메시지 도구가 그것을 legacy 로 분류한다.
- 이름 없는 스폰이 「단방향」 이라는 표를 지웠다. agent id 로 보내고 받는 것을 확인했다.
  이름을 붙이는 이유는 능력이 아니라 주소의 가독성이다.
- 모델 상속 설명을 도구 계약대로 고쳤다. 팀원 기본 모델이 설정되어 있으면 그 값이 이기고,
  없으면 team-lead 를 상속한다. 어느 쪽인지 문서로 알 수 없으므로 매번 명시한다.

### 지어낸 이름과 끊긴 참조

- `surface adapter` 와 `runtime adapter` 를 지웠다. 그런 것이 없고, 등급을 옮기는 주체는 team-lead 다.
- 「브랜치 보존은 7단계 7항이 소유한다」 를 지웠다. 7항에 그 내용이 없었다.
- `planning/task-create.md` 참조를 `planning` 의 `references/task-create.md` 로 고쳤다.

### 근거 없는 값

- 규모 표의 phase 개수 기준을 뺐다. planning 이 분할 상한을 지운 뒤로 근거가 없다.
  무엇을 바꾸는가로 가른다.
- `execution_profile` 과 `model` 이 함께 있을 때의 차단을 뺐다.
  실측 `index.json` 621개 중 둘 다 가진 것이 0개이고, planning 의 검사기가 생성 시점에 막는다.
- 한도 카운터를 `.omc/state/` 에 유지한다는 문장을 지웠다.
  그 디렉터리는 worktree 와 함께 사라지고, 같은 plan 재실행은 사전 검증이 막는다.
