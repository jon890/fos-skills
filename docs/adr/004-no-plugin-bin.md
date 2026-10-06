# ADR-004: 공용 도구의 PATH 명령은 이 플러그인에 두지 않는다

- **status**: `accepted`
- **결정**: 저장소 루트에 `bin/` 을 두지 않는다.
  `tools/browser-driver` 의 원본은 여기 두고, PATH 에서 부르는 `browser-driver` 명령은 팀 저장소의 플러그인 `nhn-dev` 가 소유한다.
- **맥락**: Claude Code 는 활성화된 플러그인마다 루트의 `bin/` 을 PATH 에 넣는다.
  2026-10-06 에 확인한 결과, 팀 저장소의 `plugins/nhn-dev/bin/browser-driver` 가 이미 PATH 에 올라와 있었다.
  그 파일은 같은 플러그인의 `tools/browser-driver/browser_driver.py` 를 실행한다. 그 `tools/` 는 이 저장소가 내보낸 사본이다.
  실행하기 전에 ego 백엔드를 고르고 설정 파일 위치를 정하므로, 본체를 바로 실행할 때와 동작이 다르다.
  이 플러그인에도 같은 이름을 두면 두 명령이 같은 이름을 두고 경쟁한다. 어느 쪽이 실행될지는 PATH 순서가 정하고, 두 사본의 버전은 내보내기 시점에 따라 다르다.
  명령을 이 플러그인으로 옮기면 `nhn-dev` 만 설치한 팀원은 그 명령을 잃는다.
- **결과**:
  - 이 플러그인을 설치해도 `browser-driver` 명령은 생기지 않는다.
    PATH 에서 부르려면 `nhn-dev` 를 설치한다.
    플러그인 없이는 [README](../../README.md) 의 링크 설치로 `~/.claude/scripts/browser-driver` 를 건다. 이 링크는 PATH 명령이 아니라 스킬이 마지막에 찾는 자리다.
  - 스킬이 드라이버를 찾는 순서는 바꾸지 않는다. 캐시에서는 위로 올라가며 찾은 `tools/browser-driver/` 를 쓴다.
  - `python3 -m unittest discover -s scripts/tests` 가 루트에 `bin/` 이 생기면 실패한다.
- **적용 범위**: 도구 배치는 [code-architecture.md](../code-architecture.md) 가 소유한다.
