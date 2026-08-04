#!/usr/bin/env python3
"""Fail-closed executor routing gate for build-with-teams."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SHAPE_RANK = {
    "BOUNDED": 0,
    "JUDGMENT_REQUIRED": 1,
    "HIGH_RISK": 2,
}
VALID_PROFILES = {"fast", "standard", "deep"}
REQUIRED_SECTIONS = {
    "goal": "## 목표",
    "out_of_scope": "**범위 외**",
    "work_items": "## 작업 항목",
    "critical_files": "## Critical Files",
    "verification": "## 검증",
}
REQUIRED_BOUNDED_CHECKS = {
    "bounded_scope",
    "existing_pattern",
    "no_new_decision",
    "no_high_risk_conditions",
    "reversible",
    "regression_covered",
}


class GateInputError(ValueError):
    """Raised when the gate cannot safely classify the assessment."""


def _require_string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise GateInputError(f"missing or invalid string: {key}")
    return value.strip()


def _require_shape(data: dict[str, Any], key: str) -> str:
    value = _require_string(data, key)
    if value not in SHAPE_RANK:
        raise GateInputError(f"invalid {key}: {value}")
    return value


def _strictest(*shapes: str) -> str:
    return max(shapes, key=SHAPE_RANK.__getitem__)


def _require_string_list(data: dict[str, Any], key: str) -> list[str]:
    if key not in data:
        raise GateInputError(f"missing required list: {key}")
    value = data[key]
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise GateInputError(f"{key} must be a list of strings")
    return value


def classify(assessment: dict[str, Any]) -> dict[str, Any]:
    phase_file = Path(_require_string(assessment, "phase_file"))
    if not phase_file.is_absolute() or not phase_file.is_file():
        raise GateInputError("phase_file must be an existing absolute path")

    profile = _require_string(assessment, "execution_profile")
    if profile not in VALID_PROFILES:
        raise GateInputError(f"invalid execution_profile: {profile}")

    critic_verdict = _require_string(assessment, "critic_verdict")
    if critic_verdict != "APPROVE":
        raise GateInputError("critic_verdict must be APPROVE before executor spawn")

    critic_shape = _require_shape(assessment, "critic_shape")
    team_lead_shape = _require_shape(assessment, "team_lead_shape")
    effective_shape = _strictest(critic_shape, team_lead_shape)
    reasons: list[str] = []

    if critic_shape != team_lead_shape:
        reasons.append("critic/team-lead disagreement: strictest shape selected")

    phase_text = phase_file.read_text(encoding="utf-8")
    missing_sections = [
        name for name, marker in REQUIRED_SECTIONS.items() if marker not in phase_text
    ]
    if missing_sections:
        reasons.append("missing phase sections: " + ", ".join(missing_sections))

    checks = assessment.get("bounded_checks")
    if not isinstance(checks, dict):
        checks = {}
        reasons.append("bounded_checks missing or invalid")
    failed_checks = sorted(
        key for key in REQUIRED_BOUNDED_CHECKS if checks.get(key) is not True
    )
    if failed_checks:
        reasons.append("bounded checks not proven: " + ", ".join(failed_checks))

    uncertainties = _require_string_list(assessment, "uncertainties")
    if uncertainties:
        reasons.append("unresolved uncertainties: " + "; ".join(uncertainties))

    high_risk_reasons = _require_string_list(assessment, "high_risk_reasons")

    if profile == "deep":
        effective_shape = "HIGH_RISK"
        reasons.append("execution_profile is deep")
    if high_risk_reasons:
        effective_shape = "HIGH_RISK"
        reasons.append("high-risk conditions: " + "; ".join(high_risk_reasons))

    bounded_failures = missing_sections or failed_checks or uncertainties
    if effective_shape == "BOUNDED" and bounded_failures:
        effective_shape = "JUDGMENT_REQUIRED"
        reasons.append("BOUNDED eligibility not fully proven")

    if not reasons:
        reasons.append("all BOUNDED eligibility conditions proven")

    return {
        "phase_file": str(phase_file),
        "execution_profile": profile,
        "effective_shape": effective_shape,
        "bounded_eligible": effective_shape == "BOUNDED",
        "reasons": reasons,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assessment", help="Path to an executor gate assessment JSON")
    args = parser.parse_args()

    try:
        data = json.loads(Path(args.assessment).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise GateInputError("assessment root must be an object")
        result = classify(data)
    except (OSError, json.JSONDecodeError, GateInputError) as exc:
        print(f"executor routing gate blocked: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
