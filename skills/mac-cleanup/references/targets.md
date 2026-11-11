# 정리 후보

후보마다 등급, 명령, 이유를 적는다. 등급은 안전(승인 뒤 바로 실행), 확인 필요(내용을 열어 보거나 사용자가 정한다), 유지다.
`$VAR` 는 후보의 경로나 이름으로 채운다.

## 스왑과 재부팅

| 대상 | 등급 | 처리 | 이유 |
| --- | --- | --- | --- |
| 스왑 | 해당 없음 | 직접 지우지 않는다 | 상주 메모리를 줄이면 줄고, 재부팅하면 스왑 파일이 비워진다. 오래 켜 둔 머신이면 재부팅을 마지막 단계로 권한다 |
| `/private/var/folders` 임시 파일 | 해당 없음 | 재부팅 때 정리된다 | 직접 지우지 않는다 |
| 보안 에이전트(Broadcom 시스템 확장 등) | 유지 | 건드리지 않는다 | CPU 를 써도 보안 정책이 소유한다 |

`sudo` 가 없을 수 있다. `sudo -n true` 로 먼저 보고, 없으면 시스템 영역 정리는 사용자 몫으로 넘긴다.

## 앱 캐시

| 대상 | 등급 | 이유 |
| --- | --- | --- |
| 실행 중인 앱의 캐시(IntelliJ, Chrome, 브라우저 앱) | 유지 | 인덱스가 깨지거나 앱이 비정상 동작한다. 앱을 닫은 뒤에만 지운다 |
| 설치본이 없는 이전 버전 디렉터리(`JetBrains/DataGrip2025.3` 등) | 안전 | 실행 중인 앱이 쓰지 않는다 |
| `*.ShipIt`, `*-updater` | 대기 표시가 없을 때만 안전, 있으면 유지 | 업데이트 설치 파일 캐시다. `survey_system.ts` 의 「업데이트 캐시」 절이 디렉터리마다 크기와 대기 표시(`pending`, `update.zip`, `update-info.json`)를 보인다. 표시가 있으면 아직 설치하지 않은 업데이트라 지우면 그 업데이트가 사라진다(실측: `orca-updater` 에 `pending` 과 `update.zip` 268MB). 앱이 업데이트를 설치한 뒤에 지운다 |
| `~/Library/Application Support/Claude/vm_bundles` | 확인 필요 | Claude 데스크톱 Cowork VM 이미지다. 앱 본체가 꺼져 있을 때만 지운다. `chrome-native-host` 와 `crashpad_handler` 만 떠 있으면 본체는 꺼진 것이다. 다시 쓰면 앱이 받는다 |
| `~/.codex/.tmp/marketplaces/.staging/marketplace-upgrade-*` | 하루 지난 것은 안전 | codex 플러그인 업그레이드 임시 사본이다. `~/.codex/.tmp` 전체를 임시 파일로 보지 않는다 |

## 큰 영역 후보

`survey_system.ts` 가 절로 보이는 후보다. 모두 확인 필요 등급이고, 되살릴 수 있는지와 확보량을 승인 질문에 적는다.
`$RELEASE` 는 지울 Codex 릴리스 디렉터리, `$TOOL` 과 `$VERSION` 은 사용자가 고른 mise 도구와 버전, `$DIR` 은 지울 `~/.cache` 하위 디렉터리다.

