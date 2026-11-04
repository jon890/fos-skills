# Phase 03. PATH 실행기 `bin/orch` 와 `orch doctor install-cli`

**Execution profile**: standard

## 목표

Claude 세션의 Bash 는 플러그인 루트 `bin/orch` 로, Codex 와 사람의 셸은 `orch doctor install-cli` 로 깐 `~/.local/bin/orch` 로 `orch` 를 부른다. 두 사본 모두 설치 기록에서 번들을 찾아 그 번들의 진입점에 넘기기만 한다.

**범위 외**: doctor 의 `CLI-MISSING`, `CLI-NOT-ON-PATH` 판정(phase 05). 진입점의 명령 해석(phase 01).

## 컨텍스트

**요구사항**: REQ1, REQ6

**근거 문서**: `docs/features/orch-cli/spec.md` 의 REQ1·REQ6, DECISION4·DECISION15. `docs/features/orch-cli/design.md` 의 「실행기 `bin/orch`」, 「실패와 일관성」, 결정 DECISION1·DECISION2·DECISION8.

- Claude Code 는 켜진 플러그인 루트의 `bin/` 을 Bash 도구의 PATH 에 넣는다(plugins-reference 「Standard layout」). 맨 이름으로 불리려면 확장자 없는 실행 파일이어야 한다.
- 지금 `docs/adr/004-no-plugin-bin.md` 가 루트 `bin/` 을 막고 `scripts/tests/test_plugin_manifest.py` 의 `test_no_bin_directory` 가 그것을 검사한다. README 「도구」 절의 「이 플러그인은 `bin/` 을 두지 않아」 문장도 그 결정을 따른다. `docs/code-architecture.md` 가 도구 배치를 소유한다.
- 번들 고르기 규칙의 원본은 phase 01 의 `skills/orch/scripts/lib/install-record.ts` 의 `selectBundle` 이다. 실행기는 CommonJS 라 import 할 수 없어 같은 규칙을 다시 쓰고, 같은 사례 표 `skills/orch/tests/fixtures/install-records.json` 으로 묶는다. `ORCH_SCRIPTS_DIR` 이 있으면 그 폴더의 `../bin/orch.ts` 로 넘긴다.
- 실행기는 고른 번들의 `skills/orch/bin/orch.ts` 를 `node --disable-warning=ExperimentalWarning` 로 실행하고 입출력·신호·종료 코드를 잇는다. 신호 전달은 지금 진입점의 `forward` 를 따른다(SIGINT·SIGTERM·SIGHUP 을 전하고 128+신호 번호).
- 고른 번들에 `skills/orch/scripts/lib/commands.ts` 가 없으면(이 기능 이전 번들) 넘기지 않고 이유와 플러그인 갱신 명령을 내고 3 으로 끝난다.
- Node 최소 버전은 `skills/orch/scripts/ts_shim.py` 의 `MIN_NODE` 와 같은 값이다.

## 의도 메모

- 실행기는 확장자 없는 CommonJS 한 파일이고 타입 문법이 없다. 낮은 node 에서도 읽혀 `NODE-TOO-OLD <필요> <지금>` 을 직접 내고 3 으로 끝난다(설계 DECISION2, `docs/adr/011-node-24-minimum.md`).
- 파일 머리에 표지 주석 `fos-skills orch launcher` 를 둔다. phase 04 의 `NEXT_WAIT` 와 phase 05 의 doctor 가 PATH 의 `orch` 를 이 표지로 가린다.
- 명령 표를 갖지 않으므로 `~/.local/bin` 사본이 낡지 않는다. `~/.local/bin` 사본은 든 번들이 없어 설치 기록에 쓸 항목이 없으면 이유와 `claude plugin install fos-skills@fos-skills` 을 내고 3 이다.
- `install-cli` 는 다른 `orch`(표지 없음)를 덮지 않고 `CLI-CONFLICT <경로>` 와 1 로 끝난다(스펙 DECISION15).

## 작업 항목

### 1. 플러그인 루트 `bin/orch` 신규

