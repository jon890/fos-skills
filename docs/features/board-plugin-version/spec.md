# 보드의 플러그인 버전 표시와 갱신 단축키

확인: 2026-11-02

## 목표

`/board` 창에서 지금 세션이 읽은 fos-skills 설치본의 버전과 main 의 최신 버전을 보고, 뒤처졌으면 창의 단축키로 갱신할 수 있다.
창이 좁아도 단축키 상자의 모든 단축키가 보인다.

## 범위

이번 범위:

- 창 머리 줄에 설치본의 플러그인 version 과 커밋, 최신 여부를 보인다.
- 최신 커밋과 그 커밋의 플러그인 version 을 원격 저장소에서 읽는다.
- 갱신 단축키로 설치본을 갱신하고 다시 불러오기를 안내한다.
- 단축키 상자가 좁은 폭에서 줄바꿈되게 고친다.
- `plugin.json` 에 `version` 을 두고 main 에 머지될 때마다 자동으로 올린다([ADR-019](../../adr/019-plugin-version-auto-bump.md)).
- 상태 줄을 글이 바뀔 때만 보낸다. SDK 로 실린 세션에서 같은 `ui_status` 메시지가 5초마다 쌓이지 않게 한다.

범위 밖:

- 스킬마다 있는 `metadata.version` 과 CHANGELOG 를 창에 보이는 것.
- 다른 플러그인(omc, ai-sdt 등)의 버전.
- 갱신 내용(바뀐 커밋 목록)을 창에 보이는 것.

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| R1 | 창에 지금 세션이 읽은 설치본의 version 과 커밋을 보인다 | 마켓플레이스 설치본이면 「fos-skills 1.4.0 (b1e2c09)」 처럼 설치본 `plugin.json` 의 version 과 설치 기록의 커밋 앞 7자리가, `--plugin-dir` 로 읽은 작업 트리면 「작업 트리」 와 그 HEAD 커밋이 머리 줄에 보인다. version 이 없으면 커밋만 보인다 |
| R2 | main 의 최신 버전과 비교해 최신 여부를 보인다 | 같으면 「최신」 이 흐리게, 다르면 최신 version·커밋과 「p 로 갱신」 이 노란색으로, 확인하지 못하면 「최신 확인 불가」 가 흐리게 보인다. 둘 다 version 이 있으면 version 으로, 아니면 커밋으로 비교한다 |
| R3 | 갱신 단축키 `p` 가 설치본을 갱신한다 | `p` 를 누르면 그 설치본의 scope 로 `claude plugin update` 가 돌고, 성공하면 입력란에 `/reload-plugins` 가 채워진다. 실패하면 toast 에 이유가 보이고 입력란은 그대로다. 최신으로 확인됐거나 작업 트리면 `p` 가 없다 |
| R4 | 좁은 창에서도 단축키가 모두 보인다 | 터미널 폭 70칸에서 `/board` 를 열면 단축키 상자에 모든 단축키가 잘리지 않고 보인다(줄바꿈 허용) |
| R5 | directory 소스 마켓플레이스의 폴더에서 읽은 설치본도 `p` 로 갱신한다 | `known_marketplaces.json` 의 directory path 가 설치본 폴더와 같으면(`--plugin-dir` 로 읽었어도) 「작업 트리」 가 아니라 「fos-skills 1.4.0 (…)」 로 보이고 뒤처지면 「p 로 갱신」 이 보인다. `p` 는 그 폴더가 main 이고 추적 파일 변경이 없고 fast-forward 할 수 있을 때만 `git pull --ff-only origin main` 을 돌리고 `/reload-plugins` 를 채운다. 아니면 받지 않고 toast 에 이유(「main 이 아니라서」, 「고치는 중인 파일이 있어서」, 「fast-forward 할 수 없어서」)를 보인다. 받은 뒤 머리 줄은 새 version 을 보인다 |

## 설계

- 표시: `extensions/work-board/hooks/register.js` 의 머리 줄 Box(`updated-at`)가 「HH:MM 업데이트  ·  <버전 글>」 을 줄바꿈 허용으로 그린다. 버전 글과 색은 `versionLabel` 이 정한다.
- 읽는 시점: 세션 시작에 설치본을 한 번 읽고(`loadInstall`), main 은 세션 시작, `/board` 열 때, 30분마다(`VERSION_MS`), 갱신 직후에 읽는다(`loadLatest`). 명령마다 10초 시간 초과다.
- 최신 version: `git ls-remote` 로 받은 커밋의 `plugin.json` 을 `https://raw.githubusercontent.com/<owner>/<repo>/<커밋>/.claude-plugin/plugin.json` 에서 `curl` 로 읽는다. 커밋 주소라 CDN 캐시에 낡은 값이 남지 않는다. 읽지 못하면 커밋으로만 비교한다.
- version 으로 비교하는 이유: version 을 올리지 않은 커밋은 `update` 가 받지 않는다. 커밋으로 비교하면 받을 것이 없는데도 「p 로 갱신」 이 계속 보인다.
- 갱신: `updatePlugin` 이 `claude plugin update <key> --scope <scope>` 를 project·local scope 면 그 `projectPath` 에서 돌린다. 시간 초과는 3분이다.
- directory 설치본: `claude plugin update` 는 folder 에서 읽는 마켓플레이스에서 갱신할 것이 없다고 끝난다. 설정 폴더의 `plugins/known_marketplaces.json` 에서 source 가 directory 이고 path 가 `$.plugin.root` 와 같으면 어떻게 읽었든(`--plugin-dir` 로 같은 폴더를 읽은 경우 포함) `kind: 'directory'` 로 본다(`directoryMarketplaceOf`). 등록되지 않은 다른 폴더를 `--plugin-dir` 로 읽은 것만 작업 트리(`tree`)다. 프로세스 인자는 보지 않는다. 작업 중인 변경은 아래 세 보호가 지킨다. 최신 판정은 같다(폴더의 version 과 origin main 의 version). `p` 는 `updatePlugin` 이 브랜치, 추적 파일 변경, `git fetch origin main` 뒤 fast-forward 가능 여부를 보고(`checkDirectory`, `directoryRefusal`) `git -C <폴더> pull --ff-only origin main` 을 돌린다. 이 설치본은 폴더를 그대로 읽으므로 받은 뒤 `loadInstall` 로 다시 읽어 머리 줄이 새 version 을 보인다. 캐시 설치본은 세션 동안 한 번만 읽는다
- 단축키 줄: 버튼 줄 Box(`shortcut-row`)에 `flexWrap: 'wrap'` 을 준다.

