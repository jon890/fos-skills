# mac-cleanup 컨테이너 런타임 기술 설계

스펙: [spec.md](spec.md). 코드는 `skills/mac-cleanup/scripts/` 아래다. 스킬 하나 안의 변경이라 새 서비스나 ADR 은 없다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | `container_runtimes.ts` 가 런타임 표(`RUNTIMES`)와 `docker context ls` 로 런타임별 줄과 `--json-out` 을 낸다 |
| REQ2 | 표에 맞지 않는 로컬 unix 소켓은 `unknown`, ssh·tcp 는 `remote` 로 분류한다. `delete_volumes.ts` 는 유효 엔드포인트가 로컬 unix 가 아니면 삭제 전에 종료 코드 5 로 끝난다 |
| REQ3 | 꺼진 런타임 줄에 켜는 명령이 나온다. `runtime_start.ts` 가 표의 켜는 명령을 돌리고 `docker info` 를 최대 120초 기다리며, 넘으면 「켜지 못함」 과 종료 코드 1 이다 |
| REQ4 | `container_runtimes.ts` 가 소켓을 realpath 로 풀어 context 를 런타임 하나로 합친다. `docker_images.ts`, `docker_volumes.ts`, `delete_volumes.ts` 는 `--context` 로 `docker --context` 를 붙인다. `survey_docker.ts` 가 켜진 런타임마다 두 조사를 돌린다. 현재 context 설정은 읽지도 쓰지도 않는다 |
| REQ5 | `runtime_reclaim.ts` 가 런타임 표의 `reclaim` 값으로 갈라진다. `fstrim` 은 기존 `colima_trim.ts` 를 그대로 부르고, `disk-size` 는 전후 크기만 재고, `none` 은 회수하지 않았다고 보고한다 |
| REQ6 | `SKILL.md` 와 `targets.md` 는 런타임별 값을 `references/runtimes.md` 한 표에서만 가리킨다. `survey_system.ts` 의 Colima 전용 Docker 절은 뺀다 |
| REQ7 | 5단계가 호스트 여유 전후(확보량), `runtime_reclaim.ts` 의 전후 크기(참고), 정리하지 않은 런타임(크기와 함께)을 보고 항목으로 요구한다 |

## 책임과 경계

Java 로 빗대면 `RUNTIMES` 는 enum 이고, 각 스크립트는 그 enum 을 받는 서비스다. 런타임 하나를 더하려면 표 항목 하나를 더한다.

| 모듈 | 책임 | 소유하는 값 |
| --- | --- | --- |
| `container_runtimes.ts` | 감지와 분류, 런타임별 출력과 JSON | `RUNTIMES` 표, 상태(running, stopped, unresponsive), 합친 context |
| `runtime_start.ts` | 승인된 런타임 하나를 켜고 준비를 기다린다 | 켜기 제한 시간 120초 |
| `survey_docker.ts` | 켜진 로컬 런타임마다 이미지와 volume 조사를 돌려 런타임별 출력과 파일로 나눈다 | 런타임별 volume JSON 파일 이름 |
| `docker_images.ts`, `docker_volumes.ts`, `delete_volumes.ts` | 이미 있던 조사와 삭제. `--context` 만 더한다 | 기존 출력 계약 |
| `runtime_reclaim.ts` | 정리 뒤 회수. 방법은 표에서 고른다 | 회수 결과 출력 |
| `colima_trim.ts` | Colima 의 fstrim 반복. 바뀌지 않는다 | 재시도, 시간 상한, 종료 코드 0/1/2 |

의존 방향은 `survey_docker`, `runtime_start`, `runtime_reclaim`, `delete_volumes` 에서 `container_runtimes` 로 간다. `container_runtimes` 는 `io`, `pylike` 만 쓴다. `docker_volumes.ts` 의 `docker()` 가 `--context` 를 붙이는 한 곳이다.

## 결정

되돌리기 쉬운 기술 판단은 권장안으로 정했다. PR 본문 「결정」 절에도 같은 표를 둔다.

| 결정 | 고른 안 | 이유 |
| --- | --- | --- |
| `colima_trim.ts` 일반화 여부 | 일반화하지 않고 `runtime_reclaim.ts` 가 부른다 | `colima_trim.ts` 는 fstrim 과 재시도 전용이라 테스트와 종료 코드 계약이 굳어 있다. Docker Desktop 과 OrbStack 은 trim 이 없어 공통 코드가 거의 없다 |
| context 전달 | 각 스크립트의 `--context NAME` 이 `docker --context NAME` 으로 간다 | 현재 context 설정을 바꾸지 않고, 가짜 docker 의 호출 인자에 context 가 남아 테스트가 쉽다. 환경변수 `DOCKER_CONTEXT` 도 같은 효과지만 호출 기록에 안 남는다 |
| 삭제 대상 context 기록 | `docker_volumes.ts --json-out` 이 `context` 를 적고 `delete_volumes.ts` 가 그 값을 쓴다 | 조사한 런타임과 지우는 런타임이 달라지지 않는다. 필드는 있을 때만 읽으므로 기존 파일도 읽힌다(없으면 현재 context) |
| 원격 판정 | 유효 엔드포인트를 `docker context inspect [이름]` 으로 읽는다. `DOCKER_HOST` 가 있고 context 를 안 줬으면 그 값을 쓴다. unix 가 아니거나 비면 5 로 거부하고, 읽지 못하면 4 로 끝난다 | 삭제 도구는 실패하면 닫힌다(fail-closed). 맥 밖 데이터를 지우지 않는다는 DECISION9 를 지킨다 |
| 런타임 ID | `docker-desktop`, `orbstack`, `colima:<프로필>`, `unknown:<context>`, `remote:<context>` | 사용자에게 묻는 묶음 이름과 명령 인자가 같은 문자열이다 |
| `survey_system.ts` Docker 절 | 뺀다 | 런타임별 조사는 `container_runtimes.ts` 가 한다. 이 절은 현재 context 하나와 Colima 만 봤다 |
| 켜진 판정 | `docker --context <이름> info` 성공(15초 제한) | 소켓 파일은 런타임이 꺼져도 남을 수 있다. `colima status` 는 Colima 만 안다 |

