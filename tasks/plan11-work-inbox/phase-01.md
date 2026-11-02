# Phase 01. inbox 코어와 두레이 adapter

**Execution profile**: deep

## 목표

공통 항목 모델, 사람 단위 설정·상태, 저장소 필터, 두레이 adapter 와 `inbox.ts` 명령을 만든다. 보드와 대화가 같은 명령으로 알림을 받고 답한다.

**범위 외**: 보드 표시(phase 02), 스킬 문서와 매니페스트(phase 03), `dooray stream list` 명령 구현(jon890/dooray-cli 별도 PR)

## 컨텍스트

orch 스크립트의 TypeScript 관례(`orch/scripts/*.ts`, `node --disable-warning=ExperimentalWarning` 실행, `import.meta.main` 안에서만 명령 실행)를 따른다. 테스트는 `orch/tests/*.spec.ts` 처럼 `node:test` 와 임시 폴더를 쓴다.
dooray CLI 0.29.1 의 JSON 필드는 2026-11-02 실측: `member get me` 는 `id`, `defaultOrganization.id`. `post get --id` 는 `project.id`, `project.code`, `taskNumber`, `subject`. `post comment list` 원소는 `creator.member.organizationMemberId`, `createdAt`, `body`. `messenger logs --json` 원소는 `id`, `sender.member.organizationMemberId`, `sentAt`, `text`. `messenger channels --json` 원소는 `id`, `title`, `type`, `updatedAt`, `organization.id`.

**근거 문서**: `docs/features/work-inbox/spec.md` 의 「설계」 와 「요구사항과 인수 조건」

## 작업 항목

### 1. 구현

- `inbox/scripts/lib/model.ts`: `InboxItem`, `Adapter`, `FetchResult`(항목, 출처별 오류), `Context` 타입과 `Runner`(명령 실행 함수, 테스트에서 바꾼다)
- `inbox/scripts/lib/store.ts`: 사람 단위 설정(`${XDG_CONFIG_HOME:-~/.config}/fos-skills/inbox.json`)과 상태 폴더(`${XDG_STATE_HOME:-~/.local/state}/fos-skills/inbox/`) 읽기·쓰기. 경로는 환경 변수 `INBOX_CONFIG`, `INBOX_STATE_DIR` 로 바꿀 수 있다(테스트용). 캐시 쓰기는 임시 파일 뒤 rename, 받기 잠금은 `mkdir` 잠금과 10분 넘은 잠금 무시
- `inbox/scripts/lib/view.ts`: 순수 함수. 저장소 필터(`<orchDir>/config/notification.json`)와 알려진 저장소 목록, `defaultBoard` 로 항목을 「이 보드 목록」, 「미분류 수」 로 나눈다. `days` 밖 항목과 넘긴 항목은 뺀다. 새 항목 먼저, 최신순, 답함은 뒤
- `inbox/scripts/adapters/dooray.ts`: 스펙 「adapter 계약」 표의 다섯 동작. 명령은 모두 `Runner` 로 부른다
  - 업무: `dooray --json stream list --since <ISO> --all` 결과의 `event`(type comment, 본문에 `members/<내 id>`) 는 mention, `post`(users.to/cc 에 나, 보낸 사람이 나 아님) 는 assigned/cc. 업무 정보는 `dooray --json post get --id <postId>` 의 `project.id`, `project.code`, `taskNumber`, `subject` 를 쓰고 상태 폴더에 캐시
  - 메신저: `dooray --json messenger channels --since <ISO>` 에서 type 이 bot, me 가 아닌 방을 updatedAt 최신순 20개, 방마다 `dooray --json messenger logs <id> -n 50`. 본문에 `members/<내 id>` 가 있고 보낸 사람이 나 아니면 mention
  - 출처(task, messenger)마다 실패를 따로 잡아 `errors` 에 넣는다. 한 출처가 실패해도 다른 출처 항목은 낸다
  - 나: `dooray --json member get me` 의 `id`, `defaultOrganization.id`
  - 이름: `dooray --json member get <id>` 의 `name`, 상태 폴더 `people.json` 캐시
  - answered: 업무는 `dooray --json post comment list --id <postId> --since <at>` 에 내 댓글, 메신저는 그 방 logs 에서 알림 뒤 내 메시지
  - reply: 본문 앞에 `[@이름](dooray://<orgId>/members/<id> "member")` 와 공백, 끝에 빈 줄과 signature(빈 문자열이면 생략). 업무는 `dooray post comment add --id <postId> --body-file <파일>`, 메신저는 `dooray messenger channel-send --channel <id> --body-file <파일>`
