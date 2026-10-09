# 코드 구조

이 저장소는 스킬을 두 가지 방식으로 제공한다.
하나는 저장소를 Claude Code 플러그인 `fos-skills` 로 설치하는 것이고, 다른 하나는 스킬 디렉터리를 `~/.claude/skills/<이름>` 에 심볼릭 링크로 거는 것이다.
이 문서는 플러그인 배포의 구조를 소유한다. 스킬 각각의 절차는 그 스킬의 `SKILL.md` 가 소유한다.

## 범위

| 구분 | 대상 |
| --- | --- |
| 플러그인에 담는다 | `build-with-teams`, `docs-check`, `harness-cleanup`, `planning`, `pr-review`, `review-fix` |
| 내보내기 전용 원본으로 함께 복사한다 | `content-preview`, `korean-check`. 스킬 목록에는 등록하지 않는다 |
| 플러그인과 함께 복사되지만 스킬이 아니다 | `tools/browser-driver`, `scripts/`, `hooks/`, `docs/` |
| 플러그인이 설치하지 않는다 | `PostToolUse` 훅, `~/.claude/rules/` 의 규칙 파일, `~/.claude/scripts/` 의 링크 |

플러그인은 통째로 설치된다. 스킬을 골라 설치하는 방법은 두지 않는다.

## 디렉터리 배치

```
.claude-plugin/marketplace.json     마켓플레이스 목록. 플러그인 하나를 소스 "./" 로 가리킨다
.claude-plugin/plugin.json          플러그인 이름과 skills 배열. version 은 쓰지 않는다
build-with-teams/                   스킬. 루트에 그대로 둔다
content-preview/
docs-check/
harness-cleanup/
korean-check/
planning/
pr-review/
review-fix/
tools/browser-driver/               content-preview 가 쓰는 공용 도구
scripts/export-to-team.sh           공용 스킬을 팀 저장소로 내보낸다
scripts/install-hooks.sh            hooks/ 의 git 훅을 건다
scripts/test-plugin-install.sh      격리된 설정 폴더에서 설치를 테스트한다
scripts/tests/test_plugin_manifest.py   매니페스트와 루트의 스킬 디렉터리를 대조한다
hooks/post-commit                   git 훅. Claude Code 훅이 아니다
```

스킬을 `skills/` 아래로 옮기지 않은 근거는 [ADR-001](adr/001-plugin-from-repo-root.md) 이 소유한다.

## 매니페스트

`.claude-plugin/marketplace.json` 은 다음과 같다.

```json
{
  "name": "fos-skills",
  "description": "여러 저장소가 함께 쓰는 Claude Code 워크플로 스킬 모음",
  "owner": { "name": "jon890" },
  "plugins": [
    {
      "name": "fos-skills",
      "source": "./",
      "description": "계획, 구현, 리뷰 작성, 리뷰 반영, 문서 감사, 하네스 정리 스킬"
    }
  ]
}
```

`.claude-plugin/plugin.json` 은 다음과 같다.

```json
{
  "name": "fos-skills",
  "description": "계획, 구현, 리뷰 작성, 리뷰 반영, 문서 감사, 하네스 정리 스킬",
  "author": { "name": "jon890" },
  "homepage": "https://github.com/jon890/fos-skills",
  "repository": "https://github.com/jon890/fos-skills",
  "skills": [
    "./build-with-teams",
    "./docs-check",
    "./harness-cleanup",
    "./planning",
    "./pr-review",
    "./review-fix"
  ]
}
```

`skills` 배열은 이름순으로 둔다. 스킬을 더하거나 이름을 바꾸면 이 배열을 함께 고친다.
[`../scripts/export-only-skills.json`](../scripts/export-only-skills.json) 에 명시한 내보내기 전용 원본만 배열에서 제외한다.
`version` 을 쓰지 않는 근거는 [ADR-002](adr/002-plugin-version-is-commit-sha.md) 가 소유한다.

## 모듈 책임

