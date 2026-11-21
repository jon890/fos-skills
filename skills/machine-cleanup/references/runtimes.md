# 컨테이너 런타임

런타임마다 다른 값은 이 표 한곳이 소유한다. `SKILL.md` 와 `targets.md` 는 런타임 이름을 쓰지 않고 이 표를 가리킨다.
Java 로 빗대면 이 표가 enum 이고, 코드의 원본은 `scripts/container_runtimes.ts` 의 `RUNTIMES` 다. 둘이 같은지는 `tests/runtimes-doc.spec.ts` 가 확인한다.
`<프로필>` 은 Colima 프로필 이름이고, 프로필마다 런타임 하나로 다룬다.

## 직접 지원하는 런타임

| id | 런타임 | 설치 흔적 | 소켓 | context | VM 디스크 파일 | 켜는 명령 | 회수 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `docker-desktop` | Docker Desktop | `Docker.app`, `~/Library/Containers/com.docker.docker` | `~/.docker/run/docker.sock`, `~/.docker/desktop/docker.sock` | `desktop-linux` | `~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw` | `open -a Docker` | `disk-size` |
| `orbstack` | OrbStack | `OrbStack.app`, `~/.orbstack`, `orb` 명령 | `~/.orbstack/run/docker.sock` | `orbstack` | `~/.orbstack/data/data.img` | `orb start` | `disk-size` |
| `colima:<프로필>` | Colima | `~/.colima/_lima/_disks` 의 디스크 디렉터리, `~/.colima/<프로필>/colima.yaml`, `colima` 로 시작하는 context | `~/.colima/<프로필>/docker.sock` | `colima-<프로필>`(default 프로필은 `colima`) | `~/.colima/_lima/_disks/colima-<프로필>/datadisk`(default 프로필은 `colima`) | `colima start -p <프로필>` | `fstrim` |

설치 흔적은 앱 번들, 데이터 디렉터리, CLI 를 함께 본다. 꺼진 런타임은 context 가 응답하지 않으므로 이 흔적이 있어야 감지한다.
켜짐은 `docker --context <context> info` 가 성공하는 것이다. 사용자의 현재 context 는 바꾸지 않는다.

## 표에 없는 엔진

| id | 무엇인가 | 조사 | 정리 | 디스크 회수 |
| --- | --- | --- | --- | --- |
| `unknown:<context>` | 표의 소켓에 맞지 않는 이 맥의 unix 소켓(Rancher Desktop, Podman 등) | docker CLI 로 한다 | docker CLI 로 한다. 켜는 명령을 몰라 꺼져 있으면 건드리지 않는다 | 하지 않는다. 사용자 몫으로 보고한다 |
| `remote:<context>` | ssh, tcp 엔드포인트. 이 맥 밖의 엔진이다 | 크기(`docker system df`)만 보인다 | 승인 묶음과 삭제 대상에 넣지 않는다. `delete_volumes.ts` 도 종료 코드 5 로 거부한다 | 해당 없음 |

소켓 경로를 심볼릭 링크까지 풀어 같으면 context 를 런타임 하나로 합친다. Docker Desktop 의 `default`(`/var/run/docker.sock`)는 `desktop-linux` 소켓을 가리키는 링크라 따로 조사하면 같은 이미지가 두 번 나온다.

런타임을 더하려면 `RUNTIMES` 와 그 옆 함수(`socketsOf`, `contextOf`, `diskOf`, `startOf`)에 항목 하나를 더하고, 이 표에 줄 하나를 더한다.

## 회수 방법

`scripts/runtime_reclaim.ts` 가 표의 `회수` 값으로 방법을 고른다.

| 값 | 방법 | 보고 |
| --- | --- | --- |
| `fstrim` | `scripts/colima_trim.ts` 를 프로필과 함께 부른다. 종료 코드 0/1/2 는 그 스크립트의 것이다 | 호스트 확보량을 출력한다 |
| `disk-size` | trim 명령이 없다. 1단계 조사 때(`container_runtimes.ts` 가 쓴 파일)와 지금의 디스크 파일 점유 크기(`du`)를 비교만 한다. 덜 줄었어도 재시도하지 않는다 | 줄지 않았으면 런타임이 비동기로 줄인다는 문구를 낸다 |
| `none` | 회수하지 않는다 | 사용자 몫이라고 보고한다 |

### `fstrim`

**prune 해도 호스트 디스크는 바로 늘지 않는다.** VM 디스크 파일이 그대로라 trim 해야 반영된다.
**volume 을 지운 직후 이어서 돌리면 trim 이 덜 될 수 있다.** 스크립트는 `sync` 뒤에 `fstrim -v` 를 돌리고, 호스트 디스크 파일의 점유 크기와 VM 안 사용량의 차이가 기준값(기본 4GiB)보다 크면 기다렸다 다시 돈다.
전체 시간은 `--max-seconds`(기본 100초)로 제한해 도구의 명령 시간 한도(120초) 안에 끝난다.
종료 코드는 0 이 완료, 1 이 런타임 정지나 측정 실패, 2 가 횟수나 시간 상한까지 차이가 남은 경우다. 2 면 남은 차이를 사용자에게 보고한다.

### `disk-size`

두 런타임은 지운 만큼 디스크 파일을 스스로 줄인다. 사용자가 쓸 수 있는 trim 명령이 없다.
비교 기준은 1단계에서 쓴 `--json-out` 파일이다. 정리 도중에 `container_runtimes.ts` 를 같은 파일로 다시 돌리면 기준이 사라진다.

## 실측 근거

- Colima: 꺼진 상태로 건너뛴 뒤 켜 보니 전체 확보량 100Gi 가운데 50.9GiB 가 Docker 에서 나왔다. 그래서 꺼진 런타임을 건너뛰고 끝내지 않는다.
- Colima trim: 이미지와 빌드 캐시를 지운 뒤 따로 돌린 trim 은 48.5GiB 를 비워 디스크 파일이 68G 에서 40G 가 됐다. volume 을 지운 직후 돌린 trim 은 8GiB 만 비웠고, 1분 뒤 다시 돌리자 43.8GiB 를 비워 호스트 여유가 17GiB 늘었다.
- Docker Desktop(2026-11-11): 빌드 캐시 32.08GB 와 이미지 15개를 지운 뒤 `Docker.raw` 가 5.6G 로 저절로 줄었고 호스트 여유가 늘었다. 이 머신의 context 는 `desktop-linux` 이고 `/var/run/docker.sock` 은 `~/.docker/run/docker.sock` 링크다.
- Docker Desktop 의 `Docker.raw` 는 희소 파일이라 `ls` 크기(논리 크기)가 아니라 `du` 점유 크기로 잰다.
