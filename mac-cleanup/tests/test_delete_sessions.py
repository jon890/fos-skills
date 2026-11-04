"""워크트리가 사라진 대화 기록의 판정(survey_sessions)과 삭제(delete_sessions)를 임시 폴더로 검증한다."""

import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import delete_sessions as ds  # noqa: E402
import survey_sessions as ss  # noqa: E402

DAY = 86400


class Fixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()
        self.base = self.root / "projects"
        self.base.mkdir()
        self.live = self.root / "live-worktree"
        self.live.mkdir()
        self.now = time.time()

    def session(self, name, cwd, age_days=20, lines=None, size=100):
        folder = self.base / name
        folder.mkdir()
        f = folder / "a.jsonl"
        body = lines if lines is not None else [json.dumps({"type": "user", "cwd": str(cwd)})]
        f.write_text("\n".join(body) + "\n" + "x" * size, encoding="utf-8")
        t = self.now - age_days * DAY
        os.utime(f, (t, t))
        return folder

    def age(self, path, text, age_days=20):
        path.write_text(text, encoding="utf-8")
        t = self.now - age_days * DAY
        os.utime(path, (t, t))

    def item(self, folder, cwd):
        size, newest = ss.folder_stats(str(folder))
        return {"path": str(folder), "cwd": str(cwd), "newest_mtime": newest, "size_bytes": size}


class DetectTest(Fixture):
    def test_missing_cwd_is_candidate(self):
        gone = self.root / "gone-worktree"
        self.session("a", gone)
        found = ss.find_orphan_sessions(str(self.base))
        self.assertEqual([o["cwd"] for o in found], [str(gone)])
        self.assertEqual(found[0]["path"], str(self.base / "a"))

    def test_existing_cwd_is_not_candidate(self):
        self.session("a", self.live)
        self.assertEqual(ss.find_orphan_sessions(str(self.base)), [])

    def test_unreadable_cwd_is_not_candidate(self):
        self.session("nocwd", "", lines=[json.dumps({"type": "user"}), "not json"])
        (self.base / "empty").mkdir()
        self.assertEqual(ss.find_orphan_sessions(str(self.base)), [])

    def test_cwd_read_from_first_50_lines_only(self):
        late = [json.dumps({"type": "x"})] * 50 + [json.dumps({"cwd": str(self.root / "gone")})]
        self.session("late", "", lines=late)
        self.assertEqual(ss.find_orphan_sessions(str(self.base)), [])

    def test_cwd_found_after_non_cwd_lines(self):
        lines = ["garbage", json.dumps({"type": "x"}), json.dumps({"cwd": str(self.root / "gone")})]
        self.session("a", "", lines=lines)
        self.assertEqual(len(ss.find_orphan_sessions(str(self.base))), 1)

    def test_newest_mtime_is_latest_file(self):
        folder = self.session("a", self.root / "gone", age_days=20)
        sub = folder / "sub"
        sub.mkdir()
        newer = sub / "b.txt"
        newer.write_text("hi")
        t = self.now - 2 * DAY
        os.utime(newer, (t, t))
        found = ss.find_orphan_sessions(str(self.base))
        self.assertAlmostEqual(found[0]["newest_mtime"], t, delta=1)

    def test_claude_config_dir(self):
        self.assertEqual(ss.claude_projects_dir({"CLAUDE_CONFIG_DIR": "/x/y"}), "/x/y/projects")
        self.assertTrue(ss.claude_projects_dir({}).endswith(".claude/projects"))


class BucketTest(Fixture):
    def test_buckets_cumulative(self):
        orphans = [
            {"newest_mtime": self.now - 1 * DAY, "size_bytes": 1},
            {"newest_mtime": self.now - 5 * DAY, "size_bytes": 10},
            {"newest_mtime": self.now - 10 * DAY, "size_bytes": 100},
            {"newest_mtime": self.now - 40 * DAY, "size_bytes": 1000},
        ]
        b = ss.orphan_buckets(orphans, self.now)
        self.assertEqual(b, {3: (3, 1110), 7: (2, 1100), 14: (1, 1000), 30: (1, 1000)})


