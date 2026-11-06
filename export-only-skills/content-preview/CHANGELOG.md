# CHANGELOG: content-preview

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 4.0.1 (2026-11-06)

- 표기 검사가 korean-check 의 `check.sh` 대신 `check.ts` 를 node 로 부른다. 실행 권한은 필요 없다

## 4.0.0 (2026-11-06)

- 호환성: 스크립트 다섯(`dooray-preview/generate`, `github-preview/generate`, `preview_output`, `show-preview`, `style-check`)을 Node 24 의 `.ts` 로 바꿨다
- `node "$SKILL_DIR/scripts/show-preview.ts" …` 처럼 이름의 확장자만 바꿔 부른다. 생성기는 `python3` 대신 `node` 로 부른다
- 옵션, 출력, 종료 코드는 그대로다. 이 스킬을 쓰려면 Node 24 이상이 필요하다
- 값이 `-` 로 시작하는 옵션(`--title -x`)을 받는다. 옛 생성기는 사용법 오류로 거부했다
- 옛 `python3 …/generate.py`, `bash …/show-preview.sh`, `bash …/style-check.sh` 호출(허용 규칙과 오버레이 포함)은 새 이름으로 바꿔야 한다

## 3.x

- 실행 절차를 표기 검사(3단계)와 검토(4단계)를 나눈 6단계로 정했다. 검사기와 판정 기준은 `korean-check` 가 소유하고, 찾지 못하면 종료 코드 2 로 멈춘다
- Dooray 생성기에 `--mode messenger` 를 더했다. 멘션, 인라인 코드, HTTPS 주소와 링크만 렌더하고, 렌더되지 않는 형식과 `dooray://` 업무·위키 링크는 경고 띠와 stderr 로 알린다. `--strict` 는 경고가 있으면 종료 코드 1 이다
- 두 생성기가 시작할 때 `--out` 의 이전 파일을 스스로 지우고 임시 파일에 쓴 뒤 이름을 바꿔 덮어쓴다
- 미리보기에 쓸 브라우저 백엔드를 설정 파일의 `previewDriver` 나 `PREVIEW_BROWSER_DRIVER` 로 정한다. 설정 파일은 `BROWSER_CONFIG`, 드라이버의 `config-path`, `~/.claude/browser.config.json` 순으로 찾는다
- 사용자가 이번 본문의 등록을 미리 승인했거나 범위를 밝힌 상시 승인을 했으면 미리보기를 생략하거나 응답을 기다리지 않고 등록한다. 표기 검사는 그대로 한다
- 에이전트 조율 도구의 dispatch 로 받은 세션은 미리보기 HTML 을 만드는 것으로 5단계를 통과하고, 지시문에 등록이 있으면 이 턴에 등록한다
- 한 턴에 본문이 여럿이면 순번 머리를 붙여 한 파일로 이어 붙여 미리보기를 한 번 띄운다. 부분 수정이면 바뀐 블록을 AS-IS 와 TO-BE 로 보인다. 매체마다 다르게 렌더되는 패턴은 `references/render-traps.md` 에 모았다
- 호환성: 드라이버 경로를 지정하는 환경 변수가 `BROWSER_DRIVER` 에서 `BROWSER_DRIVER_PATH` 로 바뀌었다

## 2.x

- 실행 절차를 5단계로 정하고 단계마다 통과 조건을 세웠다. 본문 전문을 채팅에 다시 쓰지 않고, 미리보기 턴은 미리보기로 끝낸다
- 개인 문체 참조를 어디에 두고 무엇을 적는지 `references/persona.md` 로 옮겼다
- 저장소가 브라우저 드라이버를 함께 배포하고, `show-preview.sh` 가 호출자 지정, 저장소 안, 개인 심링크 순으로 찾는다
- Dooray 생성기 `--project` 의 기본값을 비웠다. 값이 없으면 그 줄을 그리지 않는다
- 자가 점검 단계가 표기 검사기를 직접 돌린다. 편집 훅을 거치지 않은 본문도 검사한다

## 1.x

- 개인 스킬 폴더에서 이 저장소로 옮기고, HTML 생성기를 스킬 번들의 `scripts/` 로 들였다
- `scripts/show-preview.sh` 로 미리보기를 사용자 화면에 띄우고, 같은 파일의 탭이 있으면 새로 열지 않고 갱신한다
- `browser-driver` 가 있으면 그것으로 띄워 에이전트 IDE 안의 탭도 갱신한다
- 미리보기 탭이 사용자가 보는 워크트리에 있는지 대조하고, 어긋나면 기본 브라우저로 다시 띄운다
- Dooray 생성기에 `--mode` 를 더했다. `task` 는 업무 머리를, `comment` 는 댓글 머리를 그린다
- Dooray 본문은 TOAST UI viewer 로만 미리본다. marked 는 줄을 나눈 문장을 한 문단으로 붙이고 물결표를 취소선으로 읽는다
- 개인 문체 참조를 배포에서 빼고 `~/.claude/references/` 에 둔다
