# Phase 01. 보고서 검사 스크립트

**Execution profile**: standard

## 목표

report 스킬이 만든 HTML 한 파일이 깨지지 않았는지 판정하는 `report/scripts/check-report.py` 와 그 테스트를 만든다.
스펙 R2(외부 자원 없음), R7(태그 짝, 각주와 출처 짝), R3(슬러그 파일 이름)을 검사로 관측할 수 있게 한다.

**범위 외**: 공통 틀 HTML 과 구성 문서(phase 02), SKILL.md 와 플러그인 등록(phase 03).

## 컨텍스트

- 스펙: `docs/features/report/spec.md` 의 R2, R3, R7, D6, D11, D12.
- 같은 종류의 검사기 선례는 `presentation/scripts/check-deck.py` 다. Python 표준 라이브러리만 쓰고, 종료 코드는 0 통과, 1 위반, 2 검사기가 돌지 못함이다.
- CI 의 Python 작업은 `*/tests` 를 모두 `python3 -m unittest discover -s` 로 돈다(`.github/workflows/ci.yml`). 그래서 테스트는 `report/tests/` 에 두면 따로 등록하지 않아도 CI 가 돈다.
- `korean-check/scripts/check.sh` 는 `.md` 만 받는다. HTML 을 그대로 넘기면 태그 줄을 건너뛰어 금지어를 못 잡는다(2026-11-03 실측). 그래서 이 스크립트가 보이는 글만 뽑아 내는 모드를 함께 둔다.

**근거 문서**: `docs/features/report/spec.md` 의 「요구사항과 인수 조건」 R2, R3, R7 과 「결정」 D6, D11, D12

## 의도 메모

- HTML 파서는 `html.parser.HTMLParser` 를 쓴다. 새 의존을 들이지 않는다.
- 끝 태그를 생략할 수 있는 요소(`p`, `li`, `td` 등)도 짝을 요구한다. 틀이 모든 태그를 닫으므로 생략은 실수로 본다.
- 본문 `<a href="https://...">` 는 허용한다(D11). 불러오는 자원만 막는다. 상대 경로 자원도 한 파일이 아니게 만들므로 막는다. `data:` URI 는 허용한다.
- korean-check 를 직접 import 하지 않는다. 그 스킬은 팀 플러그인으로 따로 설치되고 내부 API 가 바뀔 수 있다. 글만 뽑아 `.md` 로 넘긴다.

## 작업 항목

### 1. `report/scripts/check-report.py`

- 사용법: `check-report.py <파일.html>` 은 검사, `check-report.py --text <파일.html>` 은 보이는 글을 한 덩어리에 한 줄씩 stdout 으로 낸다. `check-report.py --korean <파일.html>` 은 보이는 글을 임시 `.md` 로 써서 korean-check 의 `scripts/check.sh` 로 검사하고 그 종료 코드를 낸다.
- korean-check 는 `KOREAN_CHECK` 환경 변수, 이 스킬의 형제 디렉터리(`../korean-check`), `~/.claude/skills/korean-check` 순서로 찾는다(`content-preview/scripts/style-check.sh` 와 같은 순서). 플러그인 설치본은 저장소 전체를 복사하므로 형제 디렉터리에 있다. 못 찾으면 종료 코드 2 다.
- 검사 항목과 위반 출력 형식 `<파일>:<줄>: <종류>: <설명>`:
  - `tag`: 닫히지 않은 태그, 짝이 맞지 않는 끝 태그, 여는 태그 없는 끝 태그. void 요소(`meta`, `link`, `br`, `img`, `hr`, `input`, `source`, `wbr`, `col`, `area`, `base`, `embed`, `track`, `param`)는 짝을 요구하지 않는다.
  - `external`: 불러오는 자원의 주소가 `data:` 나 `#` 로 시작하지 않는다. 대상은 `script[src]`, `link[href]`, `img[src|srcset]`, `iframe[src]`, `source[src|srcset]`, `video[src|poster]`, `audio[src]`, `embed[src]`, `object[data]`, `input[type=image][src]`, `track[src]`, SVG 의 `image`, `use` 의 `href`, `base[href]`, 다른 주소로 넘기는 `meta http-equiv=refresh`, 그리고 `<style>` 과 `style` 속성 안의 `url(...)`, `@import`.
  - `ref`: `href="#x"` 인 링크의 대상 id 가 없다.
  - `source`: id 가 `src-` 로 시작하는 출처 항목을 가리키는 링크가 하나도 없다.
  - `id`: 같은 id 가 두 번 나온다.
  - `name`: 파일 이름이 `^[a-z0-9]+(-[a-z0-9]+)*\.html$` 가 아니다(R3 의 슬러그).
- 위반이 없으면 `통과: <파일>` 한 줄과 종료 코드 0. 위반이 있으면 1. 파일이 없거나 인자가 틀리면 2.
- `--text` 는 `script`, `style`, `code`, `pre` 안의 글을 빼고, 블록 요소(`p`, `li`, `td`, `th`, `h1`~`h4`, `summary`, `dt`, `dd`, `strong.hd` 를 포함한 블록 경계)마다 줄을 나눠 낸다. 빈 줄은 내지 않는다. 줄 머리가 `<`, `|`, `#` 이면 앞에 `\` 를 붙여 korean-check 가 HTML, 표 행, 제목으로 읽고 건너뛰지 않게 한다.
- 머리 docstring 에 사용법, 검사 항목, 종료 코드를 적는다.

### 2. 이 phase 를 검증하는 `report/tests/test_check_report.py`

`unittest` 와 `tempfile.TemporaryDirectory` 안에 `sample-report.html` 같은 고정 슬러그 이름으로 임시 HTML 을 써서 `subprocess` 로 스크립트를 부른다.

- 정상: 외부 링크 `<a href="https://example.com">` 와 `data:` 이미지, 짝이 맞는 각주가 있는 파일은 종료 코드 0.
- 외부 자원: `<script src="https://...">`, `<link rel="stylesheet" href="x.css">`, `<img src="a.png">`, `<style>` 안의 `url(https://...)` 와 `@import` 각각 종료 코드 1, 출력에 `external`.
- 태그: 닫지 않은 `<div>`, 엇갈린 `</span></div>` 는 종료 코드 1, 출력에 `tag`.
- 각주: 없는 id 를 가리키는 `#src-X` 링크, 아무도 가리키지 않는 `id="src-Y"`, 중복 id 는 각각 종료 코드 1.
- 이름: `My Report.html` 은 종료 코드 1, 출력에 `name`.
- 없는 파일은 종료 코드 2.
- `--text` 는 `<script>` 와 `<code>` 의 글을 내지 않고, 표 칸의 글을 줄마다 낸다. 줄 머리의 `<`, `|`, `#` 에 `\` 를 붙인다.
- `--korean`: korean-check 매핑 표의 금지어가 본문이나 표 칸에 있으면 종료 코드 1, 없으면 0. 형제 korean-check 가 없는 임시 위치에 스크립트를 복사하고 `HOME` 을 바꿔 부르면 종료 코드 2.

## 검증

```bash
python3 -m unittest discover -s report/tests
```

기대값: 모든 테스트 통과, 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `report/scripts/check-report.py` | 신규 |
| `report/tests/test_check_report.py` | 신규 |