| 대상 | 등급 | 지우는 조건 | 이유 |
| --- | --- | --- | --- |
| `~/.codex/packages/standalone/releases/*` 이전 버전 | 확인 필요 | `current` 가 가리키는 버전과 명령줄에 그 경로가 든 프로세스가 있는 버전은 남긴다 | 실측: 22개 5.9GB. 실행 중이던 codex 는 Orca 계정 디렉터리의 다른 경로를 썼다. 「Codex 이전 버전」 절의 `current`, `실행중` 표시를 따른다 |
| `~/Library/Application Support/Cursor/snapshots` | 확인 필요 | 절이 「Cursor 실행 중: 아니오」 라고 할 때만 | 실측 8.5GB. Cursor 가 켜져 있으면 쓰는 중일 수 있다 |
| mise 가 지울 수 있다고 본 버전 | 확인 필요 | 사용자가 고른 도구만. 절에서 `실행중` 표시가 붙은 버전은 남긴다 | 실측: node 3개, java 1개, gradle 3개 등. `mise prune` 은 사용자가 고르지 않은 도구(gradle 등)까지 지우므로 돌리지 않는다. 2026-11-04 실측: 후보였던 node 24.15.0(3.3G)으로 Claude HUD 가 돌고 있었다. 지웠으면 HUD 가 깨졌다 |
| 오래된 `~/.cache` 하위 디렉터리 | 확인 필요 | 절의 「프로세스 없음」 이고 마지막 수정이 사용자가 정한 기준보다 오래됐을 때만 | 실측: `codex-runtimes` 1.8GB 는 4개월, `puppeteer` 1GB 는 3개월 동안 바뀌지 않았다. 프로세스 확인은 명령줄에 그 경로가 있는지만 보므로 열린 파일은 못 잡는다 |

변수가 비면 `${VAR:?}` 형식은 셸이 오류로 멈춰 `rm -rf /` 가 되지 않는다. Claude Code 의 삭제 안전 검사도 이 형식은 막지 않는다.

```bash
rm -rf "${RELEASE:?}"
mise uninstall "$TOOL@$VERSION"
rm -rf "${HOME:?}/Library/Application Support/Cursor/snapshots"
rm -rf "${DIR:?}"
```

## 도구 캐시 명령

| 대상 | 등급 | 명령 |
| --- | --- | --- |
| npm | 안전 | `npm cache clean --force` |
| Homebrew | 안전 | `brew cleanup --prune=all` |
| uv | 안전 | `uv cache clean` |
| pip | 안전 | `pip3 cache purge` |
| pnpm | 안전 | `pnpm store prune` |
| Docker 빌드 캐시 | 안전 | `docker --context "$CONTEXT" builder prune -af` (승인한 런타임마다. `$CONTEXT` 는 아래 「Docker」 참고) |
| bun | 안전 | `pgrep -fl 'bun install'` 로 설치 중인 bun 이 없는지 본 뒤 `rm -rf "${HOME:?}/.bun/install/cache"` |

**`npm cache clean --force` 는 `~/.npm/_cacache` 만 비운다.** `~/.npm/_npx` 는 그대로라 종료 코드 0 이어도 확보량이 0 일 수 있다(실측: `~/.npm` 3.4GB 가 전부 `_npx` 였다). 확보량은 `~/.npm` 합계가 아니라 `_cacache` 크기로 약속한다.

**`bun pm cache rm` 은 프로젝트 밖에서 아무것도 지우지 않는다.** 2026-11-04 실측: 「Run "bun init"」 만 내고 종료 코드 0 으로 끝났고 `~/.bun/install/cache` 2.4GB 가 그대로였다. 폴더를 지워서 비웠다.

**`pnpm store prune` 은 참조되지 않는 패키지만 지운다.** store 대부분이 프로젝트에서 쓰이면 거의 줄지 않는다(실측 13GB 중 114MB). 큰 확보량을 약속하지 않는다.

## npx 캐시

| 대상 | 등급 | 이유 |
| --- | --- | --- |
| `~/.npm/_npx` | 확인 필요 | npx 로 띄운 MCP 서버 같은 실행 중 프로세스가 그 디렉터리를 쓴다 |

30일 지난 하위 디렉터리만, 그 경로를 쓰는 프로세스가 없는지 확인한 뒤 지운다.
`$DAYS` 는 사용자가 정한 기준 일수이고, `$DIR` 는 위 `find` 가 보인 하위 디렉터리다.

```bash
find ~/.npm/_npx -mindepth 1 -maxdepth 1 -type d -mtime +"$DAYS"
pgrep -fl _npx
rm -rf "${DIR:?}"
```

변수가 비면 `${DIR:?}` 가 셸을 멈춰 `rm -rf ~/.npm/_npx` 같은 넓은 삭제가 되지 않는다. 삭제 안전 검사도 이 형식은 막지 않는다.

