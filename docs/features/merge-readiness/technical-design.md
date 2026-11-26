# orch 머지 판단 하나로 모으기 기술 설계

스펙: [spec.md](spec.md)

코드 기준은 main `2861cae8` 이다. module, interface, depth, seam, adapter, leverage, locality 는 deep module 설계의 용어 그대로 쓴다.

## 요구사항 연결

| ID | 해결 방법 | PR |
| --- | --- | --- |
| REQ1 | 조건을 `core/merge-readiness.ts` 의 조건 표 하나에 둔다. 관문, 머지 큐, 루프는 `lib/merge-readiness.ts` 의 `checkReadiness` 를 부르고 범위(`light`, `full`)만 고른다. 체크 상태도 `core/checks.ts` 의 `judgeChecks` 하나가 정한다 | PR1, PR2, PR3 |
| REQ2 | 조건마다 단계(`ready`, `merge`)를 둔다. 보류 세 가지(지시서, PR 본문, 보드)는 `merge` 단계다. 관문은 `ready` 단계 이유로만 실패하고 `merge` 단계 이유를 `HOLD` 줄로 낸다. 머지 큐와 루프는 두 단계 이유 모두에 멈춘다. 머지 큐가 보드 보류를 읽기 시작한다 | PR5 |
| REQ3 | 조건 표의 `draft` 조건을 관문과 머지 큐에도 적용한다. 지금은 루프만 본다. 예외를 두지 않으므로 「draft 로 CI 미루기」 옵션을 먼저 없앤다(아래 「draft 로 CI 를 미루는 옵션 제거」) | PR4, PR5 |
| REQ4 | `judgeChecks` 가 지금 HEAD 의 체크가 하나도 없으면 `none` 을 낸다. 설정 `queue.allow_no_checks` 가 true 일 때만 통과로 본다. 체크 대기(`waitChecks`)도 같은 함수를 써서 첫 체크가 나타날 때까지 기다린다 | PR6 |
| REQ5 | 조건 표의 `review-config` 조건을 「루프가 스스로 거는 머지」(`ask.auto`)에만 적용하고, 기능 PR 인지는 더 이상 보지 않는다 | PR7 |
| REQ6 | snapshot 의 값마다 읽은 시점의 HEAD 를 함께 두고, 판단 대상 HEAD 와 다르면 다른 이유를 버리고 `head` 이유 하나만 낸다. 루프의 PR 조회에서 gh 캐시를 끈다 | PR7 |

## 지금 구조와 문제

같은 질문을 세 곳이 따로 답한다.

| 자리 | 지금 보는 것 | 다른 곳과 다른 점 |
| --- | --- | --- |
| `queue/steps/gate.ts` 의 `gateReasons`(관문, 머지 큐) | 체크, 미해결 스레드, 충돌, 리뷰, 통합 테스트 기록, 마이그레이션 base 번호, 비공개 낱말. 보류는 `steps/spec-hold.ts` 가 따로 본다 | draft 와 보드 보류를 보지 않는다. 체크는 jq 문자열(`steps/model.ts`)로 판단한다 |
| `loop/steps/auto-merge.ts` 의 `judgeTarget`(루프) | draft, 체크, 이미 건 HEAD, 보류 세 가지, 미해결 스레드, 기능 PR 의 리뷰 설정, 리뷰 | 체크는 TS(`lib/gh.ts` 의 `ciState`)로 판단한다. PR 조회에 캐시를 쓰고 HEAD 를 비교하지 않는다 |
| `queue/steps/checks.ts` 의 `waitChecks` | 체크 대기 | 필수 체크 이름을 `lib/gh.ts` 의 `requiredNames` 와 다른 코드로 읽는다 |

조건 하나를 고치면 위 자리들을 함께 고쳐야 했다. 스레드 기본 명령(`steps/setup.ts`, `auto-merge.ts`)과 PR 본문 보류 읽기도 두 벌이다.
`finish-pr.ts` 는 머지된 뒤에 돌아 머지 전 조건을 보지 않는다. 기능 PR 인지(`featureBranch`)로 마무리 실패 처리만 바꾼다.

## 책임과 경계

```text
호출부: queue/gate.ts, queue/steps/merge.ts, loop/steps/auto-merge.ts
  └─ lib/merge-readiness.ts      snapshot adapter. gh, git, 보드, 지시서, 설정을 읽어 snapshot 값을 채운다
       └─ core/merge-readiness.ts  조건 표와 판단. snapshot 값을 받아 이유 목록이나 「더 읽을 값」 을 낸다
            ├─ core/checks.ts              체크 상태 판단(judgeChecks)
            ├─ core/auto-merge.ts          리뷰 판단(judgeReview), 보류 줄 읽기, 마이그레이션 번호 판단
            └─ core/integration-evidence.ts 통합 테스트 기록 판단
```

| module | 맡는 일 | 맡지 않는 일 |
| --- | --- | --- |
| `core/merge-readiness.ts`(신규) | 조건 표(조건마다 종류, 단계, 범위, 필요한 값, 판단 함수, 문구), snapshot 과 이유의 타입, 조건을 도는 순서와 범위·`only`·`skip`·`stopAtFirst` 의 적용, 보드 항목 찾기(이미 읽은 항목 목록을 받는 순수 함수) | gh, git, 파일을 읽지 않는다([ADR-028](../../adr/028-orch-core-layer.md)) |
| `core/checks.ts`(신규) | 롤업 행 고르기(`currentChecks`), 실패·진행 중·미등장·없음 판단(`judgeChecks`). `lib/gh.ts` 의 `ciState`, `requiredCiState`, `currentChecks` 는 이 파일을 다시 내보낸다 | 필수 체크 이름 조회 |
| `lib/merge-readiness.ts`(신규) | 값 하나하나를 읽는 함수, core 가 달라는 값만 읽어 다시 묻는 반복, `checkReadiness`. 스레드 기본 명령, mergeable `UNKNOWN` 재시도, 비공개 낱말로 이유 가리기도 여기 둔다 | 조건의 뜻과 순서. 조건을 더하거나 빼지 않고 표를 따로 돌지 않는다 |
| `queue/steps/gate.ts` | `gateReasons` 가 `checkReadiness` 를 부르는 얇은 함수가 된다. 이유 종류를 머지 큐의 동작(충돌 처리, worker 알림, 일반 보류)으로 옮기는 `holdWith` 는 남는다 | 조건 판단 |
| `queue/steps/checks.ts` | 체크를 기다리는 일. 끝났는지는 `judgeChecks` 로 본다 | 실패·진행 중·미등장의 정의 |
| `queue/steps/spec-hold.ts` | 지시서 찾기(`specTargets`). 보류 판단(`mergeHold`, `refuseSpecHold`)은 `checkReadiness` 호출로 바뀐다 | 보류 판단 |
| `loop/steps/auto-merge.ts` | 대상 고르기, 이미 건 HEAD 기록, 마이그레이션 순서, 큐 띄우기, 알림 | PR 하나가 준비됐는지의 판단 |

