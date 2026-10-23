"""부모 Dispatch ID를 복사한 하위 세션의 완료를 PR 준비 보고와 구별한다."""

import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "completion_evidence.py"
spec = importlib.util.spec_from_file_location("completion_evidence", SCRIPT)
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


def message(kind, second=1, **changes):
    return {"id": f"m{second}", "type": kind, "from_handle": "term_parent",
            "created_at": f"2026-10-23T00:00:{second:02d}Z", "task_id": "task_a",
            "dispatch_id": "ctx_a", "subject": "준비 보고", "body": "",
            "payload": {"outcome": "succeeded"}, **changes}


def ready(**changes):
    return message("status", **{"subject": "준비됨 #123, head " + "a" * 40, **changes})


class CompletionEvidenceTest(unittest.TestCase):
    def test_child_review_cannot_complete_without_ready_status(self):
        done = message("worker_done", 2, subject="검토 완료")
        result = evidence.classify([done])[0]
        self.assertEqual(result["type"], "suspicious_worker_done")
        self.assertEqual(done["type"], "worker_done")

    def test_ready_status_of_same_context_is_evidence(self):
        done = message("worker_done", 2)
        result = evidence.classify([done], [ready()])[0]
        self.assertEqual(result["type"], "worker_done")
        self.assertEqual(result["completionVerification"]["head"], "a" * 40)
        self.assertEqual(result["completionVerification"]["pr"], 123)

    def test_other_context_sender_short_hash_or_later_status_is_not_evidence(self):
        candidates = [ready(task_id="task_old"), ready(dispatch_id="ctx_old"),
                      ready(from_handle="term_other"), ready(second=3),
                      ready(subject="준비됨 #123, head abc1234"),
                      ready(subject="아직 준비됨 #123, head " + "a" * 40),
                      ready(created_at="bad")]
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                self.assertEqual(evidence.classify([message("worker_done", 2)], [candidate])[0]["type"],
                                 "suspicious_worker_done")

    def test_payload_ids_and_camelcase_are_supported(self):
        status = ready(task_id=None, dispatch_id=None,
                       payload='{"taskId":"task_a","dispatchId":"ctx_a"}')
        self.assertEqual(evidence.classify([status, message("worker_done", 2)])[1]["type"], "worker_done")

    def test_missing_context_is_not_trusted(self):
        self.assertEqual(evidence.classify([ready(), message("worker_done", 2, dispatch_id=None)])[1]["type"],
                         "suspicious_worker_done")

    def test_failed_outcome_does_not_need_pr(self):
        result = evidence.classify([message("worker_done", payload={"outcome": "failed"})])[0]
        self.assertEqual(result["completionVerification"]["status"], "failure_report")
        self.assertEqual(result["type"], "worker_done")

    def test_waiter_proof_survives_file_triage_without_history(self):
        checked = evidence.classify([message("worker_done", 2)], [ready()])
        self.assertEqual(evidence.classify(checked), checked)

    def test_timestamp_less_history_is_not_proof_but_current_order_is(self):
        status = ready(created_at=None)
        done = message("worker_done", 2, created_at=None)
        self.assertEqual(evidence.classify([done], [status])[0]["type"], "suspicious_worker_done")
        self.assertEqual(evidence.classify([status, done])[1]["type"], "worker_done")


if __name__ == "__main__":
    unittest.main()