| 경로 | 책임 | 읽거나 부르는 쪽 |
| --- | --- | --- |
| `.claude-plugin/marketplace.json` | 마켓플레이스 이름과 플러그인 소스 | `claude plugin marketplace add` |
| `.claude-plugin/plugin.json` | 플러그인 이름과 담을 스킬의 경로 | `claude plugin install`, 세션 시작 |
| `<스킬>/SKILL.md` | 그 스킬의 절차. 자기 스크립트를 `$SKILL_DIR` 로 부른다 | Claude |
| `tools/browser-driver/` | 브라우저 백엔드 중립 계층 | `content-preview/scripts/show-preview.sh` |
| `scripts/tests/test_plugin_manifest.py` | 내보내기 전용 원본을 제외한 루트 스킬 디렉터리 집합이 `skills` 배열과 같은지, `version` 이 없는지 확인한다 | 사람, 구현 검증 |
| `scripts/test-plugin-install.sh` | 격리된 `CLAUDE_CONFIG_DIR` 에 설치해 스킬 인식과 캐시 안의 경로 참조를 확인한다 | 사람, 구현 검증 |
| `scripts/export-to-team.sh` | 공용 스킬을 팀 저장소로 내보낸다. 플러그인 배포와 무관하게 그대로 동작한다 | 사람, `hooks/post-commit` |

## 스킬 사이의 경로 참조

설치하면 저장소 루트가 `~/.claude/plugins/cache/fos-skills/fos-skills/<커밋 SHA 12자리>/` 로 복사된다.
스킬 디렉터리는 캐시 안에서도 서로 형제이고 `tools/` 도 같은 루트에 있다.

| 참조 | 플러그인 설치에서의 동작 |
| --- | --- |
| 스킬 본문의 `$SKILL_DIR` | 스킬을 로드할 때 붙는 `Base directory for this skill` 줄의 값이다. 캐시 안의 스킬 디렉터리를 가리킨다 |
| 스킬 문서의 `../korean-check/` 같은 형제 경로 | 캐시 안에서 그대로 풀린다 |
| `build-with-teams` 와 `review-fix` 의 `$PLANNING_SKILL_DIR` | 자기 번들의 형제 디렉터리 `planning` 이다. 값은 `$SKILL_DIR/../planning` 이다 |
| `content-preview/scripts/style-check.sh` 가 `korean-check` 를 찾는 순서 | `KOREAN_CHECK` 환경 변수, 형제 디렉터리, `~/.claude/skills/korean-check` 순이다. 캐시에서는 형제 디렉터리에서 찾는다 |
| `content-preview/scripts/show-preview.sh` 가 드라이버를 찾는 순서 | `BROWSER_DRIVER_PATH`, 위로 올라가며 찾은 `tools/browser-driver/`, `~/.claude/scripts/browser-driver` 순이다. 캐시에서는 루트의 `tools/` 에서 찾는다 |
| `harness-cleanup/scripts/check_references.py` 의 설치된 스킬 이름 수집 | `~/.claude/plugins` 아래에서 `SKILL.md` 를 가진 디렉터리 이름을 모은다. 스킬이 `skills/` 아래에 있지 않아도 찾는다 |

루트에는 `bin/` 을 두지 않는다. `browser-driver` 명령은 팀 저장소의 플러그인이 PATH 에 싣는다. 근거는 [ADR-004](adr/004-no-plugin-bin.md) 가 소유한다.

`${CLAUDE_PLUGIN_ROOT}` 는 쓰지 않는다. 스킬 본문에서만 치환되고 `references/` 파일과 Bash 명령에서는 치환되지 않으며, 링크 설치에서는 값이 없기 때문이다.
`$SKILL_DIR` 은 플러그인 설치와 링크 설치에서 같은 방식으로 얻는다.

## 저장소 밖에서 이 저장소를 가리키는 경로

캐시 경로에는 커밋 SHA 가 들어 있어 갱신할 때마다 바뀐다.
저장소 밖의 파일이 스킬 안의 파일을 가리켜야 하면 **로컬 체크아웃 경로**를 쓴다.

| 저장소 밖의 것 | 가리키는 곳 | 플러그인으로 옮긴 뒤 |
| --- | --- | --- |
| `~/.claude/scripts/korean-style-check.py`, `check-readability.py` 링크 | 체크아웃의 `korean-check/scripts/` | 그대로 둔다 |
| `~/.claude/scripts/browser-driver` 링크 | 체크아웃의 `tools/browser-driver/browser_driver.py` | 그대로 둔다 |
| `~/.claude/rules/korean-style.md` 링크 | 체크아웃의 `korean-check/references/korean-style.md` | 그대로 둔다 |
| `~/.claude/settings.json` 의 `PostToolUse` 훅 | `~/.claude/scripts/` 의 링크 | 그대로 둔다 |
| 전역 지침과 `~/.claude/references/` 가 적은 `~/.claude/skills/<스킬>/` 아래 경로 | 스킬 링크 | `~/personal/fos-skills/<스킬>/` 로 고친다 |
| 다른 저장소의 오버레이와 스킬이 적은 `~/.claude/skills/<스킬>` 경로 | 스킬 링크 | 그 저장소에서 고친다. 고치기 전에는 그 스킬의 링크를 남긴다 |

