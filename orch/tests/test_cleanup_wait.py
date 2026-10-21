"""Check polling defaults and short waits without real sleeping or processes."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "cleanup-sweep.py"
SPEC = importlib.util.spec_from_file_location("cleanup_wait", SCRIPT)
sweep = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sweep)


class CleanupWaitTest(unittest.TestCase):
    def test_default_interval_preserves_full_wait_and_final_check(self):
        with patch.object(sweep, "holder_pids", return_value=["123"]) as holders, \
                patch.object(sweep.time, "sleep") as sleep:
            self.assertEqual(["123"], sweep.wait_free("/unused", 3))
        self.assertEqual([1, 1, 1], [call.args[0] for call in sleep.call_args_list])
        self.assertEqual(4, holders.call_count)

    def test_fractional_wait_includes_final_partial_interval(self):
        with patch.object(sweep, "holder_pids", return_value=["123"]) as holders, \
                patch.object(sweep.time, "sleep") as sleep:
            self.assertEqual(["123"], sweep.wait_free("/unused", 0.025, 0.01))
        self.assertEqual(3, sleep.call_count)
        self.assertAlmostEqual(0.025, sum(call.args[0] for call in sleep.call_args_list))
        self.assertEqual(4, holders.call_count)

    def test_stops_polling_as_soon_as_holder_leaves(self):
        with patch.object(sweep, "holder_pids", side_effect=[["123"], []]) as holders, \
                patch.object(sweep.time, "sleep") as sleep:
            self.assertEqual([], sweep.wait_free("/unused", 5, 0.01))
        sleep.assert_called_once_with(0.01)
        self.assertEqual(2, holders.call_count)

    def test_zero_wait_checks_once_without_sleeping(self):
        with patch.object(sweep, "holder_pids", return_value=["123"]) as holders, \
                patch.object(sweep.time, "sleep") as sleep:
            self.assertEqual(["123"], sweep.wait_free("/unused", 0))
        holders.assert_called_once()
        sleep.assert_not_called()

    def test_signal_wait_minimum_defaults_to_one_second_and_can_be_shortened(self):
        for interval in (1, 0.01):
            with self.subTest(interval=interval), \
                    patch.object(sweep, "targets", side_effect=[["123"], []]), \
                    patch.object(sweep, "describe", return_value="123"), \
                    patch.object(sweep, "run") as run, \
                    patch.object(sweep, "wait_free") as wait, \
                    patch.object(sweep, "holder_pids", return_value=[]):
                self.assertEqual([], sweep.stop_holders("/unused", [], 0, lambda line: None, interval))
                run.assert_called_once_with([sweep.KILL, "-TERM", "123"])
                wait.assert_called_once_with("/unused", interval, interval)

    def test_invalid_wait_values_are_rejected_before_external_commands(self):
        with patch.object(sweep, "live_terminals") as terminals:
            for flag, value in (("--wait", "-1"), ("--wait", "nan"), ("--wait", "inf"),
                                ("--poll-interval", "0"), ("--poll-interval", "-1"),
                                ("--poll-interval", "nan"), ("--poll-interval", "inf")):
                with self.subTest(flag=flag, value=value):
                    self.assertEqual(2, sweep.main(["--repo", "/unused", flag, value]))
        terminals.assert_not_called()


if __name__ == "__main__":
    unittest.main()
