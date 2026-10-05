---
name: content-preview
metadata:
  version: "3.16.0"
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

**본문을 등록하기 전에 무엇을 보여주고 언제 승인을 받는지는 이 스킬이 소유한다.**
본문을 외부에 등록하는 스킬과 레포 오버레이는 여기를 가리키고
자기 쪽에 확인 절차를 다시 적지 않는다. 두 곳에 적으면 한쪽만 고쳐져 서로 다른 지시가 남는다.

## 실행 절차

각 단계는 진입 시 해당 reference 를 읽고 수행한다. 통과 조건을 확인한 뒤 다음으로 간다.

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 수신자와 문체 | 누가 읽는지 정했고, 개인 문체 참조가 있으면 본문을 쓰기 전에 읽었다 | `references/persona.md` |
| 2 | 본문 작성 | 본문 파일의 첫 줄이 새 내용이다 | `references/render-traps.md` |
| 3 | 표기 검사 | 검사기가 종료 코드 0 으로 끝났다 | `scripts/style-check.sh` |
| 4 | 검토 | 의미 점검의 통과 조건을 채웠다. 짧은 글이면 건너뛴 것을 알렸다 | [`../korean-check/references/review-axes.md`](../korean-check/references/review-axes.md) |
| 5 | 미리보기 | 사용자가 보는 워크트리의 탭에 새 본문이 떠 있다. dispatch 워커는 새 본문으로 `$PREVIEW_DIR/preview.html` 을 생성했다 | `scripts/show-preview.sh` |
| 6 | 등록 | 사용자가 읽고 응답한 다음 턴이다. 이 본문의 등록을 사용자가 미리 승인했으면 그 승인이 대화에 있다 | |

이 세션이 에이전트 조율 도구의 dispatch 로 일을 받았으면 5단계와 6단계는 「보는 사람이 없는 세션에서 등록할 때」 를 따른다.

본문과 미리보기를 둘 자리를 하나 정해 `PREVIEW_DIR` 에 담는다.
하네스가 알려주는 임시 디렉터리가 있으면 그것을 쓰고, 없으면 저장소 밖의 임시 경로를 쓴다.

```bash
PREVIEW_DIR=<본문과 미리보기를 둘 디렉터리>
```

### 1. 수신자와 문체

**누가 읽는지 먼저 정한다.** 읽는 사람이 문체와 분량 구간을 정한다.

본인 명의로 나가는 글이면 `~/.claude/references/work-writing-persona.md` 를 **본문을 쓰기 전에** 읽는다.
개인이 만들어 두는 파일이라 없으면 이 단계를 건너뛴다.
만드는 방법은 `references/persona.md` 가 소유한다.

### 2. 본문 작성

본문을 `$PREVIEW_DIR/body.md` 에 쓴다.

**수정본을 같은 경로에 다시 쓸 때는 기존 파일을 먼저 지운다.**
zsh 의 `noclobber` 로 `cat > 기존파일` 이 거부되는데, 오류는 `file exists` 한 줄로만 나오고
뒤이은 생성기는 그대로 성공한다. 이전 본문으로 만든 미리보기를 새 본문이라고 착각하게 된다.

**`rm` 대상의 변수는 `${PREVIEW_DIR:?}` 로 쓴다.** `$PREVIEW_DIR` 가 비어 있으면 셸이 오류를 내고 `rm` 을 실행하지 않는다.

```bash
rm -f "${PREVIEW_DIR:?}/body.md" "${PREVIEW_DIR:?}/preview.html"
cat > "$PREVIEW_DIR/body.md" <<'EOF'
...
EOF
head -3 "$PREVIEW_DIR/body.md"
```

**첫 줄을 확인해 갱신됐는지 본다.** 이것이 이 단계의 통과 조건이다.

매체마다 다르게 렌더되는 패턴과 그 대응은 [`references/render-traps.md`](references/render-traps.md) 가 소유한다.
표기와 문장 구성의 판정 기준은 `korean-check` 가 소유한다.

### 3. 표기 검사

본문 파일에 검사기를 돌린다. 판정 기준과 검사기는 `korean-check` 스킬이 소유한다.
`$SKILL_DIR` 은 이 스킬 번들 경로다. **스크립트는 스킬 번들에 있고 cwd 는 어디든 된다.**

