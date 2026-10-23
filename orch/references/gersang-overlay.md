# gersang-lab 의 로컬 명령 교체 예시

코디네이터가 스킬 1.43.0 이상을 설치한 뒤 오버레이에 적용할 예시다.
이 문서의 명령은 예시이며 실제 Run 에 자동으로 실행하지 않는다.
`$SKILL_DIR` 은 설치한 orch 번들, `$REPO` 는 gersang-lab 경로다.
`$RUN_ID`, `$DELIVERY_ID`, `$SPEC_FILE`, `$WORKTREE_NAME`, `$AGENT`, `$MODEL`, `$EFFORT` 는 현재 코디네이터의 값으로 채운다.
`PR_NUMBERS` 는 머지 순서의 배열이며 PR 번호마다 인자 하나를 넘긴다.

## 검증 명령 준비

`merge-tested.sh` 의 사본 생성과 머지는 큐가 맡는다.
검증 부분은 아래 `VERIFY_BODY` 처럼 넘긴다. 의존성 설치와 generated 빌드, 변경한 테스트, 겹친 파일을 읽는 테스트와 convention 전체를 검사한다.
Vitest 인자는 8개씩 나누고 삭제된 테스트는 제외한다. 파일 이름의 공백은 그대로 보존한다.
반복해서 쓸 때는 `VERIFY_BODY` 본문을 저장소의 검증 스크립트에 두고 `VERIFY_CMD` 에 그 경로만 적는다.

```bash
REPO=/Users/nhn/personal/gersang-lab
REQUIRED_CHECKS=ci
export HEAVY_SLOT="$REPO/.orch/bin/with-heavy-slot.sh"
export VERIFY_BODY='
set -euo pipefail
pnpm install --frozen-lockfile
gen=tools/build/build-generated.ts
[ -f "$gen" ] || gen=tools/build/build-generated.cjs
node "$gen"
tests=$(
  {
    printf "%s\n" "$CHANGED_FILES" | grep -E "^tests/.*\.test\.(cjs|ts)$" || :
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      stem=$(basename "$file" | sed -E "s/\.(cjs|js|ts|json|md)$//")
      grep -rlF --include="*.test.cjs" --include="*.test.ts" -- "$stem" tests || :
    done <<< "$OVERLAP_FILES"
    find tests/convention -name "*.test.cjs" -type f
  } | sort -u | while IFS= read -r test_file; do
    if [ -f "$test_file" ]; then printf "%s\n" "$test_file"; fi
  done
)
[ -n "$tests" ] || { echo "실행할 테스트가 없다: PR $PR" >&2; exit 1; }
while IFS= read -r test_file; do printf "%s\0" "$test_file"; done <<< "$tests" |
  xargs -0 -n 8 pnpm exec vitest run
'
VERIFY_CMD='bash "$HEAVY_SLOT" bash -c "$VERIFY_BODY"'
AFTER_CMD='if [ -n "$CODE_PRS" ] && [ "${SKIP_PUBLISH:-0}" != 1 ]; then bash "$HEAVY_SLOT" bash scripts/local-publish.sh; fi'
```

검증 명령은 합친 사본 안에서 실행된다. `MERGE_COPY` 와 `$1` 은 그 경로, `PR` 은 번호다.
`CHANGED_FILES` 와 `OVERLAP_FILES` 는 Git 에서 읽은 줄바꿈 목록이며 추가 API 조회가 필요 없다.
검증과 배포는 기존의 `with-heavy-slot.sh` 안에서 각각 실행한다. 이 무거운 작업 대기열은 교체 대상인 다섯 스크립트에 포함되지 않는다.

## 로컬 스크립트를 대신할 다섯 명령

아래는 순서대로 `ci-ready.sh`, `merge-ready.sh`, `merge-tested.sh`, `start-worker.sh`, `wait-important.sh` 에 대응한다.
두 머지 명령은 같은 큐를 사용한다. 기존 `merge-tested.sh` 의 직접 호출에도 코드 PR 머지 뒤 배포를 적용한 예시다.
기존 `start-worker.sh path:...` 를 대신할 때는 네 번째 줄의 `--repo/--name/--base` 대신 `--worktree "$WORKTREE"` 를 쓴다.
첫 대기처럼 delivery 가 없으면 마지막 줄에서 `--ack "$DELIVERY_ID"` 를 뺀다.
`REQUIRED_CHECKS=ci` 는 현재 `ci.yml` 의 job 이름이다. workflow 제목 `CI` 와 구분하며, job 이름을 바꾸면 `statusCheckRollup` 을 확인해 함께 바꾼다.

```bash
python3 "$SKILL_DIR/scripts/ci-ready.py" --repo "$REPO" "${PR_NUMBERS[@]}"
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" --method squash --required "$REQUIRED_CHECKS" --skipped-is-missing --verify-merged "$VERIFY_CMD" --verify-merged-when code --docs-glob 'docs/*,*.md' --update-docs-on-overlap --after-merged "$AFTER_CMD" "${PR_NUMBERS[@]}"
python3 "$SKILL_DIR/scripts/merge-with-finish.py" --repo "$REPO" --method squash --required "$REQUIRED_CHECKS" --skipped-is-missing --verify-merged "$VERIFY_CMD" --verify-merged-when code --docs-glob 'docs/*,*.md' --update-docs-on-overlap --after-merged "$AFTER_CMD" "${PR_NUMBERS[@]}"
bash "$SKILL_DIR/scripts/launch-worker.sh" --run "$RUN_ID" --spec "$SPEC_FILE" --repo "$REPO" --name "$WORKTREE_NAME" --base origin/main -- --agent "$AGENT" --model "$MODEL" --effort "$EFFORT"
python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID" --ack "$DELIVERY_ID" --kill-stale
```

머지 옵션을 매번 옮겨 적지 않으려면 `.orch/config.json` 의 `queue` 절에 둔다([`overlay.md`](overlay.md)).
`update_docs_on_overlap: true` 를 포함할 수 있으며 필수 체크 목록도 함께 정한다.
문서가 base 와 겹쳐도 GitHub CLEAN 이면 base 를 합치고 새 CI 를 기다린다. CLEAN 이 아니면 멈춰 worker 에게 넘긴다.
코드 PR 은 겹침이 없어도 합친 사본을 검사하며, 큐에서 코드 PR 을 하나라도 머지했을 때만 배포한다.
새로 머지한 PR 이 없으면 배포하지 않고, 앞 PR 머지 뒤 뒤 PR 이 보류돼도 배포 명령은 한 번 실행한다.
배포 실패는 `AFTER-MERGED-FAILED` 로 남는다. 머지한 작업은 되돌리지 않는다.

이미 확인한 끊긴 dispatch 는 [`waiting.md`](waiting.md) 의 `--ack-lost` 로 한 번 기록한다.
고아 대기를 종료한 실행은 종료 코드 4 이므로, 출력에서 종료 결과를 확인한 뒤 대기를 다시 건다.
