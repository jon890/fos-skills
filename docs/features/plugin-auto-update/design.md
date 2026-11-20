# fos-skills 자동 갱신 기술 설계

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1, REQ2, REQ3 | 루프 부모가 30분 간격으로 main 버전을 읽고, 설치 기록에 있는 캐시 설치본만 설정 폴더·scope 별로 갱신한다 |
| REQ4 | 홈 아래 머신 공통 잠금과 마지막 확인 시각을 공유한다. 잠금이 있으면 이번 확인을 건너뛴다 |
| REQ5 | 갱신 결과를 공통 기록에 남긴다. 다시 뜨기 알림에 그 결과를 붙이고, 실패가 있으면 버전당 한 번 알린다 |
| REQ6 | 보드는 설치 기록과 세션이 읽은 번들의 버전을 비교한다. 새 설치본을 발견하면 내장 명령 여부를 확인한 뒤 `$.command.run` 을 부른다 |
| REQ7 | 루프 부모가 저장소의 `plugin.auto_update` 를 읽고 `false` 면 확인 자체를 건너뛴다 |

## 책임과 경계

`skills/orch/scripts/loop/plugin-auto-update.ts` 가 확인 주기, 머신 잠금, 설정 폴더 탐색, 갱신, 결과 기록을 맡는다. `lifecycle.ts` 는 틱 직후 이를 호출하고, 기존 설치본 교체 판정과 넘겨주기를 그대로 사용한다. 기존 `self-update.ts` 는 다시 뜰 때 공통 결과 기록을 읽어 알림 문장에 붙인다. `extensions/work-board/hooks/register.js` 는 현재 세션 설치본과 설치 기록의 버전만 대조하며 설치를 직접 바꾸지 않는다.

## 인터페이스와 데이터

설정 폴더는 `~/.claude` 와 `lib/claude-profile.ts` 의 Orca 프로필 루트 아래 `*/home` 이다. 테스트에서는 임시 폴더 경로를 함수 인자로 주입한다. 각 폴더의 `plugins/installed_plugins.json` 에서 `fos-skills@fos-skills` 행만 읽는다. 캐시 밖의 `installPath` 는 제외한다. `user` 는 그 설정 폴더, `project`·`local` 은 `projectPath` 에서 명령을 실행하며 자식 프로세스의 `CLAUDE_CONFIG_DIR` 를 대상 폴더로 지정한다.

머신 공통 상태는 사용자 홈의 캐시 폴더에 마지막 확인 시각, main 버전, 설치본별 결과와 실패 알림을 보낸 버전을 둔다. 이는 설치 기록을 대신하지 않는다. 갱신 명령이 성공하고 설치 기록의 `version` 이 main 과 같을 때 성공으로 판단한다. 상태 기록은 잠금을 쥔 루프만 쓴다. 같은 version 을 다시 읽으면 성공한 설치본은 명령을 호출하지 않고 성공 결과를 유지한다. 늦게 다시 뜬 루프에도 옛 버전과 성공 결과를 알리기 위해서다.

Claude Code의 [mod 타입 선언](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)은 `$.command.list()` 의 `source` 가 `builtin` 을 구분하고, `$.command.run()` 이 내장 명령을 포함한 슬래시 명령을 세션이 쉴 때 실행한다고 정의한다. 보드는 목록에 `{ name: 'reload-plugins', source: 'builtin' }` 이 있는 경우에만 `{ command: 'reload-plugins' }` 를 보낸다. 명령 출력은 Claude Code 가 채팅에 기록하며 입력란은 건드리지 않는다. 목록에 없거나 실행이 실패하면 다음 확인에서 재시도한다.

## 실패와 일관성

잠금을 얻지 못한 루프는 이번 확인을 건너뛰고 다음 틱에 다시 본다. 네트워크 실패나 일부 설치 실패는 결과에 남기고 30분 뒤 다시 시도한다. 성공한 scope 는 기록된 version 으로 건너뛴다. 잠금은 프로세스가 죽으면 회수할 수 있게 pid 와 프로세스 식별 정보를 둔다. 개발용 directory 설치는 설치 기록에 있어도 캐시 경로가 아니므로 git 명령을 실행하지 않는다. 새 번들이 없는 실패는 버전별 알림 상태를 공통 파일에 남겨 중복을 막는다.

## 검증 전략

임시 홈·Orca 프로필·설치 기록과 가짜 명령 실행기로 버전 비교, 범위별 cwd, 성공 기록 재확인, 실패 재시도, 잠금 경합을 검증한다. 보드는 Claude Code 모의 세션에서 명령 목록과 실행을 관측하고 입력란을 쓰지 않는지 검증한다. 저장소 전체 테스트와 `claude plugin test .` 도 실행한다. 실제 사용자의 설정 폴더는 테스트에서 갱신하지 않는다.

## 결정

DECISION7은 타입 선언의 `builtin` 출처와 명령 실행 계약으로 충족된다. 새 ADR 은 만들지 않는다. 이 기능은 기존 루프 넘겨주기와 mod 명령 API 를 연결하며 별도의 장기 아키텍처 원칙을 만들지 않는다.
