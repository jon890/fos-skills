---
name: content-preview
metadata:
  version: "1.6.0"
description: 외부에 게시·등록되는 본문(Dooray 댓글·업무, GitHub 이슈·PR, 메일·슬랙 메시지, 위키 등)을 사용자에게 등록 전 미리보기로 보여줄 때 사용한다. 렌더링 HTML 을 띄우는 절차, 미리보기 직전 자가 점검 체크리스트, Dooray(TOAST UI)·GitHub(marked.js) HTML 생성기 사용법을 담는다. 사용자가 "미리보기"라고 명시하지 않아도, 외부에 나갈 텍스트를 작성해 등록·게시하려는 순간이면 반드시 이 skill 을 연다. 로컬 파일 작성·코드 커밋처럼 외부에 게시되지 않는 산출물은 대상이 아니다.
---

# content-preview — 외부 게시 본문 미리보기

Dooray·GitHub·메일·슬랙 등 외부로 나가는 본문을, 사용자가 등록 전에 검토·수정할 수 있도록 미리보기로 보여주는 절차다.

핵심 이유: `Write`/`Edit` 로 임시 파일에만 저장하면 사용자 화면에는 도구 호출만 보이고 내용이 숨겨져, 검토·수정 지시를 할 수 없다. 그래서 본문을 **실제 렌더링 HTML** 로 띄워 눈으로 볼 수 있게 한다.

## 순서 (고정)

```
수신자 확인 → 문체 결정 → 본문 작성 → 자가 점검 → 미리보기(턴 종료) → 사용자가 읽고 응답 → 등록
```

- **본인 명의로 나가는 글이면 본문을 쓰기 전에 개인 문체 참조를 읽는다.** 다 쓴 뒤 점검 항목으로 확인하면 늦다. 헤더와 표로 짜놓은 본문은 문체를 고치는 게 아니라 처음부터 다시 쓰는 일이 된다.
    * 참조 위치는 `~/.claude/references/work-writing-persona.md` 다. 개인이 만들어 두는 파일이라 **없으면 이 항목을 건너뛴다.**
    * 문체는 사람마다 다르므로 이 저장소는 참조를 배포하지 않는다. 만드는 방법은 아래 「개인 문체 참조」 를 본다.
- **HTML 미리보기를 띄운다.** 사용자가 따로 요청하지 않아도 생략하지 않는다.
- **본문 전문을 채팅에 다시 쓰지 않는다.** 무엇을 띄웠는지와 제목만 한 줄로 알린다.
    * 본문은 이미 파일과 브라우저에 있다. 채팅에 옮겨 적으면 같은 내용이 두 번 쌓여 토큰만 쓴다.
    * 사용자는 렌더링된 쪽을 읽는다. 인라인 사본은 읽히지 않는다.
    * 예외는 사용자가 채팅에서 보자고 명시할 때뿐이다.

**이 확인 방식은 본 skill 이 소유한다.** `create-pr`, `dooray-task` 같은 게시 skill 과
레포 오버레이는 여기를 가리키고 자기 쪽에 확인 절차를 다시 적지 않는다.
두 곳에 적으면 한쪽만 고쳐져 서로 다른 지시가 남는다.

부분 수정은 예외다. 바뀐 블록만 AS-IS / TO-BE 로 채팅에 보인다.
렌더링된 전문은 무엇이 바뀌었는지 보여주지 못하고, 바뀐 블록은 전문이 아니라 diff 다.
- **미리보기와 구조화된 질문을 같은 턴에 묶지 않는다.** 선택창이 본문을 가려 사용자가 읽기 전에 결정을 강요당한다. 미리보기 턴은 미리보기로 끝내고, 등록 확인은 사용자가 본문을 읽고 응답한 다음 턴에서 받는다.

## 자가 점검 (미리보기 직전, 의무)

미리보기로 넘어가기 전에 아래를 통과한다. 건너뛰면 사용자가 같은 규칙 위반을 반복 지적하게 된다. 컨텍스트 누적으로 규칙이 밀려도 이 단계만은 강제한다.

