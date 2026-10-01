# Phase 03. harness-cleanup 이 루트 배치 플러그인의 스킬 이름을 찾게 한다

**Execution profile**: standard

## 목표

`harness-cleanup/scripts/check_references.py` 가 설치된 스킬 이름을 모을 때, 스킬이 `skills/` 아래에 있지 않은 플러그인의 스킬도 찾게 한다.
플러그인 `fos-skills` 는 스킬을 루트에 두므로, 지금 코드로는 링크 설치를 지운 뒤 다른 저장소를 감사하면 `` `planning` 스킬 `` 같은 참조가 깨진 참조로 잡힌다.

**범위 외**: `check_references.py` 의 다른 검사 항목은 바꾸지 않는다. 매니페스트와 설치 시험은 phase 01 과 02 가 만들었다.

## 컨텍스트

`harness-cleanup/scripts/check_references.py` 의 `installed_skills()` 는 스킬 이름을 다섯 디렉터리와 감사 대상 저장소, 그리고 플러그인에서 모은다.
플러그인 부분은 지금 이렇게 되어 있다.

```python
    # 플러그인 스킬
    plug = pathlib.Path.home() / ".claude/plugins"
    if plug.is_dir():
        for p in plug.rglob("skills/*"):
            if p.is_dir():
                names.add(p.name)
```

`fos-skills` 를 설치하면 스킬은 `~/.claude/plugins/cache/fos-skills/fos-skills/<커밋 SHA 12자리>/planning/SKILL.md` 처럼 캐시 루트 바로 아래에 놓인다.
경로에 `skills/` 가 없어 위 코드가 이름을 모으지 못한다.

2026-10-01 에 재현했다. 임시 홈에 위 경로의 `SKILL.md` 를 만들고, `CLAUDE.md` 에 `` `planning` 스킬을 쓴다. `` 한 줄을 둔 저장소를 감사하면 `깨진 참조 1건` 과 `CLAUDE.md:3  [스킬] planning` 이 나오고 종료 코드 1 이다.

스킬 참조는 정규식 `SKILL_REF` 가 `` `이름` 스킬 `` 이나 `` `이름` skill `` 꼴에서 찾는다.
감사 대상 파일은 `harness-cleanup/scripts/target_files.py` 의 `iter_targets` 가 정한다. 저장소 루트의 `CLAUDE.md` 는 대상이다.

`harness-cleanup/tests/` 디렉터리는 아직 없다. 이 phase 가 만든다. 테스트는 `planning/tests/test_plan_number.py` 처럼 `unittest` 로 쓴다.

스킬을 고치면 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 디렉터리의 `CHANGELOG.md` 를 함께 고친다. 기준은 `README.md` 의 「버전과 변경 이력」 절이다. 지금 버전은 `3.14.1` 이다.

**근거 문서**: `docs/code-architecture.md` 의 「스킬 사이의 경로 참조」 절, `docs/adr/001-plugin-from-repo-root.md`

## 의도 메모

- `skills/*` 검색을 남기고 루트 배치용 검색을 덧붙이는 안은 기각했다. `SKILL.md` 를 가진 디렉터리를 찾는 한 가지 규칙이 두 배치를 모두 찾는다.
- 테스트는 스크립트를 하위 프로세스로 부른다. 스크립트가 import 할 때 `sys.argv` 를 읽으므로 모듈로 불러 쓰지 않는다.
- 하위 프로세스의 인터프리터는 `sys.executable` 로 준다. `HOME` 을 임시 디렉터리로 바꾼 채 `python3` 이라는 이름으로 부르면, mise shim 을 쓰는 머신에서 shim 이 인터프리터를 새로 내려받는다. 2026-10-01 에 실제로 겪었다.

## 작업 항목

### 1. `harness-cleanup/scripts/check_references.py` 의 `installed_skills()` 수정

플러그인 부분을 `~/.claude/plugins` 아래에서 `SKILL.md` 를 찾아 그 부모 디렉터리 이름을 모으는 것으로 바꾼다.