module 을 하나로 묶는 근거는 deletion test 다. `core/merge-readiness.ts` 를 지우면 조건 목록이 관문, 머지 큐, 루프 세 곳에 다시 흩어진다.
호출부가 배울 것은 `checkReadiness(대상, 질문)` 하나와 이유의 종류·단계뿐이고, 조건이 몇 개인지와 무엇을 읽는지는 몰라도 된다.

seam 은 snapshot 값이다. 값을 만드는 쪽이 실제로 둘이라 가상의 seam 이 아니다.
하나는 gh 와 git 을 직접 읽는 길이고(관문, 머지 큐), 하나는 루프가 틱에서 이미 읽은 값(열린 PR 목록, 롤업, 지시서, 보드)과 루프의 읽기 함수를 넘기는 길이다. 테스트는 세 번째로 값을 직접 만든다.

### 호출부가 바뀌는 모양

| 호출부 | 지금 | 바뀐 뒤 |
| --- | --- | --- |
| `orch queue gate` | `loadPr` → (`--wait` 면 `waitChecks`) → `gateReasons` → `mergeHold` 로 `HOLD` 한 줄 | `loadPr` → (`--wait` 면 `waitChecks`) → `checkReadiness(full)`. `ready` 단계 이유가 있으면 `GATE-FAIL`, `merge` 단계 이유는 `HOLD` 줄 |
| 머지 큐 차례 시작 | `refuseSpecHold` | `checkReadiness(full, only: hold·draft)`. base 최신화와 체크 대기 전에 빨리 멈춘다 |
| 머지 큐 체크 대기 실패 뒤 | `gateReasons('none')` | `checkReadiness(full, skip: ci)`. 체크 이유는 대기가 낸 것을 쓴다 |
| 머지 큐 머지 전 | `gateReasons('failed')` → `holdWith` | `checkReadiness(full)` → `holdWith` |
| 머지 큐 머지 직전(base 재판정 루프 안) | HEAD 다시 읽기, 체크를 캐시 없이 다시 읽기, `migrationReasons` | `checkReadiness(full, only: ci·migration, fresh)`. 캐시 없이 읽은 체크 값에 HEAD 가 붙어 있어 HEAD 변경도 이 호출에서 함께 걸린다. 원격 브랜치 HEAD 대조는 머지 큐에 남는다 |
| 머지 큐 `gh pr merge` 바로 앞 | 중단 확인, 큐 잠금 확인, `refuseSpecHold` | 같은 자리에서 `checkReadiness(full, only: hold·draft)`. 보류 확인이 지금처럼 마지막 확인이다 |
| 루프 자동 머지 | `judgeTarget` 이 차례로 보고 첫 이유에서 멈춤 | `checkReadiness(light, auto, stopAtFirst, skip: migration)`. 틱이 읽은 값과 루프의 읽기 함수는 `known` 으로 넘긴다 |
| `finish-pr.ts` | 머지 전 조건을 보지 않는다 | 바뀌지 않는다(DECISION8) |
| 루프 CI 감시(`loop/steps/ci.ts`) | `ciState` | 같은 함수 이름으로 `judgeChecks` 를 쓴다. PR6 전까지 출력과 이벤트는 그대로다 |

## 인터페이스와 데이터

### 질문과 답

```ts
// lib/merge-readiness.ts
checkReadiness(target: PrTarget, ask: ReadinessAsk, read?: ReadOptions): Promise<Readiness>

type PrTarget = { repo: string; number: number; head: string; base: string; branch: string; host: string; slug: string; draft: boolean }
type ReadinessAsk = {
  scope: 'light' | 'full'
  auto?: { attempted: boolean }   // 루프가 사람 지시 없이 머지를 걸 때만 준다
  only?: ReasonKind[]             // 이 종류의 조건만 본다
  skip?: ReasonKind[]             // 이 종류는 부르는 쪽이 이미 판단했다
  stopAtFirst?: boolean           // 첫 이유에서 멈추고 뒤 조건의 값은 읽지 않는다
  fresh?: boolean                 // 체크를 HEAD 별 공유 캐시 없이 읽는다
}
type ReadOptions = {
  known?: { [K in FactName]?: Fact<Facts[K]> | (() => Fact<Facts[K]> | Promise<Fact<Facts[K]>>) }
  threadsCmd?: string; required?: string[]; allowFail?: string[]
  retries?: number; retrySeconds?: number; nap?: (seconds: number) => Promise<void>
}

type Reason = { code: string; kind: ReasonKind; stage: 'ready' | 'merge'; text: string; wait?: string }
type Readiness = { reasons: Reason[]; notes: string[]; summary: string; basis: string | null; snapshot: ReadinessSnapshot }
```

- 대상 HEAD 는 호출부가 정해 넘긴다. 머지 큐는 `loadPr` 가 읽은 HEAD 이고 루프는 그 틱의 열린 PR 목록에 있는 HEAD 다. 이미 MERGED 이거나 OPEN 이 아닌 PR 은 호출부가 지금처럼 먼저 처리한다.
- `Reason.kind` 는 지금의 `GateKind` 에 `draft`, `hold`, `attempted`, `head` 를 더한 것이다. `code` 는 `ci-failed`, `ci-pending`, `ci-none`, `hold-spec`, `hold-body`, `hold-board`, `review-missing` 처럼 더 잘게 나눈 이름이다. 호출부와 테스트는 문구가 아니라 `kind` 와 `code` 로 나눈다.
- `text` 는 관문과 머지 큐가 내는 문구이고 `wait` 는 루프의 대기 문구다. 두 문구를 조건 옆에 함께 둔다.
- `notes` 는 막지 않고 보이기만 하는 줄(통합 테스트 생략), `summary` 는 큐 로그의 `fails=0 threads=0 mergeable=MERGEABLE`, `basis` 는 리뷰 통과 근거(`AUTO-MERGE-BASIS`)다.
- `blocksReady(readiness)` 는 `ready` 단계 이유가 있는지, `blocksMerge(readiness)` 는 이유가 하나라도 있는지다. `merge` 단계에서 막는 조건은 `ready` 단계 조건을 모두 포함한다.
- `fresh` 는 머지 큐의 머지 직전 확인과 `waitChecks` 의 마지막 재확인이 반드시 켠다. 같은 HEAD 에서 체크만 다시 돌렸을 때 캐시에 남은 완료 결과로 머지하지 않게 하는 지금 동작(`field(..., true)`)이다.
- `known` 의 값은 이미 읽은 값이거나 그 값을 읽는 함수다. 함수는 core 가 그 값을 달라고 할 때만 불린다. 루프가 자기 방식으로 읽던 값(스레드, PR 조회)을 PR3 에서 그대로 넘기는 자리다.
- `allowFail`, `required`, `threadsCmd` 는 머지 큐 옵션에서 온다(스펙 DECISION10). 루프는 `allowFail` 을 주지 않는다. `nap` 은 머지 큐의 `MERGE_QUEUE_SLEEP_SCALE` 을 따르는 대기 함수다.

