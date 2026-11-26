# 홈서버 정리 절차

SKILL.md 「머신 고르기」 가 홈서버를 골랐을 때 읽는다. 단계 번호와 통과 조건의 뜻은 SKILL.md 의 실행 절차 표와 같다.
홈서버 스크립트는 이 맥의 스킬 번들에서 ssh 로 보내 돌린다. 홈서버 checkout 을 갱신하지 않아도 된다(`remote.ts` 머리 주석).

`$SKILL_DIR` 은 이 스킬 번들 경로다. `$HS` 는 이번 정리의 파일을 둘 세션 임시 폴더이고, 아래 변수는 그 안의 파일이다.

```bash
CFG="$HS/config.json"; SURVEY="$HS/survey.json"; GIT="$HS/git.json"; ORPHANS="$HS/orphans.json"; HERMES="$HS/hermes.tsv"; IMAGES="$HS/images.tsv"; CLEAR="$HS/clearance.json"
```

## 0. 오버레이와 접속 확인

```bash
node "$SKILL_DIR/scripts/hs_overlay.ts" --json-out "$CFG"
HOST=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).host)' "$CFG")
LOCK=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).lock)' "$CFG")
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true
```

**하나라도 실패하면 홈서버는 조사도 정리도 하지 않는다.** 아래 「실패 처리」 로 간다.
오버레이는 개인 오버레이의 `fos-home-infra 오버레이: <경로>` 줄이 가리키는 fos-home-infra 의 파일이다. 키와 형식은 `hs_overlay.ts` 머리 주석이 소유한다.

## 1. 조사

```bash
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --input "$CFG" --json-out "$SURVEY" hs_survey.ts --config "$CFG"
node "$SKILL_DIR/scripts/hs_classify.ts" "$SURVEY" --config "$CFG" --git-out "$GIT" --orphans-out "$ORPHANS" --hermes-out "$HERMES" --images-out "$IMAGES" --clearance-out "$CLEAR"
```

- 통과 조건: 두 명령이 종료 코드 0 이다. 조사는 1분 안쪽이 걸린다.
- **`hs_classify.ts` 가 3 이면 필수 조사(Docker 접속, 백업 루트, git 저장소, 대화 기록, Hermes 세션과 연결 조회 등)가 실패한 것이다. 홈서버는 승인 질문도 삭제도 하지 않고 「실패 처리」 로 간다.** 보고에는 「실행 차단」 절의 범주와 원인을 적는다. 이때 `$CLEAR` 에 차단이 적혀 `hs_delete.ts --apply` 도 종료 코드 5 로 거부하고, 브랜치와 대화 기록 삭제 입력은 비어 있다.
- 정리 전 수치는 `hs_classify.ts` 의 「정리 전 수치」 절이다(디스크 여유, Docker 회수 가능량, 메모리 available, 스왑 사용). 5단계에서 같은 값을 다시 읽는다.
- 조사가 바꾸는 것은 `git fetch --prune` 의 원격 ref 뿐이다. 운영 checkout 의 fetch 는 잠금 아래에서 하고, 잠금을 못 얻으면 그 저장소의 fetch 만 건너뛴다(`fetch: 잠금 실패`).
- 절 하나가 `읽지 못함` 이면 그 절의 후보는 승인에 올리지 않고 보고에 적는다.
- 승인은 이 조사 때의 목록에 대한 것이다. 삭제 스크립트는 항목마다 지우기 직전에 그 항목이 조사 때와 같은지(이미지 ID, 브랜치와 워크트리의 끝 커밋, 워크트리 안의 프로세스, Hermes 세션의 연결과 활동) 다시 보고, 다르거나 다시 보지 못하면 「건너뜀」 이나 「남김」 과 이유를 낸다.

## 2. 후보 분류

`hs_classify.ts` 가 등급을 붙였다. 등급 규칙과 정리 명령은 `homeserver-targets.md` 가 소유한다.
`원인 확인 필요:` 가 붙은 유지 항목은 그 문서의 「자동 정리가 놓친 것」 대로 원인을 판정한다.

## 3. 승인

승인 질문은 맥과 따로 둔다. 질문과 묶음 이름에 「홈서버」 를 붙인다.
선택지마다 확보 예상량, 되돌릴 수 있는지, sudo 가 필요한지를 적는다. 확인 필요 등급은 묶음 안에서도 항목별로 이름과 날짜를 보인다.

묶음 예: 안전한 도구 캐시, 명시적 정리 명령이 있는 백업, 사람이 정하는 백업, 쓰지 않는 이미지, 휴지통, 머지된 브랜치와 워크트리, 대화 기록, Hermes 세션, sudo 정리.