조사 결과는 아래와 같다.

- 설치본 위치: mod 의 `$.plugin.root` 가 설치본 폴더다. 마켓플레이스 설치본은 `<설정 폴더>/plugins/cache/fos-skills/fos-skills/<커밋 앞 12자리>` 다([ADR-002](../../adr/002-plugin-version-is-commit-sha.md)).
  `<설정 폴더>/plugins/installed_plugins.json` 의 같은 `installPath` 항목에 `gitCommitSha` 40자리와 `scope` 가 있다.
- 최신 커밋: `git ls-remote https://github.com/jon890/fos-skills refs/heads/main` 이 인증 없이 0.5초 안팎에 끝난다(2026-11-02 실측 0.46초). 저장소 주소는 설치본의 `plugin.json` 의 `repository` 에서 읽는다.
  `<설정 폴더>/plugins/marketplaces/fos-skills` 의 HEAD 는 마켓플레이스를 갱신할 때만 바뀌어 최신 판정에 쓰지 않는다.
- 갱신 명령: `claude plugin update fos-skills@fos-skills --scope <user|project|local>`. 한 머신에 user 와 project scope 설치본이 함께 있을 수 있어(2026-11-02 이 머신) scope 를 지정한다. 적용은 `/reload-plugins` 다.
- 단축키 잘림: 단축키 상자의 줄은 `flexDirection: 'row'` 에 `flexWrap` 이 없다. 다섯 버튼 폭의 합(약 81칸)이 상자 안쪽 폭보다 넓으면 오른쪽 버튼이 잘린다.
  2026-11-02 tmux 70칸 터미널에서 `d: 단계와 완료 펼치기` 가 보이지 않는 것을 재현했다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| D1 | 버전 표시 위치와 형식 | 머리 줄에 붙인다. 뒤처지면 노란색과 「p 로 갱신」, 형식은 「fos-skills 1.4.0 (b1e2c09)」 | 사용자 2026-11-02 | 창 높이가 늘지 않고 뒤처졌을 때만 눈에 띈다 |
| D2 | 최신 확인 시점과 오프라인 동작 | 세션 시작, `/board` 열 때, 30분마다, 갱신 직후. 실패(시간 초과 10초)하면 「최신 확인 불가」 를 흐리게 보인다 | 사용자 2026-11-02 | 네트워크 호출이 시간당 두세 번이다 |
| D3 | 갱신 단축키 키와 실행 방식 | `p`. 보드가 그 세션 설치본의 scope 로 `claude plugin update` 를 직접 돌리고 성공하면 입력란에 `/reload-plugins` 를 채운다. 최신일 때는 숨긴다 | 사용자 2026-11-02 | 모델 턴 없이 끝나고, 설치본이 scope 마다 다를 수 있다 |
| D4 | plugin.json version 도입 | 둔다. 변경마다 올린다. ADR-002 를 ADR-019 로 대체한다 | 사용자 2026-11-02 | 플러그인 버전을 사람이 읽는 값으로 관리하고 싶다 |
| D5 | 좁은 폭의 단축키 배치 | 줄바꿈을 허용한다 | 사용자 2026-11-02 | 넓은 창은 지금과 같다 |
| D6 | version 을 자동으로 올리는 방식 | main push 때 GitHub Actions 가 version 과 `.claude-plugin/CHANGELOG.md` 를 올린다. 바뀐 스킬 CHANGELOG 에 `호환성:` 항목이 있으면 major, 새 버전 절이 있으면 minor, 그 밖은 patch | 사용자 2026-11-02 | 동시 PR 끼리 충돌하지 않고 머지 경로와 상관없이 빠지지 않는다 |
| D7 | directory 소스 마켓플레이스 설치본의 갱신 | 따로 판정(`kind: 'directory'`)하고 `p` 가 폴더에서 `git pull --ff-only origin main` 을 돌린다. 막을 이유(main 아님, 추적 파일 변경, fast-forward 불가)는 받기 전에 toast 로 보인다. 그 이유를 보이려고 뒤처졌으면 이유와 상관없이 `p` 를 보인다 | 사용자 2026-11-03 | `claude plugin update` 는 folder 에서 읽은 마켓플레이스에서 받을 것이 없다. 작업 중인 변경은 덮지 않는다 |
| D8 | 등록된 폴더를 `--plugin-dir` 로 읽은 경우 | 프로세스 인자로 구분하지 않고 directory 로 본다. 작업 중인 변경은 세 보호(main 인지, 추적 파일 변경, fast-forward 가능 여부)가 지킨다 | 사용자 2026-11-03: ps 판정을 빼고 세 보호로 작업 트리를 지킨다 | 프로세스 인자 해석은 상대경로, 공백 경로, 병행 세션, 조회 실패마다 예외가 생긴다 |