```bash
# cwd: 아무 곳
bash "$SKILL_DIR/scripts/style-check.sh" "$PREVIEW_DIR/body.md"
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

제목도 함께 검사한다.

```bash
bash "$SKILL_DIR/scripts/style-check.sh" --text "$TITLE"
```

### 4. 검토

메인이 본문을 의미 점검 축으로 직접 점검한다.
담당자와 별도 검토 조건은 [`../korean-check/SKILL.md`](../korean-check/SKILL.md) 가,
점검에 쓸 자료와 발견을 처리하는 방법은
[`../korean-check/references/review-axes.md`](../korean-check/references/review-axes.md) 가 소유한다.
그 파일을 읽고 수행한다.

본문과 함께 제목, 그리고 개인 문체 참조가 있으면 그 점검 항목을 함께 본다.

`korean-check` 가 어디 있는지는 아래 명령이 낸다. 저장소마다 배치가 한 단 다르다.

```bash
bash "$SKILL_DIR/scripts/style-check.sh" --where
```

#### 검토를 건너뛰는 때

**짧은 글은 이 단계를 건너뛴다.**
긴 문서와 정형 양식만 수행한다.
분량 구간의 판정 기준은 [`../korean-check/references/writing-structure.md`](../korean-check/references/writing-structure.md) 가 소유한다.

### 5. 미리보기

Dooray 업무와 댓글, GitHub issue 와 PR 본문은 실제 렌더링과 비슷한 HTML 을 만들어 브라우저로 띄운다.

| 대상 | 렌더링 원리 | 생성기 |
| --- | --- | --- |
| Dooray | TOAST UI Editor viewer 의 CSS 와 JS. 실제 등록 화면과 거의 같다 | `scripts/dooray-preview/` |
| GitHub | github-markdown-css 와 marked.js. 실제 화면과 비슷하다 | `scripts/github-preview/` |

**대상과 생성기를 바꿔 쓰지 않는다.** marked 는 한 문장마다 줄을 나눈 본문을 한 문단으로 붙이고
물결표를 취소선으로 읽는다. TOAST UI 는 둘 다 살린다 (실측).

인자는 각 생성기의 `--help` 가 소유한다. Dooray 는 `--mode`, GitHub 는 `--type` 으로 머리를 고른다.

| 생성기 | 값 | 머리 | 쓰는 곳 |
| --- | --- | --- | --- |
| Dooray | `task` (기본) | 프로젝트, 제목, 메타, 태그 | 업무 본문 |
| Dooray | `comment` | 작성자 아바타와 이름 | 댓글, 진행 기록, 주간보고 |
| GitHub | `issue` (기본) | Issue 배지 | 이슈 본문 |
| GitHub | `pr` | Pull Request 배지 | PR 본문, 리뷰 응답 |

```bash
# cwd: 아무 곳. $REPO 는 owner/repo 형태다
python3 "$SKILL_DIR/scripts/dooray-preview/generate.py" \
  --mode comment --author "$USER" \
  --title "주간보고 2026년 8월 4주차" \
  --md-file "$PREVIEW_DIR/body.md" --out "$PREVIEW_DIR/preview.html"

python3 "$SKILL_DIR/scripts/github-preview/generate.py" \
  --type pr --repo "$REPO" \
  --title "$TITLE" \
  --md-file "$PREVIEW_DIR/body.md" --out "$PREVIEW_DIR/preview.html"

