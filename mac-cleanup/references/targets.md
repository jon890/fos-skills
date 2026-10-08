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

**`pnpm store prune` 은 참조되지 않는 패키지만 지운다.** store 대부분이 프로젝트에서 쓰이면 거의 줄지 않는다(실측 13GB 중 114MB). 큰 확보량을 약속하지 않는다.

## Docker

- **Colima 에서 prune 해도 호스트 디스크는 바로 늘지 않는다.** VM 디스크 파일이 그대로라 `colima ssh -- sudo fstrim -av` 를 돌려야 반영된다(실측: 76GB 에서 13GB).
- **익명 volume(이름이 64자리 hex)은 대개 컨테이너를 지울 때 남은 테스트 DB 데이터다.** `docker volume prune -f` 는 익명 volume 만 지운다. 이름 있는 volume 과 멈춘 컨테이너에 붙은 volume 은 남는다.
  기본 등급은 확인 필요다. 하나를 열어 내용을 확인하고 등급을 정한다. 최근 몇 분 안에 생긴 volume 이 있으면 다른 세션이 테스트 중일 수 있으니 사용자에게 알린다.
- 이미지는 `scripts/docker_images.py` 가 사용 중, 미사용, 최근 생성으로 나눈다.
  컨테이너의 `Image` 값과 `repo:tag` 를 비교할 때 태그 생략(`:latest`)을 맞춘다. 그대로 비교하면 실행 중 컨테이너가 쓰는 이미지가 미사용으로 잡힌다.
- 오래됐거나 같은 이미지의 이전 버전, `<none>` 태그는 안전에 가깝다. 최근 하루 안에 만든 로컬 테스트 이미지는 확인 필요다.
- 확인용으로 받은 이미지(`alpine` 등)는 끝나고 지운다.

## Gradle

`survey_gradle.sh` 가 "삭제 후보" 로 낸 버전만 `~/.gradle/wrapper/dists`, `~/.gradle/caches`, `~/.gradle/daemon` 에서 지운다. 안전 등급이다.
사용처도 데몬도 없는 버전이므로 지워도 wrapper 가 필요할 때 다시 받는다.

## 프로젝트 산출물

더 이상 쓰지 않는 프로젝트(`(deprecated)` 같은 표시)의 `node_modules`, `build`, `.gradle`, `.next` 는 소스를 남기고 지운다. 확인 필요 등급이고, 프로젝트 단위로 사용자에게 묻는다.

## 대화 기록과 계정

| 대상 | 등급 | 이유 |
| --- | --- | --- |
| `~/.claude/projects`, `~/.codex/sessions`, `orca/codex-accounts/*/home/sessions` | 확인 필요 | 지우면 resume 할 수 없다. 기본 기준은 30일이다 |
| `orca/codex-accounts/*` 디렉터리 자체 | 유지 | 로그인 정보가 들어 있어 지우지 않는다. 그 안의 `home/sessions` 만 정리 대상이다 |
| `.orca-worktree-trash` | 유지 | Orca 가 관리한다 |
| 반복 helper 프로세스 | 확인 필요 | 절차는 `git-and-sessions.md` |
