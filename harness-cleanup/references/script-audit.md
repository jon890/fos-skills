# 스크립트 감사

`collect_targets.py` 가 「Markdown 대상은 없고 스크립트 N개가 있다」 를 내고 종료 코드 2 로 끝났을 때 읽는다.
저장소 루트는 맞다. 범위에 `.py`, `.sh` 만 있어 문서 대상이 없을 뿐이다.
문서 검사 다섯은 돌릴 대상이 없으므로 이 절차로 대신한다.

## 절차

스크립트마다 아래 셋을 순서대로 한다. `$SCRIPT` 는 저장소 루트 기준 상대경로다.

1. 호출처를 찾는다.
2. docstring 이나 머리 주석이 말하는 전제를 재현한다.
3. 그 스크립트의 테스트를 돌린다.

`$SEARCH_DIRS` 에는 호출처가 있을 파일과 폴더를 `$ROOT` 기준 배열로 넣는다.
저장소 하네스는 훅 설정 `.claude/settings.json`, 지침 `CLAUDE.md` 와 `AGENTS.md`, 문서 폴더, git hook 폴더처럼 저장소가 가진 것을 넣는다.
사용자 전역 하네스는 `$ROOT` 가 `~` 이고 설정, 지침, 참조, 스킬이 모두 `.claude` 아래에 있다.
공백으로 나눈 문자열은 zsh 가 단어 분할을 하지 않으므로 배열을 쓴다.

```bash
# cwd: $ROOT. 저장소 하네스의 예
SEARCH_DIRS=(.claude/settings.json CLAUDE.md AGENTS.md README.md docs hooks)
grep -rn "$(basename "$SCRIPT")" "${SEARCH_DIRS[@]}" 2>/dev/null
```

```bash
# cwd: ~. 사용자 전역 하네스의 예
SEARCH_DIRS=(.claude/settings.json .claude/CLAUDE.md .claude/references .claude/skills)
grep -rn "$(basename "$SCRIPT")" "${SEARCH_DIRS[@]}" 2>/dev/null
```

찾을 곳은 저장소마다 다르다. 훅은 `settings.json` 에, 스킬 호출은 각 `SKILL.md` 에 있다.
이 스킬이 소유한 것은 찾는 위치가 아니라 판정 기준이다.

## 판정 기준

| 관측 | 판정 | 이유 |
| --- | --- | --- |
| 호출처가 0건이다 | 제거 후보 | 부르는 곳이 없으면 고쳐도 아무것도 바뀌지 않는다 |
| 전제가 재현되지 않는다 | 보류 | 전제가 거짓이면 스크립트가 틀렸는지 재현 환경이 달랐는지 가려지지 않는다 |
| 테스트가 실패한다 | 위반 | 실행 결과가 근거이므로 실측 등급이다 |
| 테스트가 없다 | 검증 공백 | 완료 보고에 적는다 |

**호출처 0건은 제거 후보이지 제거 결정이 아니다.** 사용자가 직접 부르는 스크립트는 저장소 안에 호출처가 없다.
4단계 판정표에 올려 승인을 받는다.

**보류는 근거를 적고 판정표에 남긴다.** 전제를 재현하지 못한 환경과 시도한 방법을 함께 적는다.