- 유지 등급, 조사만 하는 저장소의 항목, 원인 수정 제안, 메모리 제안은 질문에 넣지 않는다. 5단계 보고에 둔다.
- **표에 없는 백업 용도는 용도마다 지울지와 보관 규칙 표에 올릴지를 함께 묻는다.**
- **Hermes 세션은 출처별 묶음으로 묻는다.** `hs_classify.ts` 가 출처(cron, cli, tui 등)마다 묶어 보인다. 채팅 출처(discord)는 사람이 스레드에서 다시 이어 쓰는 대화일 수 있어 권장 묶음에서 빼고 따로 묻는다.

## 4. 실행

승인한 묶음의 명령만 돌리고 명령마다 종료 코드를 기록한다. 지우는 명령은 모두 dry-run 을 먼저 돌려 목록을 보인 뒤 `--apply` 를 붙인다.
**Docker 이미지, 백업, 운영 checkout 의 브랜치와 워크트리는 `--lock "$LOCK"` 으로 돌린다.** 배포가 복구본과 복구 이미지를 만드는 동안 지우면, 그 배포가 실패했을 때 되돌릴 복구본이 사라진다.

목록은 배열에 담아 항목마다 인자 하나로 넘긴다. macOS 기본 zsh 는 따옴표 없는 `$VAR` 를 줄마다 나누지 않아 여러 줄이 인자 하나로 넘어간다.
`REFS` 는 승인한 이미지 줄(`$IMAGES` 의 `태그=이미지ID`), `PICKS` 는 승인한 출처 묶음의 Hermes 루트(`$HERMES` 의 `profile:세션`)다. `$SOURCE` 는 승인한 출처, `$LABEL` 은 백업 용도 하나, `$KEEP` 은 그 용도의 판정 칸이 보인 남길 개수(명시적 정리 백업은 꼭 넘긴다), `$WT` 는 워크트리 경로, `$NAME` 은 휴지통 항목, `$DAYS` 는 사용자가 정한 기준 일수다.
태그로만 넘기지 않는다. 조사 뒤 태그가 다른 이미지로 옮겨 갔으면 `hs_delete.ts images --clearance "$CLEAR"` 가 건너뛴다.

```bash
REFS=(); while IFS=$'\t' read -r grade item; do REFS+=("$item"); done < "$IMAGES"
PICKS=(); while IFS=$'\t' read -r source pick; do [ "$source" = "$SOURCE" ] && PICKS+=("$pick"); done < "$HERMES"
```

`REFS` 를 만든 뒤 사용자가 고르지 않은 줄은 배열에서 뺀다.

```bash
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --lock "$LOCK" --input "$CLEAR" hs_delete.ts images --clearance "$CLEAR" "${REFS[@]}"
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --lock "$LOCK" --input "$CLEAR" hs_delete.ts images --clearance "$CLEAR" --apply "${REFS[@]}"
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --lock "$LOCK" --input "$CFG" --input "$CLEAR" hs_delete.ts backup --clearance "$CLEAR" --config "$CFG" "$LABEL"
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --lock "$LOCK" --input "$CFG" --input "$CLEAR" hs_delete.ts backup --clearance "$CLEAR" --config "$CFG" --keep "$KEEP" "$LABEL"
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --lock "$LOCK" --input "$GIT" delete_branches.ts "$GIT" --only merged
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --lock "$LOCK" --input "$GIT" --input "$CLEAR" hs_delete.ts worktrees --clearance "$CLEAR" --survey "$GIT" "$WT"
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --input "$CLEAR" hs_delete.ts trash --clearance "$CLEAR" "$NAME"
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --input "$ORPHANS" delete_sessions.ts "$ORPHANS" --older-than-days "$DAYS"
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --input "$CFG" --input "$CLEAR" hs_delete.ts hermes --clearance "$CLEAR" --config "$CFG" "${PICKS[@]}"
```

