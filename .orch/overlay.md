# fos-skills orch 오버레이

- 기준 브랜치: `main`.
- PR 은 draft 없이 `gh pr create` 로 연다. CI 는 PR 과 main push 에서 실행한다.
- draft 로 CI 를 미루지 않는다. `ci-ready.ts` 와 `--skipped-is-missing` 은 쓰지 않는다.
- 머지 전 `Plugin tests` 와 `Python tests` 가 모두 통과해야 한다.
- 로컬 검증: 저장소 루트에서 `claude plugin test .`, `python3 -m unittest discover -s scripts/tests`, `python3 -m unittest discover -s korean-check/tests`, `node scripts/run-node-tests.ts` 를 실행한다. 600초를 넘기면 `--background` 로 띄우고 출력된 `--wait` 명령을 끝 줄이 나올 때까지 다시 부른다.
