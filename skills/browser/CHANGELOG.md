# CHANGELOG: browser

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 2.0.3 (2026-11-12)

- description 의 ego-browser 문장에서 본문이 이미 갖는 소유 설명을 빼고 경계만 남겼다.

## 2.0.2 (2026-11-09)

- browser-driver README 의 옛 링크 설명을 원본 체크아웃과 팀 사본으로 나눠, 팀 사본에는 옛 이름 진입이 없고 install 로 링크를 다시 건다고 적는다.

## 2.0.1 (2026-11-09)

- browser-driver 테스트의 반복 명령을 함수 호출로 옮겨 준비 비용을 줄인다. 백엔드와 옵션·출력·종료 코드의 대표 CLI 대조는 유지한다.

## 2.0.0 (2026-11-09)

- 호환성: 브라우저 드라이버를 `tools/browser-driver/` 에서 이 스킬의 `browser-driver/` 로 옮기고 Node 24 의 `.ts` 로 바꿨다. 진입은 `browser_driver.ts` 다
- 옵션, stdout, stderr, 종료 코드, 설정 파일 경로 판정은 그대로다. 설치 캐시 판정은 새 자리와 팀 사본 자리를 모두 읽는다
- 옛 `tools/browser-driver/browser_driver.py` 는 옛 링크가 돌도록 node shebang JS 로 남기고 stderr 에 새 명령을 알린다. 다음 major 에 지운다
- `install` 이 링크를 진입 파일로 건다. 전에는 링크가 `driver/admin.py` 를 가리키는 잘못이 있었다
- 새 링크는 `ln -sfn …/skills/browser/browser-driver/browser_driver.ts ~/.claude/scripts/browser-driver` 다. Python 은 필요 없고 Node 24 이상이 필요하다

## 1.x

- 브라우저 작업을 browser-driver 로 끝내는 스킬이다. CLI 와 공개 API 를 먼저 보고, 로그인과 되돌리기 어려운 버튼만 사람이 확인한다
- 작업마다 `BROWSER_EGO_SPACE` 로 공간을 열고 실패해도 `reset` 으로 닫으며, 저장소 오버레이를 읽고 새로 안 화면 순서와 함정을 더한다
- 하위 에이전트에 넘길 지시 문구를 `references/delegation.md` 에 두고, 설명에 `ego-browser` 스킬과의 경계를 적었다
