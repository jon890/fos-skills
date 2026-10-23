"""target_files.is_target 이 저장소 오버레이를 감사 대상으로 고르는지 본다."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from target_files import is_target  # noqa: E402

ROOT = Path("/repo")


class OverlayTargetTest(unittest.TestCase):
    def test_orch_overlay_and_claude_overlays_are_targets(self):
        self.assertTrue(is_target(ROOT / ".orch/overlay.md", ROOT))
        self.assertTrue(is_target(ROOT / ".claude/planning-overlay.md", ROOT))

    def test_other_overlay_named_files_are_not_targets(self):
        self.assertFalse(is_target(ROOT / "orch/references/overlay.md", ROOT))
        self.assertFalse(is_target(ROOT / ".orch/specs/spec-a.md", ROOT))


if __name__ == "__main__":
    unittest.main()
