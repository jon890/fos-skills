# Codex worker 한국어 표기 검사 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 저장소의 연결된 워크트리에 `installCommitCheck` 로 훅을 건다 | `node scripts/run-tests.ts skills/orch/tests/lib-commit-check.spec.ts` 의 거절 사례. 금지어가 든 `.md` 를 스테이징하고 실제 `git commit` 을 한다 | 커밋이 거절되고 stderr 에 발견 줄(경로와 줄 번호), 권장 표현 줄, 커밋하지 않았다는 안내가 나온다. `git log` 에 커밋이 없다 | 로컬 git 과 Node 24 | worker | 없음 | PR 전 |
| REQ1 | 위와 같다 | 같은 테스트의 통과 사례. 경고만 있는 `.md`, 깨끗한 `.md`, `.md` 가 아닌 파일을 커밋한다 | 모두 커밋된다. 경고는 stderr 에 보이고 커밋을 막지 않는다 | 로컬 git 과 Node 24 | worker | 없음 | PR 전 |
| REQ1 | 임시 저장소에 원래 훅(공통 git 폴더의 `hooks/` 와 공유 설정의 `core.hooksPath`)을 둔다 | 같은 테스트의 이어 부르기와 건너뜀 사례 | 원래 `pre-commit`, `commit-msg` 가 인자와 함께 불린다. 주 checkout 과 다른 워크트리의 `core.hooksPath` 는 바뀌지 않는다. `git worktree remove` 뒤 훅 폴더가 없다 | 로컬 git 과 Node 24 | worker | 없음 | PR 전 |
| REQ1 | 루트 `package.json` 의 `type` 이 `commonjs` 인 임시 저장소와 `type` 이 없는 임시 저장소 | 같은 테스트의 대상 저장소 `type` 사례와 고장 사례 | 금지어 커밋은 발견 줄과 함께 거절되고 깨끗한 커밋은 된다. 검사기가 발견 줄 없이 죽으면 알리고 커밋된다 | 로컬 git 과 Node 24 | worker | 없음 | PR 전 |
| REQ1 | 임시 저장소에 금지어가 든 기존 문서를 커밋해 둔다 | `node scripts/run-tests.ts export-only-skills/korean-check/tests/check-diff.spec.ts` 의 `--staged` 사례 | 더한 줄의 금지어만 1 이고 권장 표현이 나온다. 기존 줄, 스테이징하지 않은 작업 트리 내용, 이름만 바꾼 파일은 막지 않는다 | 로컬 git 과 Node 24 | worker | 없음 | PR 전 |
| REQ1 | 가짜 orca CLI 와 `git worktree add` 로 만든 워크트리 | `node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts` 의 커밋 검사 사례 | claude 로 띄워도 codex 로 띄워도 그 워크트리의 `core.hooksPath` 가 `orch-hooks` 로 끝난다. 사용자가 둔 값이 있으면 `COMMIT-CHECK-SKIP` 이 나오고 띄우기는 이어진다 | 가짜 orca CLI 와 로컬 git | worker | 없음 | PR 전 |
| REQ1 | 아래 「실제 Codex 확인」 의 준비 | 아래 「실제 Codex 확인」 의 절차 | 에이전트가 hook 신뢰 확인 화면(`Hooks need review`)에서 멈추지 않고 일을 시작한다. 첫 커밋은 거절되고 보고에 `probe.md:1` 발견 줄과 `권장 표현: "스윕"` 줄이 있다. 둘째와 셋째 커밋은 된다 | 실제 Codex CLI 세션(하위 dispatch) | worker | 없음 | PR 전 |

## 실제 Codex 확인

표의 마지막 행이다. 지시서가 worker 에게 맡긴 확인이라 worker 가 받은 머리말의 하위 dispatch 명령으로 Codex 에이전트 하나를 시작시킨다. 이 브랜치의 `launch-worker` 로 띄우지 않는 것은 코디네이터의 보드와 띄우기 기록에 확인용 worker 가 남기 때문이다. `launch-worker` 가 설치를 부르는 연결은 가짜 orca CLI 행이 본다.

준비

1. 기존 worker 워크트리와 같은 부모 폴더(`<주 checkout>/worktrees/<저장소 이름>/`) 아래에 `origin/main` 에서 확인용 워크트리를 만든다. 브랜치는 `tmp/codex-korean-probe` 이고 upstream 을 두지 않는다. Codex 가 이미 신뢰한 저장소 아래라 폴더 신뢰 질문이 따로 뜨지 않는다.
2. 이 작업 공간의 설치 코드로 훅을 건다. `$WT` 는 확인용 워크트리, `$WS` 는 이 작업 공간이다.

   ```bash
   node --input-type=module -e 'const m = await import(process.argv[1]); console.log(JSON.stringify(m.installCommitCheck(process.argv[2])))' "$WS/skills/orch/scripts/lib/commit-check.ts" "$WT"
   ```

   출력의 `status` 가 `set` 이어야 한다.

절차

1. worker 가 받은 머리말의 하위 dispatch 명령 꼴(`orca orchestration worker-start --from <이 worker 의 터미널> … --agent codex`)로 시작시킨다. 워크트리는 `--worktree path:$WT`, 모델은 `gpt-6.1-sol`, effort 는 `low` 다. 지시는 `--spec-file` 이나 `--spec` 으로 준다(`orca orchestration worker-start --help` 의 꼴을 따른다).
2. 지시 파일에는 아래를 그대로 시킨다. push 하지 않고, `--no-verify` 를 쓰지 않고, 커밋 명령의 출력을 고치지 않고 보고에 붙이게 한다.
   - `probe.md` 를 본문 한 줄 `결과를 스윕한다.` 로 만든다. 코드 블록, 코드 스팬, 표에 넣지 않는다. `git add probe.md` 뒤 `git commit -m "probe 1"` 을 하고 종료 코드와 출력을 적는다.
   - 그 줄을 `결과를 한 번에 검사한다.` 로 고쳐 다시 스테이징하고 `git commit -m "probe 2"` 를 한다.
   - `warn.md` 를 본문 한 줄 `배포 + 검증을 쓴다.` 로 만들어 `git commit -m "probe 3"` 을 한다.
3. 시작 영수증의 준비 상태와, 시작 직후 `orca terminal read --terminal <에이전트 터미널> --screen --json` 으로 읽은 화면에 `Hooks need review` 가 없는지 본다.
4. 에이전트의 완료 보고와 확인용 워크트리의 `git log --oneline origin/main..HEAD` 를 대조한다. 커밋은 `probe 2`, `probe 3` 둘이어야 한다.
5. 확인이 끝나면 에이전트 터미널을 놓고 확인용 워크트리와 브랜치를 지운다. 원격에는 아무것도 올리지 않는다.
