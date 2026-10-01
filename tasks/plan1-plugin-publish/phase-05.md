# Phase 05. README 의 설치와 버전 설명을 플러그인 기준으로 고친다

**Execution profile**: standard

## 목표

`README.md` 가 플러그인 설치를 기본 설치 방법으로 안내하게 한다.
지금 README 는 링크 설치만 적고, 버전 절은 소비 방식이 링크라는 전제로 쓰여 있다.

**범위 외**: 스킬 디렉터리의 `README.md` 는 고치지 않는다. `korean-check/README.md` 가 적은 훅과 규칙 링크는 플러그인 설치 뒤에도 그대로 쓴다. `docs/` 는 이미 플러그인 구조를 적고 있어 고치지 않는다.

## 컨텍스트

phase 01 이 매니페스트를, phase 02 가 `scripts/test-plugin-install.sh` 를 만들었다.
마켓플레이스와 플러그인의 이름은 모두 `fos-skills` 다. GitHub 저장소는 `jon890/fos-skills` 이고 공개 상태다.

`plugin.json` 에 `version` 이 없어 커밋 SHA 가 버전이다. main 에 머지한 커밋마다 설치한 쪽이 `claude plugin update fos-skills@fos-skills` 로 받는다.
스킬마다 두는 `metadata.version` 과 `CHANGELOG.md` 는 변경 추적용으로 그대로 둔다.

설치, 갱신, 고치는 동안의 확인, 링크 설치에서 옮기는 순서는 `docs/flow.md` 가 소유한다. README 는 명령만 적고 순서와 분기는 그 문서를 가리킨다.

`README.md` 에서 고칠 곳은 넷이다.

- 5행: `워크플로 개선은 여기 한 곳만 고치면 심링크로 연결된 전 프로젝트에 반영된다.`
- 「공용 도구」 절의 스크립트 표
- 「설치」 절 전체
- 「버전과 변경 이력」 절의 `**이 버전은 배포 핀이 아니다.**` 로 시작하는 세 줄과, 절 끝의 git 태그 항목

**근거 문서**: `docs/flow.md` 의 「설치」, 「갱신」, 「고치는 동안의 확인」, 「링크 설치에서 옮기기」 절, `docs/code-architecture.md` 의 「매니페스트」 절, `docs/adr/002-plugin-version-is-commit-sha.md`

## 의도 메모

- 링크 설치를 README 에서 지우는 안은 기각했다. 플러그인 시스템이 없는 에이전트와 팀 저장소의 사본은 링크로 쓴다.
- 옮기는 순서를 README 에 다시 적지 않는다. 같은 내용을 두 문서에 두면 한쪽이 먼저 낡는다.
- 한국어 문서다. 평서체로 쓰고 한 문장마다 줄을 나눈다.

## 작업 항목

### 1. `README.md` 5행

아래 한 줄로 바꾼다.

```markdown
워크플로 개선은 여기 한 곳만 고쳐 main 에 머지하면, 플러그인을 설치한 모든 프로젝트가 갱신으로 받는다.
```

### 2. `README.md` 의 스크립트 표에 한 줄 추가

`scripts/install-hooks.sh` 줄 아래에 넣는다.

```markdown
| `scripts/test-plugin-install.sh` | 격리된 설정 폴더에서 플러그인 설치를 시험한다 |
```

### 3. `README.md` 의 「설치」 절

절 전체를 아래 내용으로 바꾼다. 코드 블록 안의 명령은 글자 그대로 쓴다.

- 첫 문단: Claude Code 플러그인으로 설치한다고 적고 아래 명령을 둔다.

  ```bash
  claude plugin marketplace add jon890/fos-skills
  claude plugin install fos-skills@fos-skills
  ```

