# Phase 03. 지시서 문구 예시와 버전

**Execution profile**: standard

## 목표

코디네이터가 지시서 공통 규칙에 넣을 마이그레이션 문구 예시와, 막힘 알림을 받았을 때 할 일을 orch 스킬 문서에 적고 버전을 4.5.0 으로 올린다.

**범위 외**: 코드(phase 01, 02). 저장소 `docs/`(planning 이 갱신했다).

## 컨텍스트

- 지시서 형식은 `orch/references/spec-writing.md` 의 「넣을 것」 이다. 앞 PR 이 그 절에 `- 머지 보류: <이유>` 항목을 더했다.
- 루프 알림 대응은 `orch/references/waiting.md` 의 종료 코드 7 목록이다. 앞 PR 이 `MIGRATION-BLOCKED` 항목을 두었다.
- 오버레이의 마이그레이션 순서 칸은 `orch/references/overlay.md` 「적을 것」 표의 `마이그레이션 순서` 행이다.
- 명령의 옵션과 출력, 종료 코드는 `orch/scripts/reserve-migration.ts` 머리 주석이 소유한다. 스킬 문서는 옮겨 적지 않는다.
- 버전과 CHANGELOG 형식은 저장소 `README.md` 의 「버전과 변경 이력」, 검사는 `scripts/check-skill-docs.py` 다.

**근거 문서**: `docs/adr/017-orch-migration-reserve.md`, `docs/flow.md` 의 「마이그레이션 번호 예약」.

## 작업 항목

### 1. `orch/references/spec-writing.md`

「넣을 것」 에 항목 하나와 문구 예시를 더한다. DB 마이그레이션을 더할 수 있는 지시서에는 아래 문구를 공통 규칙으로 넣는다.

```markdown
- Flyway 마이그레이션 파일 이름은 직접 정하지 않는다. 만들기 전에 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/reserve-migration.ts" --repo <저장소> --module <모듈> --name <영문 설명>` 을 자기 worktree 에서 부르고, `RESERVED` 줄의 경로로 만든다. 줄 끝이 `renewed` 면 이미 만든 파일의 이름을 그 경로로 바꾼다.
- `RESERVED` 줄이 없으면 파일을 만들지 않는다. 종료 코드 4(잠금)면 다시 부르고, 1 이나 2 면 그 줄을 붙여 ask 로 묻는다.
- out-of-order 를 켜지 않는다. 코디네이터가 이 PR 이 막는 쪽이라고 알리면 `--again` 으로 새 번호를 받아 파일 이름을 바꾼다.
```

`$SKILL_DIR` 은 코디네이터가 지시서에 절대경로로 바꿔 넣는다고 한 줄 적는다.

### 2. `orch/references/waiting.md`

종료 코드 7 목록의 `MIGRATION-BLOCKED` 항목을 고친다. 막는 쪽이 PR 이거나 PR 없는 예약일 수 있다고 적고, 할 일은 막는 쪽 worker 에게 `reserve-migration.ts --again` 으로 다시 받게 하는 것이다. 막는 쪽 브랜치를 버렸으면 그 브랜치를 지운 뒤 `reserve-migration.ts --repo <저장소> --prune` 을 부른다. 다음 틱에 막힘이 풀린다. 알림은 한 번만 오므로 기다리는 PR 은 그 뒤 알림 없이 기다린다.

### 3. `orch/references/overlay.md`

「적을 것」 표의 `마이그레이션 순서` 행 설명 끝에 「번호는 `reserve-migration.ts` 로 예약한다(`migrations.dirs` 가 있어야 한다)」 를 더한다.

### 4. `orch/SKILL.md` 와 `orch/CHANGELOG.md`

- `SKILL.md` frontmatter `metadata.version` 을 `"4.5.0"` 으로 올린다.
- `CHANGELOG.md` 에 `## 4.5.0 (2026-10-27)` 을 4.4.0 위에 더한다. 항목: `reserve-migration.ts`(다음 번호를 잠금을 걸고 예약, 같은 인자는 같은 예약, `--again`, 머지되거나 사라진 브랜치의 예약 정리), 자동 머지가 PR 없는 예약을 낮은 번호로 보고 막힘 알림에 재예약을 안내, 지시서 문구 예시.

## 검증

```bash
python3 -m unittest discover -s scripts/tests
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
grep -n '"4.5.0"' orch/SKILL.md
grep -n '^## 4.5.0' orch/CHANGELOG.md
```

기대값: 앞의 둘은 종료 코드 0. grep 둘은 한 줄씩 나온다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/references/spec-writing.md` | 수정 |
| `orch/references/waiting.md` | 수정 |
| `orch/references/overlay.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