### 판단과 읽기가 만나는 방식

조건을 도는 코드는 core 한 곳에만 둔다.

```ts
// core/merge-readiness.ts
judgeReadiness(snapshot, policy, ask): { reasons: Reason[]; need: FactName[]; notes: string[]; summary: string; basis: string | null }
```

core 는 조건을 순서대로 보다가 snapshot 에 없는 값을 만나면 그 이름을 `need` 로 돌려준다.
`stopAtFirst` 면 지금 조건에 필요한 값만, 아니면 범위 안의 모든 조건에 필요한 값을 한 번에 돌려준다.
`checkReadiness` 는 `need` 의 값을 읽어 snapshot 에 채우고 다시 묻기를 `need` 가 빌 때까지 되풀이한다. 범위, `auto`, `only`, `skip`, `stopAtFirst`, 조회 실패의 단계 규칙은 lib 에 다시 쓰지 않는다.
`need` 가 여럿일 때 lib 가 읽는 순서는 지금 `gateReasons` 의 gh 호출 순서다.

### snapshot

snapshot 은 PR 하나에 대해 읽은 값의 묶음이다.

```ts
type Fact<T> = { ok: true; value: T; head?: string } | { ok: false; error: string; wait?: string }
type ReadinessSnapshot = { pr: { number: number; head: string; base: string; draft: boolean }; facts: Partial<Facts> }
```

| 값 | 내용 | 읽는 곳 | 범위 |
| --- | --- | --- | --- |
| `checks` | 지금 HEAD 의 롤업 행과 필수 체크 이름 | gh PR 조회(HEAD 별 공유 캐시 `checkSnapshot`, `fresh` 면 캐시 없이), 저장소 규칙 API. 루프는 틱의 롤업과 CI 감시가 읽은 이름을 넘긴다 | light |
| `specHold` | 지시서의 `머지 보류:` 이유 | 지시서 파일(`specTargets`) | light |
| `boardItems` | 보드 항목 목록 | 보드 파일을 한 번 읽는다. 파일이 없으면 빈 목록이다. 이 PR 의 항목 찾기와 `머지 보류` 줄 읽기는 core 가 한다 | light |
| `threads` | 미해결 리뷰 스레드 수 | 스레드 명령 | light |
| `holdBody` | PR 본문의 `머지 보류:` 이유 | gh PR 조회(`body`), 캐시 없음 | light |
| `reviewRollup` | 리뷰 체크를 볼 롤업 | gh PR 조회(`statusCheckRollup,headRefOid`), 캐시 없음. 리뷰 설정이 없으면 읽지 않는다 | light |
| `receipts` | 믿는 봇의 영수증 목록이나 봇이 거절한 이유 | `lib/review-bot.ts`. 리뷰 체크가 이미 success 면 읽지 않고 빈 목록이다 | light |
| `files` | 바뀐 파일 목록 | gh PR 조회(`files,headRefOid`), 캐시 없음 | light |
| `baseMigrations` | base 의 모듈별 최고 마이그레이션 번호 | git fetch 와 ls-tree. 이 PR 이 더한 마이그레이션이 없으면 읽지 않는다 | light |
| `mergeable` | `MERGEABLE`, `CONFLICTING`, 그 밖 | gh PR 조회. `UNKNOWN` 이면 20초 간격으로 네 번까지 다시 읽는다 | full |
| `body` | PR 본문 | gh PR 조회(`body,headRefOid`), 캐시 없음 | full |
| `integrationFiles` | 통합 테스트 규칙을 볼 바뀐 파일(옛 경로 포함) | REST. 규칙이 없으면 읽지 않는다 | full |
| `acceptedCommits` | 통합 테스트 기록의 커밋 가운데 지금 HEAD 로 인정되는 것 | core 의 `integrationCandidates(body, head, needs)` 가 확인이 필요한 커밋만 고르고 lib 가 그 커밋만 git 으로 확인한다(`acceptsVerifiedCommit`) | full |
| `privateWords` | 본문, 댓글, 리뷰에서 찾은 위치와 읽지 못한 곳 | REST 세 곳. 목록이 비었거나 비공개 저장소면 읽지 않는다 | full |

- gh PR 조회는 지금 호출 단위 그대로 값 하나에 한 번이다(DECISION9). 루프는 한 번의 조회(`statusCheckRollup,files,body,headRefOid`)로 `holdBody`, `reviewRollup`, `files` 를 함께 채우는 읽기 함수를 `known` 으로 넘긴다. 지금 루프의 호출 수가 그대로다.
- `ok: false` 는 조회 실패다. 그 값을 쓰는 조건이 범위에 있으면 `lookup` 이유가 값 하나에 한 번 나온다. 단계는 그 값을 쓰는 조건 가운데 가장 이른 단계다(스펙 DECISION11). `wait` 가 있으면 루프는 그 문구로 대기 줄을 쓴다.
- adapter 가 모르는 값 이름을 core 가 달라고 하면 lib 는 `ok: false` 를 채운다. 빠뜨린 값이 통과로 읽히지 않는다.
- `receipts` 는 세 갈래다. 영수증 목록, 봇이 남긴 거절(지적, 봇의 미해결 줄 댓글)과 조회 실패다. 거절은 `ok: true` 의 값이고 `review` 이유가 된다. 조회 실패는 `ok: false` 에 `wait` 를 함께 두어 루프에서 지금처럼 대기 줄로 남는다.
- `head` 는 그 값을 읽을 때 gh 가 돌려준 HEAD 다. `pr.head` 와 다른 값이 하나라도 있으면 core 는 다른 이유를 모두 버리고 `head` 이유 하나만 돌려준다(REQ6). 옛 HEAD 로 읽은 충돌이나 스레드로 큐에서 빼거나 worker 에게 알리지 않게 한다.
- 보류 이유는 adapter 가 읽을 때 비공개 낱말을 위치로 바꾼다(`redactLine`). 나머지 이유 문구는 `checkReadiness` 가 돌려주기 직전에 가린다(`mask`).
- 지시서 폴더와 보드 파일은 「없음」 과 「읽지 못함」 을 구분한다. 없으면 보류 없음이고 읽지 못하면 `ok: false` 다. 지금 `specFiles` 와 `findBoardItems` 는 읽기 실패를 빈 결과로 돌려주므로, `specTargets` 가 읽지 못한 폴더를 함께 돌려주게 넓힌다(PR5).

