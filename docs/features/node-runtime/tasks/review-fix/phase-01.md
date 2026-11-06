# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

review-fix 여섯 명령이 지키는 옵션, stdout, 종료 코드, 가짜 `gh` 가 받은 인자를 `node:test` 로 먼저 고정한다. 이 phase 의 커밋에서 새 테스트는 옛 Python·셸 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체, 옛 Python 테스트 삭제(phase-02).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `skills/review-fix/tests/<명령>.spec.ts` 다. 파일 머리의 「명령 경계」 상수(실행 argv 앞부분)만 구현을 가린다. phase-02 는 이 상수만 바꾸고 사례는 고치지 않는다.
- review-fix 는 팀으로 내보내는 스킬이다. 테스트는 Node 내장 모듈만 쓰고 `modules/testkit/` 을 import 하지 않는다(`exported-imports.spec.ts`). 가짜 `gh`, `ssh` 와 임시 저장소 helper 는 `tests/helpers.ts` 한 파일에 둔다. 폴더 안이라 내보내진다.
- 가짜 `gh`, `ssh` 는 PATH 앞에 둔 실행 파일이다. GitHub 에는 닿지 않는다. `fold_fixup` 은 git 상태를 바꾸므로 임시 저장소에서만 돈다(설계 「영역별 메모」 4행).
- 옛 Python 테스트 사례는 모두 새 테스트가 같은 명령 경계로 덮는다. phase-02 가 그것을 지우기 전에 사례 목록을 대조한다.

## 의도 메모

- `review_threads` 옛 테스트는 `gh` 함수를 `patch` 로 바꾸고 `main` 을 직접 불렀다. 새 테스트는 가짜 `gh` 가 GraphQL 인자(`query=`, `threadId=`, `id=`)에 맞춰 JSON 을 낸다. `gh_host` 의 호스트 결정은 `GH_HOST` 를 지운 환경과 가짜 `git`·`ssh`·`gh auth status` 로 본다.
- Python 의 `\b`, `\w`, `\d` 는 유니코드 뜻이다. `check_reply_body` 의 `/review반영` 처럼 한글이 붙은 사례를 경계 테스트로 둔다(Phase 02 가 같은 값으로 정규식을 옮긴다).
- `collect_review` 는 같은 폴더의 `review_threads` 를 자식 프로세스로 부른다. 테스트는 가짜 `gh` 하나로 두 명령의 출력과 순서를 함께 본다.

## 작업 항목

### 1. `tests/helpers.ts`

임시 폴더, 가짜 `gh`·`ssh`(규칙에 맞는 stdout·종료 코드, 받은 인자와 `GH_HOST` 기록), 임시 git 저장소(`origin` 선택), 명령 실행.

### 2. `tests/gh-host.spec.ts`

`GH_HOST` 우선, 인자 없음은 origin, `<owner> <repo>` 가 origin 과 같으면 로그인 호스트를 조회하지 않음, 다른 origin 은 로그인 호스트에서 찾음, 로그인 호스트 하나, `gh auth status` 가 종료 코드 1 이어도 호스트를 읽음, 어디에도 없으면 경고 후 origin, SSH 별칭, 인자 수 오류 2.

### 3. `tests/review-threads.spec.ts`

`list`, `list-all`, `--count`(미해결만, 전체, 100건 초과 실패), compact JSON 줄, outdated 의 `originalLine`, head 120자 잘림, `show`(본문 전체, 댓글 머리줄, 스레드가 아닌 노드, 인자 수, 100건 초과 경고), `carried`(표지 문구, 첫 댓글 제외, `--marker`, 100건 초과 경고), `reply`(파일 없음 2, 본문 인자 `body=@경로`), `reply-batch`(성공, 실패 목록, 없는 파일, 형식 오류, 빈 map 2, 상대 경로), `resolve`(여러 인자, 공백이 든 인자, `-`, 빈 입력 2), `--repo`(어느 자리나, `=` 꼴, `/` 없음 2), 사용법 오류 2.

### 4. `tests/collect-review.spec.ts`

인자 해석(기본, `--carried-from` 여러 번호, 옵션이 앞, 값 없음, 위치 인자 수, PR URL, `HOST/OWNER/REPO NUMBER`, 잘못된 URL), 머리말과 명령 순서, `GH_HOST` 전달, 실패 합산(종료 코드 1), 호스트를 구하지 못하면 2.

### 5. `tests/checkout-pr.spec.ts`, `tests/check-reply-body.spec.ts`, `tests/fold-fixup.spec.ts`

- `checkout_pr`: dirty 1, 이미 head 브랜치면 체크아웃 없이 이름, 다르면 `gh pr checkout`, head 를 못 읽음 3, 사용법 2
- `check_reply_body`: 재트리거 토큰, auto-link 꼴(`#12`, `o/r#12`, `GH-12`), 코드 스팬과 펜스 안 제외, 한글이 붙은 경계, 여러 파일, 읽지 못함 2
- `fold_fixup`: 옛 테스트 여덟 사례(앞 커밋에 접기, HEAD 면 amend, 루트 커밋, 스테이징 안 한 변경 보존, 스테이징 없음 2, 모르는 커밋 2, 머지 커밋 거부 2, 충돌 시 중단하고 fixup 남김 1)

## 검증

```bash
node scripts/run-tests.ts 'skills/review-fix/tests/*.spec.ts'
```

종료 코드 0. 옛 Python 테스트와 새 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/review-fix/tests/helpers.ts` | 신규 |
| `skills/review-fix/tests/gh-host.spec.ts` | 신규 |
| `skills/review-fix/tests/review-threads.spec.ts` | 신규 |
| `skills/review-fix/tests/collect-review.spec.ts` | 신규 |
| `skills/review-fix/tests/checkout-pr.spec.ts` | 신규 |
| `skills/review-fix/tests/check-reply-body.spec.ts` | 신규 |
| `skills/review-fix/tests/fold-fixup.spec.ts` | 신규 |
