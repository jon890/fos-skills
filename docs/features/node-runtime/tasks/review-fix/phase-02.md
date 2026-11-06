# Phase 02. 구현을 TypeScript 로 바꾸고 부르는 곳을 맞춘다

**Execution profile**: standard

## 목표

phase-01 의 명령 경계 테스트를 사례는 고치지 않은 채 TypeScript 구현으로 통과시키고, 옛 Python·셸 파일과 테스트를 지운다. 스킬 문서와 orch 의 호출, 저장소 정책이 새 이름을 부른다.

**범위 외**: 다른 영역의 명령(plan 의 `overlay_paths.py` 등)을 부르는 줄, 다른 저장소의 호출(머지 뒤 후속), 팀 저장소 반영.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ7

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 명령 파일 이름은 확장자만 바꾼다(설계 DECISION5): `gh_host.ts`, `review_threads.ts`, `collect_review.ts`, `checkout_pr.ts`, `check_reply_body.ts`, `fold_fixup.ts`. 첫 줄 `#!/usr/bin/env node`, 실행 권한, 머리 주석이 사용법과 종료 코드를 소유한다.
- 명령은 진입일 때만 돈다(`io.ts` 의 `isMain`). 함수는 export 한다.
- 호출 꼴은 `node "$SKILL_DIR/scripts/<이름>.ts"` 다(설계 DECISION4).
- 스킬은 자기 폴더 밖을 import 하지 않는다. 옛 Python 의 출력과 입력 해석을 맞추는 `py.ts` 의 복사본 `skills/review-fix/scripts/kit/py.ts` 를 쓴다(`scripts/sync-kit.ts --add`). 이 스크립트들은 `argparse` 를 쓰지 않아 `args.ts` 는 필요 없다.
- 두 엔진의 뜻이 다른 정규식은 명시 문자 클래스로 옮긴다(설계 「동등성 확인」). `check_reply_body` 의 `\b`, `\w`, `\d` 가 해당한다.
- orch 의 `merge_queue.ts`, `orch-loop.ts` 가 기본 미해결 스레드 명령으로 `node '<경로>/review_threads.ts' list --count …` 를 부른다. `test-speed` PR4 가 같은 파일을 고치는 중이면 먼저 머지된 쪽 위로 rebase 한다.

## 의도 메모

- `gh_host` 는 `pr-review` 의 `gh-host.ts` 보다 일을 더 한다(저장소 이름으로 호스트 탐색). 폴더 경계 때문에 합치지 않고 두 파일을 그대로 둔다.
- 출력은 `fs.writeSync` 로 동기로 쓴다. 자식 프로세스(`gh`)와 같은 fd 를 쓰고 `collect_review` 의 머리말이 그 출력보다 앞에 있어야 한다.
- 호환성 항목이라 스킬 버전을 3.0.0 으로 직접 올리고 CHANGELOG 에 `호환성:` 항목을 둔다(README 「버전과 변경 이력」). 변경 조각은 쓰지 않는다.

## 작업 항목

### 1. `kit` 복사본

`node scripts/sync-kit.ts --add skills/review-fix py.ts`, `tsconfig.json` 의 include 에 `skills/review-fix/scripts/**/*.ts`.

### 2. 명령 여섯 구현

`gh_host`, `review_threads`, `collect_review`, `checkout_pr`, `check_reply_body`, `fold_fixup` 순으로 구현하고, `gh-host.spec.ts`, `review-threads.spec.ts`, `collect-review.spec.ts`, `checkout-pr.spec.ts`, `check-reply-body.spec.ts`, `fold-fixup.spec.ts` 의 명령 경계 상수를 새 파일로 바꾼다. 옛 `.py`, `.sh`, `test_*.py` 를 지운다.

### 3. 문서

`SKILL.md`, `references/reply.md` 의 호출, README 의 필요 조건, CHANGELOG, `metadata.version`.

### 4. orch 호출

`merge_queue.ts` 의 기본 `--threads-cmd` 와 찾지 못함 오류, `orch-loop.ts` 의 기본 `THREADS_CMD`, 같은 줄을 설명하는 주석, `references/gh-call-budget.md`, `references/replying.md`.

### 5. 저장소 정책

`runtime-policy.json` 에서 `review-fix` 줄을 지운다. `SKILL.md` 에 plan 영역의 `overlay_paths.py` 호출 줄이 남아 `migrated_docs` 에는 아직 들이지 않는다(영역 7 이 옮긴 뒤). 설계의 알려진 호출 줄(「실패와 일관성」)을 새 사정에 맞춘다.

## 검증

```bash
node scripts/run-tests.ts 'skills/review-fix/tests/*.spec.ts'
node scripts/runtime-policy.ts --pending
node scripts/sync-kit.ts --check
```

모두 종료 코드 0, pending 에 `review-fix` 가 없다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/review-fix/scripts/gh_host.ts` | 신규 |
| `skills/review-fix/scripts/review_threads.ts` | 신규 |
| `skills/review-fix/scripts/collect_review.ts` | 신규 |
| `skills/review-fix/scripts/checkout_pr.ts` | 신규 |
| `skills/review-fix/scripts/check_reply_body.ts` | 신규 |
| `skills/review-fix/scripts/fold_fixup.ts` | 신규 |
| `skills/review-fix/scripts/io.ts` | 신규 |
| `skills/review-fix/scripts/kit/py.ts` | 신규 |
| `skills/review-fix/scripts/gh_host.py` | 삭제 |
| `skills/review-fix/scripts/review_threads.py` | 삭제 |
| `skills/review-fix/scripts/collect_review.py` | 삭제 |
| `skills/review-fix/scripts/checkout_pr.py` | 삭제 |
| `skills/review-fix/scripts/check_reply_body.py` | 삭제 |
| `skills/review-fix/scripts/fold_fixup.sh` | 삭제 |
| `skills/review-fix/tests/test_gh_host.py` | 삭제 |
| `skills/review-fix/tests/test_review_threads.py` | 삭제 |
| `skills/review-fix/tests/test_collect_review.py` | 삭제 |
| `skills/review-fix/tests/test_fold_fixup.py` | 삭제 |
| `skills/review-fix/tests/gh-host.spec.ts` | 수정 |
| `skills/review-fix/tests/review-threads.spec.ts` | 수정 |
| `skills/review-fix/tests/collect-review.spec.ts` | 수정 |
| `skills/review-fix/tests/checkout-pr.spec.ts` | 수정 |
| `skills/review-fix/tests/check-reply-body.spec.ts` | 수정 |
| `skills/review-fix/tests/fold-fixup.spec.ts` | 수정 |
| `skills/review-fix/SKILL.md` | 수정 |
| `skills/review-fix/README.md` | 수정 |
| `skills/review-fix/CHANGELOG.md` | 수정 |
| `skills/review-fix/references/reply.md` | 수정 |
| `skills/orch/changes/review-threads-node.patch.md` | 신규 |
| `skills/orch/scripts/queue/merge_queue.ts` | 수정 |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 |
| `skills/orch/references/gh-call-budget.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
| `tsconfig.json` | 수정 |
| `docs/features/node-runtime/design.md` | 수정 |