### 조건 표

「평가」 는 core 가 조건을 보는 순서이고 루프가 지금 보는 순서다. 값을 읽는 비용이 낮은 순서이기도 해서, `stopAtFirst` 로 물으면 앞 조건에 걸린 PR 은 gh 를 부르지 않는다.
「출력」 은 `Readiness.reasons` 에 넣는 순서이고 지금 `gateReasons` 가 이유를 모으는 순서다. 관문의 이유 줄과 머지 큐의 STOP 문구가 지금 순서로 나온다.

| 평가 | 출력 | code | kind | 단계 | 범위 | 관문·머지 큐 문구(`text`) | 루프 대기 문구(`wait`) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | `draft` | draft | ready | light | `draft PR 이다` | `draft` |
| 2 | 2 | `ci-failed` | ci | ready | light | `실패한 체크 <n> 개` | `CI failed` |
| 2 | 2 | `ci-pending` | ci | ready | light | `체크가 아직 끝나지 않았다(진행 중 <n>, 나타나지 않은 필수 체크 <이름>)` | `CI pending` |
| 2 | 2 | `ci-none` | ci | ready | light | `PR 에 CI 체크가 하나도 없다` | `CI pending` |
| 3 | 없음 | `attempted` | attempted | merge | light, auto 만 | 없음 | `이미 건 HEAD` |
| 4 | 9 | `hold-spec` | hold | merge | light | `<이유>` | `지시서 보류: <이유>` |
| 5 | 11 | `hold-board` | hold | merge | light | `보드 보류: <줄>` | `보드 보류: <줄>` |
| 6 | 없음 | `review-config` | review | merge | light, auto 만 | 없음 | `자동 머지는 queue.auto_review 의 trusted_bots 나 review_checks 가 필요하다` |
| 7 | 3 | `threads` | threads | ready | light | `미해결 리뷰 스레드 <n> 개` | `미해결 스레드 <n>` |
| 8 | 10 | `hold-body` | hold | merge | light | `<이유>` | `PR 본문 보류: <이유>` |
| 9 | 5 | `review-missing`, `review-wait` | review | ready | light | `HEAD <앞 8자리> 에 <없는 것>이 없다` 나 봇이 거절한 이유 | 같다 |
| 10 | 7 | `migration` | migration | ready | light | 지금 문구 그대로 | 루프는 묻지 않는다(DECISION5) |
| 11 | 4 | `conflict`, `mergeable` | conflict, mergeable | ready | full | 지금 문구 그대로 | 없음 |
| 12 | 6 | `evidence` | evidence | ready | full | 지금 문구 그대로 | 없음 |
| 13 | 8 | `private` | private | ready | full | 지금 문구 그대로 | 없음 |

- `head` 는 표의 조건이 아니다. HEAD 가 붙은 값이 snapshot 에 들어올 때마다 core 가 먼저 보고, 다르면 조건을 더 보지 않는다. 문구는 `검사 중 HEAD 가 바뀌었다 checked=<8자리> now=<8자리>` 이고 `wait` 는 `HEAD 가 바뀌었다` 다.
- 리뷰 설정이 없으면 9번은 보지 않는다. 8번은 그때만 걸린다.
- `review-config` 는 PR7 부터 보드 보류 바로 뒤, 스레드 조회 앞에서 본다(DECISION11).
- 체크의 조회 실패는 `wait` 를 따로 둔다. 필수 체크 규칙을 읽지 못했으면 `CI 규칙을 읽지 못했다`, 그 틱의 CI 감시가 값을 주지 않았으면 `CI 없음` 이다. 지금 문구와 같다.

### 체크 판단

```ts
// core/checks.ts
judgeChecks(rows, { required, allowFail, allowNoChecks }):
  { state: 'passed' | 'failed' | 'pending'; failed: string[]; allowedFailed: string[]; pending: number; missing: string[]; none: boolean; checks: CiCheck[] }
```

머지 큐의 jq(`FAIL_SEL`, `PENDING`, `ROLL_NAMES`, `state.q`)와 `lib/gh.ts` 의 `ciState` 가 이 함수 하나로 합쳐진다.
`none` 은 남은 행이 하나도 없다는 뜻이고, `allowNoChecks` 가 false 면 `pending` 이다. 필수 체크 이름이 있는데 체크가 없으면 지금처럼 미등장이다. 결론이 SKIPPED 인 필수 체크도 나타난 체크로 센다.
필수 체크 이름은 머지 큐도 `lib/gh.ts` 의 `ruleChecks` 로 읽는다. `--required` 가 있으면 지금처럼 그 값을 쓰고 규칙 API 를 부르지 않는다.
`ruleChecks` 는 플랜 제한으로 빈 목록을 돌려줬는지를 함께 알려 주게 넓혀 머지 큐의 경고 로그를 유지한다. 규칙 출력을 해석하지 못한 경우는 지금처럼 예외로 올린다.
체크가 끝난 시각을 읽는 jq(`SETTLED_JQ`, `RUNNING_SINCE_JQ`)는 기다리는 간격을 정할 뿐 판단이 아니라 그대로 둔다.
work-board 의 `ciPassed` 는 이번에 바꾸지 않는다(스펙 DECISION9).

체크가 하나도 없을 때 `waitChecks` 는 지금의 「필수 체크가 나타나지 않는다」 와 같은 한도(`--missing-timeout`)를 쓴다.
넘으면 `진행 중인 체크가 없는데 CI 체크가 <n>분째 하나도 나타나지 않는다. CI 가 없는 저장소면 queue.allow_no_checks 를 켠다` 로 멈춘다(PR6).

### 루프의 대기 문구