```python
    # 플러그인 스킬. 스킬을 skills/ 아래에 두지 않는 플러그인도 있어 SKILL.md 로 찾는다.
    plug = pathlib.Path.home() / ".claude/plugins"
    if plug.is_dir():
        for skill_file in plug.rglob("SKILL.md"):
            names.add(skill_file.parent.name)
```

함수의 나머지와 docstring 은 그대로 둔다.

### 2. `harness-cleanup/tests/test_check_references.py` 신규

테스트마다 임시 디렉터리 안에 `home/` 과 `repo/` 를 만든다.
스크립트는 `subprocess.run([sys.executable, <check_references.py 경로>, <repo 경로>], env={**os.environ, "HOME": <home 경로>})` 로 부른다.

| 테스트 | 준비 | 기대 결과 |
| --- | --- | --- |
| 루트 배치 플러그인의 스킬을 찾는다 | `home/.claude/plugins/cache/fos-skills/fos-skills/0123456789ab/planning/SKILL.md` 를 만든다. `repo/CLAUDE.md` 에 `` `planning` 스킬을 쓴다. `` 를 적는다 | 종료 코드 0, 표준 출력에 `깨진 참조 0건` |
| `skills/` 배치 플러그인의 스킬을 찾는다 | `home/.claude/plugins/cache/m/p/1.0.0/skills/brain-add/SKILL.md` 를 만든다. `repo/CLAUDE.md` 에 `` `brain-add` 스킬을 쓴다. `` 를 적는다 | 종료 코드 0 |
| 없는 스킬을 잡는다 | `home/.claude/plugins/` 를 빈 디렉터리로 만든다. `repo/CLAUDE.md` 에 `` `no-such-skill` 스킬을 쓴다. `` 를 적는다 | 종료 코드 1, 표준 출력에 `[스킬] no-such-skill` |

`repo/CLAUDE.md` 의 첫 줄은 `# 지침` 으로 두고 빈 줄 뒤에 위 문장을 적는다.

### 3. `harness-cleanup/SKILL.md` 와 `harness-cleanup/CHANGELOG.md` 의 버전

`harness-cleanup/SKILL.md` frontmatter 의 `version: "3.14.1"` 을 `version: "3.14.2"` 로 바꾼다. 지시가 아니라 검사 스크립트의 결함을 고친 것이라 patch 다.

`harness-cleanup/CHANGELOG.md` 의 `## 3.14.1` 위에 아래 절을 넣는다.

```markdown
## 3.14.2

`check_references.py` 가 플러그인 스킬 이름을 `SKILL.md` 를 가진 디렉터리에서 모은다.
스킬을 `skills/` 아래에 두지 않는 플러그인의 스킬이 깨진 참조로 잡혔다.
```

## 검증

```bash
# cwd: 저장소 루트
python3 -m unittest discover -s harness-cleanup/tests -v
grep -n 'version: "3.14.2"' harness-cleanup/SKILL.md
grep -n '^## 3.14.2$' harness-cleanup/CHANGELOG.md
section="$(mktemp -d)/section.md"
sed -n '/^## 3.14.2$/,/^## 3.14.1$/p' harness-cleanup/CHANGELOG.md | sed '$d' > "$section"
bash korean-check/scripts/check.sh "$section"
```

- `unittest` 는 세 테스트가 통과한다. 고치기 전 코드에서는 첫 번째 테스트가 종료 코드 1 로 실패한다.
- 두 `grep` 은 각각 한 줄을 찾는다.
- `korean-check` 는 새로 넣은 `3.14.2` 절만 검사하고 종료 코드 0 이다. `CHANGELOG.md` 의 옛 절 140, 150, 155, 169, 171행에 금지어 `좁히` 류 다섯 건이 이미 있어 파일 전체는 종료 코드 1 이다. 옛 절은 고치지 않는다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `harness-cleanup/scripts/check_references.py` | 수정 |
| `harness-cleanup/tests/test_check_references.py` | 신규 |
| `harness-cleanup/SKILL.md` | 수정 |
| `harness-cleanup/CHANGELOG.md` | 수정 |
