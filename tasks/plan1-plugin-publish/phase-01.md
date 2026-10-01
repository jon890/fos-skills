# Phase 01. 플러그인 매니페스트와 매니페스트 시험

**Execution profile**: standard

## 목표

저장소 루트를 Claude Code 플러그인 `fos-skills` 로 설치할 수 있게 매니페스트 둘을 추가한다.
스킬을 더하고 매니페스트를 고치지 않은 변경을 잡는 시험을 함께 둔다.

**범위 외**: 설치 시험 스크립트는 phase 02 가 만든다. README 는 phase 05 가 고친다. 스킬 디렉터리는 옮기지 않는다.

## 컨텍스트

스킬 일곱 개가 저장소 루트에 디렉터리로 있다. 각 디렉터리에 `SKILL.md` 가 있다.
`build-with-teams`, `content-preview`, `docs-check`, `harness-cleanup`, `korean-check`, `planning`, `review-fix` 다.

스킬을 `skills/` 로 옮기지 않고 `plugin.json` 의 `skills` 배열에 경로를 적는다.
Claude Code 2.1.286 에서 이 배치로 일곱 스킬이 인식되는 것을 확인했다.

`plugin.json` 에 `version` 을 쓰지 않는다. 쓰지 않으면 커밋 SHA 가 버전이 된다.
그래서 `claude plugin validate` 는 버전 경고 하나를 내고 종료 코드 0 으로 끝난다. `--strict` 는 그 경고로 실패하므로 쓰지 않는다.

이 저장소의 테스트는 `unittest` 로 쓴다. `planning/tests/test_plan_number.py` 가 따를 예다.
`scripts/tests/` 디렉터리는 아직 없다. 이 phase 가 만든다.

**근거 문서**: `docs/code-architecture.md` 의 「매니페스트」 와 「검증」 절, `docs/adr/001-plugin-from-repo-root.md`, `docs/adr/002-plugin-version-is-commit-sha.md`

## 의도 메모

- 스킬을 `skills/` 로 옮기는 안은 기각했다. 내보내기 스크립트, git 훅, 개인 링크가 루트 배치에 기대고 있다.
- `version` 을 두는 안은 기각했다. 이 phase 에서 `version` 을 넣으면 시험이 실패해야 한다.
- 마켓플레이스 항목에도 `version` 을 쓰지 않는다.
- `license` 는 적지 않는다. 저장소에 라이선스 파일이 없다.

## Blocked 조건

- `claude` 명령이 없다 → `PHASE_BLOCKED: claude CLI 없음` 출력 후 종료

## 작업 항목

### 1. `.claude-plugin/marketplace.json` 신규

`docs/code-architecture.md` 의 「매니페스트」 절에 있는 첫 번째 JSON 을 글자 그대로 쓴다.
`name` 은 `fos-skills`, `owner.name` 은 `jon890`, `plugins` 는 항목 하나이고 `name` 은 `fos-skills`, `source` 는 `./` 다.

### 2. `.claude-plugin/plugin.json` 신규

같은 절의 두 번째 JSON 을 글자 그대로 쓴다.
`skills` 배열은 `./build-with-teams` 부터 `./review-fix` 까지 일곱 항목을 이름순으로 둔다. `version` 키는 없다.

### 3. `scripts/tests/test_plugin_manifest.py` 신규

저장소 루트는 `Path(__file__).resolve().parents[2]` 로 얻는다.
비교 함수 `skill_diff(array, root)` 를 테스트 파일 안에 둔다.
`root` 바로 아래에서 `SKILL.md` 를 가진 디렉터리 이름에 `./` 를 붙인 집합과 `array` 를 비교해 `(빠진 것, 남는 것)` 을 정렬된 리스트 둘로 돌려준다.

테스트는 다음을 확인한다.

| 테스트 | 입력 | 기대 결과 |
| --- | --- | --- |
| 배열과 디렉터리가 같다 | 실제 `plugin.json` 과 저장소 루트 | `skill_diff` 가 `([], [])` 이다 |
| 배열이 이름순이다 | 실제 `plugin.json` | `skills == sorted(skills)` |
| 빠진 스킬을 잡는다 | 임시 디렉터리에 `a/SKILL.md`, `b/SKILL.md` 를 만들고 배열 `["./a"]` 를 준다 | 빠진 것이 `["./b"]`, 남는 것이 `[]` 다 |
| 없는 스킬을 잡는다 | 같은 임시 디렉터리에 배열 `["./a", "./b", "./c"]` 를 준다 | 빠진 것이 `[]`, 남는 것이 `["./c"]` 다 |
| 버전이 없다 | 두 매니페스트 | `plugin.json`, `marketplace.json`, `marketplace.json` 의 `plugins[0]` 어디에도 `version` 키가 없다 |
| 이름과 소스가 맞다 | 두 매니페스트 | 마켓플레이스 `name`, `plugins[0].name`, `plugin.json` 의 `name` 이 모두 `fos-skills` 이고 `plugins[0].source` 가 `./` 다 |
| 작성자가 있다 | `plugin.json` | `author.name` 이 빈 문자열이 아니다 |

`SKILL.md` 가 없는 `tools`, `scripts`, `hooks`, `docs`, `tasks` 는 스킬로 세지 않는다. 루트 바로 아래 한 단만 본다.

## 검증

```bash
# cwd: 저장소 루트
python3 -m unittest discover -s scripts/tests -v
python3 -m json.tool .claude-plugin/marketplace.json >/dev/null
python3 -m json.tool .claude-plugin/plugin.json >/dev/null
claude plugin validate . --json | python3 -c '
import json, sys
report = json.load(sys.stdin)
manifest = report["manifest"]
paths = [warning["path"] for warning in manifest["warnings"]]
assert report["success"] is True, report
assert manifest["errors"] == [], manifest["errors"]
assert paths == ["plugins[0] plugin.json → version"], paths
'
bash scripts/export-to-team.sh || test $? -ne 2
```

- `unittest` 는 일곱 테스트가 모두 통과한다.
- `validate` 는 오류가 없고 경고가 버전 경고 하나뿐이다.
- 마지막 줄은 내보내기 스크립트가 이 변경 뒤에도 실행되는지를 본다. 종료 코드 0 은 사본이 같다는 뜻이고 1 은 이미 있던 어긋남이고 3 은 팀 쪽 버전이 더 높다는 뜻이다. 2 는 실행 오류라 실패로 본다. `|| test` 로 이어 종료 코드 1 과 3 에서도 이 줄을 통과시킨다. 팀 저장소가 없는 머신에서는 0 으로 끝난다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `.claude-plugin/marketplace.json` | 신규 |
| `.claude-plugin/plugin.json` | 신규 |
| `scripts/tests/test_plugin_manifest.py` | 신규 |