루프는 `checkReadiness(light, auto, stopAtFirst, skip: migration)` 가 돌려준 첫 이유의 `wait` 를 `AUTO-MERGE-WAIT #<PR> <wait>` 로 쓴다. 줄의 꼴과 한 PR 에 한 줄이라는 점이 지금과 같다.

- 평가 순서가 지금 `judgeTarget` 의 순서와 같아 같은 PR 에 같은 문구가 나온다.
- `wait` 가 없는 `lookup` 이유(스레드 명령 실패, PR 조회 실패)는 지금처럼 `errors` 에 넣어 `WATCH-ERROR auto-merge` 로 낸다. 문구는 루프가 `known` 으로 넘긴 읽기 함수가 지금 글자 그대로 만든다(`#<PR> 의 미해결 스레드를 읽지 못했다(…)`).
- `review-missing` 이면 지금처럼 `AUTO-MERGE-NO-REVIEW` 를 HEAD 마다 한 번 보낸다. HEAD 가 바뀐 것이 먼저 걸리므로 옛 HEAD 로 이 알림을 보내지 않는다.
- 보드 파일을 읽지 못하면 지금처럼 그 틱의 자동 머지 전체를 건너뛴다. 루프가 틱에 한 번 읽은 항목 목록을 `known` 으로 넘긴다. 지금은 PR 마다 `findBoardItems` 가 파일을 다시 읽는데, 그 읽기가 없어진다.
- `lib/board-queries/board-merge-queue.ts` 의 줄 파싱은 고치지 않는다. work-board 의 `WAIT_TEXTS` 는 PR7 이 「리뷰 설정 없음」 정규식 한 줄만 `^(?:기능 )?자동 머지는 queue\.auto_review` 로 넓힌다. 창 표시는 지금처럼 「독립 리뷰 설정 없음」 이다(스펙 DECISION13).
- 테스트 하나가 조건 표의 `wait` 문구를 고정 목록과 대조하고, 그 목록의 문구가 `WAIT_TEXTS` 의 정규식에 맞는지 본다. 정규식이 없어 창에 그대로 보이는 문구(`PR 본문 보류: …`, `HEAD 가 바뀌었다`)는 같은 테스트에 따로 적어 둔다. 문구를 바꾸면 이 테스트가 먼저 실패한다.

### 관문과 머지 큐의 출력

| 경우 | 관문 | 머지 큐 |
| --- | --- | --- |
| `head` 이유 | `GATE-FAIL` 과 그 이유 하나 | `holdWith` 가 가장 먼저 보고 다시 시도할 수 있는 보류(`HeadChanged`)로 던진다 |
| `ready` 단계 이유 | `GATE-FAIL <PR>` 과 이유 줄. 지금과 같다 | `holdWith` 가 종류로 나눈다. `conflict` 는 충돌 처리, `threads`·`evidence`·`migration`·`private` 는 worker 알림, `draft` 와 나머지는 일반 보류다 |
| `merge` 단계 이유(`hold`) | 보류마다 `HOLD <text>` 한 줄. 종료 코드에 넣지 않는다 | `GATE-HOLD <text>` 와 `STOP <PR> 머지 보류: <text>` |
| 보류를 확인하지 못함(`lookup`, merge 단계) | `HOLD <읽지 못한 이유>` | 멈춘다 |

지금은 지시서 보류가 있으면 PR 본문 보류를 내지 않고, 관문은 본문을 읽지 못해도 보류 없음으로 넘어간다. PR5 뒤에는 있는 보류를 모두 내고 읽지 못한 것도 알린다.

### 설정

| 키 | 꼴 | 기본 | 뜻 |
| --- | --- | --- | --- |
| `queue.allow_no_checks` | bool | false | true 면 지금 HEAD 에 CI 체크가 하나도 없는 PR 을 체크 통과로 본다. CI 가 없는 저장소가 켠다(REQ4) |

관문, 머지 큐, 루프가 모두 설정 파일에서 직접 읽는다. 명령줄 옵션은 만들지 않는다.
`QUEUE_GATE_KEYS` 는 「관문만 읽는 키」 라 여기 넣지 않고, `core/config.ts` 에 세 호출부가 함께 읽는 키 목록을 따로 둔다.
루프의 CI 감시도 이 값을 따른다. 켠 저장소에서는 체크 없는 PR 에 `ci-passed` 이벤트가 새로 난다.
키의 원본 문서는 [`docs/data-schema.md`](../../data-schema.md) 의 「config.json 에 더하는 절」 이고 PR6 이 그 표에 줄을 더한다.
`queue.auto_review` 의 「기능 PR 은 이 설정이 없으면 자동 머지하지 않는다」 는 PR7 이 「이 설정이 없으면 루프는 자동 머지하지 않는다」 로 고친다.

### draft 로 CI 를 미루는 옵션 제거

스펙 DECISION12 다. 쓰는 저장소가 없고, 남겨 두면 REQ3 때문에 그 저장소의 worker 가 관문을 통과하지 못한다. PR4 하나에서 지운다.

| 지우는 것 | 자리 |
| --- | --- |
| draft 를 ready 로 바꾸는 명령 | `queue/ci-ready.ts`, `tests/ci-ready.spec.ts`, `lib/commands.ts` 의 `queue ready` 행. 명령 표의 `retired` 칸으로 옮겨 한 줄 안내와 종료 코드 2 를 낸다 |
| 그 명령의 이벤트 | `lib/events.ts` 의 `before-ready`, `pr-ready` 와 `references/hooks.md` 의 행 |
| 건너뛴 체크를 미등장으로 보는 옵션 | 머지 큐와 관문의 `--skipped-is-missing`(`core/queue-options.ts`, `queue/steps/options.ts`), 루프의 `ctx.skippedIsMissing`(`loop/steps/context.ts`, `movement.ts`), `judgeChecks` 의 `skippedIsMissing` 인자 |
| 설정 키 | `queue.skipped_is_missing`, `pipeline.ready_slots`. `core/config.ts` 의 키 목록에는 「읽지 않는 옛 키」 로 남겨 설정 오류가 되지 않게 한다 |
| worker 지시 문구 | `templates/spec-common.md` 의 `{{DRAFT_PR_RULE}}` 줄과 `references/spec-writing.md` 의 설명 |
| 문서 | `references/overlay.md` 표의 「draft 로 CI 미루기」, 「draft 때 건너뛴 체크」 행과 예시 줄, `references/cleanup.md` 의 두 절, `docs/data-schema.md`, `docs/flow.md`, `docs/code-architecture.md` 의 해당 줄 |

