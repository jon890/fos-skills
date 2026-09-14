# korean-check

한국어로 내보내는 산출물을 내보내기 직전에 점검한다.

## 산출물

- 검사기 둘의 종료 코드. 0 이 아니면 걸린 파일과 줄 번호
- 검사기가 잡지 못하는 축의 발견 목록. 쓰지 않은 쪽이 읽고 낸다
- 반영하지 않은 발견과 그 이유

## 사용 시점

한국어 산출물이 이 세션 밖으로 나가는 순간이다.
파일, PR 본문, 커밋 메시지, 업무와 위키, 게시글, 아티팩트, 채팅 답변이 모두 대상이다.

**판정 기준은 이 스킬이 소유한다.** 다른 스킬은 여기를 가리킨다.

| 가리키는 쪽 | 어디서 |
| --- | --- |
| `content-preview` | 표기 검사 단계와 검토 단계 |
| 사용자 하네스 지침 | 한국어 산출물 점검 절 |

## 전제

- `bash` 와 `python3` 로 검사기를 돌린다. 검사기 둘 다 표준 라이브러리만 쓴다
- 매핑 표는 `references/korean-style.md` 다. 다른 위치의 표를 쓰려면 `KOREAN_STYLE_RULES` 로 경로를 준다

## 설치

스킬을 글로벌 스킬 디렉터리에 심링크한다.

```bash
ln -sfn ~/personal/fos-skills/korean-check ~/.claude/skills/korean-check
```

편집 훅에서 부르려면 검사기 둘도 함께 건다.
심링크로 걸면 스킬을 고칠 때 훅 설정을 다시 손대지 않는다.

```bash
ln -sfn ~/personal/fos-skills/korean-check/scripts/korean-style-check.py ~/.claude/scripts/korean-style-check.py
ln -sfn ~/personal/fos-skills/korean-check/scripts/check-readability.py ~/.claude/scripts/check-readability.py
```

`korean-style-check.py` 는 심링크를 실체까지 따라가 매핑 표를 찾는다.
훅에 넣을 설정은 `SKILL.md` 의 「훅에 걸기」가 소유한다.

규칙 파일을 항상 맥락에 두려면 규칙 디렉터리에도 건다.
그러면 스킬이 발동하지 않아도 판정 기준이 올라온다.

```bash
for f in korean-style writing-structure markdown-readability; do
  ln -sfn ~/personal/fos-skills/korean-check/references/$f.md ~/.claude/rules/$f.md
done
```

## 구성

| 파일 | 소유하는 것 |
| --- | --- |
| `SKILL.md` | 목표, 두 층의 구분, 검사기 실행법, 훅에 거는 방법 |
| `references/korean-style.md` | 어휘 매핑 표, 문장 구성, 출력 직전 점검, 용어를 옮기지 않는 기준 |
| `references/writing-structure.md` | 독자 구간, 분량 구간, 목록과 표로 나누는 방식, 내용 점검 |
| `references/markdown-readability.md` | 렌더링 함정, 자동 검사가 잡는 것과 잡지 못하는 것 |
| `references/review-axes.md` | 검토자에게 무엇을 주고 무엇을 받는가, 반영 통과 조건 |
| `scripts/check.sh` | 검사기 둘을 함께 돌리고 종료 코드 중 큰 값을 낸다. `--where` 로 이 스킬 경로를 낸다 |
| `scripts/korean-style-check.py` | 외래어 매핑 표의 금지어와 인라인 `+` 연결을 찾는다. 훅 모드를 갖는다 |
| `scripts/check-readability.py` | 괄호 중첩, `§`, 범위 물결표, 엠대시를 찾는다. 훅 모드와 문자열 모드를 갖는다 |
| `tests/test_korean_style_check.py` | 제외 규칙과 활용형마다 걸리는 표본과 걸리지 않는 표본을 함께 둔 검출력 검사 |
| `CHANGELOG.md` | 버전 이력 |

시험은 `python3 -m unittest discover -s korean-check/tests` 로 돌린다.

## 개인 문체 참조는 담지 않는다

사람마다 다른 습관은 이 스킬 밖에 둔다.
개인이 만들어 두는 파일이고, 없으면 그 점검을 건너뛴다.
어디에 두고 무엇을 적는지는 `content-preview` 의 `references/persona.md` 가 소유한다.
