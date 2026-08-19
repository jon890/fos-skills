# CHANGELOG — content-preview

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.0.0

- **`~/.claude/skills/` 아래의 개인 폴더에서 이 저장소로 옮겼다.** 저장소에 들어간 적이 없어
  다른 스킬처럼 승격 흐름을 타지 못했고, `dooray-task` 와 `create-pr` 이 이 skill 을 가리키기
  시작하면서 팀원 환경에서는 따라갈 대상이 없는 참조가 됐다.
- **HTML 생성기를 `~/.claude/templates/` 에서 skill 번들 안 `scripts/` 로 흡수했다.**
  생성기 호출이 절대경로여서 스킬만 배포하면 팀원 환경에서 반드시 깨진다.
  `Path(__file__).parent` 로 템플릿을 찾으므로 폴더째 옮겨도 동작은 같다.
  승격을 막던 근거로 적혀 있던 "brain-add 와 공유 중" 은 사실이 아니었다.
  brain-add 는 자기 `generate_preview.py` 를 갖고 있고 주석에서 구조만 참고한다.
- SKILL.md 의 승격 메모 절을 지웠다. 승격이 끝나 더 이상 지시할 것이 없다.
