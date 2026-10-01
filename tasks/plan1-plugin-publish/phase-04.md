# Phase 04. planning 번들을 찾는 위치를 형제 디렉터리로 적는다

**Execution profile**: fast

## 목표

`build-with-teams` 와 `review-fix` 가 planning 의 스크립트를 부를 때 쓰는 `$PLANNING_SKILL_DIR` 의 값을 본문에 정한다.
플러그인으로 설치하면 `~/.claude/skills/planning` 링크가 없어, 지금 문구로는 planning 번들이 어디 있는지 본문만 읽고 알 수 없다.

**범위 외**: planning 의 스크립트와 `planning/references/monorepo.md` 는 고치지 않는다. 팀 저장소의 사본에 반영하는 일은 이 저장소 밖의 작업이다.

## 컨텍스트

스킬을 로드하면 본문 앞에 `Base directory for this skill` 줄이 붙는다. 값은 설치된 스킬 디렉터리다. 스킬 본문은 이 값을 `$SKILL_DIR` 로 부른다.
링크 설치에서도 플러그인 설치에서도 같은 방식으로 얻는다.

스킬 디렉터리는 어느 설치 방식에서나 서로 형제다.

| 설치 방식 | `build-with-teams` 의 위치 | `planning` 의 위치 |
| --- | --- | --- |
| 플러그인 | `~/.claude/plugins/cache/fos-skills/fos-skills/<커밋 SHA 12자리>/build-with-teams` | 같은 디렉터리의 `planning` |
| 링크 | `~/.claude/skills/build-with-teams` | `~/.claude/skills/planning` |
| 팀 저장소의 사본 | `<팀 저장소>/skills/build-with-teams` | `<팀 저장소>/skills/planning` |

그래서 `$PLANNING_SKILL_DIR` 은 `$SKILL_DIR/../planning` 이다.

지금 문구는 두 곳이다.

- `build-with-teams/SKILL.md` 174행: `` `$PLANNING_SKILL_DIR`은 하네스에서 찾은 planning 번들, `$PHASE_FILE`은 해당 phase 파일의 경로다. ``
- `review-fix/SKILL.md` 29행: `` `$PLANNING_SKILL_DIR` 은 planning 번들 경로이고, `$PR` 은 1단계에서 정한 PR 번호다. ``

`review-fix/SKILL.md` 는 `$SKILL_DIR` 을 다른 곳에서 쓰지 않는다. 그래서 그 문장 안에서 `$SKILL_DIR` 이 무엇인지도 함께 적는다.

스킬을 고치면 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 디렉터리의 `CHANGELOG.md` 를 함께 고친다. 기준은 `README.md` 의 「버전과 변경 이력」 절이다.
지금 버전은 `build-with-teams` 가 `5.11.0`, `review-fix` 가 `2.6.0` 이다.

두 스킬은 `scripts/export-to-team.sh` 가 팀 저장소로 내보내는 대상이다. 커밋하면 `hooks/post-commit` 이 팀 저장소의 사본과 어긋난다고 알린다. 알림은 정상이다.

**근거 문서**: `docs/code-architecture.md` 의 「스킬 사이의 경로 참조」 절

## 의도 메모

- `${CLAUDE_PLUGIN_ROOT}` 를 쓰는 안은 기각했다. 링크 설치와 팀 저장소의 사본에서는 값이 없다.
- `~/.claude/skills/planning` 을 적는 안은 기각했다. 플러그인 설치에서는 그 경로가 없다.
- 지시를 더하는 변경이라 두 스킬 모두 minor 를 올린다.
- 이 phase 는 문서만 바꾼다. 바꾼 문구가 가리키는 스크립트가 그 위치에 있는지는 「검증」 의 `test -f` 가 확인한다.

## 작업 항목

### 1. `build-with-teams/SKILL.md` 의 문구와 버전

174행을 아래 두 줄로 바꾼다.

```markdown
`$PLANNING_SKILL_DIR`은 planning 번들이고 이 스킬 번들의 형제 디렉터리다. 값은 `$SKILL_DIR/../planning` 이다.
`$PHASE_FILE`은 해당 phase 파일의 경로다.
```

frontmatter 의 `version: "5.11.0"` 을 `version: "5.12.0"` 으로 바꾼다.

### 2. `build-with-teams/CHANGELOG.md` 에 5.12.0 절 추가

`## 5.11.0` 위에 넣는다.

```markdown
## 5.12.0

`$PLANNING_SKILL_DIR` 의 값을 이 스킬 번들의 형제 디렉터리 `$SKILL_DIR/../planning` 으로 정했다.
플러그인으로 설치하면 `~/.claude/skills/planning` 이 없어 planning 번들의 위치를 본문만으로 알 수 없었다.
```

### 3. `review-fix/SKILL.md` 의 문구와 버전

29행을 아래 두 줄로 바꾼다.

```markdown
`$PLANNING_SKILL_DIR` 은 planning 번들이고 이 스킬 번들의 형제 디렉터리다. 이 스킬 번들 경로를 `$SKILL_DIR` 이라 하면 값은 `$SKILL_DIR/../planning` 이다.
`$PR` 은 1단계에서 정한 PR 번호다.
```

frontmatter 의 `version: "2.6.0"` 을 `version: "2.7.0"` 으로 바꾼다.

### 4. `review-fix/CHANGELOG.md` 에 2.7.0 절 추가

`## 2.6.0` 위에 넣는다.

```markdown
## 2.7.0

`$PLANNING_SKILL_DIR` 의 값을 이 스킬 번들의 형제 디렉터리 `$SKILL_DIR/../planning` 으로 정했다.
플러그인으로 설치하면 `~/.claude/skills/planning` 이 없어 planning 번들의 위치를 본문만으로 알 수 없었다.
```

### 5. 기존 테스트 `build-with-teams/tests/test_plan_precheck.py` 로 회귀 확인

이 테스트는 고치지 않는다. 문구를 바꾸면서 스킬의 스크립트를 건드리지 않았는지 실행해서 확인한다.

## 검증

```bash
# cwd: 저장소 루트
python3 -m unittest discover -s build-with-teams/tests
python3 -m unittest discover -s planning/tests
grep -c 'SKILL_DIR/../planning' build-with-teams/SKILL.md review-fix/SKILL.md
! grep -n '하네스에서 찾은 planning' build-with-teams/SKILL.md
test -f build-with-teams/../planning/scripts/verify_task.py
test -f review-fix/../planning/scripts/overlay_paths.py
grep -n 'version: "5.12.0"' build-with-teams/SKILL.md
grep -n 'version: "2.7.0"' review-fix/SKILL.md
bash korean-check/scripts/check.sh build-with-teams/SKILL.md build-with-teams/CHANGELOG.md review-fix/SKILL.md review-fix/CHANGELOG.md
```

- 두 `unittest` 는 모두 통과한다.
- `grep -c` 는 두 파일 모두 1 을 낸다.
- `! grep` 은 옛 문구가 남지 않았음을 본다.
- `korean-check` 는 종료 코드 0 이다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `build-with-teams/SKILL.md` | 수정 |
| `build-with-teams/CHANGELOG.md` | 수정 |
| `review-fix/SKILL.md` | 수정 |
| `review-fix/CHANGELOG.md` | 수정 |
