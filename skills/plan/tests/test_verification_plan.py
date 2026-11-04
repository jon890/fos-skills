"""인수 검증 계획의 PR 범위·실행 조건·경로와 기존 계획의 읽기 호환을 확인한다."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import test_feature_contract as legacy

contract = legacy.contract
ROOT = legacy.ROOT
SAMPLE = (ROOT / 'skills/plan/templates/verification-plan.md').read_text()


class VerificationPlanTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.feature = self.root / 'docs/features/cancel'
        self.plan = self.feature / 'tasks/cancel-api'
        self.plan.mkdir(parents=True)
        (self.feature / 'spec.md').write_text(legacy.VALID)
        self.verification = SAMPLE.replace('REQ1', 'R1').replace('REQ2', 'R2')
        (self.plan / 'verification-plan.md').write_text(self.verification)
        self.data = {'spec': 'docs/features/cancel/spec.md', 'requirements': ['R1', 'R2'],
                     'verification_plan': 'verification-plan.md',
                     'phases': [{'requirements': ['R1', 'R2']}]}
        self.index = self.plan / 'index.json'

    def check(self, data=None, required=False):
        return contract.check_plan(data or self.data, self.root, plan_path=self.index,
                                   require_verification=required)

    def test_template_supports_multiple_cases_and_rejects_coverage_gaps(self):
        self.assertEqual([], self.check(required=True))
        text = '\n'.join(line for line in self.verification.splitlines() if not line.startswith('| R2 |'))
        errors = contract.check_verification(text, {'R1', 'R2'})
        self.assertTrue(any('R2' in e and '없는 요구사항' in e for e in errors), errors)
        self.assertEqual([], contract.check_verification(self.verification.replace('| R2 |', '| R1 |'), {'R1'}))

    def test_case_outside_pr_and_empty_steps_cannot_pass(self):
        for text in (self.verification.replace('| R2 |', '| R3 |'),
                     self.verification.replace('두 요청 성공, 취소 이력 1건', ''),
                     self.verification.replace('두 요청 성공, 취소 이력 1건', '{{actual expectation}}'),
                     '```markdown\n' + self.verification + '\n```'):
            with self.subTest(text=text):
                self.assertTrue(contract.check_verification(text, {'R1', 'R2'}))

    def test_valid_markdown_command_pipe_does_not_create_an_extra_column(self):
        text = self.verification.replace('다른 사용자로 취소 API 를 호출하고 저장 상태를 조회',
                                         r'`pytest tests/test_cancel.py \| tee results.log`')
        self.assertEqual([], contract.check_verification(text, {'R1', 'R2'}))

    def test_remote_prerequisite_cannot_be_declared_pre_pr(self):
        for text in (self.verification.replace('| 없음 | PR 전 |', '| 배포 | PR 전 |'),
                     self.verification.replace('| PR 전 |', '| 나중에 |')):
            self.assertTrue(contract.check_verification(text, {'R1', 'R2'}))
        self.assertEqual([], contract.check_verification(
            self.verification.replace('| 없음 | PR 전 |', '| 배포 후 | PR 뒤 |'), {'R1', 'R2'}))

    def test_paths_are_relative_to_this_plan_not_repository_or_other_plan(self):
        outside = self.feature / 'outside.md'
        outside.write_text(self.verification)
        for rel in ('../../outside.md', str(outside), 'missing.md', None):
            with self.subTest(rel=rel):
                if rel is None:
                    data = self.data | {'verification_plan': ''}
                else:
                    data = self.data | {'verification_plan': rel}
                self.assertTrue(self.check(data))
        (self.plan / 'linked.md').symlink_to(outside)
        self.assertTrue(self.check(self.data | {'verification_plan': 'linked.md'}))

    def test_inline_phase_and_old_plan_without_field_are_supported(self):
        (self.plan / 'phase-01.md').write_text('# phase\n## 목표\n취소\n' + self.verification)
        self.assertEqual([], self.check(self.data | {'verification_plan': 'phase-01.md'}))
        old = {k: v for k, v in self.data.items() if k != 'verification_plan'}
        self.assertEqual([], self.check(old))
        self.assertTrue(self.check(old, required=True))

    def test_template_spec_requires_actual_user_confirmation(self):
        text = (ROOT / 'skills/spec/templates/spec.md').read_text()
        ids, errors = contract.check_spec(text, draft=True)
        self.assertEqual([], errors)
        self.assertEqual({'REQ1', 'REQ2'}, ids)
        self.assertTrue(contract.check_spec(text)[1])
        design = (ROOT / 'skills/technical-design/templates/design.md').read_text()
        self.assertEqual([], contract.check_design(design, ids))

    def test_verify_task_runs_the_same_check_and_blocks_missing_plan(self):
        (self.plan / 'phase-01.md').write_text('''# Phase 1
## 목표
취소
**범위 외**: 없음
## 컨텍스트
**근거 문서**: `docs/features/cancel/spec.md`

## 작업 항목
### `test_cancel.py` 테스트
```python
assert True
```
## 검증
```bash
pytest test_cancel.py
```
## 변경 파일
| 파일 | 변경 |
| --- | --- |
| `test_cancel.py` | 신규 |
''')
        data = self.data | {'name': 'cancel-api', 'total_phases': 1,
                           'phases': [{'number': 1, 'file': 'phase-01.md', 'execution_profile': 'standard',
                                       'requirements': ['R1', 'R2']}]}
        self.index.write_text(json.dumps(data))
        args = [sys.executable, str(ROOT / 'skills/plan/scripts/verify_task.py'), 'cancel-api',
                '--tasks-dir', 'docs/features/cancel/tasks', '--audit', '--require-verification']
        ok = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(0, ok.returncode, ok.stdout + ok.stderr)
        del data['verification_plan']
        self.index.write_text(json.dumps(data))
        failed = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(1, failed.returncode, failed.stdout + failed.stderr)
        self.assertIn('verification_plan', failed.stdout)
        legacy_run = subprocess.run(args[:-1], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(0, legacy_run.returncode, legacy_run.stdout + legacy_run.stderr)


if __name__ == '__main__':
    unittest.main()