- 위 명령은 dry-run 꼴이다. 승인한 것만 같은 명령에 `--apply` 를 붙여 다시 돌린다.
- 종료 코드 75 는 잠금을 300초 안에 못 얻은 것이다. 아무것도 지우지 않았다. 실패로 보고하고 그 묶음을 멈춘다.
- 종료 코드 255 는 접속 실패다. 홈서버 단계를 멈추고 「실패 처리」 로 간다.
- 이미지 출력의 `남김 <이름>: 다른 이름이 가리킴` 은 남겨 둔 복구본의 태그가 그 이미지를 가리킨다는 뜻이다. 실패가 아니다.
- 브랜치는 지금 끝 커밋이 조사 때와 같을 때만 지운다. 기록만 남은 워크트리는 그 저장소에 남은 기록이 모두 승인 목록에 있을 때만 정리한다.
- 브랜치 분류와 `PR 확인 필요(-D)` 판정은 맥과 같다(`git-and-sessions.md` 의 「브랜치」). 점검은 `check_pr_branches.ts` 를 같은 방식으로 `--input "$GIT"` 와 함께 보낸다.
- Hermes 는 루트마다 보내기 직전에 연결 목록, 세션 DB 순서로 다시 읽어, 조사 뒤 연결됐거나 최근 활동한 트리를 `건너뜀` 으로 남긴다. 다시 읽기가 실패하면 남은 루트를 모두 지우지 않는다. 출력의 「연결된 세션 N개가 모두 남음」 을 보고에 옮긴다.
- Hermes 세션을 지워도 세션 DB 파일은 줄지 않는다. 공간 회수(`hermes sessions optimize`)는 Hermes 가 DB 를 쥐고 있으면 돌지 않아 Hermes 를 멈춰야 한다. 그래서 스킬은 돌리지 않는다. `--force` 는 쓰지 않는다. 출력의 `세션 DB 크기 <profile>` 줄을 보고에 옮긴다.
- 도구 캐시는 `ssh "$HOST" 'npm cache clean --force'` 처럼 `homeserver-targets.md` 의 명령을 그대로 보낸다.

### sudo 넘기기

**sudo 가 필요한 명령은 직접 돌리지 않는다.** 비밀번호를 요구해 멈춘다.
`hs_classify.ts` 의 「sudo 가 필요한 정리」 절에 나온 `ssh -t ... 'sudo ...'` 줄을 사용자에게 넘겨 사용자의 터미널에서 돌리게 하고, 사용자가 붙인 출력으로 결과를 확인한다.
대화창의 `!` 로 돌리게 하지 않는다. 그 셸에는 TTY 가 없어 sudo 가 비밀번호를 받지 못한다.

## 5. 재측정과 보고

```bash
node "$SKILL_DIR/scripts/remote.ts" --host "$HOST" --input "$CFG" --json-out "$SURVEY.after" hs_survey.ts --config "$CFG" --no-fetch --no-check-prs
node "$SKILL_DIR/scripts/hs_classify.ts" "$SURVEY.after" --config "$CFG"
```

1단계의 수치와 같은 항목을 「홈서버」 정리 전후 표로 보고한다. 맥 표와 합치지 않는다.
보고에 따로 적는 것:

- 메모리와 스왑: 진단 수치와 `hs_classify.ts` 의 제안. 스킬은 컨테이너 재시작이나 한도 변경을 하지 않는다. 바꿀 것은 fos-home-infra 변경으로 제안한다
- 원인 수정 제안: 2단계에서 `원인:` 으로 판정한 것, 빌드 스크립트가 남긴 워크트리
- 표에 올릴 용도: 남기기로 하고 보관 규칙 표에 올리기로 한 백업 용도
- Hermes: 지운 루트 수, 「연결된 세션이 모두 남음」 줄
- 사용자가 직접 할 일: 넘긴 sudo 명령 가운데 결과를 받지 못한 것, journal 상한처럼 설정으로 막아야 하는 것, 「Hermes 를 멈춘 점검 시간에 profile 마다 `hermes sessions optimize` 를 돌린다」 와 세션을 지운 DB 의 지금 크기

## 실패 처리

오버레이를 찾지 못했거나(`hs_overlay.ts` 종료 코드 1, 3), 접속하지 못했거나(ssh, `remote.ts` 종료 코드 255), 조사가 실패하면(`hs_survey.ts`, `hs_classify.ts` 가 0 이 아님. 실행 차단 3 을 포함한다) **홈서버는 아무것도 지우지 않는다.**
「둘 다」 면 맥은 끝까지 정리한다. 보고에 「홈서버 조사하지 못함」 과 원인, 고칠 곳을 적는다.

| 원인 | 고칠 곳 |
| --- | --- |
| 오버레이 없음 | 개인 오버레이의 `fos-home-infra 오버레이:` 줄과 그 파일 |
| 오버레이 형식 오류 | 출력에 나온 키. 형식은 `hs_overlay.ts` 머리 주석 |
| 접속 실패 | ssh 설정(`~/.ssh/config` 의 접속 이름), 홈서버 전원과 네트워크 |
| 조사 실패 | 표준 오류의 원인 줄. 홈서버 Node 버전(24 이상) |
| 실행 차단(`hs_classify.ts` 종료 코드 3) | 「실행 차단」 절의 범주와 원인. 고친 뒤 1단계부터 다시 돈다 |
