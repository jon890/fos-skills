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
| `*.ShipIt`, `*-updater` | 안전 | 업데이트 설치 파일 캐시다 |
| `~/Library/Application Support/Claude/vm_bundles` | 확인 필요 | Claude 데스크톱 Cowork VM 이미지다. 앱 본체가 꺼져 있을 때만 지운다. `chrome-native-host` 와 `crashpad_handler` 만 떠 있으면 본체는 꺼진 것이다. 다시 쓰면 앱이 받는다 |
| `~/.codex/.tmp/marketplaces/.staging/marketplace-upgrade-*` | 하루 지난 것은 안전 | codex 플러그인 업그레이드 임시 사본이다. `~/.codex/.tmp` 전체를 임시 파일로 보지 않는다 |

## 도구 캐시 명령

| 대상 | 등급 | 명령 |
| --- | --- | --- |
| npm | 안전 | `npm cache clean --force` |
| Homebrew | 안전 | `brew cleanup --prune=all` |
| uv | 안전 | `uv cache clean` |
| pip | 안전 | `pip3 cache purge` |
| pnpm | 안전 | `pnpm store prune` |
| Docker 빌드 캐시 | 안전 | `docker builder prune -af` |

**`npm cache clean --force` 는 `~/.npm/_cacache` 만 비운다.** `~/.npm/_npx` 는 그대로라 종료 코드 0 이어도 확보량이 0 일 수 있다(실측: `~/.npm` 3.4GB 가 전부 `_npx` 였다). 확보량은 `~/.npm` 합계가 아니라 `_cacache` 크기로 약속한다.

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
rm -rf "$DIR"
```

`pgrep` 이 그 디렉터리를 쓰는 프로세스를 보이면 그 디렉터리는 남긴다.

## Docker

- **Colima 에서 prune 해도 호스트 디스크는 바로 늘지 않는다.** VM 디스크 파일이 그대로라 `colima ssh -- sudo fstrim -av` 를 돌려야 반영된다(실측: 76GB 에서 13GB).
- **익명 volume(이름이 64자리 hex)은 대개 컨테이너를 지울 때 남은 테스트 DB 데이터다.** `scripts/docker_volumes.py` 가 dangling 인 것을 골라 생성 시각과 크기를 붙이고, 후보 합계를 낸다.
  **`docker volume prune` 을 쓰지 않는다.** 정리 도중 다른 세션이 시작한 테스트의 volume 까지 지울 수 있다(실측: 정리 중 `testcontainers/ryuk` 컨테이너가 떴다).
  기본 등급은 확인 필요다. `--peek N` 으로 후보의 최상위 항목을 열어 내용을 확인하고 등급을 정한다(Postgres 의 `PG_VERSION`, `base` 처럼 테스트 DB 데이터면 안전에 가깝다).
  조사 때 열어 본 volume 만 이름을 지정해 `docker volume rm` 으로 지운다.
  스크립트는 기준 시간(기본 24시간) 안에 생긴 volume 을 후보에서 빼 "최근" 으로 따로 보이고, ryuk 가 떠 있으면 경고한다. 경고가 나면 다른 세션이 테스트 중이니 지우기 전에 사용자에게 알린다.

```bash
python3 "$SKILL_DIR/scripts/docker_volumes.py" --peek 3
docker volume rm "$VOLUME"
```
- 이미지는 `scripts/docker_images.py` 가 사용 중, 미사용, 최근 생성으로 나눈다.
- 오래됐거나 같은 이미지의 이전 버전, `<none>` 태그는 안전에 가깝다. 최근 하루 안에 만든 로컬 테스트 이미지는 확인 필요다.
- 승인 질문에 이미지 확보량을 적을 때는 "최대" 로 적고 약속하지 않는다. 지우는 이미지가 남는 이미지와 레이어를 공유하면 실제 확보량이 훨씬 작다(실측: `docker system df` 와 `docker_images.py` 의 미사용 합계는 5.1GB, `docker image prune -af` 의 확보량은 1.14GB). 호스트 디스크의 실제 확보는 `fstrim` 뒤에 잰다.
- 확인용으로 받은 이미지(`alpine` 등)는 끝나고 지운다.

## Gradle

`survey_gradle.sh` 가 "삭제 후보" 로 낸 버전만 `~/.gradle/wrapper/dists`, `~/.gradle/caches`, `~/.gradle/daemon` 에서 지운다. 안전 등급이다.
사용처도 데몬도 없는 버전이므로 지워도 wrapper 가 필요할 때 다시 받는다.

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
| `orca/codex-accounts/*` 디렉터리 자체 | 유지 | 로그인 정보가 들어 있어 지우지 않는다. 그 안의 `home/sessions` 만 정리 대상이다 |
| `.orca-worktree-trash` | 유지 | Orca 가 관리한다 |
| 반복 helper 프로세스 | 확인 필요 | 절차는 `git-and-sessions.md`. 명령은 아래 「반복 helper 명령」 |

## 대화 기록 명령

`$LOG_DIR` 은 `survey_sessions.py` 가 보인 디렉터리이고, `$DAYS` 는 사용자가 정한 기준 일수다.
지우기 전에 같은 `find` 를 `-delete` 없이 돌려 개수를 사용자에게 보인다.

```bash
find "$LOG_DIR" -type f -mtime +"$DAYS" | wc -l
find "$LOG_DIR" -type f -mtime +"$DAYS" -delete
find "$LOG_DIR" -type d -empty -delete
```

## 반복 helper 명령

`$PATTERN` 은 `survey_sessions.py` 가 보인 명령줄의 일부다. 종료 뒤 남은 개수가 0 인지 확인한다.

```bash
pkill -f "$PATTERN"
pgrep -f "$PATTERN" | wc -l
```
