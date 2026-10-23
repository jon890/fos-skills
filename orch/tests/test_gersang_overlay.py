"""오버레이 예시의 검증 본문을 가짜 pnpm/node 로 실행한다. 실제 저장소와 Run 에는 닿지 않는다."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


class GersangOverlayTest(unittest.TestCase):
    def test_documented_verifier_selects_existing_tests_in_batches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / "bin"
            bindir.mkdir()
            pnpm = bindir / "pnpm"
            pnpm.write_text("#!/usr/bin/env python3\nimport json,os,sys\n"
                            "with open(os.environ['CALL_LOG'],'a') as out: out.write(json.dumps(sys.argv[1:])+'\\n')\n"
                            "if sys.argv[1]=='install': sys.exit(int(os.environ.get('INSTALL_EXIT','0')))\n")
            node = bindir / "node"
            node.write_text("#!/bin/sh\nexit 0\n")
            for script in (node, pnpm):
                script.chmod(0o755)
            names = ["tools/build/build-generated.ts", "tests/convention/rule.test.cjs",
                     "tests/a space.test.ts", "tests/consumer.test.ts"]
            names += [f"tests/extra-{i}.test.ts" for i in range(9)]
            for name in names:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("shared-module")
            doc = (Path(__file__).resolve().parents[1] / "references/gersang-overlay.md").read_text()
            preparation = re.search(r"```bash\n(.*?)\n```", doc, re.S).group(1)
            log = root / "calls.jsonl"
            env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", CALL_LOG=str(log), PR="1",
                       CHANGED_FILES="\n".join(["tests/a space.test.ts", "tests/deleted.test.ts"] + names[4:]),
                       OVERLAP_FILES="src/shared-module.ts")
            command = preparation + '\nbash -c "$VERIFY_BODY"'
            done = subprocess.run(["bash", "-c", command], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(0, done.returncode, done.stdout + done.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(["install", "--frozen-lockfile"], calls[0])
            # pnpm exec vitest run 뒤의 파일 목록을 확인한다
            batches = [call[3:] for call in calls[1:]]
            self.assertTrue(all(len(batch) <= 8 for batch in batches))
            expected = sorted(name for name in names if name.startswith("tests/"))
            self.assertEqual(expected, [name for batch in batches for name in batch])
            log.unlink()
            done = subprocess.run(["bash", "-c", command], cwd=root, env=dict(env, INSTALL_EXIT="9"),
                                  capture_output=True, text=True)
            self.assertEqual(9, done.returncode, done.stdout + done.stderr)
            self.assertEqual(1, len(log.read_text().splitlines()))


if __name__ == "__main__":
    unittest.main()