class DeleteTest(Fixture):
    def process(self, item, days=14, apply=True):
        return ds.process(item, str(self.base), days, apply, self.now)

    def test_dry_run_removes_nothing(self):
        gone = self.root / "gone"
        folder = self.session("a", gone)
        res = self.process(self.item(folder, gone), apply=False)
        self.assertEqual(res["status"], "삭제 예정")
        self.assertTrue(folder.exists())

    def test_apply_removes_folder(self):
        gone = self.root / "gone"
        folder = self.session("a", gone)
        self.assertEqual(self.process(self.item(folder, gone))["status"], "삭제")
        self.assertFalse(folder.exists())

    def test_younger_than_threshold_kept(self):
        gone = self.root / "gone"
        folder = self.session("a", gone, age_days=5)
        res = self.process(self.item(folder, gone))
        self.assertEqual(res["status"], "유지")
        self.assertTrue(folder.exists())

    def test_mtime_changed_kept(self):
        gone = self.root / "gone"
        folder = self.session("a", gone)
        item = self.item(folder, gone)
        (folder / "new.jsonl").write_text("{}")
        res = self.process(item)
        self.assertEqual(res["status"], "유지")
        self.assertIn("수정 시각", res["detail"])
        self.assertTrue(folder.exists())

    def test_cwd_reappeared_kept(self):
        gone = self.root / "gone"
        folder = self.session("a", gone)
        item = self.item(folder, gone)
        gone.mkdir()
        res = self.process(item)
        self.assertEqual(res["status"], "유지")
        self.assertIn("다시 생겼다", res["detail"])
        self.assertTrue(folder.exists())

    def test_path_outside_base_kept(self):
        gone = self.root / "gone"
        outside = self.root / "outside"
        outside.mkdir()
        self.age(outside / "a.jsonl", json.dumps({"cwd": str(gone)}))
        res = self.process(self.item(outside, gone))
        self.assertEqual(res["status"], "유지")
        self.assertIn("바로 아래", res["detail"])
        self.assertTrue(outside.exists())

    def test_nested_path_kept(self):
        gone = self.root / "gone"
        folder = self.session("a", gone)
        nested = folder / "deeper"
        nested.mkdir()
        self.age(nested / "a.jsonl", json.dumps({"cwd": str(gone)}))
        res = self.process(self.item(nested, gone))
        self.assertEqual(res["status"], "유지")
        self.assertTrue(nested.exists())

    def test_symlink_kept(self):
        gone = self.root / "gone"
        target = self.root / "target"
        target.mkdir()
        (target / "a.jsonl").write_text(json.dumps({"cwd": str(gone)}))
        link = self.base / "link"
        link.symlink_to(target)
        res = self.process({"path": str(link), "cwd": str(gone), "newest_mtime": 0, "size_bytes": 1})
        self.assertEqual(res["status"], "유지")
        self.assertTrue(target.exists())

    def test_base_not_projects_kept(self):
        other = self.root / "elsewhere"
        other.mkdir()
        gone = self.root / "gone"
        folder = other / "a"
        folder.mkdir()
        self.age(folder / "a.jsonl", json.dumps({"cwd": str(gone)}))
        item = self.item(folder, gone)
        res = ds.process(item, str(other), 14, True, self.now)
        self.assertEqual(res["status"], "유지")
        self.assertTrue(folder.exists())

    def test_failure_reported(self):
        gone = self.root / "gone"
        folder = self.session("a", gone)

        def boom(_):
            raise OSError("busy")
        res = ds.process(self.item(folder, gone), str(self.base), 14, True, self.now, remove=boom)
        self.assertEqual(res["status"], "실패")


class MainTest(Fixture):
    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ds.main(argv)
        return code, out.getvalue(), err.getvalue()

    def write_json(self, orphans):
        path = self.root / "o.json"
        path.write_text(json.dumps({"base": str(self.base), "orphans": orphans}), encoding="utf-8")
        return str(path)

    def test_dry_run_then_apply(self):
        gone = self.root / "gone"
        old = self.session("old", gone, age_days=20)
        young = self.session("young", gone, age_days=2)
        path = self.write_json([self.item(old, gone), self.item(young, gone)])
        code, out, _ = self.run_main([path, "--older-than-days", "14"])
        self.assertEqual(code, 0)
        self.assertIn("삭제 예정", out)
        self.assertTrue(old.exists() and young.exists())
        code, out, _ = self.run_main([path, "--older-than-days", "14", "--apply"])
        self.assertEqual(code, 0)
        self.assertIn("합계", out)
        self.assertFalse(old.exists())
        self.assertTrue(young.exists())

    def test_older_than_days_required(self):
        path = self.write_json([])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            ds.main([path])
        self.assertEqual(cm.exception.code, 2)

    def test_bad_input(self):
        bad = self.root / "bad.json"
        bad.write_text("{}")
        code, _, err = self.run_main([str(bad), "--older-than-days", "1"])
        self.assertEqual(code, 2)
        self.assertIn("입력", err)


class JsonOutTest(Fixture):
    def test_survey_writes_json_out(self):
        gone = self.root / "gone"
        self.session("a", gone)
        out_path = self.root / "out.json"
        import unittest.mock as mock
        with mock.patch.object(ss, "claude_projects_dir", lambda: str(self.base)), \
                mock.patch.object(ss, "run", lambda *a, **k: ""), \
                mock.patch.object(ss, "expand_log_dirs", lambda: []), \
                contextlib.redirect_stdout(io.StringIO()) as buf:
            code = ss.main(["--json-out", str(out_path)])
        self.assertEqual(code, 0)
        data = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base"], str(self.base))
        self.assertEqual(data["orphans"][0]["cwd"], str(gone))
        self.assertIn("워크트리가 사라진 대화 기록", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