doctor 는 아래를 찾으면 `DRAFT-CI-RETIRED <자리>` 경고를 낸다. 종료 코드는 바꾸지 않는다.

- 설정 파일의 `queue.skipped_is_missing`, `pipeline.ready_slots`, `hooks.timeouts.before-ready`, `hooks.timeouts.pr-ready`
- `.orch/hooks/` 의 `before-ready`, `pr-ready` 핸들러 파일
- 저장소 오버레이(`.orch/overlay.md`)의 `orch queue ready` 나 `gh pr create --draft` 문구

`pipeline.update_behind_drafts` 는 읽는 명령이 없는 다른 기능의 예약 키라 이번에 다루지 않는다.

## 실패와 일관성

- **조회 실패**: 통과로 보지 않는다. 값 하나에 `lookup` 이유 하나다. gh 재시도 횟수와 간격(`MERGE_QUEUE_GH_RETRIES`, `MERGE_QUEUE_GH_RETRY_SECONDS`)은 호출부가 `ReadOptions` 로 넘긴 지금 값을 쓴다.
- **판단 중 HEAD 변경**: 값마다 읽은 HEAD 를 대조하고, 다르면 그 이유 하나만 남긴다. 머지 큐는 다시 시도하고, 관문은 실패로 내고, 루프는 다음 틱에 다시 본다.
- **판단과 머지 사이**: 머지 큐가 머지 직전에 체크(캐시 없이, HEAD 포함)와 마이그레이션을 다시 묻고, `gh pr merge` 바로 앞에서 보류와 draft 를 다시 물은 뒤 `--match-head-commit` 으로 머지한다. 확인의 자리와 순서가 지금과 같다.
- **루프의 gh 비용**: 가벼운 범위에서 gh 를 부르는 값은 스레드, PR 조회 한 번, 영수증뿐이고 앞 조건을 모두 넘은 PR 만 읽는다. 후보 하나에 두세 번으로 지금과 같다. REQ6 으로 PR 조회가 캐시를 쓰지 않게 되지만 이 조회까지 오는 PR 은 CI 가 통과했고 보류와 미해결 스레드가 없는 PR 뿐이다. 리뷰 설정이 없는 저장소에서는 모든 PR 이 8번에 걸리므로 PR7 이 8번을 gh 조회 앞으로 옮겨 틱마다의 헛된 조회를 없앤다(DECISION11).
- **관문과 머지 큐의 gh 비용**: 값을 읽는 호출은 지금 것을 그대로 옮긴다. 조회를 합쳐 호출 수를 줄이는 일은 이번 범위가 아니다.
- **보드 읽기**: 관문과 머지 큐가 새로 보드 파일을 읽는다. 잠금 없이 한 번 읽는다. 보드는 옆 파일에 쓰고 rename 하므로 반쯤 쓰인 파일을 읽지 않는다. 읽지 못하면 `merge` 단계의 `lookup` 이유라 직접 머지가 멈춘다.
- **배포 순서**: PR6 이 머지되면 체크가 없는 PR 은 준비 안 됨이 된다. CI 가 없는 저장소는 플러그인을 갱신한 뒤 `queue.allow_no_checks` 를 켠다. 이전 버전은 이 키를 설정 오류로 보므로 키를 먼저 넣지 않는다.
- **draft 옵션 제거의 순서**: PR4 가 PR5 보다 먼저 머지되어야 한다. 순서가 바뀌면 옵션은 남았는데 관문이 draft 를 막는 기간이 생긴다. 옛 설정이 남은 저장소는 설정 오류로 멈추지 않고 doctor 경고만 받는다.

## 검증 전략

| 대상 | 방법 | 요구사항 |
| --- | --- | --- |
| 조건 판단 | `tests/core-merge-readiness.spec.ts`(신규). snapshot 값을 직접 만들어 조건마다 통과, 걸림, 조회 실패, `need` 를 본다. 가짜 gh 가 필요 없다 | REQ1-REQ6 |
| 범위 | 같은 snapshot 에 `light` 와 `full` 로 물은 결과를 대조한다. `light` 의 이유는 `full` 의 이유 가운데 범위가 `light` 인 조건의 것과 같아야 한다 | REQ1 |
| 세 호출부의 같은 답 | 같은 PR 상태(가짜 gh 응답과 지시서, 보드 파일 한 벌)를 관문, 머지 큐, 루프에 넣고 출력에서 읽은 이유 종류를 대조한다. 지금 `queue-gate.spec.ts` 는 관문과 머지 큐만 대조한다 | REQ1 |
| 두 단계 | 보류가 있는 snapshot 에서 `blocksReady` 는 false, `blocksMerge` 는 true 인지 본다. 관문 출력은 `GATE-OK` 와 `HOLD`, 머지 큐는 `GATE-HOLD` 와 STOP 이다 | REQ2 |
| 체크 판단 | `tests/core-checks.spec.ts`(신규). 지금 `lib-gh.spec.ts` 의 `ciState` 경우와 머지 큐 jq 의 경우(허용한 실패, SKIPPED, EXPECTED)를 한 표로 옮긴다 | REQ1, REQ4 |
| HEAD 변경 | 값 하나의 `head` 가 다른 snapshot 에서 다른 이유(충돌, 스레드, 리뷰 없음)가 버려지고 `head` 하나만 남는지 본다 | REQ6 |
| 대기 문구 | 조건 표의 `wait` 를 고정 목록과 `WAIT_TEXTS` 정규식에 대조한다. 정규식이 없는 문구는 따로 적은 목록과 대조한다 | REQ1 |
| adapter | 값 읽기만 가짜 gh 로 본다. 재시도, `UNKNOWN` 다시 읽기, 캐시 끄기, `fresh` 일 때 체크 캐시를 건너뛰는지, HEAD 붙이기, 읽지 않아도 되는 값을 건너뛰는지, 읽지 못한 보드와 지시서 폴더가 `ok: false` 가 되는지다. 조건의 뜻은 여기서 다시 보지 않는다 | REQ6, 스펙 DECISION11 |
| 호출부 연결 | 지금의 `queue-gate.spec.ts`, `merge-queue.spec.ts`, `orch-loop-auto-merge.spec.ts` 와 고정 입력 기록(`tests/golden/`)이 출력 줄과 종료 코드를 본다 | 전체 |
| 옵션 제거 | 옛 설정 키가 있어도 `loadConfig` 가 실패하지 않고 doctor 가 `DRAFT-CI-RETIRED` 를 내는지, `orch queue ready` 가 안내와 종료 코드 2 를 내는지 본다 | REQ3 |

