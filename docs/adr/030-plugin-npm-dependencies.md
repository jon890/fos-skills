# ADR-030: 플러그인 루트의 package.json 으로 npm 의존을 두고 설치는 Claude Code 에 맡긴다

- **status**: `accepted`
- **decision-type**: `architecture`
- **areas**: `operations, quality`
- **현재 규칙의 원본**: [저장소 실행 규칙](../code-architecture.md#저장소-실행-규칙)의 「의존」 행, 루트 `package.json`, `package-lock.json`, `scripts/runtime-policy.ts`
- **결정**: 저장소 루트(플러그인 루트)에 `package.json` 과 `package-lock.json` 을 두고 npm 의존을 정확한 버전으로 적는다. `node_modules` 는 커밋하지 않고 빌드 단계도 두지 않는다. 사용자 머신의 설치는 Claude Code 가 플러그인을 캐시에 복사할 때 하는 의존 설치에 맡긴다. 의존은 허용 목록의 orch 파일에서만 import 하고, 그 밖의 스킬과 도구는 지금처럼 Node 내장 모듈만 쓴다. 첫 의존은 설정 값 검사의 zod 다. 사용자 결정 2026-11-12.
- **맥락**: `orch config set` 이 설정 키 60여 개의 값을 검사해야 했고([orch-config-cli 설계](../features/orch-config-cli/design.md)), 사용자는 검사를 zod 로 선언하기를 원했다.
  [ADR-010](010-orch-typescript.md) 과 [ADR-025](025-script-runtime-typescript.md) 는 플러그인이 저장소를 그대로 복사해 설치되어 `npm install` 단계가 없다고 보고 npm 의존을 두지 않았다.
  2026-11-12 공식 문서(plugins/loading 「Node.js package dependencies」)는 Claude Code 가 플러그인을 캐시에 복사할 때 루트의 `package.json` 과 lock(`package-lock.json`, `npm-shrinkwrap.json`, `bun.lock`)으로 의존을 설치한다고 적는다. 설치는 `--ignore-scripts`, 60초 제한이고 끌 수 없다. `pnpm-lock.yaml` 은 건너뛴다.
  같은 날 임시 `CLAUDE_CONFIG_DIR` 에 그런 플러그인을 설치해 캐시에 `node_modules/zod` 가 생기는 것을 확인했다.
  팀 저장소는 스킬 폴더만 복사해 가므로, 그런 스킬이 의존을 쓰면 사본에서 깨진다.
- **대안 기각**:
  - `node_modules` 를 커밋한다: 의존마다 설치본(zod 4.6.7 은 파일 840개, 8.1MB)이 저장소에 들어가고 CI 가 설치본과 lock 의 일치를 따로 지켜야 한다. 설치를 Claude Code 가 해 주므로 필요 없다.
  - 빌드해 `dist/` 를 커밋한다: 명령 47개의 진입점, 개발 체크아웃(`ORCH_SCRIPTS_DIR`) 흐름, 테스트를 모두 바꿔야 하고 원본과 산출물이 어긋날 수 있다.
  - zod 원본 일부를 `vendor/` 에 복사하거나 한 파일로 묶는다: 갱신 스크립트와 원본 대조 검사를 따로 둬야 하고, 한 파일 묶기는 타입 선언 묶기가 실패했다.
  - 별도 npm 패키지로 내고 마켓플레이스 출처를 npm 으로 바꾼다: 의존 설치는 git 출처에서도 같으므로 배포 단계만 늘어난다.
  - pnpm 을 쓴다: Claude Code 의 의존 설치가 `pnpm-lock.yaml` 을 건너뛴다. 공식 문서의 대안(SessionStart 훅이 데이터 폴더에 설치하고 `NODE_PATH` 로 넘김)은 ESM import 가 `NODE_PATH` 를 보지 않아 맞지 않는다.
  - 직접 쓴 검사 도우미를 둔다: 의존 규칙은 지키지만 사용자가 zod 를 골랐다.
- **결과**:
  - 얻는 것: orch 가 npm 라이브러리를 표준 방식(`package.json`, lock)으로 쓰고, 저장소에는 소스만 남는다.
  - 감당할 것: 플러그인 설치나 갱신 때 네트워크가 필요하다. 설치에 실패하면 의존을 쓰는 명령이 돌지 않는다. 그래서 의존은 그 의존이 필요한 명령에서만 불러오고, 루프와 worker 명령은 의존 없이 돈다.
  - 감당할 것: 체크아웃, worker 워크트리, CI 는 `npm ci` 를 먼저 돌아야 테스트가 돈다.
  - 감당할 것: Codex 설치본은 이 설치를 하지 않는다. `orch` 실행기가 Claude 설치 기록의 번들을 고르는 동안은 영향이 없다.
  - 감당할 것: 설치 스크립트가 필요한 의존(네이티브 모듈)과 git 의존은 설치되지 않는다. 그런 의존은 들이지 않는다.
  - 감당할 것: 루트의 `"type": "module"` 이 CommonJS 진입(`bin/orch`, orch 의 gh·orca 감시)을 ES 모듈로 읽게 한다. `bin/` 에는 `type` 만 담은 `package.json` 을 두고, ES 모듈과 같은 폴더에 있는 guard shim 은 `type` 과 상관없이 도는 꼴로 고친다.
- **확인 방법**: `scripts/runtime-policy.ts` 의 `package.json` 자리와 bare import 허용 목록 검사, orch core 경계 검사의 허용 의존, 의존 설치 실패 때 `orch doctor` 의 `CLI-DEPS-MISSING` 테스트.
