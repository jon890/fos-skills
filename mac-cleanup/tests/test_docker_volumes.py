"""docker_volumes.py 의 파싱과 분류 순수 함수를 검증한다. docker 를 부르지 않는다."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import docker_volumes as dv  # noqa: E402

HEX = "a" * 64
NOW = 1_800_000_000.0
HOUR = 3600


class ParseTest(unittest.TestCase):
    def test_is_anonymous(self):
        self.assertTrue(dv.is_anonymous(HEX))
        self.assertFalse(dv.is_anonymous("a" * 63))
        self.assertFalse(dv.is_anonymous("A" * 64))
        self.assertFalse(dv.is_anonymous("pgdata"))
        self.assertFalse(dv.is_anonymous(HEX + "0"))

    def test_parse_size(self):
        self.assertEqual(dv.parse_size("256.6MB"), 256_600_000)
        self.assertEqual(dv.parse_size("0B"), 0)
        self.assertEqual(dv.parse_size("12kB"), 12_000)
        self.assertEqual(dv.parse_size("1.5GB"), 1_500_000_000)
        self.assertIsNone(dv.parse_size("N/A"))
        self.assertIsNone(dv.parse_size(None))

    def test_parse_created(self):
        self.assertEqual(dv.parse_created("2026-10-14T22:14:51+09:00"), dv.parse_created("2026-10-14T13:14:51+00:00"))
        self.assertIsNone(dv.parse_created("not a date"))
        self.assertIsNone(dv.parse_created(None))

    def test_has_ryuk(self):
        self.assertTrue(dv.has_ryuk(["postgres:17", "testcontainers/ryuk:0.11.0"]))
        self.assertFalse(dv.has_ryuk(["postgres:17"]))

    def test_pick_peek_image(self):
        self.assertEqual(dv.pick_peek_image(["mysql:8.4", "debian:bookworm-slim", "alpine:3"]), "alpine:3")
        self.assertEqual(dv.pick_peek_image(["mysql:8.4", "library/busybox:latest"]), "library/busybox:latest")
        self.assertIsNone(dv.pick_peek_image(["mysql:8.4", "alpine:<none>"]))


class ClassifyTest(unittest.TestCase):
    def test_recent_boundary(self):
        self.assertEqual(dv.classify_volume({"created_ts": NOW - 23 * HOUR}, NOW, 24), "최근")
        self.assertEqual(dv.classify_volume({"created_ts": NOW - 25 * HOUR}, NOW, 24), "후보")

    def test_unknown_created_is_recent(self):
        self.assertEqual(dv.classify_volume({"created_ts": None}, NOW, 24), "최근")

    def test_build_filters_named_and_sorts_by_size(self):
        small, big = "b" * 64, "c" * 64
        items = dv.build_volumes(
            [small, "pgdata", big],
            {small: NOW - 30 * HOUR, big: NOW - 30 * HOUR, "pgdata": NOW - 30 * HOUR},
            {small: 10, big: 99, "pgdata": 5}, NOW, 24)
        self.assertEqual([v["name"] for v in items], [big, small])

    def test_summarize_excludes_recent_from_candidates(self):
        old, new = "b" * 64, "c" * 64
        items = dv.build_volumes([old, new], {old: NOW - 48 * HOUR, new: NOW - HOUR}, {old: 100, new: 7}, NOW, 24)
        totals = dv.summarize(items)
        self.assertEqual(totals["후보"], {"count": 1, "size_bytes": 100})
        self.assertEqual(totals["최근"], {"count": 1, "size_bytes": 7})


if __name__ == "__main__":
    unittest.main()
