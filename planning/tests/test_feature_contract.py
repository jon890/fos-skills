"""서로 다른 기능과 PR 의 요구사항이 섞이거나 누락되는 것을 막는다."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'planning/scripts/check_feature.py'
spec = importlib.util.spec_from_file_location('feature_contract', SCRIPT)
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
VALID = '''# 취소
## 목표
작업 취소
## 범위
소유자의 작업
## 요구사항과 인수 조건
| ID | 요구사항 | 인수 조건 |
| --- | --- | --- |
| R1 | 권한 | 타 사용자는 거부 |
| R2 | 멱등성 | 반복해도 부작용 없음 |
## 설계
실행 API 의 상태를 통합 테스트로 확인한다.
## 미결정
없음
'''


class FeatureContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / 'docs/features/cancel/spec.md'
        self.path.parent.mkdir(parents=True)
        self.path.write_text(VALID)

    def plan(self, **updates):
        result = {'spec': 'docs/features/cancel/spec.md', 'requirements': ['R1'],
                  'phases': [{'requirements': ['R1']}]}
        return result | updates

    def test_partial_pr_does_not_need_all_feature_requirements(self):
        self.assertEqual([], contract.check_plan(self.plan(), self.root))

    def test_unknown_or_unassigned_requirement_is_rejected(self):
        for plan in (self.plan(requirements=['R3']),
                     self.plan(requirements=['R1', 'R2']),
                     self.plan(phases=[{'requirements': ['R2']}] )):
            with self.subTest(plan=plan):
                self.assertTrue(contract.check_plan(plan, self.root))

    def test_same_local_ids_in_other_feature_do_not_alias(self):
        other = self.root / 'docs/features/memory/spec.md'
        other.parent.mkdir(parents=True)
        other.write_text(VALID)
        self.assertTrue(contract.check_plan(self.plan(), self.root, other))

    def test_examples_cannot_satisfy_actual_contract(self):
        _, errors = contract.check_spec('```markdown\n' + VALID + '\n```')
        self.assertTrue(errors)

    def test_duplicate_ids_and_unresolved_decisions_fail(self):
        for text in (VALID.replace('| R2 |', '| R1 |'), VALID.replace('없음', '권한 정책 미정'),
                     VALID.replace('타 사용자는 거부', '')):
            with self.subTest(text=text):
                self.assertTrue(contract.check_spec(text)[1])

    def test_paths_outside_repo_and_malformed_plans_fail(self):
        for plan in (self.plan(spec='../elsewhere.md'), self.plan(spec=str(self.path)),
                     self.plan(requirements='R1'), self.plan(phases=[None])):
            with self.subTest(plan=plan):
                self.assertTrue(contract.check_plan(plan, self.root))

    def test_cli_returns_nonzero_for_broken_links(self):
        index = self.root / 'index.json'
        index.write_text(json.dumps(self.plan(spec='missing.md')))
        run = subprocess.run([sys.executable, str(SCRIPT), str(self.path.relative_to(self.root)),
                              '--plan', str(index)], cwd=self.root, capture_output=True)
        self.assertEqual(1, run.returncode)

    def test_verify_task_rejects_feature_contract_before_success(self):
        # audit avoids unrelated source-existence checks; a legacy plan needs no spec.
        plan = self.root / 'tasks/plan1-cancel'
        plan.mkdir(parents=True)
        (plan / 'phase-01.md').write_text('''# Phase 1
## 목표
취소
**범위 외**: 없음
## 작업 항목
### test_cancel.py 테스트
```python
assert True
```
## 검증
```bash
python3 test_cancel.py
```
## 변경 파일
| 파일 | 변경 |
| --- | --- |
| `test_cancel.py` | 신규 |
''')
        data = {'name': plan.name, 'total_phases': 1, 'phases': [
            {'number': 1, 'file': 'phase-01.md', 'execution_profile': 'standard'}]}
        for feature in (False, True):
            current = data | ({'spec': 'missing.md', 'requirements': ['R1']} if feature else {})
            (plan / 'index.json').write_text(json.dumps(current))
            run = subprocess.run([sys.executable, str(ROOT / 'planning/scripts/verify_task.py'),
                                  plan.name, '--audit'], cwd=self.root, capture_output=True, text=True)
            self.assertEqual(feature, '기능 계약 검사 실패' in run.stdout, run.stdout + run.stderr)
            if feature:
                self.assertNotEqual(0, run.returncode)


if __name__ == '__main__':
    unittest.main()