- 설계 「실행기」 대로. git 모드 100755 로 커밋한다(`git update-index --chmod=+x bin/orch` 또는 `chmod +x` 뒤 add).
- 첫 줄 `#!/usr/bin/env node`. 둘째 줄 표지 주석. 머리 주석에 하는 일, 번들 고르기 차례, 종료 코드(자식 코드, 3 번들 없음)를 적는다.

### 2. `skills/orch/scripts/install-cli.ts` 신규

- 명령 표의 `orch doctor install-cli` 가 부른다(phase 01 의 표 행을 그대로 쓰고, `lib-commands.spec.ts` 의 「파일 없음」 예외를 지운다).
- 이 번들의 루트 `bin/orch` 를 `~/.local/bin/orch` 에 복사하고 0755 로 둔다. 폴더가 없으면 만든다. 표지가 있는 기존 파일은 덮어 갱신한다. 결과 줄은 `CLI-INSTALLED <경로>` 또는 `CLI-UPDATED <경로>`. 표지 없는 기존 파일은 `CLI-CONFLICT <경로>` 와 1.
- `--target <파일>` 로 복사할 곳을 바꿀 수 있다(테스트용, 기본 `~/.local/bin/orch`). `lib/args.ts` 의 `expandArgs` 를 거쳐 parseArgs 로 받는다(다른 스크립트와 같은 패턴, 예: `skills/orch/scripts/user-active.ts`).

### 3. ADR 과 책임 문서

- `docs/adr/004-no-plugin-bin.md`: 결정을 「루트 `bin/` 에는 orch 실행기 `orch` 하나만 둔다. 공용 도구(`browser-driver`)의 PATH 명령은 두지 않는다」 로 고친다. 맥락에 2026-11-04 의 사용자 결정(스펙 DECISION4)과 이름 경쟁이 없는 이유(`orch` 는 다른 플러그인이 두지 않는다)를 더한다. 결과의 테스트 문장을 새 검사에 맞춘다.
- `scripts/tests/test_plugin_manifest.py`: `test_no_bin_directory` 를 「루트 `bin/` 에는 `orch` 하나만 있고 실행 비트가 있다」 로 바꾼다.
- `README.md` 「공용 도구」 절(273줄 근처)의 「이 플러그인은 `bin/` 을 두지 않아」 문장과 `docs/code-architecture.md` 의 도구 배치 줄을 ADR 에 맞춘다.

### 4. 테스트 `skills/orch/tests/orch-launcher.spec.ts` 신규

`orch-entry.spec.ts` 의 `bundle()`, `install()` 패턴으로 가짜 번들에 진입점 사본을 둔다.

- `fixtures/install-records.json` 의 행마다 실행기가 고른 번들(가짜 진입점이 자기 번들 이름을 낸다)이 기대와 같다.
- 실행기가 user 범위 번들의 진입점에 인자를 그대로 넘기고 종료 코드를 돌려준다. 공백 있는 설정 폴더도 된다. 받은 SIGTERM 을 자식에 전하고 143 으로 끝난다.
- 이 기능 이전 번들(`lib/commands.ts` 없음)을 고르면 3 과 갱신 안내.
- 실행기 안의 최소 Node 버전 값이 `ts_shim.py` 의 `MIN_NODE` 와 같다.
- user 범위 번들에 진입점이 없고 project 범위에는 있으면 3 과 이유.
- `~/.local/bin` 사본(실행기를 임시 폴더에 복사)으로 불러도 같은 번들이 돈다. 설치 기록이 없으면 3 과 설치 안내.
- `install-cli --target` 이 새 파일을 0755 로 만들고, 표지 있는 파일은 갱신하고, 표지 없는 파일은 1 과 `CLI-CONFLICT` 로 남긴다.

## 검증

```bash
node --test skills/orch/tests/orch-launcher.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/lib-commands.spec.ts
python3 -m unittest scripts/tests/test_plugin_manifest.py
python3 skills/plan/scripts/check_adr_layout.py docs/adr
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `bin/orch` | 신규 |
| `skills/orch/scripts/install-cli.ts` | 신규 |
| `skills/orch/tests/orch-launcher.spec.ts` | 신규 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
| `scripts/tests/test_plugin_manifest.py` | 수정 |
| `docs/adr/004-no-plugin-bin.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `README.md` | 수정 |