bash "$SKILL_DIR/scripts/show-preview.sh" "$PREVIEW_DIR/preview.html"
```

**`show-preview.sh` 로 띄운다. 브라우저를 직접 열지 않는다.**
어느 브라우저에 띄울지, 기존 탭을 어떻게 다시 쓰는지, 그렇게 하는 이유는
그 스크립트가 소유한다.

**재생성인데 `새로 열었다` 가 나오면 사용자가 보던 탭이 닫힌 것이다.**
출력의 나머지와 워크트리 대조는 그 스크립트가 소유한다.

조사하느라 다른 저장소로 `cd` 한 채 띄우면 사용자가 보는 곳이 아닌 워크트리에 탭이 생긴다.
사용자의 작업 경로에서 띄우거나 그 경로를 환경 변수로 고정한다.

```bash
# cwd: 아무 곳
ORCA_WORKTREE="path:$HOME/projects/MyRepo" bash "$SKILL_DIR/scripts/show-preview.sh" "$PREVIEW_DIR/preview.html"
```

#### 본문이 여럿일 때

한 턴에 등록할 본문이 여럿이면 미리보기 스크립트가 탭 하나를 다시 쓰므로, 본문마다 띄우면 마지막 것만 보인다.

- 본문은 각자 파일로 쓰고 3단계의 검사기도 각각 돌린다.
- 미리보기용으로만 본문들을 `# <순번>. <제목>` 머리를 붙여 한 파일로 이어 붙이고, 그 파일로 미리보기를 한 번 띄운다.
- 등록은 각자의 본문 파일로 한다. 이어 붙인 파일은 등록하지 않는다.

### 6. 등록

**무엇을 띄웠는지와 제목만 한 줄로 알리고 턴을 끝낸다.**
사용자가 채팅에서 보자고 명시할 때만 전문을 옮겨 적는다.

**의미 점검에서 반영하지 않은 발견을 그 보고에 한 줄로 덧붙인다.**
내가 판단해 버린 것을 사용자가 되짚을 수 있어야 한다.
반영한 발견과 발견 목록 전문은 적지 않는다. 목록이 길어지면 본문을 가린다.
본문과 제목 등 확인한 범위를 한 줄로 적는다. 의미 점검을 건너뛰었으면 그 사실을 적는다.

**미리보기와 구조화된 질문을 같은 턴에 묶지 않는다.**
선택창이 본문을 가려 사용자가 읽기 전에 결정하게 된다.

부분 수정은 바뀐 블록만 AS-IS 와 TO-BE 로 채팅에 보인다.
렌더링된 전문은 무엇이 바뀌었는지 보여주지 못하고, 바뀐 블록은 전문이 아니라 diff 다.

#### 사용자가 이번 본문의 등록을 미리 승인했을 때

**사용자가 이번 본문의 등록을 대화에서 명시적으로 미리 승인했으면 미리보기를 생략하고 바로 등록한다.**
다음 턴의 확인도 받지 않는다. 「PR 생성을 승인한다」 처럼 이 본문을 가리킨 말이 승인이다.

- 등록한 뒤 결과에 미리보기를 생략했다는 사실과 본문 파일의 경로를 적는다.
- 다른 건에 대한 과거 승인은 승인이 아니다.
- 「알아서 해」 같은 일반 위임과 에이전트 자신의 판단도 승인이 아니다.
- 생략하는 것은 5단계와 6단계의 확인뿐이다. 3단계의 표기 검사(`korean-check`)는 그대로 통과시킨 뒤 등록한다.

#### 보는 사람이 없는 세션에서 등록할 때

이 세션이 에이전트 조율 도구의 dispatch 로 일을 받았으면 아래를 따른다.
받은 지시문에 dispatch 머리말(`You are a dispatched worker`)이 있으면 dispatch 로 받은 것이다.

**5단계는 대상 생성기로 `$PREVIEW_DIR/preview.html` 을 만드는 것까지 수행한다.**
`show-preview.sh` 는 호출하지 않는다. 지시한 쪽이 읽을 미리보기 파일이 생성되면 5단계를 통과한다.

- 지시한 쪽이 그 본문의 등록을 지시문에 적었으면 사용자 응답을 기다리지 않고 이 턴에 등록한다. 「PR 을 연다」 가 그 예다.
  등록한 뒤 보고서에 `$PREVIEW_DIR/preview.html` 의 절대경로와 등록한 URL 을 적는다.
  지시한 쪽이 등록 뒤에 그 보고서로 본문을 읽는다.
- 등록 지시가 없으면 등록하지 않고 조율 도구의 질문 명령(예: `orca orchestration ask`)으로 지시한 쪽에 등록할지 묻는다.
  질문에 `$PREVIEW_DIR/preview.html` 의 절대경로를 담는다. dispatch 워커에는 다음 턴에 응답할 사용자가 없다.

dispatch 로 일을 받지 않았으면 위 절차대로 사용자가 읽고 응답한 다음 턴에 등록한다.
