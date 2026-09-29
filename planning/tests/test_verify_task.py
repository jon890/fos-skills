"""task 검사기의 실행 가능한 계획과 파일 상태를 검증한다."""

import importlib.util
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_task.py"
SPEC = importlib.util.spec_from_file_location("verify_task", SCRIPT)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


class ExistingRulesTest(unittest.TestCase):
    def test_prose_excludes_code_and_design_rationale(self):
        text = "## 의도 메모\n직접 확인했다\n## 작업 항목\n직접 확인한다\n```bash\n육안\n```\n"
        self.assertEqual(list(verify.iter_prose(text)), [(4, "직접 확인한다")])

    def test_missing_evidence_document_is_reported(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            out = []
            verify.check_phase_prompt(Path("phase.md"), "**근거 문서**: `docs/absent.md`\n", out, repo=Path(tmp))
            self.assertTrue(any("없는 경로" in issue for issue in out))

    def test_bundle_command_requires_cwd(self):
        out = []
        verify.check_bash_cwd(Path("phase.md"), '```bash\npython3 "$SKILL_DIR/scripts/check.py"\n```', out)
        self.assertTrue(any("cwd" in issue for issue in out))


class TaskRulesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.file("docs/flow.md")
        # 실제 git 테스트가 사용자 전역 설정의 영향을 받지 않게 한다.
        env = patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})
        env.start()
        self.addCleanup(env.stop)

    def file(self, rel, content=""):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def prompt(self, work, command):
        return f"## 컨텍스트\n**근거 문서**: `docs/flow.md`\n\n## 작업 항목\n{work}\n\n## 검증\n```bash\n{command}\n```\n"

    def inspect(self, work, command, entries):
        out = []
        verify.check_phase_prompt(Path("phase.md"), self.prompt(work, command), out, entries, self.repo)
        return out

    def test_last_item_can_be_acceptance_evaluation(self):
        entries = [("src/app.py", "신규"), ("tests/test_app.py", "신규")]
        work = "### 1. `src/app.py`\n### 2. `tests/test_app.py`\n정상과 실패 응답을 단언한다.\n### 3. 41종 평가 실행과 기록"
        self.assertEqual(self.inspect(work, "pytest tests/test_app.py", entries), [])

    def test_title_change_does_not_make_lint_a_test(self):
        entries = [("src/app.py", "수정")]
        for title in ("확인", "테스트"):
            with self.subTest(title=title):
                self.assertTrue(self.inspect(f"### 1. 검증하는 {title}", "ruff check src", entries))

    def test_commandless_human_verification_is_rejected(self):
        for prose in ("담당자가 확인한다.", "화면을 확인한다.", "사람이 판정한다."):
            out = []
            verify.check_human_verification(Path("p"), "## 검증\n" + prose, out)
            self.assertTrue(out)

    def test_human_description_with_command_is_not_an_extra_violation(self):
        out = []
        verify.check_human_verification(Path("p"), "## 검증\n```bash\npytest\n```\n사용자가 확인하는 화면의 응답을 단언한다.", out)
        self.assertEqual(out, [])

    def test_human_terms_in_context_or_rationale_are_not_extra_violations(self):
        out = []
        verify.check_human_verification(Path("p"), "## 컨텍스트\n사용자가 확인한다.\n## 의도 메모\n담당자가 확인했다.\n## 검증\n자동화한다.", out)
        self.assertEqual(out, [])

    def test_code_change_without_same_phase_test_is_rejected(self):
        self.assertTrue(self.inspect("### 1. `src/app.py` 변경", "pytest", [("src/app.py", "수정")]))

    def test_test_declared_only_in_file_table_is_rejected(self):
        self.assertTrue(self.inspect("### 1. `src/app.py` 변경", "pytest", [("src/app.py", "수정"), ("tests/test_app.py", "수정")]))

    def test_java_class_reference_without_extension_is_accepted(self):
        self.assertEqual(self.inspect("### 1. `AppTest` 에 실패 입력 추가", "./gradlew :api:test", [("src/App.java", "수정"), ("src/test/java/AppTest.java", "수정")]), [])

    def test_code_blocks_before_test_declarations_are_ignored(self):
        work = "### 1. `App.java`\n```java\nclass App {}\n```\n### 2. `AppTest.java` 추가"
        self.assertEqual(self.inspect(work, "./gradlew test", [("src/App.java", "신규"), ("src/test/java/AppTest.java", "신규")]), [])

    def test_test_reference_only_inside_code_is_not_a_work_item(self):
        work = "### 1. `src/app.py`\n```python\n# `tests/test_app.py`\n```"
        self.assertTrue(self.inspect(work, "pytest", [("src/app.py", "신규"), ("tests/test_app.py", "신규")]))

    def test_test_not_executed_by_targeted_command_is_rejected(self):
        out = self.inspect("### 1. `tests/test_app.py` 추가", "pytest tests/test_other.py", [("src/app.py", "수정"), ("tests/test_app.py", "신규")])
        self.assertTrue(out)

    def test_targeted_test_glob_executes_declared_file(self):
        self.assertEqual(self.inspect("### 1. `tests/test_app.py` 추가", "pytest tests/test_*.py", [("src/app.py", "수정"), ("tests/test_app.py", "신규")]), [])

    def test_same_phase_regression_script_can_be_run(self):
        self.assertEqual(self.inspect("### 1. `scripts/check-app.sh` 에 실패 응답 검증 추가", "bash scripts/check-app.sh", [("scripts/check-app.sh", "신규")]), [])

    def test_deferral_detection_ignores_next_case_and_catches_other_plans(self):
        entries = [("tests/test_app.py", "수정")]
        work = "### 1. `tests/test_app.py`\n"
        for prose in ("테스트는 다음 케이스를 추가한다.", "테스트 픽스처는 다음 형식으로 작성한다.", "회귀 테스트를 후속 plan 으로 넘기지 않는다."):
            with self.subTest(prose=prose):
                self.assertEqual(self.inspect(work + prose, "pytest", entries), [])
        for prose in ("테스트는 다음 phase 에서 작성한다. 지금은 필요하지 않다.", "회귀 테스트는 후속 plan 으로 넘긴다.", "테스트는 나중에 추가한다."):
            with self.subTest(prose=prose):
                self.assertTrue(self.inspect(work + prose, "pytest", entries))

    def test_next_phase_test_deferral_is_rejected(self):
        entries = [("tests/test_app.py", "수정")]
        self.assertTrue(self.inspect("### 1. `tests/test_app.py`\n회귀 테스트는 다음 phase 에 작성한다.", "pytest", entries))
        self.assertEqual(self.inspect("### 1. `tests/test_app.py`\n테스트를 다음 phase 로 미루지 않는다.", "pytest", entries), [])

    def test_comment_only_block_has_no_command(self):
        self.assertTrue(self.inspect("### 1. 문서", "# pytest 를 실행한다", [("docs/a.md", "수정")]))

    def test_runner_names_in_echo_and_grep_are_not_execution(self):
        for command in ("echo pytest", "grep pytest README.md", "shellcheck scripts/check.sh", "./gradlew build -x test", "mvn verify -DskipTests"):
            with self.subTest(command=command):
                self.assertFalse(any(verify.test_command(c, [], self.repo) for c in verify.shell_commands(f"```bash\n{command}\n```")))

    def test_repository_test_commands(self):
        for command in ("pytest", "python3 -m unittest discover", "npm test", "pnpm run test", "npm run test:unit", "yarn test", "./gradlew :api:build", "./gradlew test -x lint", "mvn verify -DskipTests=false", "go test ./...", "cargo test", "dotnet test"):
            with self.subTest(command=command):
                self.assertTrue(any(verify.test_command(c, [], self.repo) for c in verify.shell_commands(f"```bash\n{command}\n```")))

    def test_wrapped_and_workspace_test_commands(self):
        for command in ("make test", "make -C api check", "tox", "tox -e py312", "jest", "npx vitest run", "npx jest --ci", "bundle exec rspec", "uv run pytest", "uv run --with x pytest -q", "poetry run pytest", "pipenv run python -m pytest", "pnpm --filter web test", "pnpm -r test", "npm --prefix web test", "npm -w web run test", "yarn workspace web test", "(cd web && npm test)"):
            with self.subTest(command=command):
                self.assertTrue(any(verify.test_command(c, [], self.repo) for c in verify.shell_commands(f"```bash\n{command}\n```")))
        for command in ("make lint", "npx eslint .", "uv run ruff check", "pnpm --filter web lint", "(cd web && npm run build)"):
            with self.subTest(command=command):
                self.assertFalse(any(verify.test_command(c, [], self.repo) for c in verify.shell_commands(f"```bash\n{command}\n```")))

    def test_unknown_runner_is_warning_not_violation(self):
        out, warnings = [], []
        verify.check_phase_prompt(Path("p"), self.prompt("### 1. `tests/test_app.py`", "just test"), out, [("tests/test_app.py", "수정")], self.repo, warnings)
        self.assertEqual(out, [])
        self.assertTrue(any("판정하지 못한" in w for w in warnings))
        self.assertTrue(self.inspect("### 1. `tests/test_app.py`", "ruff check src\nnpm run lint", [("tests/test_app.py", "수정")]))

    def test_spec_suffix_needs_test_directory_or_code_test_name(self):
        for rel in ("src/main/java/UserSpec.java", "docs/specs/x.md", "src/testing.py"):
            with self.subTest(rel=rel):
                self.assertFalse(verify.is_test(rel))
        for rel in ("src/test/java/UserSpec.java", "spec/user_spec.rb", "tests/fixtures/data.json", "web/app.spec.ts", "pkg/app_test.go", "src/AppTest.java", "tests/test_*.py", "tests"):
            with self.subTest(rel=rel):
                self.assertTrue(verify.is_test(rel))

    def test_exit_zero_suppression_and_tee_without_pipefail(self):
        entries = [("tests/test_app.py", "신규")]
        self.assertTrue(self.inspect("### 1. `tests/test_app.py`", "pytest || exit 0", entries))
        out, warnings = [], []
        verify.check_phase_prompt(Path("p"), self.prompt("### 1. `tests/test_app.py`", "pytest | tee out.log"), out, entries, self.repo, warnings)
        self.assertEqual(out, [])
        self.assertTrue(any("pipefail" in w for w in warnings))
        warnings = []
        verify.check_phase_prompt(Path("p"), self.prompt("### 1. `tests/test_app.py`", "set -euo pipefail\npytest | tee out.log"), [], entries, self.repo, warnings)
        self.assertFalse(any("pipefail" in w for w in warnings))

    def test_bsd_sed_inside_shell_block_is_reported(self):
        out = []
        verify.check_code_sed(Path("p"), "## 작업 항목\n```bash\nsed -i '' 's/\\bfoo/bar/' a.txt\n```\n```python\nsed = r'sed x \\b'\n```", out)
        self.assertEqual(len(out), 1)
        self.assertIn("p:3", out[0])

    def test_fence_helper_needs_matching_closing_fence(self):
        text = "## 작업 항목\n````bash\n```\n## 코드 안\n````\n## 검증\n끝"
        self.assertIn("## 코드 안", verify.section(text, "작업 항목"))
        self.assertEqual([n for n, _ in verify.iter_prose(text)], [7])
        self.assertEqual([body for _, _, body in verify.code_blocks(text)], ["```\n## 코드 안"])

    def test_assignments_chains_and_multiline_commands(self):
        commands = list(verify.shell_commands('```bash\nenv FLAG=1 pytest \\\n tests/test_app.py; echo "exit=$?"\ngrep x a && pytest\n```'))
        self.assertEqual([c[0] for c in commands], ["pytest", "echo", "grep", "pytest"])

    def test_regular_repo_command_needs_no_cwd_comment(self):
        out = []
        verify.check_bash_cwd(Path("p"), "```bash\npytest\n```", out)
        self.assertEqual(out, [])

    def test_bundle_locations_need_cwd_comment(self):
        for command in ('python3 "$SKILL_DIR/scripts/verify.py"', 'bash "${SKILL_DIR}/scripts/verify.sh"', 'python3 ~/.claude/skills/planning/scripts/a.py', 'python3 ~/.codex/skills/planning/scripts/a.py'):
            with self.subTest(command=command):
                out = []
                verify.check_bash_cwd(Path("p"), f"```bash\n{command}\n```", out)
                self.assertTrue(out)
                out = []
                verify.check_bash_cwd(Path("p"), f"```bash\n# cwd: root\n{command}\n```", out)
                self.assertEqual(out, [])

    def test_all_multiline_evidence_documents_are_checked(self):
        out = []
        text = self.prompt("### 1. 문서", "pytest").replace("`docs/flow.md`", "`docs/flow.md`,\n`docs/missing.md`")
        verify.check_phase_prompt(Path("p"), text, out, repo=self.repo)
        self.assertTrue(any("docs/missing.md" in issue for issue in out))

    def test_fenced_heading_does_not_end_validation_section(self):
        text = "## 검증\n```bash\n## 설명\npytest\n```\n## 변경 파일\n끝"
        self.assertIn("pytest", verify.section(text, "검증"))

    def test_inline_comments_do_not_join_adjacent_commands(self):
        commands = list(verify.shell_commands("```bash\ngrep x src # 기존 설정\npytest # 전체 테스트\necho done\n```"))
        self.assertEqual([c[0] for c in commands], ["grep", "pytest", "echo"])

    def test_file_lifecycle_across_phases(self):
        virtual, out, warnings = {}, [], []
        verify.check_file_state(Path("p1"), [("src/new.py", "신규")], self.repo, virtual, out, warnings)
        verify.check_file_state(Path("p2"), [("src/new.py", "수정")], self.repo, virtual, out, warnings)
        verify.check_file_state(Path("p3"), [("src/new.py", "삭제")], self.repo, virtual, out, warnings)
        self.assertEqual(out, [])
        verify.check_file_state(Path("p4"), [("src/new.py", "수정")], self.repo, virtual, out, warnings)
        self.assertTrue(out)

    def test_file_states_and_glob_matching(self):
        self.file("src/existing.py")
        for entries, expected in (([("src/existing.py", "수정")], 0), ([("src/*.py", "삭제")], 0), ([("src/existing.py", "신규")], 1), ([("absent.py", "수정")], 1), ([("absent.py", "삭제")], 1)):
            with self.subTest(entries=entries):
                out = []
                verify.check_file_state(Path("p"), entries, self.repo, {}, out, [])
                self.assertEqual(len(out), expected)

    def test_glob_delete_is_visible_to_later_phase(self):
        self.file("src/app.py")
        virtual, out = {}, []
        verify.check_file_state(Path("p1"), [("src/*.py", "삭제")], self.repo, virtual, out, [])
        verify.check_file_state(Path("p2"), [("src/app.py", "수정")], self.repo, virtual, out, [])
        self.assertEqual(len(out), 1)

    def test_glob_directory_depth_is_preserved(self):
        self.assertTrue(verify.matches("src/a.py", "src/*.py"))
        self.assertFalse(verify.matches("src/nested/a.py", "src/*.py"))
        self.assertTrue(verify.matches("src/nested/a.py", "src/**/*.py"))
        self.assertTrue(verify.matches("src/a.py", "src/**/*.py"))

    def test_test_failure_suppression_is_rejected(self):
        entries = [("tests/test_app.py", "신규")]
        self.assertTrue(self.inspect("### 1. `tests/test_app.py`", "pytest || true", entries))
        self.assertEqual(self.inspect("### 1. `tests/test_app.py`", "pytest\ngrep optional README.md || true", entries), [])

    def test_omitted_path_is_violation_in_manifest_and_warning_in_legacy(self):
        # 생성 검사가 경고로 통과시킨 경로를 커밋 전 staged 대조가 막던 불일치의 재현이다.
        out, warnings = [], []
        verify.check_file_state(Path("p"), [("src/.../app.py", "수정"), ("src/*.py", "신규")], self.repo, {}, out, warnings)
        self.assertEqual(len(out), 1)
        self.assertEqual(len(warnings), 1)
        out, warnings = [], []
        verify.check_file_state(Path("p"), [("src/.../app.py", "수정")], self.repo, {}, out, warnings, legacy=True)
        self.assertEqual(out, [])
        self.assertEqual(len(warnings), 1)
        self.assertFalse(verify.legacy_manifest("## 변경 파일\n| `a` | 수정 |"))
        self.assertTrue(verify.legacy_manifest("## Critical Files\n| `a` | 수정 |"))

    def test_new_glob_from_earlier_phase_counts_as_existing(self):
        virtual, created, out = {}, [], []
        verify.check_file_state(Path("p1"), [("src/dto/*.java", "신규")], self.repo, virtual, out, [], created=created)
        verify.check_file_state(Path("p2"), [("src/dto/Foo.java", "수정")], self.repo, virtual, out, [], created=created)
        self.assertEqual(out, [])
        verify.check_file_state(Path("p3"), [("src/dto/Foo.java", "삭제")], self.repo, virtual, out, [], created=created)
        verify.check_file_state(Path("p4"), [("src/dto/Foo.java", "수정")], self.repo, virtual, out, [], created=created)
        self.assertEqual(len(out), 1)
        verify.check_file_state(Path("p5"), [("src/other/Foo.java", "수정")], self.repo, virtual, out, [], created=created)
        self.assertEqual(len(out), 2)

    def test_glob_inside_earlier_new_glob_counts_as_existing(self):
        # 앞 phase 가 backend/** 를 신규로 두고 뒤 phase 가 backend/tasks/** 를 삭제하던 계획서의 재현이다.
        virtual, created, out = {}, [], []
        verify.check_file_state(Path("p1"), [("backend/**", "신규")], self.repo, virtual, out, [], created=created)
        verify.check_file_state(Path("p2"), [("backend/tasks/**", "삭제")], self.repo, virtual, out, [], created=created)
        self.assertEqual(out, [])
        verify.check_file_state(Path("p3"), [("backend/tasks/**", "삭제")], self.repo, virtual, out, [], created=created)
        verify.check_file_state(Path("p4"), [("backend/tasks/a.py", "수정")], self.repo, virtual, out, [], created=created)
        self.assertEqual(len(out), 2)
        verify.check_file_state(Path("p5"), [("backend/src/*.py", "수정")], self.repo, virtual, out, [], created=created)
        self.assertEqual(len(out), 2)

    def test_glob_outside_earlier_new_glob_is_still_missing(self):
        virtual, created, out = {}, [], []
        verify.check_file_state(Path("p1"), [("backend/**", "신규")], self.repo, virtual, out, [], created=created)
        verify.check_file_state(Path("p2"), [("frontend/tasks/**", "삭제")], self.repo, virtual, out, [], created=created)
        self.assertEqual(len(out), 1)

    def test_manifest_compatibility_and_invalid_rows(self):
        for name in ("변경 파일", "Critical Files"):
            out, warnings = [], []
            entries = verify.manifest(Path("p"), f"## {name}\n| 파일 | 변경 |\n| `src/a.py` | 수정 |", out, warnings)
            self.assertEqual(entries, [("src/a.py", "수정")])
            self.assertEqual(out, [])
        for rel in ("../escape.py", "/tmp/escape.py", "$APP/a.py"):
            out = []
            verify.manifest(Path("p"), f"## 변경 파일\n| `{rel}` | 수정 |", out, [])
            self.assertTrue(out)

    def test_cli_audit_and_execution_errors(self):
        plan = self.repo / "tasks" / "plan1-app"
        self.file("src/app.py")
        phase = self.prompt("### 1. `tests/test_app.py` 추가", "pytest")
        phase += "\n## 목표\n앱\n**범위 외**: 배포\n## 변경 파일\n| `src/app.py` | 신규 |\n| `tests/test_app.py` | 신규 |\n## 마감\nindex.json status completed\n"
        self.file("tasks/plan1-app/phase-01.md", phase)
        index = {"name": "plan1-app", "total_phases": 1, "phases": [{"number": 1, "file": "phase-01.md", "execution_profile": "standard"}]}
        self.file("tasks/plan1-app/index.json", json.dumps(index))
        with patch.object(verify.Path, "cwd", return_value=self.repo), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(verify.main(["verify", "plan1-app"]), 1)
            self.assertEqual(verify.main(["verify", "plan1-app", "--audit"]), 0)
            (plan / "index.json").write_text("{")
            self.assertEqual(verify.main(["verify", "plan1-app"]), 2)
            self.assertEqual(verify.main(["verify", "missing"]), 2)
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(err):
            self.assertEqual(verify.main(["verify"]), 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("--staged", err.getvalue())

    def test_last_phase_needs_no_completion_mark(self):
        # 완료한 계획서는 지우므로 마지막 phase 가 index.json 을 completed 로 바꾸라고 적지 않아도 된다.
        self.file("src/app.py")
        phase = self.prompt("### 1. `tests/test_app.py` 추가", "pytest tests/test_app.py")
        phase += "\n## 목표\n앱\n**범위 외**: 배포\n## 변경 파일\n| `src/app.py` | 수정 |\n| `tests/test_app.py` | 신규 |\n"
        self.file("tasks/plan2-app/phase-01.md", phase)
        index = {"name": "plan2-app", "total_phases": 1, "phases": [{"number": 1, "file": "phase-01.md", "execution_profile": "standard"}]}
        self.file("tasks/plan2-app/index.json", json.dumps(index))
        with patch.object(verify.Path, "cwd", return_value=self.repo), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(verify.main(["verify", "plan2-app"]), 0, stdout.getvalue())
        self.assertNotIn("completed", stdout.getvalue())

    def test_subproject_docs_path_is_evidence(self):
        self.file("frontend/docs/flow.md")
        out = []
        text = self.prompt("### 1. 문서", "pytest").replace("`docs/flow.md`", "`frontend/docs/flow.md`")
        verify.check_phase_prompt(Path("p"), text, out, repo=self.repo)
        self.assertFalse(any("근거 문서" in issue for issue in out), out)

    def test_subproject_evidence_must_exist_and_be_docs(self):
        for evidence in ("`frontend/docs/absent.md`", "`frontend/src/app.ts`"):
            out = []
            text = self.prompt("### 1. 문서", "pytest").replace("`docs/flow.md`", evidence)
            verify.check_phase_prompt(Path("p"), text, out, repo=self.repo)
            self.assertTrue(any("근거 문서" in issue for issue in out), evidence)

    def test_cli_prefixed_plan_under_tasks_dir(self):
        self.file("frontend/docs/flow.md")
        phase = self.prompt("### 1. `frontend/tests/test_app.py` 추가", "pytest frontend/tests/test_app.py").replace("`docs/flow.md`", "`frontend/docs/flow.md`")
        phase += "\n## 목표\n앱\n**범위 외**: 배포\n## 변경 파일\n| `frontend/src/app.py` | 신규 |\n| `frontend/tests/test_app.py` | 신규 |\n"
        index = {"name": "fe-plan27-app", "total_phases": 1, "phases": [{"number": 1, "file": "phase-01.md", "execution_profile": "standard"}]}
        for tasks_dir in ("tasks", "frontend/tasks"):
            self.file(f"{tasks_dir}/fe-plan27-app/phase-01.md", phase)
            self.file(f"{tasks_dir}/fe-plan27-app/index.json", json.dumps(index))
        with patch.object(verify.Path, "cwd", return_value=self.repo), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(verify.main(["verify", "fe-plan27-app"]), 0, stdout.getvalue())
            self.assertEqual(verify.main(["verify", "fe-plan27-app", "--tasks-dir", "frontend/tasks"]), 0, stdout.getvalue())
            self.assertEqual(verify.main(["verify", "fe-plan27-app", "--tasks-dir", "backend/tasks"]), 2)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True)

    def test_staged_scope_addition_modification_deletion_and_rename(self):
        self.git("init", "--quiet")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.file("src/old.py", "old\n")
        self.file("src/edit.py", "before\n")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "initial")
        self.git("mv", "src/old.py", "src/new.py")
        self.file("src/edit.py", "after\n")
        self.git("add", "src")
        text = "## 변경 파일\n| `src/old.py` | 삭제 |\n| `src/new.py` | 신규 |\n| `src/edit.py` | 수정 |\n"
        out = []
        verify.check_staged(Path("p"), text, self.repo, out, [])
        self.assertEqual(out, [])
        self.file("unrelated.py")
        self.git("add", "unrelated.py")
        out = []
        verify.check_staged(Path("p"), text, self.repo, out, [])
        self.assertEqual(len(out), 1)

    def test_listed_file_missing_from_staged(self):
        self.git("init", "--quiet")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.file("src/app.py", "before\n")
        self.file("src/edit.py", "before\n")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "initial")
        self.file("src/app.py", "after\n")
        self.git("add", "src/app.py")
        text = "## 변경 파일\n| `src/app.py` | 수정 |\n| `tests/test_app.py` | 신규 |\n| `src/edit.py` | 수정 |\n| `src/gen/*.py` | 신규 |\n"
        out, warnings = [], []
        verify.check_staged(Path("p"), text, self.repo, out, warnings)
        self.assertEqual(out, ["p — 신규로 적은 파일이 staged 에 없다: tests/test_app.py"])
        self.assertEqual(warnings, ["p — 수정로 적은 파일이 staged 에 없다: src/edit.py"])

    def test_staged_type_mismatch_and_ellipsis_are_rejected(self):
        self.git("init", "--quiet")
        self.file("src/app.py")
        self.git("add", "src")
        for manifest in ("| `src/app.py` | 수정 |", "| `src/.../app.py` | 신규 |"):
            out = []
            verify.check_staged(Path("p"), "## 변경 파일\n" + manifest, self.repo, out, [])
            self.assertTrue(out)


if __name__ == "__main__":
    unittest.main()
