# 자동 갱신 인수 검증

완료: PR 전 인수 검증. 독립 코드 리뷰와 머지 뒤 실제 설치본 확인은 남아 있다.

- 스펙: [spec.md](spec.md)
- 설계: [design.md](design.md)
- 검증 대상 코드 커밋: `d0ba025b`
- 환경: macOS, Node.js 24.22.1, 임시 Claude 설정 폴더와 가짜 명령 실행기. 실제 `~/.claude` 와 Orca 프로필의 설치본은 갱신하지 않았다.

## 요구사항별 증거

| 요구사항 | 실행 방법 | 기대 결과 | 실제 결과 |
| --- | --- | --- | --- |
| REQ1 | `plugin-auto-update.spec.ts` 의 버전·설치 기록 사례 | main 이 높을 때만 갱신하고 기록된 version 이 같을 때 성공 | 높은 설치본은 건너뛰고, 명령이 성공해도 기록이 그대로면 실패 처리하고 다음 확인에 재시도했다 |
| REQ2 | 같은 테스트의 홈·Orca 프로필·project·local·캐시 공유 사례 | 각 설정 폴더와 scope 의 설치본을 해당 경로에서 갱신 | 설정 폴더와 프로젝트 작업 경로가 예상값과 같았다. 다른 프로필의 캐시를 가리키는 기록도 처리했다 |
| REQ3 | 같은 테스트의 작업 폴더 설치 사례 | 개발용 폴더에서 갱신과 git 명령을 실행하지 않음 | main 조회 외에 명령을 실행하지 않았고 작업 폴더를 cwd 로 쓰지 않았다 |
| REQ4 | 같은 테스트의 30분 경계·잠금·재확인 사례 | 잠금 중에는 건너뛰고, 성공한 버전은 재설치하지 않으며 실패는 재시도 | 잠금 중 추가 확인이 없었고, 30분 경계에서 성공 결과만 유지했다. 실패한 설치본은 다시 시도했다 |
| REQ5 | `plugin-auto-update.spec.ts` 와 `loop-self-update.spec.ts` | 설치 결과를 다시 뜨기 알림에 붙이고 실패는 버전당 한 번 알림 | 결과 기록·실패 알림 표식과 기존 다시 뜨기 경로를 확인했다. 실제 Orca 알림 수신은 머지 뒤 확인한다 |
| REQ6 | `version.spec.ts` 와 `network-poll.spec.ts` | 새 설치본을 먼저 표시하고 내장 명령을 세션이 쉴 때 한 번 예약 | main 조회 실패와 관계없이 표시했고, 내장 `reload-plugins` 만 실행했다. 같은 버전의 중복 예약은 막았다 |
| REQ7 | `core-config-schema.spec.ts` 와 `config-schema-readers.spec.ts` | `plugin.auto_update` 는 참거짓만 받고 false 일 때 루프가 갱신을 건너뜀 | 참거짓 표본 검사가 통과했고, 루프의 false 분기를 코드와 대조했다 |

전체 저장소 검증 `orch slot heavy --exclusive -- node scripts/run-tests.ts` 는 테스트 파일과 타입 검사를 모두 통과했다. `claude plugin test .`, `node scripts/check-skill-docs.ts`, 한국어 변경 줄 검사도 통과했다.

## 독립 검토와 남은 확인

독립 코드 리뷰는 PR 에서 받는다. 머지 뒤 실제 새 버전으로 자동 갱신하고 세션이 쉴 때 다시 읽는 확인은 코디네이터가 맡는다. 이 확인은 사용자 설정의 설치본을 바꾸므로 임시 폴더 검증에 포함하지 않았다.

## 문서 대조와 공통화 후보

| 문서 | 대조 결과 |
| --- | --- |
| [설계](design.md)와 [스펙](spec.md) | main 버전, 설치 범위, 30분, 실패 재시도, 세션 다시 읽기 조건이 구현과 맞다 |
| [설정 계약](../../data-schema.md)과 [orch 안내](../../../skills/orch/references/overlay.md) | 기본값 true, false 의 저장소별 적용 범위가 코드와 맞다 |
| [보드 동작](../../../extensions/work-board/references/behavior.md) | 새 설치본 표시와 내장 명령 실행이 코드와 맞다 |

공통화 후보 없음. 관련 [보드 버전 표시 스펙](../board-plugin-version/spec.md)과 [루프 자동 갱신 스펙](../loop-self-update/spec.md)을 대조했다. 버전 비교는 루프의 Node 실행과 보드의 Claude mod 실행에 각각 필요하지만, 두 실행 환경이 공유하는 새 계약이나 도메인 규칙은 생기지 않았다.
