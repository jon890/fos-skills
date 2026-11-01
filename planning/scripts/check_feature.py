#!/usr/bin/env python3
"""기능 스펙의 최소 형식과 PR 계획의 요구사항 연결을 검사한다.

cwd: 대상 저장소 루트.
사용: python3 check_feature.py docs/features/run-cancel/spec.md [--plan tasks/plan1-cancel/index.json]
종료 코드: 0 형식/연결 통과, 1 위반, 2 읽기/인자 오류.
의미 완전성, 실제 실행 결과, 사용자 합의는 판정하지 않는다.
"""
import argparse
import json
import re
import sys
from pathlib import Path

SECTIONS = ('목표', '범위', '요구사항과 인수 조건', '설계', '미결정')
ID = re.compile(r'R[1-9][0-9]*\Z')


def sections(text):
    """코드 예시 안의 제목과 표는 계약으로 읽지 않는다."""
    result, current, fence = {}, None, None
    for line in text.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence:
            continue
        if line.startswith('## '):
            current = line[3:].strip()
            result.setdefault(current, [])
        elif current:
            result[current].append(line)
    return {name: '\n'.join(lines).strip() for name, lines in result.items()}


def check_spec(text):
    found, problems, ids = sections(text), [], []
    for name in SECTIONS:
        if not found.get(name):
            problems.append(f'스펙의 필수 절이 없거나 비었다: {name}')
    for line in found.get('요구사항과 인수 조건', '').splitlines():
        cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
        if not line.lstrip().startswith('|') or not cells or not ID.fullmatch(cells[0]):
            continue
        rid = cells[0]
        if rid in ids:
            problems.append(f'요구사항 ID 중복: {rid}')
        ids.append(rid)
        if len(cells) < 3 or not cells[1] or not cells[2]:
            problems.append(f'{rid}: 요구사항과 인수 조건이 필요하다')
    if not ids:
        problems.append('요구사항 표에 R1 같은 ID 와 인수 조건이 필요하다')
    if found.get('미결정') not in ('없음', '- 없음'):
        problems.append('구현에 필요한 미결정을 해결하고 미결정 절에 없음으로 표시한다')
    return set(ids), problems


def inside(root, value):
    if not isinstance(value, str) or not value.strip() or Path(value).is_absolute():
        raise ValueError('스펙 경로는 저장소 루트 기준 상대경로여야 한다')
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('스펙 경로가 저장소 밖을 가리킨다')
    return path


def check_plan(data, root, expected_spec=None):
    if not isinstance(data, dict):
        return ['계획 index 는 객체여야 한다']
    try:
        spec = inside(root, data.get('spec'))
        ids, problems = check_spec(spec.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return [f'계획의 스펙을 읽을 수 없다: {exc}']
    if expected_spec is not None and spec != expected_spec.resolve():
        problems.append('검사한 스펙과 계획의 spec 이 다르다')
    assigned = data.get('requirements')
    if not isinstance(assigned, list) or not assigned or any(not isinstance(x, str) for x in assigned):
        return problems + ['계획 requirements 에 이번 PR 의 요구사항 ID 목록이 필요하다']
    if len(set(assigned)) != len(assigned) or set(assigned) - ids:
        problems.append('계획 requirements 에 중복 또는 스펙에 없는 ID 가 있다')
    phases = data.get('phases')
    if not isinstance(phases, list) or not phases:
        return problems + ['요구사항을 구현할 phases 배열이 필요하다']
    covered = set()
    for i, phase in enumerate(phases, 1):
        reqs = phase.get('requirements') if isinstance(phase, dict) else None
        if not isinstance(reqs, list) or not reqs or any(not isinstance(x, str) for x in reqs):
            problems.append(f'phase {i}: requirements ID 목록이 필요하다')
            continue
        if set(reqs) - set(assigned):
            problems.append(f'phase {i}: 이번 PR 범위 밖의 요구사항 ID 가 있다')
        covered.update(reqs)
    if set(assigned) - covered:
        problems.append('phase 에 배정하지 않은 요구사항: ' + ', '.join(sorted(set(assigned) - covered)))
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path)
    parser.add_argument('--plan', type=Path)
    args = parser.parse_args(argv)
    try:
        spec = inside(Path.cwd(), str(args.spec))
        _, problems = check_spec(spec.read_text(encoding='utf-8'))
        if args.plan:
            problems += check_plan(json.loads(args.plan.read_text(encoding='utf-8')), Path.cwd(), spec)
    except (OSError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 2
    for problem in dict.fromkeys(problems):
        print(problem)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
