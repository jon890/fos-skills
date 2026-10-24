"""delete_volumes.py 를 가짜 docker 함수로 검증한다. 실제 volume 을 지우지 않는다."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import delete_volumes as dvol  # noqa: E402

PG, MY, OT, FRESH, UNOPENED, GONE = ("a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64, "f" * 64)


def vol(name, kind, cls="후보", **kw):
    base = {"name": name, "class": cls, "size_bytes": 1000, "kind": kind}
    if kind is not None:
        base.update(top_entries=["x"], peek_error=None)
    return {**base, **kw}


class FakeDocker:
    def __init__(self, fail=()):
        self.removed = []
        self.fail = set(fail)

    def remove(self, name):
        if name in self.fail:
            return False, "volume is in use"
        self.removed.append(name)
        return True, ""


class ProcessTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeDocker()
        self.dangling = {PG, MY, OT, UNOPENED, FRESH}

    def process(self, v, kinds=("postgres", "mysql"), apply=True, dangling=None):
        return dvol.process_volume(v, set(kinds), apply, self.dangling if dangling is None else dangling, self.fake.remove)

    def test_dry_run_removes_nothing(self):
        res = self.process(vol(PG, "postgres"), apply=False)
        self.assertEqual(res["status"], "삭제 예정")
        self.assertEqual(self.fake.removed, [])

    def test_apply_removes_selected_kind_by_name(self):
        self.assertEqual(self.process(vol(PG, "postgres"))["status"], "삭제")
        self.assertEqual(self.fake.removed, [PG])

    def test_other_kept_unless_selected(self):
        res = self.process(vol(OT, "other"))
        self.assertEqual(res["status"], "유지")
        self.assertEqual(self.fake.removed, [])
        self.assertEqual(self.process(vol(OT, "other"), kinds=("other",))["status"], "삭제")

    def test_unopened_recent_and_peek_error_kept(self):
        self.assertEqual(self.process(vol(UNOPENED, None))["status"], "유지")
        self.assertEqual(self.process(vol(FRESH, "postgres", cls="최근"))["status"], "유지")
        broken = vol(PG, None, peek_error="boom")
        self.assertEqual(self.process(broken)["status"], "유지")
        self.assertEqual(self.process(vol(PG, "postgres", peek_error="boom"))["status"], "유지")
        self.assertEqual(self.fake.removed, [])

    def test_no_longer_dangling_kept(self):
        res = self.process(vol(GONE, "postgres"), dangling=self.dangling)
        self.assertEqual(res["status"], "유지")
        self.assertIn("dangling", res["detail"])
        self.assertEqual(self.fake.removed, [])

    def test_named_volume_never_removed(self):
        res = self.process(vol("pgdata", "postgres"), dangling={"pgdata"})
        self.assertEqual(res["status"], "유지")
        self.assertEqual(self.fake.removed, [])

    def test_failure_reported(self):
        self.fake.fail.add(PG)
        res = self.process(vol(PG, "postgres"))
        self.assertEqual(res["status"], "실패")
        self.assertIn("in use", res["detail"])


class MainTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "v.json")
        data = {"volumes": [vol(PG, "postgres"), vol(MY, "mysql"), vol(OT, "other")]}
        Path(self.path).write_text(json.dumps(data), encoding="utf-8")
        self.fake = FakeDocker()

    def main(self, argv, ryuk=False, dangling=None, docker_down=False):
        dangling = {PG, MY, OT} if dangling is None else dangling
        out, err = io.StringIO(), io.StringIO()
        patches = [mock.patch.object(dvol, "remove_volume", self.fake.remove),
                   mock.patch.object(dvol, "ryuk_running", lambda: ryuk),
                   mock.patch.object(dvol, "list_dangling", lambda: dangling)]
        if docker_down:
            def boom():
                raise RuntimeError("daemon down")
            patches[1] = mock.patch.object(dvol, "ryuk_running", boom)
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            code = dvol.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_default_kinds_skip_other(self):
        code, out, _ = self.main([self.path, "--apply"])
        self.assertEqual(code, 0)
        self.assertEqual(sorted(self.fake.removed), sorted([PG, MY]))
        self.assertIn("합계", out)

    def test_kind_option_repeatable(self):
        self.main([self.path, "--apply", "--kind", "other", "--kind", "postgres"])
        self.assertEqual(sorted(self.fake.removed), sorted([PG, OT]))

    def test_dry_run_warns_on_ryuk_and_removes_nothing(self):
        code, out, _ = self.main([self.path], ryuk=True)
        self.assertEqual(code, 0)
        self.assertIn("ryuk", out)
        self.assertEqual(self.fake.removed, [])

    def test_apply_refused_on_ryuk(self):
        code, _, err = self.main([self.path, "--apply"], ryuk=True)
        self.assertEqual(code, 3)
        self.assertIn("ryuk", err)
        self.assertEqual(self.fake.removed, [])

    def test_failure_exit_code_one(self):
        self.fake.fail.add(PG)
        code, _, _ = self.main([self.path, "--apply"])
        self.assertEqual(code, 1)
        self.assertEqual(self.fake.removed, [MY])

    def test_bad_input_and_docker_down(self):
        self.assertEqual(self.main([os.path.join(self._tmp.name, "none.json")])[0], 2)
        self.assertEqual(self.main([self.path], docker_down=True)[0], 4)
        Path(self.path).write_text("[]", encoding="utf-8")
        self.assertEqual(self.main([self.path])[0], 2)


if __name__ == "__main__":
    unittest.main()
