# Phase 02. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

드라이버가 지키는 옵션, stdout, stderr, 종료 코드를 `node:test` 로 먼저 고정한다. 이 커밋에서 새 테스트는 옛 Python 진입을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체와 옛 Python 테스트 삭제(phase-03).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `skills/browser/browser-driver/tests/<주제>.spec.ts` 다. `tests/helpers.ts` 의 「명령 경계」 상수 한 곳만 구현을 가린다. phase-03 은 이 상수만 바꾼다.
- **실제 브라우저를 열지 않는다.** 백엔드는 `PATH` 맨 앞의 가짜 실행 파일(`ego-browser`, `orca`, `cmux`, `agent-browser`)과 임시 폴더, 임시 `HOME`, 임시 `CLAUDE_CONFIG_DIR`, `BROWSER_CONFIG` 로 한정한다.
- 옛 Python 테스트의 사례를 모두 명령 경계로 옮긴다. 내부 함수만 부르던 사례(공간 선택 스크립트, ego 스크립트의 표현식 감싸기)는 가짜 `ego-browser` 가 stdin 으로 받은 스크립트를 기록하게 하거나, 받은 스크립트를 가짜 page 에 대고 Node 로 돌려 관측한다.
- 설치 캐시 배치 사례는 임시 폴더에 드라이버 폴더를 복사해 `plugins/cache/m/p/1.0.0/skills/browser/browser-driver` 와 `.../tools/browser-driver` 두 자리에서 부른다.
- Python 과 JS 가 다른 곳을 경계 사례로 둔다: `float` 인자의 문자열 꼴(`50.0`), `str.isdigit` 이 받는 숫자, JSON 직렬화(`ensure_ascii=False`, 여백 있는 기본 구분자와 여백 없는 구분자), `--` 와 값 옵션, 거듭 준 옵션, 빈 `PATH`, 줄바꿈 처리(`splitlines`, `rstrip`), `shutil.which` 의 탐색 규칙.

## 작업 항목

### 1. `tests/helpers.ts`
임시 폴더, 가짜 실행 파일 폴더, 명령 실행, 「명령 경계」 상수.

### 2. 주제마다 명령 경계 테스트
`tests/input-and-output.spec.ts`(출력 분리, 인자, ego 스크립트, 마우스), `tests/ego-guidance.spec.ts`(진단 안내), `tests/ego-space.spec.ts`(공간), `tests/config-path.spec.ts`(설정 경로, 설치 캐시 배치, 미리보기의 경로 조회), `tests/backends.spec.ts`(orca, cmux, agent-browser, 도움말, install).

## 검증

```bash
node --test skills/browser/browser-driver/tests/*.spec.ts
python3 -m unittest discover -s skills/browser/browser-driver/tests
```

종료 코드 0. 새 테스트와 옛 Python 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/browser/browser-driver/tests/input-and-output.spec.ts` | 신규 |
| `skills/browser/browser-driver/tests/ego-guidance.spec.ts` | 신규 |
| `skills/browser/browser-driver/tests/ego-space.spec.ts` | 신규 |
| `skills/browser/browser-driver/tests/config-path.spec.ts` | 신규 |
| `skills/browser/browser-driver/tests/backends.spec.ts` | 신규 |
| `skills/browser/browser-driver/tests/helpers.ts` | 신규 |
