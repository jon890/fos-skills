# Phase 03. 코디네이터 문서와 버전

**Execution profile**: standard

## 목표

코디네이터가 자동 머지를 켜고, 보류를 표시하고, 새 루프 알림에 대응하는 법을 orch 스킬 문서에 적고 버전을 4.4.0 으로 올린다.

**범위 외**: 코드(phase 01, 02). 저장소 `docs/`(planning 이 이미 갱신했다). 번호 예약 문서(다음 plan).

## 컨텍스트

- 루프 알림의 대응은 `orch/references/waiting.md` 의 종료 코드 7 목록(`REMINDER`, `CI-FAILED`, … `GAP`)이 소유한다.
- 머지 절차는 `orch/references/cleanup.md` 의 「머지」 가 소유한다. 표시(`PR!`, `PR~`) 표가 그 절에 있다.
- 지시서 형식은 `orch/references/spec-writing.md` 의 「넣을 것」 이다.
- 오버레이 예시는 `orch/references/overlay.md` 의 「예시」 다. 설정 키 표는 phase 01 이 더했다.
- 버전과 CHANGELOG 형식은 저장소 `README.md` 의 「버전과 변경 이력」, 항목 수와 줄 길이는 `scripts/check-skill-docs.py` 가 검사한다.
- 루프의 틱 목록은 `orch/references/waiting.md` 「상주 루프와 압축 뒤 복구」 의 목록이다.

**근거 문서**: `docs/adr/015-orch-auto-merge.md`, `docs/flow.md` 의 「상주 루프의 자동 머지」, `docs/data-schema.md` 의 「config.json 에 더하는 절」.

## 의도 메모

- 판정 조건과 알림 text 는 `orch-loop.ts` 머리 주석이 소유한다. 스킬 문서는 코디네이터가 할 일만 적고 조건을 옮겨 적지 않는다.
- 공개 저장소다. 예시의 모듈 이름, 명령, 경로는 중립 이름(`api`, `backup-db.sh`)을 쓴다.

## 작업 항목

### 1. `orch/references/waiting.md`

- 「상주 루프와 압축 뒤 복구」 의 틱 목록에 「`queue.auto_merge` 를 켠 저장소에서 머지할 수 있는 PR 을 머지 큐에 건다」 한 줄을 충돌 처리 앞에 더한다.
- 종료 코드 7 목록에 넷을 더한다.
  - `AUTO-MERGE`: 루프가 PR 들을 머지 큐에 걸었다. 그 PR 을 따로 다시 걸지 않는다
  - `AUTO-MERGE-END`: 루프가 건 큐가 끝났다. 끝 줄이 `QUEUE-DONE` 이 아니면 로그를 읽고 멈춘 이유를 처리한다. 같은 HEAD 는 루프가 다시 걸지 않으므로, 이유를 풀었으면 코디네이터가 직접 건다
  - `MIGRATION-CLASH`: 그 PR 의 마이그레이션 번호가 base 이하거나 다른 열린 PR 과 같다. 그 PR 의 worker 에게 번호를 다시 정하게 한다
  - `MIGRATION-BLOCKED`: 더 낮은 번호의 열린 PR 이 오래 막혀 있다. 막는 PR 의 번호를 뒤로 미룰지 정한다. 루프는 파일 이름을 바꾸지 않는다

### 2. `orch/references/cleanup.md` 「머지」

표시 표 앞에 짧은 문단을 더한다: `queue.auto_merge` 를 켠 저장소에서는 상주 루프가 머지할 수 있는 PR 을 스스로 건다(조건은 `orch-loop.ts` 머리 주석의 「자동 머지」). 코디네이터가 걸 일은 루프가 걸지 않은 PR(지시서 밖, 큐가 멈춘 같은 HEAD, 보류를 푼 PR)뿐이다.
루프에 걸지 말아야 할 PR 은 지시서에 `- 머지 보류: <이유>` 줄을 두거나 보드 항목에 끝나지 않은 `머지 보류: <이유>` 줄을 둔다. 풀 때 그 줄을 지우거나 끝낸다.

### 3. `orch/references/spec-writing.md` 「넣을 것」

다른 PR 의 배포 뒤에 머지할 PR 처럼 루프가 자동으로 머지하면 안 되는 지시서에는 `- 머지 보류: <이유>` 줄을 넣는다는 항목을 더한다.

### 4. `orch/references/overlay.md` 「예시」

예시 오버레이 끝에 자동 머지를 켠 저장소의 `config.json` 조각을 더한다.

```json
{
  "queue": { "auto_merge": true, "auto_review": { "pass": "머지 가능", "block": "반영 필요|반영 후 머지" } },
  "migrations": { "dirs": { "api": "modules/api/src/main/resources/db/migration" }, "before": { "*": ".orch/bin/backup-db.sh {module} \"pre-$PR\"" } }
}
```

### 5. `orch/SKILL.md` 와 `orch/CHANGELOG.md`

- `SKILL.md` frontmatter `metadata.version` 을 `"4.4.0"` 으로 올린다. 「7. 머지와 정리」 첫 문단 끝에 「`queue.auto_merge` 를 켠 저장소는 상주 루프가 머지할 수 있는 PR 을 스스로 건다(`references/cleanup.md` 의 「머지」)」 를 더한다.
- `CHANGELOG.md` 에 `## 4.4.0 (2026-10-27)` 을 4.3.0 위에 더한다. 항목: 자동 머지(`queue.auto_merge`)와 대상 조건 요약, `머지 보류:` 표시, 마이그레이션 검사(`migrations` 절, `MIGRATION-CLASH`, `MIGRATION-BLOCKED`), 새 알림 `AUTO-MERGE`, `AUTO-MERGE-END`.

## 검증

```bash
python3 -m unittest discover -s scripts/tests
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
grep -n '"4.4.0"' orch/SKILL.md
grep -n '^## 4.4.0' orch/CHANGELOG.md
```

기대값: 앞의 둘은 종료 코드 0(`scripts/tests` 가 README 와 CHANGELOG 형식을 검사한다). grep 둘은 한 줄씩 나온다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/references/waiting.md` | 수정 |
| `orch/references/cleanup.md` | 수정 |
| `orch/references/spec-writing.md` | 수정 |
| `orch/references/overlay.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
