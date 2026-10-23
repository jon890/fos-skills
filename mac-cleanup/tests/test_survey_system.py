"""survey_system.py 의 순수 함수(파싱, 집계)를 검증한다. 실제 시스템을 읽지 않는다."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import survey_system as sy  # noqa: E402


class HumanSizeTest(unittest.TestCase):
    def test_units(self):
        self.assertEqual(sy.human_kb(512), "512K")
        self.assertEqual(sy.human_kb(1536), "1.5M")
        self.assertEqual(sy.human_kb(20 * 1024), "20M")
        self.assertEqual(sy.human_kb(5 * 1024 * 1024), "5.0G")


class DuParseTest(unittest.TestCase):
    def test_parse_skips_garbage_and_keeps_spaces_in_path(self):
        out = "100\t/a/b c\nnot a row\n\n7\t/a/d\n"
        self.assertEqual(sy.parse_du_kb(out), [(100, "/a/b c"), (7, "/a/d")])

    def test_top_dirs_orders_by_size_then_path(self):
        rows = [(5, "/b"), (9, "/a"), (5, "/a2"), (1, "/z")]
        self.assertEqual(sy.top_dirs(rows, 3), [(9, "/a"), (5, "/a2"), (5, "/b")])

    def test_dot_directories_are_kept_without_glob(self):
        # 점으로 시작하는 디렉터리도 du 출력에 있으면 그대로 후보가 된다. glob 을 쓰지 않으므로 맞는 것이 없어도 실패하지 않는다.
        rows = sy.parse_du_kb("10\t/h/.cache\n20\t/h/proj\n")
        self.assertIn((10, "/h/.cache"), sy.top_dirs(rows, 5))


class RssTest(unittest.TestCase):
    def test_app_name(self):
        self.assertEqual(sy.app_name("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --x"), "Google Chrome")
        self.assertEqual(sy.app_name("/usr/bin/python3 script.py"), "python3")
        self.assertEqual(sy.app_name(""), "?")

    def test_rss_by_app_sums_and_skips_bad_rows(self):
        out = "100 /A/Foo.app/Contents/x\n 50 /A/Foo.app/Contents/y\n  7 /bin/zsh -l\nbad row\n12\n"
        self.assertEqual(sy.rss_by_app(out), {"Foo": 150, "zsh": 7})


class VmStatTest(unittest.TestCase):
    def test_parse(self):
        out = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
               "Pages occupied by compressor:                 123456.\n")
        self.assertEqual(sy.parse_vm_stat(out), (16384, 123456))

    def test_missing_values_are_none(self):
        self.assertEqual(sy.parse_vm_stat(""), (None, None))


class UpdaterTest(unittest.TestCase):
    def test_is_updater_dir(self):
        for name in ("orca-updater", "com.stablyai.orca.ShipIt", "x-updater"):
            self.assertTrue(sy.is_updater_dir(name), name)
        for name in ("com.google.GoogleUpdater", "updater-cache", "ShipIt.old", "orca"):
            self.assertFalse(sy.is_updater_dir(name), name)

    def test_pending_marks_found(self):
        self.assertEqual(sy.pending_marks(["update.zip", "pending", "other.log"]), ["pending", "update.zip"])

    def test_no_marks_for_log_only_dir(self):
        self.assertEqual(sy.pending_marks(["ShipIt_stderr.log", "ShipIt_stdout.log"]), [])
        self.assertEqual(sy.pending_marks([]), [])

    def test_verdict(self):
        self.assertTrue(sy.updater_verdict([]).startswith("안전"))
        self.assertTrue(sy.updater_verdict(["pending"]).startswith("유지"))

    def test_survey_updaters_reads_marks_from_temp_home(self):
        import contextlib
        import io
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as home:
            caches = Path(home) / "Library/Caches"
            (caches / "app-updater/pending").mkdir(parents=True)
            (caches / "app-updater/update.zip").write_bytes(b"x" * 2048)
            (caches / "other.ShipIt").mkdir()
            (caches / "other.ShipIt/ShipIt_stderr.log").write_text("log")
            (caches / "unrelated").mkdir()
            buf = io.StringIO()
            with mock.patch.object(sy, "HOME", home), contextlib.redirect_stdout(buf):
                sy.survey_updaters()
            lines = buf.getvalue().splitlines()
            pending = [l for l in lines if "app-updater" in l][0]
            clean = [l for l in lines if "other.ShipIt" in l][0]
            self.assertIn("유지", pending)
            self.assertIn("대기=pending,update.zip", pending)
            self.assertIn("안전", clean)
            self.assertFalse(any("unrelated" in l for l in lines))


class MiseTest(unittest.TestCase):
    OUT = (
        "mise pruned configuration links [dryrun]\n"
        "mise gradle@9.5.0 is prunable: no tracked config or tool stub requires gradle\n"
        "mise gradle@9.5.0 [dryrun]   uninstall\n"
        "mise gradle@9.7.1 is prunable: no tracked config or tool stub requires gradle\n"
        "mise maven@3.9.11 is prunable: maven is required at 3.9.15 by ~/.config/mise/config.toml\n"
        "mise node@20.1.0 is prunable: x\n"
        "garbage line\n"
    )

    def test_parse_prunable(self):
        rows = sy.parse_mise_prunable(self.OUT)
        self.assertEqual([(t, v) for t, v, _ in rows],
                         [("gradle", "9.5.0"), ("gradle", "9.7.1"), ("maven", "3.9.11"), ("node", "20.1.0")])
        self.assertTrue(rows[2][2].startswith("maven is required at 3.9.15"))

    def test_group_by_tool(self):
        grouped = sy.group_by_tool(sy.parse_mise_prunable(self.OUT))
        self.assertEqual(grouped, {"gradle": ["9.5.0", "9.7.1"], "maven": ["3.9.11"], "node": ["20.1.0"]})
        self.assertEqual(list(grouped), ["gradle", "maven", "node"])

    def test_nothing_prunable(self):
        self.assertEqual(sy.parse_mise_prunable("mise scanning tracked configs ✓ done\n"), [])


class ProcessMatchTest(unittest.TestCase):
    PS = "/Applications/Cursor.app/Contents/MacOS/Cursor --x\n/bin/zsh -l\nnode /home/u/.cache/puppeteer/chrome/run\n"

    def test_cursor_running(self):
        self.assertTrue(sy.cursor_running(self.PS))
        self.assertFalse(sy.cursor_running("/bin/zsh -l\n/usr/bin/vim Cursor.md\n"))

    def test_commands_using(self):
        self.assertEqual(sy.commands_using(self.PS, "/home/u/.cache/puppeteer"), 1)
        self.assertEqual(sy.commands_using(self.PS, "/home/u/.cache/other"), 0)


class CodexReleaseTest(unittest.TestCase):
    def test_rows_mark_current_and_running(self):
        base = "/h/.codex/packages/standalone/releases"
        sizes = {f"{base}/0.1": 100, f"{base}/0.2": 200, f"{base}/0.3": 300}
        ps = f"{base}/0.2/bin/codex serve\n/other/path/0.3/bin/codex\n"
        rows = sy.codex_release_rows(sizes, f"{base}/0.3", ps)
        self.assertEqual([(r["path"].rsplit("/", 1)[1], r["current"], r["running"]) for r in rows],
                         [("0.1", False, False), ("0.2", False, True), ("0.3", True, False)])

    def test_no_current(self):
        rows = sy.codex_release_rows({"/r/a": 1}, None, "")
        self.assertEqual((rows[0]["current"], rows[0]["running"]), (False, False))


class DotCacheTest(unittest.TestCase):
    def test_age_days(self):
        self.assertEqual(sy.age_days(1000, 1000 + 86400 * 90 + 5), 90)
        self.assertEqual(sy.age_days(2000, 1000), 0)
        self.assertIsNone(sy.age_days(None, 1000))

    def test_newest_mtime_looks_inside_tree(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "c"
            (root / "sub").mkdir(parents=True)
            old, new = 1_000_000_000, 1_600_000_000
            f_old, f_new = root / "a.txt", root / "sub" / "b.txt"
            f_old.write_text("x")
            f_new.write_text("y")
            os.utime(f_old, (old, old))
            os.utime(f_new, (new, new))
            os.utime(root / "sub", (old, old))
            os.utime(root, (old, old))
            self.assertEqual(sy.newest_mtime(str(root)), new)

    def test_newest_mtime_missing_root(self):
        self.assertIsNone(sy.newest_mtime("/nonexistent/path/xyz"))

    def test_newest_mtime_stops_at_entry_limit(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(5):
                (Path(tmp) / f"f{i}").write_text("x")
            self.assertIsNotNone(sy.newest_mtime(tmp, max_entries=2))

    def test_survey_dot_cache_and_codex_from_temp_home(self):
        import contextlib
        import io
        import os
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as home:
            big = Path(home) / ".cache/big"
            big.mkdir(parents=True)
            (big / "blob").write_bytes(b"0" * (2 * 1024 * 1024))
            old = 1_000_000_000
            os.utime(big / "blob", (old, old))
            os.utime(big, (old, old))
            rel = Path(home) / ".codex/packages/standalone/releases"
            (rel / "0.1").mkdir(parents=True)
            (rel / "0.2").mkdir()
            (rel / "0.1/f").write_bytes(b"0" * 4096)
            os.symlink(rel / "0.2", Path(home) / ".codex/packages/standalone/current")
            buf = io.StringIO()
            with mock.patch.object(sy, "HOME", home), mock.patch.object(sy, "CACHE_MIN_KB", 1024), \
                    mock.patch.object(sy, "CODEX_RELEASES", str(rel)), \
                    mock.patch.object(sy, "CODEX_CURRENT", str(Path(home) / ".codex/packages/standalone/current")), \
                    mock.patch.object(sy, "run", return_value=""), contextlib.redirect_stdout(buf):
                sy.survey_dot_cache()
                sy.survey_codex_releases()
            text = buf.getvalue()
            line = [l for l in text.splitlines() if l.endswith("/.cache/big")][0]
            self.assertIn("프로세스 없음", line)
            self.assertIn("일 전", line)
            self.assertIn("0.2 current", text)
            self.assertIn("버전 2개", text)
            self.assertIn("남길 것(current 또는 실행중) 1개", text)


class MissingAreaTest(unittest.TestCase):
    def test_missing_dirs_are_skipped_not_errors(self):
        import contextlib
        import io
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as home:
            buf = io.StringIO()
            with mock.patch.object(sy, "HOME", home), \
                    mock.patch.object(sy, "CODEX_RELEASES", home + "/none"), \
                    mock.patch.object(sy, "CURSOR_SNAPSHOTS", home + "/none2"), \
                    contextlib.redirect_stdout(buf):
                sy.survey_codex_releases()
                sy.survey_cursor_snapshots()
                sy.survey_dot_cache()
            self.assertEqual(buf.getvalue().count("해당 디렉터리 없음"), 3)


if __name__ == "__main__":
    unittest.main()
