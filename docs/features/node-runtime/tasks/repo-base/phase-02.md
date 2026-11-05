# Phase 02. 스크립트 언어 규칙 ADR 과 저장소 실행 규칙 문서

**Execution profile**: standard

## 목표

이 저장소의 스크립트와 테스트는 TypeScript(Node 24)이고 Python·셸 파일을 두지 않는다는 규칙을 ADR 과 `docs/code-architecture.md` 에 적어, 다른 worker 가 새 스크립트를 쓸 때 따르게 한다.

**범위 외**: 각 영역의 문서 호출 바꾸기(뒤 PR). 개인 지침 파일(저장소 밖).

## 컨텍스트

**요구사항**: REQ9

**근거 문서**: `docs/features/node-runtime/spec.md` 의 DECISION2, DECISION9, `docs/features/node-runtime/design.md` 의 「진입 파일」, 「호출 꼴」, 「스킬은 자기 폴더 안만 import 한다」, `docs/adr/010-orch-typescript.md`, `docs/adr/011-node-24-minimum.md`

- ADR 양식은 기존 ADR(`docs/adr/023-version-at-merge.md`)의 꼴을 따른다: 제목, `status`, `결정`, `맥락`, `대안 기각`, `결과`, `적용 범위`.
- ADR 번호: 착수 때 `git ls-files docs/adr` 와 `gh pr list --state open --json files --jq '.[].files[].path' | grep '^docs/adr/'` 로 쓰인 번호를 보고 다음 번호를 쓴다. 이 저장소의 `.orch/config.json` 에 `adr.dirs` 가 있으면 `orch queue reserve --kind adr` 로 예약한다. 아래에서는 `0NN` 으로 적는다. 번호를 착수 때 정하므로 변경 파일 표는 이 ADR 을 glob 으로 적는다. 2026-11-05 에는 ADR-023 이 마지막이고 열린 PR 이 쓰는 번호가 없었다.
- 이 저장소는 대체된 ADR 을 `docs/adr/` 에 그대로 두고 색인에서 구분한다(ADR-001 이 `superseded` 로 그 자리에 있다).
- 같은 정보를 두 문서에 쓰지 않는다. 규칙의 원본은 `docs/code-architecture.md` 「저장소 실행 규칙」 이고, ADR 은 선택 이유를 갖는다. 남은 파일 목록의 원본은 `scripts/runtime-policy.json` 이라 문서에 옮겨 적지 않는다.

## 의도 메모

- ADR-010 과 ADR-011 을 `superseded` 로 바꾸지 않는다. 두 결정(orch 를 한 번에 옮김, Node 24)은 그대로 유효하고, 새 ADR 이 적용 범위를 저장소 전체로 넓힌다. 두 ADR 의 「적용 범위」 끝에 새 ADR 을 가리키는 한 줄만 더한다.
- `docs/code-architecture.md` 의 orch 절 「실행 규칙」 표(2026-11-05 에 228~238줄, 행은 Node 버전, 실행, 문법, 의존, 테스트, 오류 출력, 주석)를 행마다 아래 4 의 표대로 나눈다. orch 만의 내용은 orch 절에 남긴다.

## 작업 항목

### 1. `docs/adr/0NN-script-runtime-typescript.md` 신규

- 제목: `ADR-0NN: 저장소의 스크립트와 테스트를 TypeScript(Node 24) 하나로 둔다`
- 결정: 저장소의 스크립트, 검사기, git 훅, 테스트는 TypeScript 로 쓰고 Node 24 의 타입 제거로 바로 실행한다. Python 과 셸 파일을 두지 않는다. JS 는 타입 제거가 닿지 않는 진입(확장자 없는 git 훅과 실행기, 옛 이름 진입, 이미 있는 work-board hooks 모듈)에만 쓴다. 스킬과 도구는 자기 폴더와 Node 내장 모듈만 import 한다. 사용자 결정 2026-11-04, 2026-11-05. ADR-010 과 ADR-011 의 범위를 넓힌다.
- 맥락: 스펙의 실측(Python 124개 파일, 셸 16개)과 얻으려는 것(스펙 DECISION1). 팀 저장소 배치 때문에 스킬 밖 import 가 깨지는 사실(설계 「스킬은 자기 폴더 안만 import 한다」).
- 대안 기각: Python 유지(두 언어가 공통 helper 를 두 벌 둔다), 셸 한 줄 진입 허용(사용자가 예외 없이 옮기기로 했다. node 가 확장자 없는 진입을 돌린다), 빌드나 번들러(ADR-010 과 같은 이유), 공통 helper 를 import(팀 플러그인 안 스킬에서 경로가 깨진다).
- 결과: 얻는 것(한 언어, python3 없는 환경, 저장소 검사가 새 파일을 막음), 감당할 것(Python `re` 와 JS RegExp 의 차이, `kit` 복사본 동기, 이행 동안 팀 사본이 어긋남, Node 24 미만에서 안내 없이 실패).
- 적용 범위: 규칙은 `docs/code-architecture.md` 「저장소 실행 규칙」, 남은 파일과 허용 진입은 `scripts/runtime-policy.json`, 이행 순서는 `docs/features/node-runtime/spec.md` 가 소유한다.

### 2. `docs/adr/INDEX.md` 수정