PR1-PR3 은 리팩토링이다. 지금 테스트의 기대값과 고정 입력 기록을 바꾸지 않고 통과해야 한다. 가짜 gh 는 호출 횟수와 `--json` 의 첫 필드로 응답을 고르므로, 호출 단위와 순서를 지금대로 두는 것이 이 조건의 전제다.
PR4-PR7 은 바뀌는 동작만 기대값을 고친다. 그때 가짜 gh 테스트에 있던 조건별 경우는 snapshot 값 테스트로 옮기고, 가짜 gh 테스트에는 호출부마다 통과 하나, 걸림 하나와 출력 꼴만 남긴다.
`tests/core-boundary.spec.ts` 가 새 core 파일의 import 와 외부 상태 접근을 그대로 검사한다.

## 커밋과 PR 순서

동작이 그대로인 리팩토링이 먼저고 동작 변경이 뒤다. PR 하나의 작업 분해는 plan 이 정한다.

| PR | 내용 | 바뀌는 동작 |
| --- | --- | --- |
| PR1 | `core/checks.ts`. 머지 큐의 체크 jq 를 `judgeChecks` 로 바꾸고 필수 체크 이름을 `ruleChecks` 로 읽는다 | 없음 |
| PR2 | `core/merge-readiness.ts`, `lib/merge-readiness.ts`, ADR. 관문과 머지 큐가 `checkReadiness` 를 쓴다 | 없음 |
| PR3 | 루프가 `checkReadiness(light)` 를 쓴다. 스레드 기본 명령의 중복이 없어진다 | 루프가 체크를 CI 감시의 기록이 아니라 그 틱의 롤업으로 판단한다. CI 실패 알림 전송이 실패한 틱에만 결과가 다르다. 지금은 기록이 이전 값으로 되돌아가 옛 `passed` 로 걸 수 있고, 바뀐 뒤에는 `CI failed` 로 기다린다(사용자 2026-11-24 수용) |
| PR4 | 「draft 로 CI 미루기」 옵션 제거(스펙 DECISION12) | `orch queue ready`, `--skipped-is-missing`, `queue.skipped_is_missing`, `pipeline.ready_slots`, `before-ready`·`pr-ready` 이벤트가 없어진다. 결론이 SKIPPED 인 체크는 늘 나타난 체크로 센다. doctor 가 남은 설정을 경고한다. `hooks.timeouts.before-ready` 와 `hooks.timeouts.pr-ready` 는 무시하고 doctor 에서 알린다 |
| PR5 | REQ3, REQ2 | 관문이 draft 를 `GATE-FAIL` 로 낸다. 머지 큐가 draft 를 차례 시작에서 보류한다. 관문이 보드 보류를 `HOLD` 로 내고 머지 큐가 보드 보류에 멈춘다. 보류가 여럿이면 모두 낸다. 보류를 읽지 못한 것(본문, 보드, 지시서 폴더)을 관문이 `HOLD` 로 알리고 머지 큐가 멈춘다. 스레드 명령이 숫자가 아닌 것을 내면 관문도 조회 실패로 본다 |
| PR6 | REQ4 | 체크가 하나도 없으면 준비 안 됨이고 체크 대기가 첫 체크를 기다린다. `queue.allow_no_checks` 가 생긴다. 켠 저장소에서는 루프도 체크 없는 PR 을 통과로 보고 `ci-passed` 를 낸다. 머지 큐가 체크 대기 뒤에도 진행 중·미등장을 본다(DECISION4) |
| PR7 | REQ5, REQ6, 스펙 DECISION15 | 리뷰 설정이 없으면 루프가 모든 PR 을 기다린다. 그 문구에서 「기능」 이 빠지고 평가 순서가 gh 조회 앞으로 온다. 루프의 PR 조회와 스레드 명령이 캐시를 쓰지 않고 HEAD 가 다르면 기다린다. HEAD 변경 문구가 하나로 모이고, 체크 조회 중의 HEAD 변경도 머지 큐가 다시 시도한다. P1·P2 지적이 없으면 마지막으로 끝난 리뷰를 이후 커밋에도 인정한다(스펙 DECISION15) |

PR2 와 PR3 이 동작을 그대로 두려면 호출부마다 다른 점을 남겨 두어야 한다. 조건의 차이는 `ReadinessAsk` 의 임시 값 `compat` 로, 읽는 방식의 차이는 `known` 의 읽기 함수로 남기고 뒤 PR 이 하나씩 지운다.

| 임시로 남기는 것 | 뜻 | 쓰는 곳 | 지우는 PR |
| --- | --- | --- | --- |
| `compat.noDraft` | `draft` 조건을 보지 않는다 | 관문, 머지 큐 | PR5 |
| `compat.oldHolds` | `hold-board` 조건을 보지 않는다. 지시서 보류가 있으면 본문 보류를 내지 않는다. 관문은 본문 보류를 읽지 못해도 넘어간다 | 관문, 머지 큐 | PR5 |
| 스레드 수 읽기 | 관문은 숫자가 아닌 출력도 수로 받아 이유 문구에 넣는다 | 관문, 머지 큐 | PR5 |
| `compat.checksAfterWait` | 체크 대기 뒤에는 실패만 본다 | 머지 큐 | PR6 |

`allowNoChecks` 는 PR6 전까지 관문과 머지 큐가 true, 루프가 false 를 넘겼다. PR7 이 `compat` 타입 자체를 지웠다.

문서는 그 동작을 바꾸는 PR 이 함께 고친다.

- `queue/gate.ts`, `queue/merge_queue.ts`, `loop/steps/auto-merge.ts` 의 파일 맨 위 설명
- [`docs/flow.md`](../../flow.md) 의 자동 머지 그림, `docs/data-schema.md`
- `skills/orch/references/cleanup.md`, `spec-writing.md` 의 보류 설명, `replying.md` 의 `HOLD` 설명(여러 줄), `overlay.md` 의 「기능 PR 만 리뷰 설정이 필요하다」 문장
- [ADR-016](../../adr/016-orch-auto-merge.md) 의 「적용 범위」 줄(PR3)과 「감당할 것」 보탬(PR7)

## 결정