- `inbox/scripts/adapters/index.ts`: adapter 이름과 생성 함수의 표. 설정의 `adapters[].type` 으로 고른다
- `inbox/scripts/inbox.ts`: 명령 `board --repo R [--json]`, `fetch [--force]`, `list [--repo R]`, `context <id>`, `reply <id> --body-file F [--yes]`, `dismiss <id> [--undo]`, `--help`
  - 설정 파일이 없으면 `board --json` 은 `{"enabled": false}` 를 내고 종료 코드 0, 다른 명령은 안내를 stderr 에 내고 1
  - `board` 는 캐시가 `intervalMinutes`(기본 5) 보다 오래됐고 잠금을 잡으면 fetch 와 answered 를 부른 뒤 캐시를 쓴다. 저장소 R 에 필터 파일이 있으면 상태 폴더 `repos.json` 에 R 을 더한다
  - `board --json` 출력: `{"enabled", "fetchedAt", "errors": {출처: 메시지}, "items": [...], "unclassified": n, "isDefault": bool}`
  - `context` 는 JSON 으로 항목, 본문, 앞 대화(작성자 이름 포함)를 낸다. 풀지 못한 id 가 있으면 그 id 를 stderr 에 내고 1
  - `reply` 는 `--yes` 없으면 합성 본문을 stdout 에 내고 3. `--yes` 면 등록 뒤 항목을 answered 로 캐시에 적는다
  - 종료 코드: 0 성공, 1 거절·실패, 2 사용법 오류, 3 확인 필요
- orch 폴더 해석은 `orch/scripts/lib/paths.ts` 의 `orchDir(repo)` 를 import 한다

### 2. 이 phase 를 검증하는 `inbox/tests/inbox.spec.ts` 와 `inbox/tests/dooray.spec.ts`

- 가짜 adapter 로 `board` 가 항목을 내고, 설정이 없으면 `enabled: false` 이며 Runner 를 부르지 않는다 (R2, R6)
- 필터 파일이 있는 저장소, 없는 저장소, defaultBoard, 미분류 수 (R8, R9)
- 넘김이 다른 저장소 `board` 에서도 빠진다, answered 가 뒤로 가고 새 수에서 빠진다 (R5)
- 두레이 변환: 고정 streams 응답에서 멘션 댓글, 담당 업무, 참조 업무, 내가 쓴 댓글 제외 (R1 의 변환 부분)
- 메신저 실패 시 errors.messenger 만 있고 업무 항목은 남는다. 업무 실패 시 직전 캐시 항목이 남는다 (R7)
- context 의 이름 풀기, 풀지 못한 id 면 1 (R3)
- reply 의 `--yes` 없을 때 3 과 합성 본문, 멘션 링크와 signature, 빈 signature (R4, R10)

## 검증

```bash
node --test --test-concurrency=4 "inbox/tests/*.spec.ts"
npx --no-install tsc -p tsconfig.json
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `inbox/scripts/lib/model.ts` | 신규 |
| `inbox/scripts/lib/store.ts` | 신규 |
| `inbox/scripts/lib/view.ts` | 신규 |
| `inbox/scripts/adapters/dooray.ts` | 신규 |
| `inbox/scripts/adapters/index.ts` | 신규 |
| `inbox/scripts/inbox.ts` | 신규 |
| `inbox/tests/inbox.spec.ts` | 신규 |
| `inbox/tests/dooray.spec.ts` | 신규 |
| `tsconfig.json` | 수정 |