`pgrep` 이 그 디렉터리를 쓰는 프로세스를 보이면 그 디렉터리는 남긴다.

## Docker

런타임이 하나가 아닐 수 있다. 런타임마다 다른 값(소켓, context, VM 디스크 파일, 켜는 명령, 회수 방법)은 `references/runtimes.md` 의 표가 소유한다. 이 절은 런타임과 무관한 정리 절차만 적는다.
`$CONTEXT` 는 승인한 런타임의 docker context 이고 `survey_docker.ts` 출력의 `## 런타임 ... context=` 에 보인다. 모든 Docker 명령에 `--context "$CONTEXT"` 를 붙이고 사용자의 현재 context 는 바꾸지 않는다.
이 맥 밖의 엔진(ssh·tcp)은 정리하지 않는다. `delete_volumes.ts` 는 그런 엔드포인트면 종료 코드 5 로 거부한다.

- **prune 해도 호스트 디스크는 바로 늘지 않을 수 있다.** VM 디스크 파일이 그대로면 `scripts/runtime_reclaim.ts` 로 회수해야 반영된다. 런타임마다 회수 방법이 다르고, 어떤 런타임은 디스크 파일을 스스로 줄이므로 `runtime_reclaim.ts` 는 전후 크기만 보고한다(`references/runtimes.md`).
  **volume 을 지운 직후 이어서 돌리면 회수가 덜 될 수 있다.** 재시도와 시간 상한, 종료 코드는 `runtimes.md` 의 `fstrim` 절이 소유한다.

```bash
node "$SKILL_DIR/scripts/runtime_reclaim.ts" "$RUNTIMES" --runtime "$RUNTIME"
```
- **익명 volume(이름이 64자리 hex)은 대개 컨테이너를 지울 때 남은 테스트 DB 데이터다.** `scripts/docker_volumes.ts` 가 dangling 인 것을 골라 생성 시각과 크기를 붙이고, 후보 합계를 낸다.
  **`docker volume prune` 을 쓰지 않는다.** 정리 도중 다른 세션이 시작한 테스트의 volume 까지 지울 수 있다(실측: 정리 중 `testcontainers/ryuk` 컨테이너가 떴다).
  기본 등급은 확인 필요다. `--peek all` 로 후보의 최상위 항목을 열어 내용 종류를 붙이고 등급을 정한다. `postgres`(`PG_VERSION`)와 `mysql`(`ibdata1`, `#innodb_redo`, `mysql`, `auto.cnf`) 같은 테스트 DB 데이터는 안전에 가깝다.
  `other` 는 에이전트 홈(`SOUL.md`, `auth.json`)이나 SQLite 파일(`gersang.db`)일 수 있어 테스트 DB 와 따로 묻는다. 실측: 후보 101개 중 Postgres 77개, MySQL 2개, `other` 22개였다.
  조사 때 열어 본 volume 만 `delete_volumes.ts` 로 지운다. 이름마다 `docker volume rm` 을 따로 부르고, 열지 않은 volume 과 최근 volume 은 건드리지 않는다. 기본 `--kind` 는 `postgres`, `mysql` 이고 `other` 는 승인 뒤 `--kind other` 로만 지운다.
  스크립트는 기준 시간(기본 24시간) 안에 생긴 volume 을 후보에서 빼 "최근" 으로 따로 보이고, ryuk 가 떠 있으면 경고한다. 경고가 나면 다른 세션이 테스트 중이니 지우기 전에 사용자에게 알린다.
  `survey_docker.ts` 가 런타임마다 `volumes-<런타임 id>.json` 을 쓰고 `volume 조사 파일:` 경로로 알린다. `delete_volumes.ts` 는 그 파일에 적힌 context 의 엔진에만 지우므로, 조사한 런타임과 지우는 런타임이 어긋나지 않는다.

`$VOLUMES` 는 승인한 런타임의 `volume 조사 파일:` 경로다.

