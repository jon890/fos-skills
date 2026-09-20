---
name: content-preview
metadata:
  version: "3.3.0"
description: |
  외부에 게시하거나 등록할 본문을 등록 전에 렌더링해 사용자에게 보여준다.
  Dooray 댓글과 업무, GitHub 이슈와 PR, 메일, 슬랙 메시지, 위키가 대상이다.
  사용자가 "미리보기" 라고 말하지 않아도, 외부에 나갈 텍스트를 등록하려는 순간이면 이 스킬을 쓴다.
  로컬 파일 작성과 코드 커밋처럼 외부에 나가지 않는 것은 대상이 아니다.
---

# content-preview

**목표: 외부로 나갈 본문을 등록 전에 실제 렌더링으로 보여주고, 사용자가 읽은 뒤에 등록한다.**

임시 파일에만 저장하면 사용자 화면에는 도구 호출만 보이고 내용이 숨겨져, 검토와 수정 지시를 할 수 없다.
그래서 본문을 실제 렌더링 HTML 로 띄워 눈으로 볼 수 있게 한다.

- 본문 전문을 채팅에 다시 쓰지 않는다. 사용자는 렌더링된 쪽을 읽는다.
- 미리보기 턴은 미리보기로 끝낸다. 등록 확인은 사용자가 읽고 응답한 다음 턴에 받는다.

**등록 전 확인 방식은 이 스킬이 소유한다.**
`create-pr`, `dooray-task` 같은 게시 스킬과 레포 오버레이는 여기를 가리키고
자기 쪽에 확인 절차를 다시 적지 않는다. 두 곳에 적으면 한쪽만 고쳐져 서로 다른 지시가 남는다.

## 실행 절차

각 단계는 진입 시 해당 reference 를 읽고 수행한다. 통과 조건을 확인한 뒤 다음으로 간다.

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 수신자와 문체 | 누가 읽는지 정했고, 개인 문체 참조가 있으면 본문을 쓰기 전에 읽었다 | `references/persona.md` |
| 2 | 본문 작성 | 본문 파일의 첫 줄이 새 내용이다 | |
| 3 | 표기 검사 | 검사기가 종료 코드 0 으로 끝났다 | `scripts/style-check.sh` |
| 4 | 검토 | 검토 축의 통과 조건 셋을 채웠다. 짧은 글이면 건너뛴 것을 알렸다 | [`../korean-check/references/review-axes.md`](../korean-check/references/review-axes.md) |
| 5 | 미리보기 | 사용자가 보는 워크트리의 탭에 새 본문이 떠 있다 | `scripts/show-preview.sh` |
| 6 | 등록 | 사용자가 읽고 응답한 다음 턴이다 | |

본문과 미리보기를 둘 자리를 하나 정해 `SP` 에 담는다.
하네스가 알려주는 임시 디렉터리가 있으면 그것을 쓰고, 없으면 저장소 밖의 임시 경로를 쓴다.

```bash
SP=<본문과 미리보기를 둘 디렉터리>
```

### 1. 수신자와 문체

**누가 읽는지 먼저 정한다.** 읽는 사람이 문체와 분량 구간을 정한다.

본인 명의로 나가는 글이면 `~/.claude/references/work-writing-persona.md` 를 **본문을 쓰기 전에** 읽는다.
개인이 만들어 두는 파일이라 없으면 이 단계를 건너뛴다.
만드는 방법은 `references/persona.md` 가 소유한다.

### 2. 본문 작성

본문을 `$SP/body.md` 에 쓴다.

**수정본을 같은 경로에 다시 쓸 때는 기존 파일을 먼저 지운다.**
zsh 의 `noclobber` 로 `cat > 기존파일` 이 거부되는데, 오류는 `file exists` 한 줄로만 나오고
뒤이은 생성기는 그대로 성공한다. 이전 본문으로 만든 미리보기를 새 본문이라고 착각하게 된다.

```bash
rm -f "$SP/body.md" "$SP/preview.html"
cat > "$SP/body.md" <<'EOF'
...
EOF
head -3 "$SP/body.md"
```

**첫 줄을 확인해 갱신됐는지 본다.** 이것이 이 단계의 통과 조건이다.

### 3. 표기 검사

본문 파일에 검사기를 돌린다. 판정 기준과 검사기는 `korean-check` 스킬이 소유한다.
`$SKILL_DIR` 은 이 스킬 번들 경로다. **스크립트는 스킬 번들에 있고 cwd 는 어디든 된다.**

```bash
# cwd: 아무 곳
bash "$SKILL_DIR/scripts/style-check.sh" "$SP/body.md"
```

| 코드 | 무엇을 한다 |
| --- | --- |
| 0 | 다음 단계로 간다 |
| 1 | 걸린 자리를 고치고 다시 돌린다 |
| 2 | 검사기가 돌지 못한 것이다. stderr 가 원인을 말한다. 사용자에게 알리고 그것을 먼저 해소한다 |

**만든 방법과 무관하게 이 자리에서 직접 돌린다.**
편집 훅이 어떤 파일을 놓치는지는
[`../korean-check/references/markdown-readability.md`](../korean-check/references/markdown-readability.md) 의
「훅이 잡지 못하는 것」 이 소유한다.

제목도 함께 검사한다. 제목은 파일이 아니라 인자로 나가 훅을 거치지 않는다.

```bash
bash "$SKILL_DIR/scripts/style-check.sh" --text "$TITLE"
```

### 4. 검토

**본문을 쓰지 않은 쪽이 읽는다.** 쓴 쪽이 자기 글을 평가하면 통과 여부가 산출물에 남지 않는다.
읽기 전용 검토 역할이 있으면 그것에 맡기고, 없으면 사용자에게 검토를 청한다.