## 인터페이스와 데이터

런타임 표 항목은 `id`, `label`, 설치 흔적(앱 번들, 데이터 디렉터리), 소켓 경로 후보, 기대 context 이름, 디스크 파일 경로, 켜는 명령, `reclaim` 이다. 값은 `references/runtimes.md` 에 사람이 읽는 표로 한 번 더 적고, 둘이 같은지는 테스트가 확인한다.

`container_runtimes.ts --json-out FILE` 의 `runtimes[]` 항목:

| 필드 | 뜻 |
| --- | --- |
| `id`, `kind`, `label`, `profile` | 이름과 종류(`docker-desktop`, `orbstack`, `colima`, `unknown`, `remote`) |
| `state` | `running`, `stopped`(설치됐고 응답 없음), `unresponsive`(알 수 없는 로컬이 응답 없음) |
| `local` | 이 맥 안의 unix 소켓이면 true |
| `context`, `contexts` | 명령에 줄 대표 context 와 합친 context 목록 |
| `endpoint` | 대표 context 의 엔드포인트 |
| `disk_path`, `disk_bytes` | VM 디스크 파일과 점유 크기(`du -sk`). 없으면 null |
| `start_command` | 켜는 명령 배열. 없으면 null |
| `reclaim` | `fstrim`, `disk-size`, `none` |

`docker_volumes.ts --json-out` 은 `--context` 를 줬을 때만 맨 끝에 `context` 필드를 더한다. 주지 않으면 필드가 없어 기존 출력과 같다. 텍스트 출력도 `--context` 를 줬을 때만 첫 줄에 `## context: 이름` 이 붙는다. 기존 출력 계약은 바뀌지 않는다.

종료 코드는 새 스크립트가 `0` 성공, `1` 실패(켜지 못함, 측정 실패, 조사 실패), `2` 사용법과 입력 오류다. `delete_volumes.ts` 는 기존 값에 `5`(원격 엔드포인트라 거부)를 더한다.

## 실패와 일관성

- 한 런타임을 켜지 못하거나 조사에 실패해도 나머지는 계속한다. `survey_docker.ts` 는 실패를 런타임 줄에 적고 마지막에 종료 코드 1 로 끝난다.
- `docker context ls` 가 실패하면(docker 없음) 설치 흔적만으로 런타임을 낸다. 꺼진 것으로 보고 `docker info` 도 부르지 않는다.
- 삭제 직전 검사는 `delete_volumes.ts` 의 기존 검사에 원격 거부 한 단계를 앞에 더한다. 원격 판정이 확정되기 전에는 `volume rm` 을 부르지 않는다.
- 호환: `--context` 가 없으면 모든 스크립트가 지금과 같이 동작한다. 배포 순서 제약은 없다.

## 검증 전략

실제 런타임과 삭제는 돌리지 않는다. 가짜 `docker`, `colima`, `orb`, `open`, `du` 를 PATH 맨 앞에 두고 임시 홈에 앱 번들과 데이터 디렉터리를 만든다(`tests/helpers.ts` 의 `Sandbox`).

| REQ | 테스트 |
| --- | --- |
| REQ1 | Docker Desktop, Colima(프로필 둘), OrbStack 을 각각 또는 함께 둔 홈에서 런타임별 줄과 JSON. 이 머신에서 읽기 전용으로 실제 실행해 PR 본문에 붙인다 |
| REQ2 | 알 수 없는 소켓은 `unknown` 줄과 「사용자 몫」 문구. ssh·tcp context 로 `delete_volumes` 를 부르면 종료 코드 5 이고 가짜 docker 호출에 `volume rm` 이 없다 |
| REQ3 | 꺼진 런타임 줄에 켜는 명령. `runtime_start` 가 가짜 `open`, `colima`, `orb` 를 부르고, 준비되지 않으면 제한 시간 뒤 「켜지 못함」 과 종료 코드 1 |
| REQ4 | 두 런타임이 켜진 홈에서 `survey_docker` 출력이 나뉘고, `default` 와 `desktop-linux` 가 같은 소켓이면 런타임 하나이며, 삭제 호출 인자가 승인한 context 뿐이다. 테스트 앞뒤로 `~/.docker/config.json` 이 같다 |
| REQ5 | `runtime_reclaim` 이 Colima 에서만 `fstrim` 을 부르고 Docker Desktop 과 OrbStack 은 전후 크기 줄, `unknown` 은 회수하지 않았다는 줄. 기존 `colima-trim.spec.ts` 는 고치지 않는다 |
| REQ6, REQ7 | `SKILL.md` 와 `targets.md` 의 런타임 이름 위치를 읽는 문서 테스트. 5단계 보고 항목 세 가지 |

## 도메인 규칙

해당 없음: 스펙이 정한 대로 스킬 하나의 내부 절차와 스크립트만 바뀐다.
