"""spec-lint.py 를 실제 git 저장소와 지시서 파일로 본다."""

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "spec-lint.py"


def sh(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


class SpecLintTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / "repo"
        files = {
            "src/net/client.ts": "export function connect() {}\n",
            "src/net/retry.ts": "export const retry = 1\n",
            "src/ui/panel.ts": "export class Panel { render() {} }\n",
            "docs/adr/001.md": "# ADR\n",
        }
        for name, body in files.items():
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(body)
        env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True, env=env)
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True, env=env)
        self.specs = self.tmp / "specs"
        self.specs.mkdir()

    def spec(self, name, text):
        path = self.specs / f"{name}.md"
        path.write_text(textwrap.dedent(text))
        return path

    def overlay(self, text):
        path = self.tmp / "overlay.md"
        path.write_text("# orch 오버레이\n\n## spec-lint\n\n" + textwrap.dedent(text))
        return path

    def lint(self, *specs, overlay=None):
        cmd = ["python3", str(SCRIPT), "--repo", str(self.repo)]
        if overlay:
            cmd += ["--overlay", str(overlay)]
        done = subprocess.run(cmd + [str(s) for s in specs], capture_output=True, text=True)
        return done.returncode, done.stdout

    def test_overlapping_owned_paths_are_caught(self):
        a = self.spec("spec-net", "담당: `src/net/**`\n")
        b = self.spec("spec-retry", "- 담당: `src/net/retry.ts`\n")
        code, out = self.lint(a, b)
        self.assertEqual(code, 1)
        self.assertIn("spec-net.md:1: 겹침: `src/net/**` 와 spec-retry.md 의 `src/net/retry.ts`", out)

    def test_separate_owned_paths_pass(self):
        a = self.spec("spec-net", "담당: `src/net/**`\n")
        b = self.spec("spec-ui", "담당: `src/ui/**`, `docs/ui.md`\n")
        self.assertEqual(self.lint(a, b), (0, ""))

    def test_coordinator_owned_path_is_caught(self):
        a = self.spec("spec-adr", "담당: `docs/adr/001.md`\n")
        code, out = self.lint(a, overlay=self.overlay("- 코디네이터 소유: `docs/adr/**`\n"))
        self.assertEqual(code, 1)
        self.assertIn("코디네이터: `docs/adr/001.md`", out)

    def test_ownership_contract_allows_only_the_owner(self):
        overlay = self.overlay("- 소유: `src/net/**` spec-net\n")
        other = self.spec("spec-ui", "담당: `src/net/client.ts`\n")
        owner = self.spec("spec-net", "담당: `src/net/client.ts`\n")
        code, out = self.lint(other, overlay=overlay)
        self.assertEqual(code, 1)
        self.assertIn("소유: `src/net/client.ts` 는 spec-net 소유", out)
        self.assertEqual(self.lint(owner, overlay=overlay)[0], 0)

    def test_missing_function_is_caught_and_existing_one_passes(self):
        bad = self.spec("spec-a", "`reconnect()` 를 고친다\n")
        good = self.spec("spec-b", "`connect()` 와 `Panel.render()` 를 고친다\n")
        code, out = self.lint(bad)
        self.assertEqual(code, 1)
        self.assertIn("없음: `reconnect()`", out)
        self.assertEqual(self.lint(good)[0], 0)

    def test_forbidden_command_is_caught_unless_negated_or_excepted(self):
        bad = self.spec("spec-a", "끝나면 `pkill -f node` 로 호스트를 끈다\n")
        negated = self.spec("spec-b", "`pkill` 은 쓰지 않는다. 자기 PID 만 끈다\n")
        excepted = self.spec("spec-c", "예외: 이 작업은 `rm -rf work/tmp` 를 한다\n")
        overlay = self.overlay("- 금지 문구: `rm -rf`\n")
        code, out = self.lint(bad, overlay=overlay)
        self.assertEqual(code, 1)
        self.assertIn("금지: `pkill`", out)
        self.assertEqual(self.lint(negated, excepted, overlay=overlay)[0], 0)

    def test_missing_path_is_only_a_warning(self):
        a = self.spec("spec-a", "`src/net/new-file.ts` 를 만든다. `src/net/client.ts` 와 `panel.ts` 를 고친다\n"
                                "브랜치: `fix/net-retry`. 접두는 `feature/` 를 쓴다\n")
        code, out = self.lint(a)
        self.assertEqual(code, 0)
        self.assertIn("경로: `src/net/new-file.ts`", out)
        # 있는 경로, 폴더 없이 적은 있는 파일 이름, 브랜치 이름과 접두는 경고하지 않는다
        self.assertEqual(1, out.count("경로:"), out)

    def test_missing_spec_is_usage_error(self):
        self.assertEqual(self.lint(self.specs / "nope.md")[0], 2)

    def commit_as_origin(self):
        env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                   GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True, env=env)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-q", "-m", "base"], check=True, env=env)
        subprocess.run(["git", "-C", str(self.repo), "update-ref", "refs/remotes/origin/main", "HEAD"], check=True, env=env)

    def check_overlay(self, overlay):
        done = subprocess.run(["python3", str(SCRIPT), "--repo", str(self.repo), "--overlay", str(overlay),
                               "--check-overlay"], capture_output=True, text=True)
        return done.returncode, done.stdout

    def test_check_overlay_reports_paths_missing_on_origin_base(self):
        (self.repo / ".gitignore").write_text(".orch/\n")
        (self.repo / ".orch").mkdir()
        (self.repo / ".orch" / "config.json").write_text(
            '{"finish": {"verify": "bash src/gone.sh --fast"}, "queue": {"before": "node src/net/client.ts"}}\n')
        self.commit_as_origin()
        # 로컬에만 만든 파일은 origin/main 에 없으므로 지적한다
        (self.repo / "src" / "local.ts").write_text("")
        overlay = self.overlay(
            "- 검증: `bash src/net/verify.sh --fast` 와 `src/local.ts`\n"
            "- 문서: `docs/adr/001.md`, `$SKILL_DIR/scripts/x.py`, `merge-queue.sh`, `docs/<이름>.md`\n"
            "- 로컬: `.orch/bin/start.sh`, `~/bin/x.sh`, `/abs/x.sh`\n"
            "- 바깥: `references/cleanup.md`, `scratchpad/aapi.sh`, `origin/release-1.2.x`, `github.com/o/r.git`\n"
            "- 예외: `src/local-only.sh` 는 로컬에만 둔다\n")
        code, out = self.check_overlay(overlay)
        self.assertEqual(1, code, out)
        self.assertIn("overlay.md:5: 오버레이: `src/net/verify.sh` 가 origin/main 에 없다", out)
        self.assertIn("overlay.md:5: 오버레이: `src/local.ts` 가 origin/main 에 없다", out)
        self.assertIn("config.json:1: 오버레이: `src/gone.sh` 가 origin/main 에 없다", out)
        self.assertEqual(3, out.count("오버레이:"), out)

    def test_check_overlay_passes_without_specs_when_paths_exist(self):
        self.commit_as_origin()
        overlay = self.overlay("- 문서: `docs/adr/001.md`, `./src/net/client.ts`, `src/net`\n")
        self.assertEqual((0, ""), self.check_overlay(overlay))

    def test_check_overlay_without_origin_base_is_usage_error(self):
        self.assertEqual(2, self.check_overlay(self.overlay(""))[0])

    def test_no_spec_without_check_overlay_is_usage_error(self):
        done = subprocess.run(["python3", str(SCRIPT), "--repo", str(self.repo)], capture_output=True, text=True)
        self.assertEqual(2, done.returncode)


if __name__ == "__main__":
    unittest.main()