```bash
node "$SKILL_DIR/scripts/survey_docker.ts" "$RUNTIMES" --out-dir "$DOCKER_DIR"
node "$SKILL_DIR/scripts/delete_volumes.ts" "$VOLUMES"                    # dry-run
node "$SKILL_DIR/scripts/delete_volumes.ts" "$VOLUMES" --apply            # 테스트 DB
node "$SKILL_DIR/scripts/delete_volumes.ts" "$VOLUMES" --apply --kind other   # 따로 승인받은 other
```
- 이미지는 `scripts/docker_images.ts --context "$CONTEXT"` 가 사용 중, 미사용, 최근 생성으로 나눈다(`survey_docker.ts` 가 런타임마다 돌린다).
- 이미지는 각 줄 끝의 `rmi=` 값으로 `docker --context "$CONTEXT" rmi "$REF"` 처럼 지운다. 태그가 있으면 `repo:tag`, 저장소나 태그가 `<none>` 이면 이미지 ID 다. `traefik:<none>` 을 넘기면 `invalid reference format` 으로 실패한다. 태그가 여럿인 이미지를 ID 로 지우면 `-f` 없이는 거절되므로, 태그가 있는 줄은 `repo:tag` 로 지운다. 다만 `repo:tag` 로 조회되지 않는 이미지도 이미지 ID 다. 이름이 `repo:tag@digest` 로 저장된 이미지는 `docker images` 가 태그를 보여 줘도 `docker rmi repo:tag` 가 `No such image` 로 실패한다. 실측 사례는 `ghcr.io/actions/actions-runner:2.338.0` 이다. 이 줄은 `rmi=4ffadc0002b2` 로 지워졌다.
- 오래됐거나 같은 이미지의 이전 버전, `<none>` 태그는 안전에 가깝다. 최근 하루 안에 만든 로컬 테스트 이미지는 확인 필요다.
- 승인 질문에 이미지 확보량을 적을 때는 "최대" 로 적고 약속하지 않는다. 지우는 이미지가 남는 이미지와 레이어를 공유하면 실제 확보량이 훨씬 작다(실측: `docker system df` 와 `docker_images.ts` 의 미사용 합계는 5.1GB, `docker image prune -af` 의 확보량은 1.14GB). 호스트 디스크의 실제 확보는 `runtime_reclaim.ts` 뒤에 잰다.
- 확인용으로 받은 이미지(`alpine` 등)는 끝나고 지운다.

## Gradle

`survey_gradle.ts` 가 "삭제 후보" 로 낸 버전만 `~/.gradle/wrapper/dists`, `~/.gradle/caches`, `~/.gradle/daemon` 에서 지운다. 안전 등급이다.
사용처도 데몬도 없는 버전이므로 지워도 wrapper 가 필요할 때 다시 받는다.
버전 이름을 읽지 못한 `dists` 폴더는 후보에 올리지 않는다.
스크립트가 후보 경로를 한 줄에 하나씩 보이고 끝에 「승인 뒤 돌릴 명령」 으로 `rm -rf` 한 줄을 낸다. 사용자가 승인한 뒤 그 줄을 그대로 돌린다.
glob 반복문(`for d in ~/.gradle/wrapper/dists/gradle-9.8.0-*; do rm -rf "${d:?}"; done`)으로 지우지 않는다.
2026-11-04 실측: auto mode 분류기가 glob 반복문과 npm, brew, pnpm, mise 정리를 한 명령에 묶은 것을 되돌릴 수 없는 로컬 삭제로 막았다. 원인이 반복문인지 묶음인지는 확인하지 않았다. 경로를 하나씩 적은 `rm -rf` 는 통과했다.
스크립트가 낸 `rm -rf` 한 줄을 그대로 돌리는 규칙은 남긴다. 사용자가 승인한 목록과 실행 명령이 같아지기 때문이다.

## 프로젝트 산출물

더 이상 쓰지 않는 프로젝트(`(deprecated)` 같은 표시)의 `node_modules`, `build`, `.gradle`, `.next` 는 소스를 남기고 지운다. 확인 필요 등급이고, 프로젝트 단위로 사용자에게 묻는다.
`$PROJECT` 는 사용자가 고른 프로젝트 경로다.

