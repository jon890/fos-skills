# content-preview

외부에 게시하거나 등록할 본문을 등록 전에 렌더링해 사용자에게 보여준다.

## 산출물

- 본문 markdown 파일과 그것으로 만든 렌더링 HTML
- 사용자 화면에 열린 미리보기 탭. 같은 파일이 이미 열려 있으면 새 탭을 만들지 않고 갱신한다
- 무엇을 띄웠는지와 제목만 담은 한 줄 보고. 본문 전문은 채팅에 다시 쓰지 않는다
- 사용자가 읽고 응답한 다음 턴에 이뤄지는 등록

## 사용 시점

Dooray 댓글과 업무, GitHub 이슈와 PR, 메일, 슬랙 메시지, 위키처럼 외부에 나갈 텍스트를
등록하려는 순간이면 쓴다. 사용자가 「미리보기」 라고 말하지 않아도 마찬가지다.
로컬 파일 작성과 코드 커밋처럼 외부에 나가지 않는 것은 대상이 아니다.

**등록 전 확인 방식은 이 스킬이 소유한다.** 아래 스킬은 여기를 가리키고
자기 쪽에 확인 절차를 다시 적지 않는다.

| 가리키는 쪽 | 어디서 |
| --- | --- |
| `create-pr` | PR 본문 등록 전 확인 |
| `dooray-task` | 업무 본문과 댓글 등록 전 확인 |
| 레포 오버레이 | 그 저장소의 게시 절차 |

## 전제

- `python3` 로 생성기를 돌린다
- CDN 에서 스타일과 렌더러를 받으므로 망이 없으면 스타일이 빠진다.
  Dooray 는 `uicdn.toast.com` 의 TOAST UI Editor viewer, GitHub 은 github-markdown-css 와 marked.js 를 쓴다
- 브라우저 드라이버가 띄울 곳을 정한다. 이 저장소의 `tools/browser-driver/` 를 함께 받으면
  따로 설치하지 않아도 되고, 없으면 기본 브라우저로 내려간다
- `orca` 백엔드는 셸의 작업 디렉토리가 속한 워크트리에 탭을 만든다.
  다른 저장소로 `cd` 한 뒤 띄우면 `ORCA_WORKTREE` 로 사용자의 작업 경로를 고정해야 한다
- 개인 문체 참조와 표기 규칙은 선택이다. 이 저장소는 둘 다 배포하지 않으며,
  없으면 미리보기 절차만 수행한다

## 구성

| 파일 | 소유하는 것 |
| --- | --- |
| `SKILL.md` | 목표와 5단계 실행 절차, 단계별 통과 조건, 자가 점검, 생성기 사용법 |
| `references/persona.md` | 개인 문체 참조를 어디에 두고 무엇을 적는지 |
| `scripts/show-preview.sh` | 미리보기 HTML 을 사용자 화면에 띄운다. 같은 파일의 탭을 찾아 갱신하고 워크트리를 대조한다 |
| `scripts/dooray-preview/generate.py` | Dooray 본문 미리보기 HTML 생성. `--mode` 로 업무 본문과 댓글의 머리를 고른다 |
| `scripts/dooray-preview/template.html` | TOAST UI Editor viewer 를 쓰는 Dooray 미리보기 골격 |
| `scripts/github-preview/generate.py` | GitHub issue 와 PR 본문 미리보기 HTML 생성. `--type` 으로 헤더 배지 색을 가른다 |
| `scripts/github-preview/template.html` | github-markdown-css 와 marked.js 를 쓰는 GitHub 미리보기 골격 |
| `CHANGELOG.md` | 버전 이력 |
