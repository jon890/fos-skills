# gh 호출 예산

자동 조회로 GitHub 서버에 주는 부하를 줄이기 위한 규칙이다. 코디네이터와 worker 가 직접 CI 를 기다릴 때는
`gh pr checks --watch --interval 60` 이상을 쓴다. `gh run watch` 도 `--interval 60` 이상을 준다.

## 공유 캐시

orch 의 gh 실행은 `scripts/lib/gh.ts` 를 거친다. 같은 인자의 읽기 조회 결과를 orch 작업 폴더의
`state/gh/cache/` 에 저장한다. 같은 저장소의 워크트리와 프로세스가 잠금과 응답 파일을 함께 쓴다.
호스트, 저장소, 실행 파일과 인자가 다르면 다른 키다. PR 번호를 생략한 조회는 작업 폴더도 구분한다.

| 조회 | 기본 TTL | 이유 |
| --- | --- | --- |
| 표시·목록용 `pr view`, `pr list`, `pr checks`, `run list`, `run view` | 60초 | 같은 표시용 조회를 함께 쓴다 |
| 표시용 REST GET, GraphQL query | 60초 | 같은 API 조회가 겹치면 응답을 함께 쓴다 |
| 표시용 브랜치 규칙 GET | 300초 | 자주 바뀌지 않는 규칙을 함께 쓴다 |
| `repo view` | 300초 | 저장소 URL 은 PR 상태보다 드물게 바뀐다 |

실패 응답은 캐시하지 않는다. 표시용 `pr checks` 의 진행 중 응답(종료 코드 8)은 캐시한다.
GraphQL 은 인자에 직접 쓴 query 만 캐시한다. mutation 이거나 query 파일·stdin 처럼 읽기 여부를
확인할 수 없는 호출은 매번 실행한다. merge, create, comment, update-branch 등 쓰기는 캐시하지 않는다.
쓰기를 시도하면 해당 저장소의 캐시 전체를 비운다. PR 조회뿐 아니라 목록과 배포 조회도 새로 읽기 위해서다.
다른 도구가 바꾼 표시용 메타데이터는 TTL 이 지난 뒤 반영된다.

## 판정 조회

머지 큐와 CI 루프의 판정 읽기(체크 스냅샷, HEAD, mergeable, mergeStateStatus, 브랜치 비교·필수 규칙·리뷰 스레드, ready)는 표시 캐시를 쓰지 않거나 HEAD 별 스냅샷으로 짧게(진행 중이거나 비었으면 60초, 모두 끝났으면 300초) 공유한다. 실패로 멈추기 전, 대기 한도를 넘기기 전, 머지 직전에는 응답을 새로 읽는다. 분류와 규칙은 `scripts/lib/gh-budget.ts` 와 `scripts/lib/gh.ts` 의 `currentChecks` 머리 주석이 소유한다. 미해결 스레드 명령에도 `ORCH_GH_CACHE=0` 을 넘긴다.

- `ORCH_GH_CACHE=0`: 캐시를 끈다.
- `ORCH_GH_CACHE_TTL_SECONDS`: 읽기 조회의 TTL 을 초 단위로 바꾼다. `0` 은 끄기다.
- `ORCH_DIR`: 기존 orch 경로 규칙대로 캐시와 기록의 루트를 바꾼다.

응답 파일은 소유자만 읽고 쓸 수 있게 만들고 기록에는 인자·응답·인증값을 남기지 않는다. 캐시 폴더를 쓸 수 없으면 gh 를 직접 실행한다.

## 폴링과 측정

`finish-pr --poll-interval` 기본값은 60초다. 배포 대기는 60, 120, 240, 최대 300초로 늘린다.
명시한 간격이 60초보다 짧으면 그 값을 따른다. 머지 큐의 CI 대기도 같은 방식으로 늘리며,
기존 대기 시간 제한이 먼저 오면 남은 시간만 기다린다.

호출마다 `state/gh/logs/YYYY-MM-DD.jsonl` 에 UTC 날짜별로 줄을 더한다.
각 줄의 `time`, `command`, `durationMs`, `cacheHit` 는 시각, 명령 종류, 잠금 대기를 포함한 시간, 캐시 적중 여부다.
캐시 적중 줄은 실제 gh 프로세스를 띄우지 않은 조회다. 기록 파일은 자동 삭제하지 않는다.

```bash
orch doctor gh-usage --repo "$REPO"
```

출력은 `GH-USAGE last-hour calls=... cache-hits=...` 다. 최근 한 시간의 실제 호출과 캐시 적중을 나눠 센다.
실측을 비교할 때는 같은 PR, 같은 시간, 같은 동시 프로세스 조건을 쓴다. 재현하지 못하면 테스트에서 센 호출 수임을 밝힌다.