```bash
find "$PROJECT" -type d \( -name node_modules -o -name build -o -name .gradle -o -name .next \) -prune -exec rm -rf {} +
```

## 대화 기록과 계정

| 대상 | 등급 | 이유 |
| --- | --- | --- |
| `~/.claude/projects`, `~/.codex/sessions`, `orca/codex-accounts/*/home/sessions` | 확인 필요 | 지우면 resume 할 수 없다. 기본 기준은 30일이다. 명령은 아래 「대화 기록 명령」 |
| 워크트리가 사라진 Claude 기록 폴더(`~/.claude/projects` 하위) | 확인 필요 | 안의 `cwd` 경로가 이미 없는 폴더다. 명령은 아래 「워크트리가 사라진 대화 기록 명령」. `harness-cleanup` 의 사용 기록 감사(`session_log.ts`)가 이 기록을 입력으로 읽으므로 지우면 감사 자료가 준다 |
| `orca/codex-accounts/*` 디렉터리 자체 | 유지 | 로그인 정보가 들어 있어 지우지 않는다. 그 안의 `home/sessions` 만 정리 대상이다 |
| `.orca-worktree-trash` | 유지 | Orca 가 관리한다 |
| 반복 helper 프로세스 | 확인 필요 | 절차는 `git-and-sessions.md`. 명령은 아래 「반복 helper 명령」 |

## 대화 기록 명령

`$LOG_DIR` 은 `survey_sessions.ts` 가 보인 디렉터리이고, `$DAYS` 는 사용자가 정한 기준 일수다.
지우기 전에 같은 `find` 를 `-delete` 없이 돌려 개수를 사용자에게 보인다.

```bash
find "$LOG_DIR" -type f -mtime +"$DAYS" | wc -l
find "$LOG_DIR" -type f -mtime +"$DAYS" -delete
find "$LOG_DIR" -type d -empty -delete
```

## 워크트리가 사라진 대화 기록 명령

`survey_sessions.ts` 의 「워크트리가 사라진 대화 기록」 절이 3일, 7일, 14일, 30일 넘은 묶음마다 개수와 크기를 보인다. 기준 일수는 사용자가 정한다.
승인 질문에 묶음별 개수와 크기를 그대로 보이고, `harness-cleanup` 감사 자료가 준다는 점을 적는다.
실측(2026-11-04): `~/.claude/projects` 18.4GB 의 폴더 1532개 가운데 1500개(13.5GB)가 `cwd` 가 없는 기록이었다. 30일 기준 대화 기록 절은 350.8MB 만 잡았다. orch worker 워크트리가 머지 뒤 지워지면서 남은 기록이다. 마지막 수정이 3일 넘은 것 1279개 12.4GB, 7일 넘은 것 1003개 10.7GB, 14일 넘은 것 731개 7.5GB 였다.
`delete_sessions.ts` 는 지우기 직전에 경로가 기록 폴더 바로 아래인지, `cwd` 가 여전히 없는지, 가장 늦은 수정 시각이 조사 때와 같은지 다시 확인하고 하나라도 다르면 남긴다.
기본은 dry-run 이고 `--apply` 일 때만 지운다. 실패가 있으면 종료 코드가 1 이다. `cwd` 를 읽지 못한 폴더는 후보에 넣지 않는다.

```bash
node "$SKILL_DIR/scripts/survey_sessions.ts" --json-out "$ORPHANS"
node "$SKILL_DIR/scripts/delete_sessions.ts" "$ORPHANS" --older-than-days "$DAYS"           # dry-run
node "$SKILL_DIR/scripts/delete_sessions.ts" "$ORPHANS" --older-than-days "$DAYS" --apply
```

## 반복 helper 명령

`$PATTERN` 은 `survey_sessions.ts` 가 보인 명령줄의 일부다. 종료 뒤 남은 개수가 0 인지 확인한다.

```bash
pkill -f "$PATTERN"
pgrep -f "$PATTERN" | wc -l
```