끝에 `- [ADR-0NN](0NN-script-runtime-typescript.md): 저장소의 스크립트와 테스트를 TypeScript(Node 24) 하나로 둔다 (`accepted`)` 를 더한다. 다른 줄은 고치지 않는다.

### 3. `docs/adr/010-orch-typescript.md`, `docs/adr/011-node-24-minimum.md` 수정

각 「적용 범위」 끝에 `저장소 전체로 넓힌 규칙은 [ADR-0NN](0NN-script-runtime-typescript.md) 이 소유한다.` 한 줄을 더한다.
ADR-011 의 「적용 범위」 는 버전 판정 소유자를 낡은 경로 `orch/scripts/ts_shim.py` 로 적고 있다. 지금 판정하는 곳인 플러그인 실행기 `bin/orch`(와 orch-cli 가 지울 때까지 남는 `skills/orch/scripts/ts_shim.py`)로 고친다. 결정과 맥락은 고치지 않는다.

### 4. `docs/code-architecture.md` 수정

- 「orch 코어와 핸들러」 앞에 `## 저장소 실행 규칙` 절을 새로 둔다. 근거로 ADR-0NN 을 링크한다. 표의 행:
  - Node 버전: 24 이상. 고른 이유는 ADR-011. 값의 원본은 `scripts/runtime-policy.json` 의 `min_node`
  - 언어: TypeScript. Python·셸 파일을 두지 않는다. JS 는 `entry_js` 와 `legacy` 의 진입만
  - 문법: 지금 orch 행의 문장을 그대로 옮긴다
  - 의존: 지금 orch 행의 문장을 그대로 옮긴다
  - import 범위: 스킬과 도구는 자기 폴더와 Node 내장 모듈만
  - 호출 꼴: `node "$SKILL_DIR/scripts/<이름>.ts"`
  - 테스트: `node:test` 의 `*.spec.ts`. CI 의 다섯 패턴이 고른다. 신호를 보내는 테스트 때문에 로컬에서는 README 「기여」 의 명령으로 돌린다
  - 주석: 지금 orch 행의 문장을 그대로 옮긴다
  - 저장소 검사: `node scripts/runtime-policy.ts`
- orch 절 「실행 규칙」 표는 이렇게 남긴다. 표 앞에 `저장소 전체 규칙은 「저장소 실행 규칙」 이 소유한다. 아래는 orch 만의 규칙이다.` 한 줄을 둔다.
  - Node 버전 행은 「Node 버전 판정」 으로 이름을 바꾸고 orch 만의 내용(실행기 `bin/orch` 의 판정, `NODE-TOO-OLD`, `ts_shim.py` 와 `orch-launcher.spec.ts` 의 대조)만 남긴다. 「24 이상, ADR-011」 부분은 새 절로 옮겼으므로 지운다
  - 실행, 오류 출력 행은 그대로 둔다
  - 문법, 의존, 테스트, 주석 행은 지운다
- 「모듈 책임」 표에 `scripts/runtime-policy.ts`(남은 Python·셸 파일과 허용 진입을 정책 파일과 대조한다. 부르는 쪽: `scripts/tests/runtime-policy.spec.ts`, CI, worker)와 `scripts/runtime-policy.json`(이행 상태의 원본) 행을 더한다.
- 「검증」 표의 node 테스트 줄을 CI 의 다섯 패턴으로 바꾸고 `node scripts/runtime-policy.ts` 줄을 더한다.

### 5. `README.md` 수정

- 「공용 도구」 의 스크립트 목록에 `scripts/runtime-policy.ts` 행을 더한다: 남은 Python·셸 파일과 허용한 JS 진입을 `scripts/runtime-policy.json` 과 대조해 새 파일을 막는다.
- 「기여」 의 node 테스트 문장을 저장소 전체(다섯 패턴)를 도는 말로 바꾼다. 실행기(`scripts/run-node-tests.ts`)가 남아 있으면 그 안내는 그대로 두고, 지워졌으면 그 PR 이 정한 문장을 따른다.

## 검증

```bash
node --test scripts/tests/runtime-policy.spec.ts
python3 -m unittest discover -s scripts/tests
python3 skills/plan/scripts/check_adr_layout.py docs/adr --flat
bash export-only-skills/korean-check/scripts/check.sh docs/adr/*-script-runtime-typescript.md docs/adr/010-orch-typescript.md docs/adr/011-node-24-minimum.md docs/adr/INDEX.md docs/code-architecture.md README.md
```

- 첫 줄: phase-01 의 테스트가 그대로 통과한다(문서 변경이 정책 파일을 건드리지 않았다).
- 둘째 줄: `scripts/tests` 의 Python 테스트가 그대로 통과한다(문서 변경이 매니페스트와 스킬 문서 검사를 깨지 않았다). 루트 README 의 형식은 이 테스트가 보지 않으므로 넷째 줄의 한국어 검사와 diff 로 본다.
- 셋째 줄: ADR 상대 링크가 모두 풀리고 종료 코드 0. 저장소의 plan 검사기를 쓴다(PR7 전까지 Python 이다).
- 넷째 줄: 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `docs/adr/*-script-runtime-typescript.md` | 신규·수정 |
| `docs/adr/INDEX.md` | 수정 |
| `docs/adr/010-orch-typescript.md` | 수정 |
| `docs/adr/011-node-24-minimum.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `README.md` | 수정 |