- 개인 문체 참조가 있으면 그 자가 점검 항목을 통과했는지
- 굵은 글씨를 뺀 자리에 강조를 남겼는지 — 그냥 빼면 강조가 통째로 사라진다
- 분량 구간을 판단했는지 — 훑어 찾는 글이면 댓글에도 헤더를 쓴다. 처음부터 끝까지 읽는 짧은 댓글에만 헤더를 뺀다
- 언어 — 인라인 항목 연결, 명사형 종결, 괄호 2겹
- 매체 — `~` 짝수개로 인한 취소선, `§` 기호, heredoc escape 잔존, 압축된 표 셀
- 본문 파일이 실제로 갱신됐는지 — 아래 "본문 파일 덮어쓰기" 참조
- 개인 표기·가독성 규칙(`~/.claude/rules/` 의 `korean-style.md`, `writing-structure.md`, `markdown-readability.md`)을 두고 있으면 그것도 함께 통과했는지
    * 이 저장소는 이 규칙들을 배포하지 않는다. **없으면 이 항목을 건너뛴다.**
    * 위 여섯 항목은 규칙 파일이 없어도 그대로 수행한다.

## HTML 미리보기 생성 (Dooray · GitHub)

Dooray 업무·댓글, GitHub issue·PR 본문은 실제 렌더링과 비슷한 HTML 을 만들어 브라우저로 띄운다.

생성기와 템플릿은 이 skill 번들 안 `scripts/` 에 있다. 스킬을 옮기면 생성기도 함께 따라간다.

| 대상 | 렌더링 원리 | 생성기 |
| --- | --- | --- |
| Dooray | NHN TOAST UI Editor viewer CSS/JS (`uicdn.toast.com/editor/latest`) → 실제 등록 화면과 거의 동일 | `scripts/dooray-preview/` |
| GitHub | github-markdown-css(공식 스타일)와 marked.js(GitHub Flavored Markdown) → 실제 화면과 비슷 | `scripts/github-preview/` |

Dooray 는 업무 본문과 댓글의 머리가 다르므로 `--mode` 로 고른다.

| 값 | 머리 | 쓰는 곳 |
| --- | --- | --- |
| `task` (기본) | 프로젝트, 제목, 메타, 태그 | 업무 본문 |
| `comment` | 작성자 아바타와 이름 | 댓글, 진행 기록, 주간보고 |

```bash
python3 ~/.claude/skills/content-preview/scripts/dooray-preview/generate.py \
  --mode comment --author "홍길동" \
  --title "주간보고 2026년 8월 4주차 — #199" \
  --md-file /tmp/body.md --out /tmp/preview.html
```

**Dooray 본문을 다른 렌더러로 미리 보지 않는다.** marked 계열은 같은 markdown 을 다르게 렌더한다.
한 문장마다 줄을 나눈 본문을 marked 는 한 문단으로 붙이고, TOAST UI 는 줄을 살린다.
범위 표기의 물결표도 marked 만 취소선으로 읽는다 (실측).
등록 결과와 다른 화면을 보고 판단하게 되므로 Dooray 대상은 이 생성기를 쓴다.

공통 주의:

- 본문에 `` `</script>` `` 문자열 금지 (생성기가 검출·거부).
- CDN 로드라 오프라인이면 스타일이 빠진다.

### 화면에 띄우기

`show-preview.sh` 로 띄운다. 브라우저를 직접 열지 않는다.

```bash
~/.claude/skills/content-preview/scripts/show-preview.sh "$SP/preview.html"
```

같은 파일의 탭이 이미 있으면 갱신하고, 없으면 새로 만든 뒤 화면 앞으로 가져온다.

어디에 띄울지는 `browser-driver` 가 정한다. 에이전트 IDE 안의 브라우저를 쓰면 거기서 열리고, 드라이버가 없으면 기본 브라우저로 내려간다.
AppleScript 로 Chrome 계열과 Safari 만 훑던 때는 IDE 안의 탭을 찾지 못했다. 그래서 재생성할 때마다 탭이 쌓였고 사용자는 오래된 본문을 읽고 판단했다 (실측).

출력이 `갱신` 인지 `새로 열었다` 인지 확인한다. 재생성했는데 새로 열렸다면 사용자가 보던 탭이 닫힌 것이다.