링크가 체크아웃을 가리키므로 훅과 규칙은 체크아웃의 현재 내용을 읽는다.
설치된 스킬은 main 에 push 한 내용을 읽는다. push 하기 전에는 두 내용이 다를 수 있다.

## 이름과 겹침

플러그인 스킬은 `fos-skills:planning` 처럼 불린다.
`~/.claude/skills/planning` 같은 같은 이름의 링크와 함께 두면 둘 다 목록에 뜨고 어느 쪽도 다른 쪽을 가리지 않는다.
전환할 때 링크를 지우는 순서는 [flow.md](flow.md) 의 「링크 설치에서 옮기기」 가 소유한다.

팀 저장소의 플러그인은 `content-preview` 와 `korean-check` 의 사본을 싣는다.
두 스킬의 원본은 여기 있지만, 스킬로는 사본을 싣는 팀 저장소의 플러그인으로 받는다.
그 플러그인을 받을 수 없는 환경에서는 두 스킬이 목록에 뜨지 않는다.
이 플러그인은 두 원본 디렉터리를 캐시에 복사하되 `skills` 배열에서 제외하므로 함께 설치해도 중복으로 뜨지 않는다.

- 사본은 `scripts/export-to-team.sh` 가 원본과 같은 내용으로 유지한다.
- 팀 양식 스킬은 자기 플러그인 안의 사본을 상대 경로로 읽는다. 이 플러그인의 유무와 무관하다.
- 팀 플러그인은 이 플러그인에 기대지 않는다. 두 플러그인을 함께 켜는 사람은 두 저장소를 모두 쓰는 한 명이다.

## 팀 저장소 내보내기

`scripts/export-to-team.sh` 와 `hooks/post-commit` 은 고치지 않는다.
스킬이 루트에 그대로 있으므로 원본 경로 `<저장소>/<이름>` 과 목적지 `<팀 저장소>/skills/<이름>` 이 그대로다.
팀 저장소가 `skills/<이름>` 을 플러그인 안의 본체를 가리키는 상대 링크로 바꿔도, 내보내기는 링크 너머로 읽고 쓰므로 목적지를 바꾸지 않는다.

`.claude-plugin/` 은 내보내는 대상이 아니다. 스킬 디렉터리 밖에 있어 내보내기가 읽지 않는다.

## 검증

| 명령 | 확인하는 것 |
| --- | --- |
| `python3 -m unittest discover -s scripts/tests` | 내보내기 전용 원본을 제외한 루트 스킬 디렉터리 집합이 `skills` 배열과 같다. 두 매니페스트에 `version` 이 없다. 마켓플레이스의 소스가 `./` 다 |
| `bash scripts/test-plugin-install.sh` | 격리된 설정 폴더에서 스킬 여섯 개가 인식되고 내보내기 전용 원본은 목록에 없다. 캐시에 원본이 남고 형제 참조와 도구 탐색이 된다 |

`claude plugin validate --strict` 는 쓰지 않는다. `version` 이 없다는 경고로 실패하기 때문이다.
설치 테스트가 `claude plugin validate . --json` 의 결과에서 오류가 없고 경고가 버전 경고 하나뿐인지를 확인한다.

## 다음 차수

플러그인이 `PostToolUse` 훅을 실어 설치만으로 한국어 검사가 켜지게 하는 일은 이번에 하지 않는다.
플러그인 훅이 실제로 발화하는지는 세션을 띄워야 확인되는데 격리 환경에서 실측하지 못했다.
그때까지 사외 머신에서 훅을 쓰려면 저장소를 clone 하고 `korean-check/README.md` 의 링크를 건다.
훅을 실을 때는 훅 정의 파일을 git 훅이 있는 `hooks/` 와 다른 경로에 둔다.
