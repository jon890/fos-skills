# 원격 검증

GitHub 의 main 에 매니페스트가 있어야 끝나는 검증이다. 순서대로 실행한다.
옮기는 순서와 분기는 `docs/flow.md` 의 「링크 설치에서 옮기기」 가 소유한다.

| 선행 조건 | 실행 위치 | 명령 | 기대값 |
|---|---|---|---|
| PR 을 main 에 머지한 뒤 | 이 머신의 터미널 | `claude plugin marketplace add jon890/fos-skills` | `Successfully added marketplace: fos-skills` |
| 위 등록 뒤 | 이 머신의 터미널 | `claude plugin install fos-skills@fos-skills` | `Successfully installed plugin` |
| 위 설치 뒤 | 이 머신의 터미널 | `claude plugin details fos-skills@fos-skills` | `Skills (7)` 과 일곱 스킬의 이름 |
| 위 설치 뒤 | 이 머신의 터미널 | `ls ~/.claude/plugins/cache/fos-skills/fos-skills/` | 16진수 12자리 이름의 디렉터리 하나 |
| 스킬 일곱 개를 확인한 뒤 | 이 머신의 터미널 | `docs/flow.md` 의 「링크 설치에서 옮기기」 2번에 있는 `grep` 명령 | 찾은 경로를 `~/personal/fos-skills/<스킬>/` 로 고친 뒤 다시 돌리면 결과가 없다 |
| 위 경로를 고친 뒤 | 이 머신의 터미널 | 다른 저장소가 `~/.claude/skills/<스킬>/` 아래 파일을 실행하는지 그 저장소에서 `grep` 으로 찾는다 | 실행하는 곳이 있으면 그 스킬의 링크만 남긴다 |
| 위 판정 뒤 | 이 머신의 터미널 | 남기기로 한 것을 뺀 `~/.claude/skills/<스킬>` 링크를 `rm` 으로 지운다 | `ls -l ~/.claude/skills` 에 fos-skills 체크아웃을 가리키는 링크가 남기기로 한 것뿐이다 |
| 링크를 지운 뒤 | 새로 연 Claude Code 세션 | 스킬 목록을 본다 | `fos-skills:` 접두사가 붙은 스킬이 일곱이고, 지운 이름이 접두사 없이 뜨지 않는다 |
| 링크를 지운 뒤 | 새로 연 Claude Code 세션 | 한국어 `.md` 파일을 하나 고친다 | `PostToolUse` 의 한국어 표기 점검과 가독성 점검이 전과 같이 돈다 |
| 설치한 뒤 | 저장소 작업 트리 | `claude --plugin-dir "$(git rev-parse --show-toplevel)"` 로 연 세션에서 `planning` 을 부른다 | `Base directory for this skill` 이 작업 트리 경로다. 캐시 경로면 `docs/flow.md` 의 「고치는 동안의 확인」 대로 설치본을 끄고 다시 연다 |
| main 에 새 커밋을 push 한 뒤 | 이 머신의 터미널 | `claude plugin update fos-skills@fos-skills` | `updated from <옛 SHA> to <새 SHA>` |
| PR 을 main 에 머지한 뒤 | 저장소 주 체크아웃 | `bash scripts/export-to-team.sh` | `build-with-teams` 와 `review-fix` 의 `SKILL.md`, `CHANGELOG.md` 가 어긋남으로 나온다. 팀 저장소에 반영하는 일은 그 저장소의 작업이다 |
