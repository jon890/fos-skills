# Phase 02. 공용 orch 스킬에서 한 저장소의 고유 내용을 뺀다

**Execution profile**: standard

## 목표

공개 플러그인인 orch 스킬 문서와 테스트에서 특정 저장소의 명령 이름, CI job 이름, 배포 스크립트, 저장소 이름을 뺀다.
그 값이 들어갈 자리를 저장소 오버레이 항목으로 만든다.

**범위 외**: `orch/scripts/heavy-slot.py` 의 `classify` 정규식. 코드라 TypeScript 전환에서 `config.json` 의 `heavy` 절로 옮긴다. `orch/CHANGELOG.md` 의 지난 항목은 이력이라 고치지 않는다.

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다.

`orch/references/gersang-overlay.md` 는 한 저장소의 로컬 명령 교체 예시다. 그 파일이 대신한다던 로컬 스크립트는 이미 없고(문서의 「로컬 스크립트를 대신할 다섯 명령」 절이 낡았다), pnpm, vitest, CI job 이름 같은 비공개 저장소 값을 담는다.
`orch/tests/test_gersang_overlay.py` 는 그 문서의 명령 예시를 검사한다.
`orch/references/cleanup.md` 는 두 곳에서 저장소 이름으로 그 문서를 가리킨다(「같은 파일을 고친 PR」 절의 `--update-docs-on-overlap` 설명, 「머지 뒤 명령」 절 끝).

**근거 문서**: `docs/code-architecture.md` 의 「orch 문서가 소유하는 것」 표 아래 문장(한 저장소의 명령 이름, CI job 이름, 배포 스크립트는 공용 스킬에 두지 않는다)

## 의도 메모

- 지운 문서의 내용 가운데 일반 규칙(검증 명령을 오버레이에 둔다, 배포는 `--after-merged` 로 건다)은 이미 `overlay.md` 와 `cleanup.md` 가 가진다. 옮길 것이 있는지 확인하고, 있으면 일반 이름으로 옮긴다.
- 예시가 필요하면 `example.com`, `PROJ-123`, `./bin/deploy.sh` 처럼 일반 이름을 쓴다.

## 작업 항목

### 1. `orch/references/gersang-overlay.md` 와 `orch/tests/test_gersang_overlay.py` 를 지운다

지우기 전에 `git grep -n "gersang-overlay"` 로 가리키는 곳을 모두 찾아 함께 고친다.

### 2. `orch/references/cleanup.md` 의 저장소 이름 두 곳을 일반 문장으로 바꾼다

- `--update-docs-on-overlap` 설명: 「문서 겹침에서 큐가 멈추던 저장소의 오버레이에서 켠다」
- 「머지 뒤 명령」 절 끝의 포인터 줄: 지운다. 저장소의 검증과 배포 명령은 그 저장소의 오버레이가 소유한다는 한 줄로 바꾼다

### 3. `orch/references/overlay.md` 「적을 것」 표에 두 항목을 더한다

| 항목 | 담는 것 | 쓰는 단계 |
| --- | --- | --- |
| 무거운 검사 분류 | 같은 PC 에서 혼자 돌아야 하는 전체 검사와 브라우저 검사 명령, 대기열을 거치지 않아도 되는 가벼운 명령 | 6 |
| 문서 PR 의 CI | 문서만 바꾼 PR 이 CI 를 생략하는지, 그때 머지 큐에 줄 `--docs-glob` | 7 |

### 4. 테스트 목록에서 빠진 테스트가 없는지 본다

`scripts/run-orch-tests.py` 는 `orch/tests/` 를 훑으므로 고칠 것이 없다. 지운 테스트 이름을 적은 다른 파일이 있는지 `git grep -n "test_gersang_overlay"` 로 확인한다.

## 검증

```bash
python3 scripts/run-orch-tests.py --jobs 4
python3 -m unittest discover -s scripts/tests
python3 korean-check/scripts/korean-style-check.py orch/references/cleanup.md orch/references/overlay.md
! git grep -n -i "gersang" -- orch/references orch/SKILL.md orch/templates orch/tests
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/references/gersang-overlay.md` | 삭제 |
| `orch/tests/test_gersang_overlay.py` | 삭제 |
| `orch/references/cleanup.md` | 수정 |
| `orch/references/overlay.md` | 수정 |
