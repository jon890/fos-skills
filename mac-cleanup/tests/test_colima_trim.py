"""colima_trim.py 의 파싱과 재시도 판정 순수 함수를 검증한다. colima 를 부르지 않는다."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import colima_trim as ct  # noqa: E402

GIB = 1024**3


class ParseTest(unittest.TestCase):
    def test_parse_trim_bytes(self):
        out = "/mnt/lima-colima: 43.8 GiB (47028871168 bytes) trimmed on /dev/vdb1\n"
        self.assertEqual(ct.parse_trim_bytes(out), 47028871168)

    def test_parse_trim_bytes_sums_mounts(self):
        out = "/a: 1 GiB (1073741824 bytes) trimmed\n/b: 1 GiB (1073741824 bytes) trimmed\n"
        self.assertEqual(ct.parse_trim_bytes(out), 2 * GIB)

    def test_parse_trim_bytes_unknown(self):
        self.assertEqual(ct.parse_trim_bytes("error"), 0)
        self.assertEqual(ct.parse_trim_bytes(None), 0)

    def test_parse_used_bytes(self):
        self.assertEqual(ct.parse_used_bytes("       Used\n25769803776\n"), 25769803776)
        self.assertIsNone(ct.parse_used_bytes("Used\n"))
        self.assertIsNone(ct.parse_used_bytes(""))

    def test_parse_du_bytes(self):
        self.assertEqual(ct.parse_du_bytes("42572800\t/x/datadisk\n"), 42572800 * 1024)
        self.assertIsNone(ct.parse_du_bytes("du: no such file"))
        self.assertIsNone(ct.parse_du_bytes(""))


class DecisionTest(unittest.TestCase):
    def test_gap(self):
        self.assertEqual(ct.gap_bytes(40 * GIB, 24 * GIB), 16 * GIB)

    def test_retry_when_gap_large(self):
        self.assertTrue(ct.should_retry(16 * GIB, 4 * GIB, 1, 4))

    def test_no_retry_when_gap_small(self):
        self.assertFalse(ct.should_retry(1 * GIB, 4 * GIB, 1, 4))
        self.assertFalse(ct.should_retry(4 * GIB, 4 * GIB, 1, 4))

    def test_no_retry_at_limit(self):
        self.assertFalse(ct.should_retry(16 * GIB, 4 * GIB, 4, 4))

    def test_negative_gap_does_not_retry(self):
        self.assertFalse(ct.should_retry(-1 * GIB, 4 * GIB, 1, 4))


class TimeBudgetTest(unittest.TestCase):
    def test_retry_blocked_by_time(self):
        # 경과 30 + 대기 60 + 직전 시도 20 = 110 > 100
        self.assertFalse(ct.should_retry(16 * GIB, 4 * GIB, 1, 4, 30, 60, 20, 100))

    def test_retry_allowed_within_time(self):
        self.assertTrue(ct.should_retry(16 * GIB, 4 * GIB, 1, 4, 10, 60, 10, 100))

    def test_no_time_limit(self):
        self.assertTrue(ct.should_retry(16 * GIB, 4 * GIB, 1, 4, 999, 60, 999, None))


class LoopTest(unittest.TestCase):
    def run_loop(self, gaps, max_attempts=4, interval=60, max_seconds=100, step=10):
        now = [0.0]
        sleeps = []
        measures = iter((g * GIB + 10 * GIB, 10 * GIB, 0) for g in gaps)

        def trim_fn():
            now[0] += step
            return 0

        def sleep(sec):
            sleeps.append(sec)
            now[0] += sec

        result = ct.trim_until_done(trim_fn, lambda: next(measures), 4 * GIB, max_attempts, interval, max_seconds,
                                    clock=lambda: now[0], sleep=sleep, out=lambda _: None)
        return result, sleeps, now[0]

    def test_stops_when_gap_closes(self):
        (attempt, _), sleeps, _ = self.run_loop([16, 0])
        self.assertEqual((attempt, sleeps), (2, [60]))

    def test_time_budget_stops_before_attempt_limit(self):
        # 시도 10초 + 대기 60 + 시도 10초 = 80초. 두 번째 시도 뒤에 90 + 60 > 100 이라 멈춘다.
        (attempt, after), sleeps, elapsed = self.run_loop([16, 16, 16, 16])
        self.assertEqual((attempt, sleeps), (2, [60]))
        self.assertLessEqual(elapsed, 100)
        self.assertGreater(ct.gap_bytes(after[0], after[1]), 4 * GIB)

    def test_attempt_limit(self):
        (attempt, _), sleeps, _ = self.run_loop([16] * 5, max_attempts=3, interval=1, max_seconds=1000)
        self.assertEqual((attempt, sleeps), (3, [1, 1]))


class PathTest(unittest.TestCase):
    def test_disk_path(self):
        self.assertEqual(ct.disk_path("default").parts[-3:], ("_disks", "colima", "datadisk"))
        self.assertEqual(ct.disk_path("dev").parts[-3:], ("_disks", "colima-dev", "datadisk"))
        self.assertEqual(ct.disk_path("dev", "/tmp/x"), Path("/tmp/x"))


if __name__ == "__main__":
    unittest.main()
