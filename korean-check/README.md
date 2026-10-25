# korean-check

한국어 글을 내보내기 전에 어색한 말과 번역투를 한 줄씩 찾아 고치는 수고를 덜어 준다.
누가 봐도 어색한 음차와 비유어, 지어낸 번역어는 검사기가 종료 코드 1 로 막고, 문장 구성 일부는 경고로 알린다.
검사기가 판정하지 못하는 것은 축 목록으로 본문을 읽어 발견과 확인한 범위를 남긴다.

판정 기준은 이 스킬이 소유하고 다른 스킬은 여기를 가리킨다.
가리키는 문서는 `grep -rl korean-check --include='*.md' .` 로 찾는다.

## 이럴 때 쓴다

- PR 본문, 커밋 메시지, 업무와 위키, 게시글처럼 한국어 글이 이 세션 밖으로 나가기 직전이다
- 여러 사람이 함께 고치는 기존 문서에서 이번에 더한 줄만 점검하고 싶다
- 업무 제목이나 커밋 메시지처럼 파일이 아닌 한 줄을 점검하고 싶다
- 편집할 때마다 `.md` 파일을 자동으로 검사하고 싶다

"korean-check 로 점검해줘", "올리기 전에 한국어 점검해줘" 처럼 말하면 이 스킬이 뜬다.
한국어 글을 내보내는 순간이 모두 대상이라 이름을 말하지 않아도 불릴 수 있고, `content-preview` 처럼 글을 올리는 다른 스킬이 이 스킬의 검사기를 부르기도 한다.

## 사용 예시

파일 이름과 줄 번호는 예시다.

```text
나:   PR 본문 올리기 전에 한국어 점검해줘

스킬: 검사기를 돌렸습니다. 종료 코드 1 입니다.
        pr-body.md:12  금지어 "스파이크". 권장 표현은 사전 조사, 탐색 작업, 실증
        pr-body.md:20  경고 [DASH] 평문의 엠대시
      금지어를 "사전 조사" 로 고치고 엠대시를 콜론으로 바꿔 다시 돌렸습니다. 종료 코드 0 입니다.
      검사기가 잡지 못하는 축으로 본문 전체와 제목을 읽었습니다.
        14줄  문장 성분: 무엇이 바뀌는지 주어가 없다. 고쳤습니다
        22줄  지어낸 이름: 저장소에 없는 번역어다. 원어로 되돌렸습니다
      반영하지 않은 발견은 없습니다.

나:   팀 위키 문서에서 내가 고친 절만 봐줘

스킬: 이번에 더한 줄만 판정했습니다.
        이번 변경  발견 없음. 종료 코드 0
        기존 줄    금지어 2곳. 손대지 않은 문장이라 범위 밖 발견으로 남깁니다
```

## 받는 것

- 검사기의 종료 코드. 1 이면 금지어가 걸린 파일과 줄 번호, 권장 표현이 함께 나온다
- 경고 줄. 실패로 막지 않으며 문맥을 보고 고칠지 판단한다
- 검사기가 잡지 못하는 축의 발견 목록과 확인한 범위
- 반영하지 않은 발견과 그 이유
- `--diff` 로 돌렸으면 손대지 않은 기존 줄의 발견을 범위 밖 발견으로 따로 받는다

## 준비

`bash` 와 `python3` 가 필요하다. 검사기는 표준 라이브러리만 쓴다.
매핑 표는 `references/korean-style.md` 다. 다른 위치의 표를 쓰려면 `KOREAN_STYLE_RULES` 로 경로를 준다.

금지어를 품은 고유명사가 있는 저장소는 `.claude/korean-check-allow.txt` 에 한 줄에 하나씩 적는다.
검사기는 그 문자열 안의 발견을 건너뛰고, 문자열 밖의 금지어는 그대로 잡는다.

### 링크 설치

스킬을 글로벌 스킬 디렉터리에 심링크한다. `$CHECKOUT` 은 이 저장소를 체크아웃한 경로다.

```bash
ln -sfn "$CHECKOUT"/korean-check ~/.claude/skills/korean-check
```

편집 훅에서 부르려면 검사기 둘도 함께 건다.
심링크로 걸면 스킬을 고칠 때 훅 설정을 다시 손대지 않는다.

```bash
ln -sfn "$CHECKOUT"/korean-check/scripts/korean-style-check.py ~/.claude/scripts/korean-style-check.py
ln -sfn "$CHECKOUT"/korean-check/scripts/check-readability.py ~/.claude/scripts/check-readability.py
```

`korean-style-check.py` 는 심링크를 실체까지 따라가 매핑 표를 찾는다.

규칙 파일을 항상 맥락에 두려면 규칙 디렉터리에도 건다.
그러면 스킬이 발동하지 않아도 판정 기준이 올라온다.

```bash
ln -sfn "$CHECKOUT"/korean-check/references/korean-style.md ~/.claude/rules/korean-style.md
```

**`korean-style.md` 하나만 건다.** 어휘와 문장 구성, 짧은 글 규칙은 채팅 답변에도 적용되므로 항상 실려야 한다.
`writing-structure.md` 와 `korean-examples.md` 는 문서를 쓰거나 검토할 때,
`markdown-readability.md` 는 검사기를 돌릴 때만 쓰여 스킬이 발동할 때 읽는다.

### 훅 설정

Claude Code 는 `~/.claude/settings.json` 의 `hooks` 에 아래를 넣는다.

```json
"PostToolUse": [{
  "matcher": "Edit|Write|MultiEdit",
  "hooks": [
    { "type": "command", "command": "~/.claude/scripts/korean-style-check.py --hook", "timeout": 15 },
    { "type": "command", "command": "~/.claude/scripts/check-readability.py --hook", "timeout": 15 }
  ]
}]
```

훅은 작업을 막지 않고 발견만 알린다. 훅이 놓치는 파일과 훅 모드의 동작은 `references/markdown-readability.md` 가 소유한다.

## 함께 쓰는 스킬

- 외부에 올릴 본문을 매체별로 렌더링해 보여 주는 일은 `content-preview` 가 맡는다. 매체별 렌더링 함정도 그 스킬의 `references/render-traps.md` 가 정한다
- 사람마다 다른 문체 습관은 이 스킬이 다루지 않는다. 개인 문체 참조를 어디에 두고 무엇을 적는지는 `content-preview` 의 `references/persona.md` 가 정한다