- 스킬이 `fos-skills:planning` 처럼 접두사가 붙어 불린다고 한 줄로 적는다.
- 「갱신」 소절: 버전을 올리지 않아도 main 의 새 커밋을 받는다고 적고 아래 명령을 둔다.

  ```bash
  claude plugin update fos-skills@fos-skills
  ```

- 「고치는 동안」 소절: 설치본은 main 에 push 한 뒤에만 바뀌므로 작업 트리를 그 세션에만 로드한다고 적고 아래 명령을 둔다. 판정 방법은 `docs/flow.md` 의 「고치는 동안의 확인」 을 링크한다.

  ```bash
  claude --plugin-dir "$(git rev-parse --show-toplevel)"
  ```

- 「스킬을 더할 때」 소절: 고칠 곳 셋을 목록으로 적는다. `.claude-plugin/plugin.json` 의 `skills` 배열, 이 README 의 스킬 목록 표, 팀에도 내보낼 스킬이면 `scripts/export-to-team.sh` 의 `SHARED_SKILLS` 다. 배열을 빠뜨리면 `python3 -m unittest discover -s scripts/tests` 가 실패한다고 적는다.
- 「링크로 설치」 소절: 플러그인 시스템이 없는 에이전트에서 쓰는 대안이라고 적고 기존 `ln -sfn ~/personal/fos-skills/planning ~/.claude/skills/planning` 예시를 둔다. 플러그인과 같은 이름의 링크를 함께 두면 스킬이 둘씩 뜬다고 적는다. 링크에서 플러그인으로 옮기는 순서는 `docs/flow.md` 의 「링크 설치에서 옮기기」 를 링크한다.
- 공용 도구 `browser-driver` 링크 안내와 명령은 지금 문구 그대로 절 끝에 둔다.

### 4. `README.md` 의 「버전과 변경 이력」 절

`**이 버전은 배포 핀이 아니다.**` 로 시작하는 세 줄을 아래로 바꾼다.

```markdown
**이 버전은 배포 핀이 아니다.** 플러그인에는 버전을 쓰지 않아 커밋 SHA 가 버전이 되고, 설치한 쪽은 main 의 새 커밋을 갱신으로 받는다.
스킬 버전의 목적은 무엇이 언제 왜 바뀌었는지 추적하는 것뿐이다.
이 점을 잊으면 태그와 릴리스까지 붙는 과설계로 간다. 근거는 [ADR-002](docs/adr/002-plugin-version-is-commit-sha.md) 가 소유한다.
```

절 끝의 git 태그 항목을 아래로 바꾼다.

```markdown
- git 태그는 만들지 않는다. 설치한 쪽이 main 의 커밋을 받으므로 태그가 아무것도 고정하지 못한다.
```

### 5. 기존 시험 `scripts/tests/test_plugin_manifest.py` 로 README 가 적은 명령 확인

이 테스트는 고치지 않는다. README 의 「스킬을 더할 때」 가 안내하는 명령이 실제로 돌고 통과하는지 실행해서 확인한다.

## 검증

```bash
# cwd: 저장소 루트
python3 -m unittest discover -s scripts/tests
bash korean-check/scripts/check.sh README.md
grep -n 'claude plugin marketplace add jon890/fos-skills' README.md
grep -n 'claude plugin install fos-skills@fos-skills' README.md
grep -n 'claude plugin update fos-skills@fos-skills' README.md
grep -n 'claude --plugin-dir' README.md
grep -n 'docs/flow.md' README.md
grep -n 'scripts/test-plugin-install.sh' README.md
! grep -n '심링크로 연결된 전 프로젝트' README.md
! grep -n '소비 방식이 심링크라' README.md
test -f docs/flow.md
test -f docs/adr/002-plugin-version-is-commit-sha.md
```

- `unittest` 는 통과한다.
- `korean-check` 는 종료 코드 0 이다.
- `grep -n` 은 각각 한 줄 이상을 찾는다. `! grep` 두 줄은 옛 문구가 남지 않았음을 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `README.md` | 수정 |
