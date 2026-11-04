# 짧은 orch 명령(PR1) 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 설정 폴더에 user 범위 가짜 번들(진입점 사본 포함), 실행기를 임시 `~/.local/bin` 에 복사 | `node --test skills/orch/tests/orch-launcher.spec.ts` | 플러그인 `bin/orch` 와 복사본 모두 같은 번들의 스크립트를 돌리고 종료 코드를 잇는다 | 로컬 node 24, 임시 폴더 | 없음 | PR 전 |
| REQ1 | 플러그인을 이 PR 이 머지된 버전으로 갱신한 Claude 세션, `orch doctor install-cli` 를 한 번 돌린 사람 셸 | 두 셸에서 번들 경로 없이 `orch loop status`, `orch doctor` 를 돌린다 | 두 셸 모두 같은 번들 경로의 스크립트가 돌고(`orch paths check` 로 확인) 판정 줄이 나온다 | 이 머신의 Claude 세션과 zsh | 머지 | PR 뒤 |
| REQ2 | 명령 표, 가짜 번들 | `node --test skills/orch/tests/lib-commands.spec.ts skills/orch/tests/orch-entry.spec.ts` | 「명령 표」 의 행마다 새 꼴과 옛 꼴이 같은 스크립트와 인자로 풀리고, 같은 값을 명시한 두 꼴의 stdout 과 종료 코드가 같다. `orch loop --start` 는 사용법 오류 2, `orch wait --ack d1` 은 통과 | 로컬 node 24 | 없음 | PR 전 |
| REQ3 | 임시 git 저장소와 워크트리, run-current 를 내는 가짜 orca, `finish.run`·`finish.specs_dir` 가 있거나 없는 설정 | `node --test skills/orch/tests/lib-context.spec.ts skills/orch/tests/orch-entry.spec.ts` | 워크트리 안에서 인자 없이 부른 결과가 명시한 결과와 같고 stderr 에 출처 한 줄. 필수 문맥(`wait` 의 run)을 문맥도 설정도 주지 못하면 진입점이 무엇을 줘야 하는지 알리고 2. 줄인 문맥 인자는 2 | 로컬 node 24, 임시 폴더 | 없음 | PR 전 |
| REQ4 | 가짜 orca 로 delivery 하나를 주는 대기 | `node --test skills/orch/tests/wait-important.spec.ts` | 기본값만 쓰고 시작 폴더와 같은 저장소의 루프 저장소 하나인 대기의 `NEXT_WAIT` 가 `orch wait --ack <id> --loop-repo <절대경로>` 이고(다른 저장소면 `--lost-state <절대경로>` 가 붙는다), run-current 에서 채운 Run 은 빠진다. PATH 에 실행기가 없으면 같은 인자 앞에 진입점 절대경로 | 로컬 node 24 | 없음 | PR 전 |
| REQ4 | 가짜 ps 로 `init → zsh → node bin/orch → node orch.ts → wait-important.ts --run R` 사슬 | `node --test skills/orch/tests/wait-important.spec.ts` | `--kill-stale` 이 그 대기를 고아로 찾아 끝낸다(실행기 한 겹이 낀 뒤의 회귀 방지) | 로컬 node 24 | 없음 | PR 전 |
| REQ5 | 가짜 번들 | `node --test skills/orch/tests/orch-entry.spec.ts` | 옛 꼴 `orch.ts wait-important …` 가 새 꼴과 같은 stdout 과 종료 코드를 내고 stderr 에 `orch: 새 꼴: orch wait …` 한 줄 | 로컬 node 24 | 없음 | PR 전 |
| REQ6 | `skills/orch/tests/fixtures/install-records.json` 의 사례 표(user 범위 설치본에 `skills/orch/scripts` 가 없고 project 범위에는 있는 기록 포함) | `node --test skills/orch/tests/lib-install-record.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/orch-launcher.spec.ts skills/orch/tests/template-script-path.spec.ts` | 진입점, 실행기, 틀의 한 줄 풀이가 사례마다 같은 답을 내고, 그 기록에서는 이유와 새 진입점 경로를 내고 3 으로 끝난다. project 범위 번들은 돌지 않는다 | 로컬 node 24 | 없음 | PR 전 |
| REQ7 | 임시 HOME(`~/.local/bin/orch` 없음, 표지 있음, PATH 밖), 옛 꼴과 직접 경로가 든 임시 저장소 `.orch/overlay.md`, 옛 번들 `wait-important.ts` 를 보이는 가짜 ps | `node --test skills/orch/tests/orch-doctor.spec.ts` | 경우마다 `CLI-MISSING`, `CLI-NOT-ON-PATH`, `CLI-STALE`, `OLD-CALL`, `DIRECT-PATH`, `WAIT-STALE` 판정 줄과 고칠 명령 한 줄. `orch-compat` 표지 줄은 나오지 않는다. 종료 코드는 새 판정 전과 같다 | 로컬 node 24 | 없음 | PR 전 |
| REQ7 | 이 머신의 알려진 저장소(스펙 부록) | 머지 뒤 각 저장소에서 `orch doctor` 를 돌린다 | 부록의 행마다 `OLD-CALL` 이나 `DIRECT-PATH` 가 나오고, 부록에 없는 줄이 나오면 부록에 더한다 | 이 머신 | 머지 | PR 뒤 |
| REQ8 | 저장소 문서 | `python3 -m unittest scripts/tests/test_doc_script_refs.py` | `skills` 와 `docs` 의 문서에 옛 진입점·직접 경로 호출이 허용 목록 밖에 없고, 문서의 새 꼴이 모두 명령 표에 있다 | 로컬 python 3, node 24 | 없음 | PR 전 |