스펙의 DECISION1-DECISION14 는 다시 적지 않는다. 아래는 이 설계의 결정이다.

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | seam 의 자리 | snapshot 값. 판단과 조건 순회는 core, 읽기는 lib | 작성자 | [ADR-028](../../adr/028-orch-core-layer.md). 값을 만드는 쪽이 둘(직접 조회, 루프의 틱 값)이고 테스트가 값을 직접 만든다. 순회를 lib 에도 두면 범위와 단계 규칙이 두 벌이 된다 |
| DECISION2 | 두 단계의 표현 | 질문에 단계를 넣지 않고 이유마다 단계를 붙인다 | 작성자 | 관문은 한 번 물어 `ready` 이유로 실패하고 `merge` 이유를 `HOLD` 로 내야 한다. 단계를 질문에 넣으면 두 번 물어야 한다 |
| DECISION3 | 루프만 보는 조건 | 「이미 건 HEAD」 와 「리뷰 설정 없음」 을 `ask.auto` 가 있을 때만 켜지는 조건으로 표에 둔다 | 작성자 | 첫 이유 하나만 남기는 루프의 문구 순서를 표 하나로 지킨다. 표 밖에 두면 루프가 조건 사이에 끼워 넣는 코드를 따로 가져야 한다 |
| DECISION4 | 체크 대기 뒤 판단 | 머지 큐도 대기 뒤에 진행 중·미등장을 본다 | 작성자 | 스펙 REQ1. 지금은 대기 직후 새 체크가 붙으면 머지 직전 확인에서 멈춘다. 멈추는 것은 같고 자리와 문구만 앞당겨진다 |
| DECISION5 | 루프와 마이그레이션 base 번호 | 스펙 DECISION14 를 따른다. 조건은 가벼운 범위에 두고 루프는 `skip: migration` 으로 묻는다 | 작성자 | 루프의 4단계가 같은 `judgeMigrations` 로 다른 열린 PR 과 예약까지 넣어 보고 `MIGRATION-CLASH` 로 알린다 |
| DECISION6 | 리뷰 설정 없음 문구와 창 표시 | 스펙 DECISION13 을 따른다. 문구에서 「기능」 을 빼고 `WAIT_TEXTS` 의 그 정규식 한 줄만 넓힌다 | 작성자 | 사용자 결정(2026-11-24)의 적용 자리만 정했다. work-board 가 판단 결과를 직접 받는 일은 여전히 범위 밖이다 |
| DECISION7 | 옛 draft 옵션 설정 | `queue.skipped_is_missing`, `pipeline.ready_slots` 는 읽지 않지만 설정 오류로 막지 않고 doctor 가 `DRAFT-CI-RETIRED` 로 알린다 | 작성자 | 스펙 DECISION12 의 「doctor 가 경고」. 옛 리뷰 키(`LEGACY-REVIEW-KEY`)와 같은 방식이다. 설정 오류로 막으면 플러그인 갱신만으로 루프와 머지 큐가 멈춘다 |
| DECISION8 | `finish-pr.ts` | 고치지 않는다 | 작성자 | 머지된 뒤에 돌아 머지 전 조건을 보지 않는다. `featureBranch` 는 마무리 실패 처리에만 쓰여 REQ5 와 무관하다. 스펙 범위 문장도 그렇게 고쳤다(사용자 2026-11-24) |
| DECISION9 | 조회 합치기 | 하지 않는다. gh PR 조회는 지금 호출 단위와 순서 그대로 값 하나에 한 번이다 | 작성자 | 리팩토링 PR 이 가짜 gh 테스트를 그대로 통과해야 한다. 체크 조회의 HEAD 별 공유 캐시(`checkSnapshot`)도 그대로 쓴다 |
| DECISION10 | `queue.allow_no_checks` | 설정 파일에서만 읽고 기본은 false | 작성자 | 스펙 DECISION5. 저장소 성격이라 명령마다 줄 값이 아니다 |
| DECISION11 | 리뷰 설정 없음 조건의 순서 | PR7 에서 보드 보류 바로 뒤, 스레드 조회 앞으로 옮긴다 | 사용자 2026-11-24 | 설정만 보는 조건이라 읽는 값이 없다. 지금 자리에 두면 리뷰 설정이 없는 저장소에서 끝내 머지되지 않을 PR 마다 틱마다 스레드 명령과 PR 조회를 부른다. 미해결 스레드가 있는 PR 의 대기 문구가 그 저장소에서만 「리뷰 설정 없음」 으로 바뀐다 |
| DECISION12 | 평가 순서와 출력 순서 | 조건 표에 두 순서를 따로 둔다 | 작성자 | 루프의 첫 이유 순서와 관문·머지 큐의 이유 줄 순서가 지금 서로 다르다. 순서 하나로는 둘 가운데 하나의 출력이 바뀐다 |
| DECISION13 | HEAD 변경의 처리 | 조건으로 모으지 않고, 걸리면 다른 이유를 버린다 | 작성자 | 지금도 HEAD 가 바뀌면 그 자리에서 멈춘다. 옛 HEAD 로 읽은 충돌이나 스레드로 worker 에게 알리면 틀린 지시가 된다 |

### 장기 결정

| 결정 | 종류 | ADR 또는 필요 없음의 이유 | 현재 규칙의 원본 |
| --- | --- | --- | --- |
| 머지 전 조건의 원본은 조건 표 하나이고, 호출부는 범위만 고르며 보류는 머지 단계에서만 막는다 | architecture | 새 ADR 이 필요하다. 번호는 PR2 가 받는다. 되돌리려면 관문, 머지 큐, 루프의 코드와 출력 계약을 함께 바꿔야 하고, 뒤에 work-board 가 이 결과를 받는 작업이 이 결정을 다시 참조한다. 기각한 대안은 「호출부마다 조건 목록을 두고 공통 함수만 나눠 쓴다」 와 「단계를 질문으로 나눈다」 다. ADR 이 가리킬 코드가 PR2 에서 생기므로 그때 쓴다 | `skills/orch/scripts/core/merge-readiness.ts` 의 조건 표 |
| 루프가 준비된 PR 을 스스로 건다 | architecture | [ADR-016](../../adr/016-orch-auto-merge.md) 을 대체하지 않는다. 루프의 판단이 큐를 걸기 전의 사전 확인이라는 점은 가벼운 범위로 유지된다. 「적용 범위」 줄의 판정 자리는 PR3 이 고친다. REQ5 로 거는 대상이 좁아지는 것은 PR7 이 지금까지의 방식대로 「감당할 것(날짜 보탬)」 에 적는다 | [ADR-016](../../adr/016-orch-auto-merge.md) |
| 값 판단은 core, 외부 실행은 lib | architecture | [ADR-028](../../adr/028-orch-core-layer.md) 을 그대로 따른다. 새 core 파일 둘은 경계 검사를 받는다 | [ADR-028](../../adr/028-orch-core-layer.md) |