**`orca` 백엔드는 셸의 작업 디렉토리가 속한 워크트리에 탭을 만든다.**
조사하느라 다른 저장소로 `cd` 한 뒤 띄우면, 사용자가 보고 있는 워크트리가 아닌 곳에 탭이 생긴다.
`갱신` 이라고 출력돼도 사용자 화면은 그대로다 (실측).
사용자의 작업 경로에서 띄우거나, 그 경로를 `ORCA_WORKTREE` 로 고정한다.

```bash
ORCA_WORKTREE="path:$HOME/projects/MyRepo" \
  ~/.claude/skills/content-preview/scripts/show-preview.sh "$SP/preview.html"
```

`open` 이 `탭 위치:` 한 줄을 남기므로 어디에 열렸는지 그 자리에서 확인한다.

### 본문 파일 덮어쓰기

수정본을 같은 경로에 다시 쓸 때 zsh 의 `noclobber` 로 `cat > 기존파일` 이 거부된다. 오류는 `file exists` 한 줄로만 나오고 뒤이은 생성기는 그대로 성공하므로, **이전 본문으로 만든 미리보기를 새 본문이라고 착각한다.**

수정본을 쓸 때는 기존 파일을 먼저 지우고, 쓴 뒤 첫 줄을 확인한다.

```bash
rm -f "$SP/body.md" "$SP/preview.html"
cat > "$SP/body.md" <<'EOF'
...
EOF
head -3 "$SP/body.md"
```

Dooray 사용법:

```bash
python3 ~/.claude/skills/content-preview/scripts/dooray-preview/generate.py \
  --title "[VectorSearch] [DocParser] ..." \
  --tag "Document Parser" --tag "개선" --tag "REAL" \
  --meta "담당자:홍길동" --meta "참조:개발 그룹" \
  --md-file /tmp/body.md --out /tmp/dooray-preview.html
~/.claude/skills/content-preview/scripts/show-preview.sh /tmp/dooray-preview.html
```

GitHub 사용법 (`--type` 은 `issue` 또는 `pr`, 헤더 배지 색 구분):

```bash
python3 ~/.claude/skills/content-preview/scripts/github-preview/generate.py \
  --type issue \
  --repo "toast-lab/ai-playground-docu-parser" \
  --title "..." \
  --md-file /tmp/gh-body.md --out /tmp/gh-preview.html
~/.claude/skills/content-preview/scripts/show-preview.sh /tmp/gh-preview.html
```

- GitHub 고유 자동링크(`#번호`)와 `:emoji:` 코드는 marked.js 가 변환하지 않는다. 정확한 GFM 은 등록 후 GitHub 에서 확인한다.

## 개인 문체 참조 (선택)

본인 명의로 나가는 글의 문체를 고정하고 싶으면
`~/.claude/references/work-writing-persona.md` 를 만든다.
스킬 안에 두지 않는다. 스킬을 옮기거나 심링크를 다시 걸 때 참조가 꼬이고,
이 저장소가 개인 파일을 무시하는 규칙을 따로 들고 있어야 한다.
문체는 사람마다 다르고, 남의 문체를 강제하면 글이 어색해진다.

`~/.claude/rules/` 에도 두지 않는다. 하네스가 그 디렉터리를 전역 지침으로 무조건 읽어
글을 쓰지 않는 세션에도 전문이 실린다.

없으면 이 skill 은 미리보기 절차만 수행한다. 문체 관련 지시는 건너뛴다.

무엇을 적을지는 본인의 실제 작성 이력에서 뽑는 편이 정확하다.
과거에 직접 쓴 업무와 댓글을 모아 반복되는 특징을 찾고, 아래 축으로 정리한다.

| 축 | 정하는 것 |
| --- | --- |
| 수신자별 모드 | 작업 로그, 대외 회신, 업무 본문처럼 읽는 사람이 다르면 문체도 다르다 |
| 문장 종결 | 평서체·명사형·존댓말 중 무엇으로 끝낼지 모드마다 고정한다 |
| 개인 습관 | 결론을 끌어내는 기호, 강조 방식, 링크를 붙이는 자리 |
| 하지 않는 것 | AI 가 대신 썼을 때 티가 나는 지점을 적어 둔다 |

표기·가독성 규칙을 따로 두고 있다면 그것을 덮어쓰지 않고, 그 안에서 개인 문체를 정하는 문서로 쓴다.
