# Phase 01. 폴더를 옮기고 부르는 곳을 새 자리로 맞춘다

**Execution profile**: standard

## 목표

`tools/browser-driver/` 를 `skills/browser/browser-driver/` 로 이름만 바꿔 옮기고(`git mv`), 부르는 곳이 새 자리를 가리키게 한다. 구현은 아직 Python 이다.

**범위 외**: 명령 경계 테스트(phase-02), 구현 교체(phase-03).

## 컨텍스트

**요구사항**: REQ4, REQ5

**근거 문서**: `docs/features/node-runtime/design.md` 「browser-driver 를 browser 스킬 안으로 옮긴다」

- 첫 커밋은 내용을 고치지 않는 이동이다. git 이 이력을 잇는다. 이 커밋만으로는 부르는 쪽이 깨지고 다음 커밋과 함께 머지된다.
- 깨지는 곳(머지 전 `git grep -n 'tools/browser-driver'` 로 다시 확인한다):
  `driver/config.py` 의 설치 캐시 판정, `skills/browser/SKILL.md` 의 후보 경로와 README 링크, `show-preview.ts` 의 `findBundledDriver`, `check-deck.ts` 의 `findDriver`, 옛 `test_config_path.py` 의 `show-preview` 경로, `scripts/export-to-team.ts` 의 도구 원본 자리, `scripts/test-plugin-install.ts`, README 「링크로 설치」, `docs/code-architecture.md`, `runtime-policy.json` 의 pending 접두.
- 팀 사본의 자리는 `tools/browser-driver` 로 고정한다. 설치 캐시 판정과 드라이버 찾기는 두 배치(`skills/browser/browser-driver`, `tools/browser-driver`)를 모두 읽는다. 내보내기는 원본 후보를 새 자리, 옛 커밋 자리 순으로 읽는다(`scripts/export-lists.ts` 의 `toolSources`).

## 작업 항목

### 1. 이동 커밋
`git mv tools/browser-driver skills/browser/browser-driver`.

### 2. 팀 내보내기
`export-lists.ts` 에 원본 자리 후보, `export-to-team.ts` 가 그것으로 짝과 `--source-ref` 경로를 고른다.

### 3. 부르는 곳
위 목록의 파일들과 그 테스트: `scripts/tests/export-to-team.spec.ts`, `scripts/tests/exported-imports.spec.ts`, `skills/browser/tests/skill-doc.spec.ts`, `skills/presentation/tests/check-deck.spec.ts`, `skills/browser/browser-driver/tests/test_config_path.py`.

## 검증

```bash
node --test scripts/tests/export-to-team.spec.ts scripts/tests/exported-imports.spec.ts skills/browser/tests/skill-doc.spec.ts skills/presentation/tests/check-deck.spec.ts
python3 -m unittest discover -s skills/browser/browser-driver/tests
```

종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/browser/browser-driver/README.md` | 수정 |
| `skills/browser/browser-driver/driver/config.py` | 수정 |
| `skills/browser/browser-driver/tests/test_config_path.py` | 수정 |
| `scripts/tests/export-to-team.spec.ts` | 수정 |
| `scripts/tests/exported-imports.spec.ts` | 수정 |
| `skills/browser/tests/skill-doc.spec.ts` | 수정 |
| `skills/presentation/tests/check-deck.spec.ts` | 수정 |
| `scripts/export-lists.ts` | 수정 |
| `scripts/export-to-team.ts` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
| `skills/browser/SKILL.md` | 수정 |
| `export-only-skills/content-preview/scripts/show-preview.ts` | 수정 |
| `skills/presentation/scripts/check-deck.ts` | 수정 |
