"""live_specs.py 가 살아 있는 Task 의 spec 줄에서 지시서 경로를 모으는지 가짜 orca 로 본다."""

import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import live_specs  # noqa: E402

FAKE_ORCA = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    state = json.load(open(os.environ["FAKE_STATE"]))
    open(os.environ["FAKE_LOG"], "a").write(" ".join(sys.argv[1:]) + "\\n")
    kind = "tasks" if "task-list" in sys.argv else "workers"
    if state.get(kind + "_fail"):
        sys.exit(1)
    print(json.dumps({"ok": True, "result": {kind: state.get(kind, [])}}))
    """)


class LiveSpecsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.orca = self.tmp / "orca"
        self.orca.write_text(FAKE_ORCA)
        self.orca.chmod(0o755)
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        os.environ.update(FAKE_STATE=str(self.state), FAKE_LOG=str(self.log))

    def live(self, run=None, **state):
        self.state.write_text(json.dumps(state))
        return live_specs.live_spec_paths(str(self.orca), run)

    def test_spec_paths_reads_every_md_path_in_the_line(self):
        line = "지시서 /a/spec-x.md 를 읽고 `/b/common.md` 도 본다. /c/notes.txt 와 x.md 는 아니다"
        self.assertEqual(["/a/spec-x.md", "/b/common.md"], live_specs.spec_paths(line))
        self.assertEqual([], live_specs.spec_paths(None))

    def test_active_tasks_and_tasks_of_active_dispatches_count(self):
        tasks = [{"id": "t1", "status": "dispatched", "spec": "지시서 /s/one.md 를 읽는다"},
                 {"id": "t2", "status": "completed", "spec": "지시서 /s/two.md 를 읽는다"},
                 {"id": "t3", "status": "completed", "spec": "지시서 /s/three.md 를 읽는다"},
                 {"id": "t4", "status": "ready", "spec": "지시서 /s/four.md 를 읽는다"}]
        workers = [{"taskId": "t3", "dispatchStatus": "dispatched"}, {"taskId": "t2", "dispatchStatus": "completed"}]
        self.assertEqual({"/s/one.md", "/s/three.md"}, self.live("run_x", tasks=tasks, workers=workers))
        self.assertIn("orchestration task-list --run run_x --json", self.log.read_text())

    def test_any_failed_lookup_is_none(self):
        self.assertIsNone(self.live(tasks_fail=True))
        self.assertIsNone(self.live(workers_fail=True))
        self.assertIsNone(live_specs.live_spec_paths(str(self.tmp / "missing")))


if __name__ == "__main__":
    unittest.main()
