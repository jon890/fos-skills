import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from executor_routing_gate import GateInputError, classify


PHASE = """# Phase 01 — test

## 목표

검증용 phase다.

**범위 외**: 다른 모듈

## 작업 항목

### 1. 기존 함수 수정

기존 형태를 따른다.

## Critical Files

| 파일 | 변경 |
|---|---|
| `src/a.ts` | 수정 |

## 검증

`npm test`
"""


def assessment(phase_file: Path, **overrides):
    data = {
        "phase_file": str(phase_file),
        "execution_profile": "standard",
        "critic_verdict": "APPROVE",
        "critic_shape": "BOUNDED",
        "team_lead_shape": "BOUNDED",
        "bounded_checks": {
            "bounded_scope": True,
            "existing_pattern": True,
            "no_new_decision": True,
            "no_high_risk_conditions": True,
            "reversible": True,
            "regression_covered": True,
        },
        "uncertainties": [],
        "high_risk_reasons": [],
    }
    data.update(overrides)
    return data


class ExecutorRoutingGateTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.phase_file = Path(self.tempdir.name) / "phase-01.md"
        self.phase_file.write_text(PHASE, encoding="utf-8")

    def tearDown(self):
        self.tempdir.cleanup()

    def test_all_conditions_proven_allows_bounded(self):
        result = classify(assessment(self.phase_file))
        self.assertEqual("BOUNDED", result["effective_shape"])
        self.assertTrue(result["bounded_eligible"])

    def test_missing_bounded_check_promotes_to_judgment_required(self):
        data = assessment(self.phase_file)
        data["bounded_checks"]["no_new_decision"] = False
        result = classify(data)
        self.assertEqual("JUDGMENT_REQUIRED", result["effective_shape"])
        self.assertFalse(result["bounded_eligible"])

    def test_high_risk_reason_overrides_standard_and_approve(self):
        result = classify(
            assessment(self.phase_file, high_risk_reasons=["data schema migration"])
        )
        self.assertEqual("HIGH_RISK", result["effective_shape"])
        self.assertFalse(result["bounded_eligible"])

    def test_deep_profile_is_high_risk(self):
        result = classify(assessment(self.phase_file, execution_profile="deep"))
        self.assertEqual("HIGH_RISK", result["effective_shape"])

    def test_critic_revise_blocks_spawn(self):
        with self.assertRaises(GateInputError):
            classify(assessment(self.phase_file, critic_verdict="REVISE"))

    def test_missing_high_risk_proof_promotes_to_judgment_required(self):
        data = assessment(self.phase_file)
        del data["bounded_checks"]["no_high_risk_conditions"]
        result = classify(data)
        self.assertEqual("JUDGMENT_REQUIRED", result["effective_shape"])
        self.assertFalse(result["bounded_eligible"])

    def test_missing_uncertainties_list_blocks_spawn(self):
        data = assessment(self.phase_file)
        del data["uncertainties"]
        with self.assertRaises(GateInputError):
            classify(data)

    def test_missing_high_risk_reasons_list_blocks_spawn(self):
        data = assessment(self.phase_file)
        del data["high_risk_reasons"]
        with self.assertRaises(GateInputError):
            classify(data)

    def test_cli_emits_machine_readable_result(self):
        assessment_file = Path(self.tempdir.name) / "assessment.json"
        assessment_file.write_text(
            json.dumps(assessment(self.phase_file)), encoding="utf-8"
        )
        script = Path(__file__).resolve().parents[1] / "scripts" / "executor_routing_gate.py"
        completed = subprocess.run(
            [sys.executable, str(script), str(assessment_file)],
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual("BOUNDED", result["effective_shape"])
        self.assertTrue(result["bounded_eligible"])


if __name__ == "__main__":
    unittest.main()
