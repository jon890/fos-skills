# Phase 05. 참조 문서, 데이터 형식 문서, 변경 조각

**Execution profile**: standard

## 목표

코디네이터가 읽는 참조 문서와 데이터 형식 문서가 스스로 다시 뜨는 동작, 두 알림, 3번째 틱 알림, `bundle=` 값을 설명하고, 변경 조각이 첫 배포의 한 번 수동 재시작을 알린다.

**범위 외**: 코드 변경(phase 01-04). 코드 파일 맨 위 설명은 각 phase 가 이미 고쳤다.

## 컨텍스트

**요구사항**: REQ8

**근거 문서**: `docs/features/loop-self-update/spec.md` REQ8·DECISION15·DECISION16, `docs/features/loop-self-update/design.md` 「알림」·「상태 출력」·「실패와 일관성」 의 배포 순서

- `skills/orch/references/waiting.md` 32-33행이 바로 보내는 kind 와 모아 보내는 kind 의 표다. 46행이 LOOP-DEAD 와 LOOP-RESTARTED, 52행이 플러그인 갱신 뒤 사람이 stop·start 하라는 안내다.
- `skills/orch/SKILL.md` 50행이 doctor 의 `LOOP-STALE` 이면 다시 시작하라는 안내다.
- `docs/data-schema.md` 144행이 `state/loop.json` 의 키 목록, 161행이 `state/loop-runs/<Run>.json` 이다.
- 변경 조각의 자리와 꼴은 `README.md` 「버전과 변경 이력」(395행 부근)이다. `skills/orch/changes/<슬러그>.minor.md` 이고, 이 PR 의 슬러그는 `loop-self-update` 다.

## 의도 메모

- 루프 밖에서 직접 부른 스크립트의 `STALE-BUNDLE` 경고는 그대로다(스펙 DECISION16). 문서에서 그 경고를 없앤다고 쓰지 않는다.
- 숫자 상한(60분, 3번째 틱)은 동작 규칙의 값이라 문서에 둔다. 원본은 `loop/self-update.ts` 의 `STALE_WAIT_MAX_MS` 와 `lib/notice-digest.ts` 의 `STREAK_LIMIT` 이다.

## 작업 항목

### 1. `skills/orch/references/waiting.md`

- 32행 「바로」 줄에 `LOOP-UPDATED`, `LOOP-UPDATE-FAIL` 을 더한다.
- 같은 문단 근처의 연속 기준 설명을 「같은 이유의 WATCH-ERROR 가 연속 세 번째 틱이면 바로 한 번 보낸다. 부모의 틱 실패(`tick`)도 같고, 본문에 원인 줄이 든다」 로 고친다.
- 52행을 바꾼다. 상주 루프는 틱 사이에 옛 번들을 알아채면 이 저장소의 머지 큐·마무리가 끝날 때까지 최대 60분 기다린 뒤(틱이 설정 오류로 실패하면 바로) 새 설치본으로 다시 뜨고 `LOOP-UPDATED` 를 보낸다. 다시 뜨지 못하면 `LOOP-UPDATE-FAIL` 이 오고 옛 루프가 계속 돈다. 그때와 이 기능 전 번들로 뜬 루프는 그 Run 의 코디네이터 세션에서 `orch loop stop` 뒤 `orch loop start` 로 다시 띄운다. `orch loop status` 의 `bundle=` 로 버전을 확인한다.

### 2. `skills/orch/SKILL.md`

50행 안내를 「doctor·status 의 `LOOP-STALE` 은 루프가 스스로 다시 뜨기를 기다리는 중이거나 이 기능 전 번들의 루프다. `LOOP-UPDATE-FAIL` 을 받았거나 오래 남으면 다음 줄의 명령으로 다시 시작한다」 꼴로 고치고 `references/waiting.md` 를 가리킨다.

### 3. `docs/data-schema.md`

144행 `state/loop.json` 에 `bundle_version`(루프가 시작할 때 읽은 자기 번들의 `plugin.json` 버전, 읽지 못하면 null. 키가 없으면 이 기능 전 루프)을 더한다. 161행 `state/loop-runs/` 의 「새로 뜬 루프는 … 지운다」 문장에 「스스로 다시 뜬 루프(넘겨받기 모드)는 지우지 않는다」 를 더한다.

### 4. `skills/orch/changes/loop-self-update.minor.md`(신규)

README 「버전과 변경 이력」 의 조각 꼴로 쓴다. 담을 것: 옛 번들 루프가 스스로 다시 뜨는 조건과 두 알림, 3번째 틱 바로 알림, `bundle=` 값, 그리고 「이 버전 전에 띄운 루프는 한 번 `orch loop stop` 뒤 `orch loop start` 로 다시 띄운다」 한 문장.

### 5. 한국어 점검

고친 Markdown 마다 `node export-only-skills/korean-check/scripts/check.ts <파일>` 을 돌려 통과시킨다.

## 검증

```bash
node export-only-skills/korean-check/scripts/check.ts skills/orch/references/waiting.md skills/orch/SKILL.md docs/data-schema.md skills/orch/changes/loop-self-update.minor.md
node scripts/run-tests.ts skills/orch/tests/config-docs.spec.ts skills/orch/tests/orch-loop.spec.ts
orch slot heavy --exclusive -- node scripts/run-tests.ts
claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/references/waiting.md` | 수정 |
| `skills/orch/SKILL.md` | 수정 (50행 안내) |
| `docs/data-schema.md` | 수정 (`loop.json`, `loop-runs`) |
| `skills/orch/changes/loop-self-update.minor.md` | 신규 |
