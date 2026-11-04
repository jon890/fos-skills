"""새 기술 설계·기능별 계획 검사와 기존 계획의 읽기 호환을 검증한다."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import test_feature_contract as legacy

contract = legacy.contract
VALID = legacy.VALID.replace('| R', '| REQ').replace('| D', '| DECISION')
DESIGN = '''# 기술 설계
## 요구사항 연결
| ID | 해결 방법 |
| --- | --- |
| REQ1 | 작업 모듈이 권한을 검사한다 |
| REQ2 | 조건부 상태 갱신을 사용한다 |
## 책임과 경계
작업 모듈이 상태를 소유한다.
## 인터페이스와 데이터
기존 API 와 저장소를 사용한다.
## 실패와 일관성
권한을 상태 변경 전에 검사한다.
## 검증 전략
API 와 저장 상태를 통합 검증한다.
## 결정
없음: 기존 구조를 유지한다.
'''


class TechnicalDesignContractTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.feature = self.root / 'docs/features/cancel'
        self.feature.mkdir(parents=True)
        (self.feature / 'spec.md').write_text(VALID)
        (self.feature / 'design.md').write_text(DESIGN)
        self.data = {'spec': 'docs/features/cancel/spec.md', 'design': 'docs/features/cancel/design.md',
                     'requirements': ['REQ1'], 'phases': [{'requirements': ['REQ1']}]}

    def test_new_spec_needs_no_technical_design_until_plan(self):
        self.assertEqual([], contract.check_spec(VALID.replace('## 설계\n실행 API 의 상태를 통합 테스트로 확인한다.\n', ''))[1])
        self.assertEqual([], contract.check_plan(self.data, self.root))
        del self.data['design']
        self.assertTrue(any('design' in p for p in contract.check_plan(self.data, self.root)))

    def test_missing_design_or_external_path_blocks_plan(self):
        for design in ('missing.md', '../design.md', str(self.feature / 'design.md')):
            with self.subTest(design=design):
                self.assertTrue(contract.check_plan(self.data | {'design': design}, self.root))

    def test_uncovered_unknown_empty_and_open_design_fail(self):
        for design in (DESIGN.replace('| REQ2 | 조건부 상태 갱신을 사용한다 |', ''),
                       DESIGN.replace('REQ2', 'REQ9'), DESIGN.replace('작업 모듈이 상태를 소유한다.', ''),
                       DESIGN.replace('없음: 기존 구조를 유지한다.',
                                      '| DECISION1 | 저장소 | TBD | 작성자 | 관례 |')):
            with self.subTest(design=design):
                self.assertTrue(contract.check_design(design, {'REQ1', 'REQ2'}))

    def test_inline_design_uses_nested_sections(self):
        inline = VALID + '\n## 기술 설계\n' + '\n'.join(
            '### ' + line[3:] if line.startswith('## ') else line for line in DESIGN.splitlines()[1:])
        (self.feature / 'spec.md').write_text(inline)
        self.assertEqual([], contract.check_plan(self.data | {'design': self.data['spec']}, self.root))

    def test_cli_design_check_requires_confirmation(self):
        args = [sys.executable, str(legacy.SCRIPT), self.data['spec'], '--design', self.data['design'], '--draft']
        ok = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(0, ok.returncode, ok.stdout + ok.stderr)
        (self.feature / 'spec.md').write_text(VALID.replace('확인: 2026-11-02\n', ''))
        failed = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(1, failed.returncode, failed.stdout)

    def test_nested_plan_checks_its_feature_and_design(self):
        plan = self.feature / 'tasks/cancel-api'
        plan.mkdir(parents=True)
        (plan / 'phase-01.md').write_text('''# Phase 1
## 목표
취소
**범위 외**: 없음
## 컨텍스트
**근거 문서**: `docs/features/cancel/spec.md`

## 작업 항목
### test_cancel.py 테스트
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
                                       'requirements': ['REQ1']}]}
        (plan / 'index.json').write_text(json.dumps(data))
        args = [sys.executable, str(legacy.ROOT / 'skills/plan/scripts/verify_task.py'), 'cancel-api',
                '--tasks-dir', 'docs/features/cancel/tasks', '--audit']
        checked = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(0, checked.returncode, checked.stdout + checked.stderr)
        (self.feature / 'design.md').unlink()
        failed = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(1, failed.returncode, failed.stdout)
        self.assertIn('기술 설계', failed.stdout)

    def test_legacy_ids_and_original_plan_keep_working(self):
        (self.feature / 'spec.md').write_text(legacy.VALID)
        data = {'spec': self.data['spec'], 'requirements': ['R1'], 'phases': [{'requirements': ['R1']}]}
        self.assertEqual([], contract.check_plan(data, self.root))


if __name__ == '__main__':
    unittest.main()