검토자에게 무엇을 주고 받은 것을 어떻게 처리하는지는
[`../korean-check/references/review-axes.md`](../korean-check/references/review-axes.md) 가 소유한다.
그 파일을 읽고 수행한다.
경로는 3단계의 스크립트가 알려준다.

```bash
bash "$SKILL_DIR/scripts/style-check.sh" --where
```

대상은 본문과 함께 나가는 파일의 한국어, 그리고 제목이다.
개인 문체 참조를 두고 있으면 그 점검 항목도 검토자에게 함께 준다.

#### 건너뛰는 조건

**짧은 글은 이 단계를 건너뛴다.** 댓글 한 줄에 검토자를 띄우는 것은 과하다.
긴 문서와 정형 양식만 수행한다.
분량 구간의 판정 기준은 [`../korean-check/references/writing-structure.md`](../korean-check/references/writing-structure.md) 가 소유한다.

건너뛰었으면 등록 단계의 보고에 그 사실을 한 줄로 적는다.

### 5. 미리보기

Dooray 업무와 댓글, GitHub issue 와 PR 본문은 실제 렌더링과 비슷한 HTML 을 만들어 브라우저로 띄운다.

| 대상 | 렌더링 원리 | 생성기 |
| --- | --- | --- |
| Dooray | TOAST UI Editor viewer 의 CSS 와 JS. 실제 등록 화면과 거의 같다 | `scripts/dooray-preview/` |
| GitHub | github-markdown-css 와 marked.js. 실제 화면과 비슷하다 | `scripts/github-preview/` |

**대상과 생성기를 바꿔 쓰지 않는다.** marked 는 한 문장마다 줄을 나눈 본문을 한 문단으로 붙이고
물결표를 취소선으로 읽는다. TOAST UI 는 둘 다 살린다 (실측).

인자는 각 생성기의 `--help` 가 소유한다. Dooray 는 `--mode` 로 머리를 고른다.

| 값 | 머리 | 쓰는 곳 |
| --- | --- | --- |
| `task` (기본) | 프로젝트, 제목, 메타, 태그 | 업무 본문 |
| `comment` | 작성자 아바타와 이름 | 댓글, 진행 기록, 주간보고 |

```bash
# cwd: 아무 곳. $REPO 는 owner/repo 형태다
python3 "$SKILL_DIR/scripts/dooray-preview/generate.py" \
  --mode comment --author "$USER" \
  --title "주간보고 2026년 8월 4주차" \
  --md-file "$SP/body.md" --out "$SP/preview.html"

python3 "$SKILL_DIR/scripts/github-preview/generate.py" \
  --type issue --repo "$REPO" \
  --title "$TITLE" \
  --md-file "$SP/body.md" --out "$SP/preview.html"

bash "$SKILL_DIR/scripts/show-preview.sh" "$SP/preview.html"
```

**`show-preview.sh` 로 띄운다. 브라우저를 직접 열지 않는다.**
같은 파일의 탭이 이미 있으면 갱신하고, 없으면 새로 만든 뒤 화면 앞으로 가져온다.
어느 브라우저에 띄울지와 그렇게 하는 이유는 그 스크립트가 소유한다.

**출력 두 줄을 확인한다.**

| 출력 | 뜻 |
| --- | --- |
| `갱신` | 사용자가 보던 탭이 새 본문으로 바뀌었다 |
| `새로 열었다` | 재생성인데 이것이 나오면 사용자가 보던 탭이 닫힌 것이다 |
| `탭 위치:` | 그 탭이 있는 워크트리다. 사용자의 작업 경로와 같아야 한다 |

조사하느라 다른 저장소로 `cd` 한 뒤 띄우면 사용자가 보는 곳이 아닌 워크트리에 탭이 생긴다.
사용자의 작업 경로에서 띄우거나 그 경로를 고정한다.

```bash
ORCA_WORKTREE="path:$HOME/projects/MyRepo" scripts/show-preview.sh "$SP/preview.html"
```

공통 주의:

- 본문에 `` `</script>` `` 문자열을 넣지 않는다. 생성기가 검출해 거부한다.
- CDN 에서 스타일을 받으므로 망이 없으면 스타일이 빠진다.
- GitHub 고유 자동링크와 `:emoji:` 코드는 marked.js 가 변환하지 않는다.
  정확한 렌더는 등록 후 GitHub 에서 확인한다.

### 6. 등록

**무엇을 띄웠는지와 제목만 한 줄로 알리고 턴을 끝낸다.**
본문은 이미 파일과 브라우저에 있다. 채팅에 옮겨 적으면 같은 내용이 두 번 쌓인다.
사용자가 채팅에서 보자고 명시할 때만 예외다.

**검토 단계에서 반영하지 않은 발견을 그 보고에 한 줄로 덧붙인다.**
내가 판단해 버린 것을 사용자가 되짚을 수 있어야 한다.
반영한 발견과 발견 목록 전문은 적지 않는다. 목록이 길어지면 본문을 가린다.
검토 단계를 건너뛰었으면 그것을 한 줄로 적는다.

**미리보기와 구조화된 질문을 같은 턴에 묶지 않는다.**
선택창이 본문을 가려 사용자가 읽기 전에 결정하게 된다.

부분 수정은 바뀐 블록만 AS-IS 와 TO-BE 로 채팅에 보인다.
렌더링된 전문은 무엇이 바뀌었는지 보여주지 못하고, 바뀐 블록은 전문이 아니라 diff 다.
