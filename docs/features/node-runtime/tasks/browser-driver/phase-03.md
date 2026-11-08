# Phase 03. TypeScript 구현으로 바꾸기

**Execution profile**: standard

## 목표

`browser_driver.py` 와 `driver/` 패키지를 같은 옵션·stdout·stderr·종료 코드의 `.ts` 로 옮기고 옛 파일과 Python 테스트를 지운다. 옛 이름 진입을 `tools/browser-driver/browser_driver.py` 에 node shebang JS 로 둔다. 명령 경계 테스트는 `tests/helpers.ts` 의 상수만 바꿔 통과해야 한다.

**범위 외**: 문서 호출과 정책 파일, 이력(phase-04).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ5, REQ6

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 폴더 안의 배치는 그대로다: `browser_driver.ts`, `driver/*.ts`, `driver/backends/*.ts`, `tests/`, `README.md`. 폴더 밖을 import 하지 않는다(DECISION1). 필요한 Python 호환 helper 는 `driver/pylike.ts` 에 둔다.
- Python 과 JS 가 다른 곳은 처음부터 맞춘다. 직접 실행 판정은 `realpathSync` 비교(`import.meta.main` 은 24.2 부터), `\s` 는 Python 공백 집합, `str.splitlines`·`rstrip` 의 줄 경계, `float` 의 문자열 꼴, `json.dumps` 의 `ensure_ascii=False` 와 구분자, `shutil.which`, 링크를 먼저 따라간 뒤 `..` 처리하는 `Path.resolve`, 거듭 준 옵션은 값마다 검사하고 값 옵션 뒤의 `--` 는 값 누락, 입력 값의 타입 검증.
- ego 백엔드가 stdin 으로 넘기는 Node 스크립트는 글자까지 그대로 낸다(`json.dumps` 의 꼴 포함).
- 옛 구현과 다른 곳은 `install` 한 곳이다. 옛 구현은 링크가 `driver/admin.py` 를 가리키고 예시 설정 경로가 `driver/` 아래였다(README 의 「진입점을 연결한다」 와 어긋난 버그). 새 구현은 링크를 진입 `browser_driver.ts` 로, 예시 경로를 폴더의 `browser.config.example.json` 으로 낸다. PR 본문 「결정」 에 적는다.
- 옛 이름 진입은 `fs.realpathSync(__filename)` 기준이 아니라 저장소 상대(`../../skills/browser/browser-driver/browser_driver.ts`)로 새 `.ts` 를 `import()` 한다. Node 가 `MIN_NODE` 보다 낮으면 건너뛰었다는 한 줄을 stderr 에 내고 127 로 끝낸다. 정상이면 stdout 과 종료 코드는 새 명령과 같고 stderr 에 새 명령 안내가 있다.

## 작업 항목

### 1. 공용 모듈
`driver/errors.ts`, `args.ts`, `pylike.ts`, `shell.ts`, `config.ts`, `commands.ts`, `admin.ts`.

### 2. 백엔드
`driver/backends/{index,base,ego,orca,cmux,agent_browser}.ts`.

### 3. 진입
`browser_driver.ts`(`main` export, 직접 실행일 때만 돈다), `tools/browser-driver/browser_driver.py`(옛 이름 진입).

### 4. 테스트 전환
`tests/helpers.ts` 의 상수를 `.ts` 로 바꾸고 옛 `.py`, `test_*.py` 를 지운다. 옛 이름 진입은 `tests/legacy-entry.spec.ts` 가 본다. `tsconfig.json` 의 `include` 에 `skills/browser/browser-driver/**/*.ts` 를 더한다(테스트 제외).

## 검증

```bash
node --test skills/browser/browser-driver/tests/*.spec.ts
node scripts/run-tests.ts
```

종료 코드 0. 명령 경계 테스트는 phase-02 에서 상수만 바뀌었다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/browser/browser-driver/browser_driver.ts` | 신규 |
| `skills/browser/browser-driver/driver/*.ts` | 신규 |
| `skills/browser/browser-driver/driver/backends/*.ts` | 신규 |
| `tools/browser-driver/browser_driver.py` | 신규 |
| `skills/browser/browser-driver/browser_driver.py` | 삭제 |
| `skills/browser/browser-driver/driver/**/*.py` | 삭제 |
| `skills/browser/browser-driver/tests/test_*.py` | 삭제 |
| `skills/browser/browser-driver/tests/helpers.ts` | 수정 |
| `skills/browser/browser-driver/tests/legacy-entry.spec.ts` | 신규 |
| `tsconfig.json` | 수정 |
