# Phase 05. doctor 의 새 판정과 스크립트 안내 문구의 새 꼴

**Execution profile**: standard

## 목표

`orch doctor` 가 `orch` 가 PATH 에 없는 셸, 옛 번들로 도는 대기, 옛 꼴과 스크립트 직접 경로가 남은 오버레이·저장소 스크립트·공통 지시서를 판정 줄과 고칠 명령 한 줄로 알리고, 문서의 새 꼴 호출을 명령 표로 확인한다. 스크립트가 내는 안내 문구도 새 꼴로 바꾼다.

**범위 외**: 문서 본문의 호출 바꾸기(phase 06). 다른 저장소 파일 고치기(코디네이터가 맡는다, 스펙 DECISION17).

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/orch-cli/spec.md` 의 REQ7, DECISION7·DECISION15·DECISION17, 「저장소 밖에서 orch 를 부르거나 출력을 읽는 곳」 표, 부록. `docs/features/orch-cli/design.md` 의 요구사항 연결 REQ7·REQ8, 「스크립트」 의 안내 줄 규칙, 「옛 꼴과 직접 경로 판정」 표, 「실패와 일관성」 의 `CLI-MISSING` 판정과 문서 판정의 새 꼴 찾기, 결정 DECISION12.

- `skills/orch/scripts/orch-doctor.ts` 의 `main()`(545줄 근처)이 판정 줄을 모아 stdout 에 낸다. 종료 코드는 `version`, `scripts`, `questions`, `INVALID-CONFIG` 로 정한다. 새 판정은 종료 코드를 바꾸지 않는다(알림만).
- 문서 판정 `checkScripts()`(327줄)는 `REF`, `BIN_REF`, `VIA_ENTRY` 정규식(162~166줄)으로 `$SKILL_DIR/scripts/<이름>` 과 `"$SKILL_DIR/bin/orch.ts" <이름>` 을 본다. `scripts/tests/test_doc_script_refs.py` 가 스킬마다 `--skip-version` 으로 이것을 부른다.
- 옛 번들 루프 판정 `staleLoops()`(486줄)와 `staleBundle()`(463줄)이 ps 명령줄의 `orch-loop.ts --foreground` 를 본다. 대기는 `lib/waiters.ts` 의 `waiterPids(runId)` 가 ps 에서 찾는다.
- 옛 꼴이나 스크립트 직접 경로를 안내로 내는 곳은 설계 「스크립트」 의 grep 규칙으로 찾는다. 2026-11-04 실측: `skills/orch/scripts/launch-worker.ts` 516줄(`link-claude-profile`), `lib/sessions.ts` 25줄(`adopt-sessions`), `lib/config.ts` 126줄(`migrate-orch-dir`), `lib/paths.ts` 의 `warnLegacy`·`requireMigrated`(`migrate-orch-dir`), `orch-loop.ts` 의 finish-pr 안내와 `reserve-migration --prune/--again` 안내, `remove-worktree.ts` 의 `cleanup-sweep --kill-holders` 안내, `orch-doctor.ts` 의 `LOOP-DEAD` 줄(596줄 근처)과 `LOOP-STALE` 의 두 명령(507줄 근처), `lib/bundle.ts` 의 `STALE-BUNDLE` 안내. 각 스크립트의 `사용법:` 줄은 바꾸지 않는다(설계 DECISION12).
- `selectBundle()` 이 오류를 내면 `staleBundle()` 과 `WAIT-STALE` 은 판정하지 않는다(설계 「실패와 일관성」).
- doctor 의 옛 번들 판정 `staleBundle()` 은 프로필마다 캐시 폴더가 달라도 마지막 폴더 이름으로 같은 번들을 알아본다. 이 비교는 그대로 두고, 「현재 설치본」 을 고르는 부분만 `lib/install-record.ts` 의 `selectBundle()` 로 바꾼다.

## 의도 메모

- doctor 는 Claude 세션의 Bash(플러그인 `bin/` 이 PATH 에 있다)에서 돌아 사람 셸의 PATH 를 볼 수 없다. 그래서 `~/.local/bin/orch` 가 없거나 표지가 없으면 `CLI-MISSING`, 있는데 PATH 에서 플러그인 `bin/` 폴더를 뺀 나머지에 `~/.local/bin` 이 없으면 `CLI-NOT-ON-PATH` 다(설계 「실패와 일관성」).
- 안내 문구의 명령은 새 꼴에 값을 명시해 적는다(`orch loop start --repo <저장소> --run <Run>`). 안내를 다른 세션에서 붙여 넣어도 같은 대상을 보게 하려는 것이다.

## 작업 항목

### 1. `skills/orch/scripts/orch-doctor.ts` 판정 추가

- `CLI-MISSING <~/.local/bin/orch>` 와 고칠 명령 `orch doctor install-cli`. `CLI-NOT-ON-PATH <폴더>` 와 셸 설정에 PATH 를 더하라는 한 줄. 표지가 있는데 내용이 이 번들의 루트 `bin/orch` 와 다르면 `CLI-STALE <경로>` 와 `orch doctor install-cli`.
- `WAIT-STALE <pid> <번들>`: ps 에서 `wait-important.ts` 를 실행하는 프로세스의 스크립트 경로를 `staleBundle()` 로 판정한다. 고칠 줄은 「그 대기를 끝내고 `orch wait --ack <id>` 로 다시 건다」.
- `OLD-CALL`, `DIRECT-PATH`: 보는 파일, 찾는 꼴, 고칠 줄, 한 줄에 둘이 걸릴 때, `orch-compat` 예외 표지는 설계 「옛 꼴과 직접 경로 판정」 표 그대로다. `<이름>` 은 명령 표의 `script` 로 한정한다. 실제 저장소 사례로 테스트하려고 스펙 부록의 꼴(설치 기록을 푸는 `node -e` 한 줄 뒤의 `"$ORCH_SCRIPTS/worker-ask.ts"`, `"$ORCH" heavy-slot`, `join(ORCH_SCRIPTS, 'nudge-worker.ts')`, gersang-lab `with-heavy-slot.sh` 의 `orch.mts --path mem-gate`, 옛 캐시 경로 직접 기록)을 `orch-doctor.spec.ts` 안에서 임시 저장소 파일로 만든다.
- 옛 이름과 새 꼴은 `lib/commands.ts`(phase 01)의 `legacyNames()`, `resolveLegacy()` 로 얻는다. 판정 정규식을 doctor 에 따로 두지 않는다.

### 2. 문서 판정이 새 꼴을 확인

`checkScripts()` 가 문서의 백틱 안이나 코드 블록 안에서 `orch ` 뒤에 ASCII 소문자 낱말이 오는 꼴을 찾아 명령 표에 있는지, 그 `script` 파일이 있는지 본다. 없으면 `MISSING <문서>:<줄> orch <묶음> <동작>`. 산문의 「orch 루트」 는 보지 않는다. 옛 꼴 정규식은 호환 기간 동안 그대로 둔다. 머리 주석(34~40줄)을 고친다.

### 3. 안내 문구를 새 꼴로

위 컨텍스트의 자리를 모두 새 꼴로 바꾼다. 안내의 앞 낱말은 phase 04 가 만든 `lib/commands.ts` 의 `orchWord()` 다. 값은 명시해 적는다(`orch loop start --repo <저장소> --run <Run>`).

### 4. 테스트

- `skills/orch/tests/orch-doctor.spec.ts`: 먼저 `beforeEach` 에서 HOME 을 임시 폴더로 고정하고, PATH 는 node·git·가짜 orca 폴더를 남긴 채 사용자 폴더(`~/.local/bin`)만 임시 HOME 의 것으로 바꿔 그 HOME 에 표지 있는 최신 `~/.local/bin/orch` 를 두어, 출력 전체를 비교하는 기존 사례(94~106줄의 환경 설정을 쓰는 사례들)에 `CLI-*` 줄이 끼지 않게 한다. 394줄 근처의 `migrate-orch-dir` 안내 기대값을 새 꼴로 고친다. 그다음 임시 HOME 에 `~/.local/bin/orch` 가 없을 때 `CLI-MISSING`, 표지 있는 파일이 있고 PATH 에 그 폴더가 없을 때 `CLI-NOT-ON-PATH`, 둘 다 맞으면 줄이 없다. 임시 저장소의 `.orch/overlay.md` 에 `"$SKILL_DIR/bin/orch.ts" wait-important` 와 `$SKILL_DIR/scripts/merge-with-finish.ts` 를 두면 `OLD-CALL` 과 `DIRECT-PATH` 와 새 꼴 줄이 나온다. 가짜 ps(`PS` 환경 변수)로 옛 번들 `wait-important.ts` 프로세스를 보이면 `WAIT-STALE`. 표지 있고 내용이 다른 `~/.local/bin/orch` 에서 `CLI-STALE`. 부록 꼴 fixture 마다 `OLD-CALL` 이나 `DIRECT-PATH` 가 한 줄씩 나오고, `orch-compat` 표지가 붙은 줄은 나오지 않는다. 문서에 없는 새 꼴(`` `orch nope x` ``)을 쓴 임시 스킬 폴더에서 `MISSING`, 산문의 「orch 루트」 는 `MISSING` 이 아니다. 새 판정이 있어도 종료 코드는 그대로다. `LOOP-DEAD`, `LOOP-STALE` 의 고칠 줄이 새 꼴이다.
- 안내 문구 기대값을 새 꼴로 고친다. 2026-11-04 실측으로 깨지는 단언: `finish-pr.spec.ts` 520줄 근처, `merge-with-finish.spec.ts` 532·537·546·559·776·788줄 근처(`migrate-orch-dir` 안내), `orch-loop-auto-merge.spec.ts` 701줄 근처(`reserve-migration` 안내 정규식), `launch-worker.spec.ts` 1473줄 근처, 그리고 `lib-config.spec.ts`, `lib-bundle.spec.ts`. 구현 때 `git grep -nE "migrate-orch-dir|reserve-migration|link-claude-profile|adopt-sessions|kill-holders|finish-pr" skills/orch/tests` 로 다시 찾는다. 기대값이 PATH 에 따라 달라지지 않게 그 테스트들의 PATH 를 고정한다. 기대값이 없던 곳은 새 꼴이 들어 있는지 한 사례를 더한다. `lib/sessions.ts` 의 안내는 `skills/orch/tests/adopt-sessions.spec.ts` 나 그 문구를 단언하는 기존 테스트(`git grep -n "이어받기" skills/orch/tests`)에서 본다.

## 검증

```bash
node --test skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/lib-config.spec.ts skills/orch/tests/lib-bundle.spec.ts skills/orch/tests/adopt-sessions.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/remove-worktree.spec.ts skills/orch/tests/lib-paths.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/merge-with-finish.spec.ts skills/orch/tests/orch-loop-auto-merge.spec.ts
python3 -m unittest scripts/tests/test_doc_script_refs.py
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/orch-doctor.ts` | 수정 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/scripts/lib/paths.ts` | 수정 |
| `skills/orch/scripts/remove-worktree.ts` | 수정 |
| `skills/orch/tests/remove-worktree.spec.ts` | 수정 |
| `skills/orch/tests/lib-paths.spec.ts` | 수정 |
| `skills/orch/scripts/launch-worker.ts` | 수정 |
| `skills/orch/scripts/lib/sessions.ts` | 수정 |
| `skills/orch/scripts/lib/config.ts` | 수정 |
| `skills/orch/scripts/lib/bundle.ts` | 수정 |
| `skills/orch/scripts/orch-loop.ts` | 수정 |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/lib-config.spec.ts` | 수정 |
| `skills/orch/tests/lib-bundle.spec.ts` | 수정 |
| `skills/orch/tests/adopt-sessions.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 |
| `skills/orch/tests/merge-with-finish.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-auto-merge.spec.ts` | 수정 |
| `skills/orch/tests/orch-paths.spec.ts` | 수정 |
| `skills/orch/tests/wait-important.spec.ts` | 수정 |
