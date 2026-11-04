#!/usr/bin/env python3
"""기능 스펙의 최소 형식과 PR 계획의 요구사항 연결을 검사한다.

cwd: 대상 저장소 루트.
사용: python3 check_feature.py docs/features/run-cancel/spec.md [--plan tasks/plan1-cancel/index.json] [--draft]
종료 코드: 0 형식/연결 통과, 1 위반, 2 읽기/인자 오류.

스펙 검사:
- 필수 절: 목표, 범위, 요구사항과 인수 조건, 결정. 새 형식은 REQ1/DECISION1, 기존 R1/D1 은 읽기 호환이다.
- --design 은 책임·경계·데이터·일관성·검증 전략과 모든 요구사항의 연결을 검사한다.
- verification_plan 이 있으면 그 파일(또는 phase 의 인수 검증 계획 절)과 PR 요구사항 연결을 검사한다.
  경로는 계획 폴더 기준이다. --require-verification 은 새 계획의 누락도 막고, 기본값은 기존 계획을 그대로 읽는다.
- 새 REQ 형식의 계획은 design 경로가 필요하다. 기존 R 형식 계획은 기술 설계 연결을 강제하지 않는다.
- 결정 절은 `| D1 | 결정 | 답 | 누가 | 근거 |` 표이거나 `없음: <이유>` 한 줄이다.
  「답」 이 비었거나 미정·TBD·? 면 닫히지 않은 결정이다.
  「누가」 는 `사용자 YYYY-MM-DD`, `작성자`, `작성자(위임)` 중 하나다.
- 제목과 첫 `##` 절 사이에 `확인: YYYY-MM-DD` 줄(사용자 확인 날짜)이 있다. `--draft` 면 이 줄을 요구하지 않는다.
  `--plan` 과 함께 쓰면 계획이 가리킨 스펙에도 확인 줄을 요구한다. 확인 전에는 계획을 만들지 않는다.
- 옛 `## 미결정` 절은 결정 표로 바꾸라고 알린다.
의미 완전성, 실제 실행 결과, 사용자 합의의 내용은 판정하지 않는다.
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

SECTIONS = ('목표', '범위', '요구사항과 인수 조건', '결정')
DESIGN_SECTIONS = ('요구사항 연결', '책임과 경계', '인터페이스와 데이터', '실패와 일관성', '검증 전략', '결정')
ID = re.compile(r'(?:REQ|R)[1-9][0-9]*\Z')
DECISION_ID = re.compile(r'(?:DECISION|D)[1-9][0-9]*\Z')
DECIDER = re.compile(r'(사용자 \d{4}-\d{2}-\d{2}|작성자|작성자\(위임\))\Z')
OPEN_ANSWERS = {'', '미정', 'tbd', '?', '-'}
CONFIRMED = re.compile(r'확인:\s*(\d{4}-\d{2}-\d{2})\s*\Z')
NO_DECISION = re.compile(r'-?\s*없음:\s*\S.*')


def sections(text):
    """코드 예시 안의 제목과 표는 계약으로 읽지 않는다. 첫 `##` 앞은 빈 이름('')의 머리로 모은다."""
    result, current, fence = {'': []}, '', None
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
        else:
            result[current].append(line)
    return {name: '\n'.join(lines).strip() for name, lines in result.items()}


def table_rows(body):
    for line in body.splitlines():
        if line.lstrip().startswith('|'):
            yield [cell.strip().replace(r'\|', '|')
                   for cell in re.split(r'(?<!\\)\|', line.strip().strip('|'))]


def check_decisions(body):
    """결정 표가 모두 닫혔는지 본다. 표가 없으면 `없음: <이유>` 한 줄이어야 한다."""
    rows = [cells for cells in table_rows(body) if cells and DECISION_ID.fullmatch(cells[0])]
    if not rows:
        if NO_DECISION.fullmatch(body.strip()):
            return []
        return ['결정 절에 DECISION1 같은 ID 의 결정 표나 「없음: <이유>」 한 줄이 필요하다']
    problems, seen = [], set()
    for cells in rows:
        did = cells[0]
        if did in seen:
            problems.append(f'결정 ID 중복: {did}')
        seen.add(did)
        if len(cells) < 5:
            problems.append(f'{did}: 결정, 답, 누가, 근거 칸이 필요하다')
            continue
        _, title, answer, decider, reason = cells[:5]
        if not title:
            problems.append(f'{did}: 무엇을 정했는지 결정 칸이 비었다')
        if answer.lower() in OPEN_ANSWERS:
            problems.append(f'{did}: 답이 닫히지 않았다({answer or "빈칸"}). 사용자에게 묻거나 근거를 남겨 정한다')
        if not DECIDER.fullmatch(decider):
            problems.append(f'{did}: 누가 칸은 「사용자 YYYY-MM-DD」, 「작성자」, 「작성자(위임)」 중 하나다(지금 {decider or "빈칸"})')
        if not reason:
            problems.append(f'{did}: 근거 칸이 비었다')
    return problems


def check_confirmed(head):
    for line in head.splitlines():
        match = CONFIRMED.fullmatch(line.strip())
        if match:
            try:
                date.fromisoformat(match.group(1))
            except ValueError:
                return [f'확인 줄의 날짜가 올바르지 않다: {match.group(1)}']
            return []
    return ['사용자 확인 줄(제목 아래 「확인: YYYY-MM-DD」)이 없다. 사용자가 스펙을 확인하기 전에는 계획을 만들지 않는다']


def check_domain_changes(body, draft=False):
    """변경 표가 있는 스펙만 검사한다. 기존 스펙에 새 절을 강제하지 않는다."""
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S).strip()
    if not body or body.startswith('도메인 규칙 변경 없음:'):
        return []
    rows = [cells for cells in table_rows(body)
            if cells and re.search(r'\bRULE[1-9][0-9]*\b', cells[0])]
    if not rows:
        return ['도메인 규칙 변경 절에 RULE ID 의 변경 표 또는 「도메인 규칙 변경 없음: 이유」 가 필요하다']
    problems = []
    for cells in rows:
        if len(cells) != 6 or any(not cell or cell.lower() in OPEN_ANSWERS for cell in cells):
            problems.append(f'{cells[0]}: 규칙, 변경 내용, 결정 상태, 제안자, 확정 근거, 외부 검토가 필요하다')
            continue
        if cells[2] not in ('제안', '확인 대기', '확정'):
            problems.append(f'{cells[0]}: 모르는 결정 상태 {cells[2]}')
        elif not draft and cells[2] != '확정':
            problems.append(f'{cells[0]}: 도메인 규칙이 확정되지 않았다({cells[2]})')
        if cells[2] == '확정' and cells[4].lower() in ('없음', '미정', 'tbd'):
            problems.append(f'{cells[0]}: 확정 근거가 필요하다')
    return problems


def check_spec(text, draft=False):
    found, problems, ids = sections(text), [], []
    if '미결정' in found and '결정' not in found:
        problems.append('옛 「미결정」 절을 「결정」 표로 바꾼다(spec 의 references/interview.md)')
    for name in SECTIONS:
        if not found.get(name):
            problems.append(f'스펙의 필수 절이 없거나 비었다: {name}')
    for cells in table_rows(found.get('요구사항과 인수 조건', '')):
        if not cells or not ID.fullmatch(cells[0]):
            continue
        rid = cells[0]
        if rid in ids:
            problems.append(f'요구사항 ID 중복: {rid}')
        ids.append(rid)
        if len(cells) < 3 or not cells[1] or not cells[2]:
            problems.append(f'{rid}: 요구사항과 인수 조건이 필요하다')
    if not ids:
        problems.append('요구사항 표에 REQ1 같은 ID 와 인수 조건이 필요하다')
    if found.get('결정'):
        problems += check_decisions(found['결정'])
    problems += check_domain_changes(found.get('도메인 규칙 변경', ''), draft)
    if not draft:
        problems += check_confirmed(found.get('', ''))
    return set(ids), problems


def check_design(text, requirement_ids, inline=False):
    """설계의 구조·요구사항 연결만 검사한다. 의미와 독립 검토는 판정하지 않는다."""
    if inline:
        body = sections(text).get('기술 설계', '')
        text = re.sub(r'^### ', '## ', body, flags=re.M)
    found = sections(text)
    problems = [f'기술 설계의 필수 절이 없거나 비었다: {name}'
                for name in DESIGN_SECTIONS if not found.get(name)]
    linked = set()
    for cells in table_rows(found.get('요구사항 연결', '')):
        if not cells or not ID.fullmatch(cells[0]):
            continue
        rid = cells[0]
        if rid in linked:
            problems.append(f'기술 설계 요구사항 ID 중복: {rid}')
        linked.add(rid)
        if len(cells) < 2 or not cells[1]:
            problems.append(f'{rid}: 기술 설계의 해결 방법이 비었다')
    if linked - requirement_ids:
        problems.append('기술 설계에 스펙에 없는 요구사항 ID 가 있다')
    if requirement_ids - linked:
        problems.append('기술 설계에 연결하지 않은 요구사항: ' + ', '.join(sorted(requirement_ids - linked)))
    if found.get('결정'):
        problems += check_decisions(found['결정'])
    return problems


def inside(root, value):
    if not isinstance(value, str) or not value.strip() or Path(value).is_absolute():
        raise ValueError('스펙 경로는 저장소 루트 기준 상대경로여야 한다')
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('스펙 경로가 저장소 밖을 가리킨다')
    return path


def check_verification(text, assigned):
    """검증 계획의 구조와 PR 요구사항 연결만 본다. 절차의 충분성·실행 결과는 보지 않는다."""
    body = sections(text).get('인수 검증 계획', '')
    if not body:
        return ['인수 검증 계획 절이 없거나 비었다']
    headers = ['요구사항', '준비 조건', '실행 절차', '기대 결과', '실행 환경', '선행 조건', '시점']
    rows = list(table_rows(body))
    if not rows or rows[0] != headers:
        return ['인수 검증 계획 표의 열은 ' + ', '.join(headers) + ' 순서여야 한다']
    problems, covered = [], set()
    for cells in rows[1:]:
        if cells and all(re.fullmatch(r':?-+:?', cell) for cell in cells):
            continue
        if len(cells) != len(headers):
            problems.append('인수 검증 사례에 준비 조건·절차·기대값·환경·선행 조건·시점이 필요하다')
            continue
        rid, _, _, _, _, prerequisite, timing = cells
        if rid not in assigned:
            problems.append(f'인수 검증에 이번 PR 범위 밖의 요구사항: {rid}')
        else:
            covered.add(rid)
        if any(cell.lower() in OPEN_ANSWERS or '{{' in cell or '}}' in cell for cell in cells):
            problems.append(f'{rid}: 인수 검증 사례의 빈칸·미정·양식 자리표시자를 채운다')
        if timing not in {'PR 전', 'PR 뒤'}:
            problems.append(f'{rid}: 인수 검증 시점은 PR 전 또는 PR 뒤다')
        if not re.match(r'^(없음|push|머지|배포)(?:\s|$|[(:])', prerequisite):
            problems.append(f'{rid}: 선행 조건은 없음, push, 머지, 배포 중 하나로 시작한다')
        if timing == 'PR 전' and prerequisite.startswith(('머지', '배포')):
            problems.append(f'{rid}: 머지·배포가 필요한 검증은 PR 뒤다')
    if assigned - covered:
        problems.append('인수 검증 사례가 없는 요구사항: ' + ', '.join(sorted(assigned - covered)))
    return problems


def check_verification_file(data, plan_path, assigned, required=False):
    value = data.get('verification_plan')
    if value is None:
        return ['새 기능 계획에 verification_plan 경로가 필요하다'] if required else []
    if plan_path is None:
        return ['검증 계획을 읽으려면 계획 index 경로가 필요하다']
    try:
        # 경로는 repo 기준인 spec/design 과 달리 index.json 의 부모 기준이다.
        directory = Path(plan_path).resolve().parent
        if not isinstance(value, str) or not value.strip() or Path(value).is_absolute():
            raise ValueError('verification_plan 은 계획 폴더 기준 상대경로여야 한다')
        path = (directory / value).resolve()
        if not path.is_relative_to(directory):
            raise ValueError('verification_plan 이 다른 계획 폴더를 가리킨다')
        return check_verification(path.read_text(encoding='utf-8'), assigned)
    except (OSError, ValueError) as exc:
        return [f'인수 검증 계획을 읽을 수 없다: {exc}']


def check_plan(data, root, expected_spec=None, plan_path=None, require_verification=False):
    if not isinstance(data, dict):
        return ['계획 index 는 객체여야 한다']
    try:
        spec = inside(root, data.get('spec'))
        ids, problems = check_spec(spec.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return [f'계획의 스펙을 읽을 수 없다: {exc}']
    if expected_spec is not None and spec != expected_spec.resolve():
        problems.append('검사한 스펙과 계획의 spec 이 다르다')
    # 새 REQ 형식은 기술 설계를 필수로 연결한다. 기존 R 계획은 경로·스키마를 유지한다.
    design_value = data.get('design')
    if design_value is not None:
        try:
            design = inside(root, design_value)
            problems += check_design(design.read_text(encoding='utf-8'), ids, inline=design == spec)
        except (OSError, ValueError) as exc:
            problems.append(f'계획의 기술 설계를 읽을 수 없다: {exc}')
    elif any(rid.startswith('REQ') for rid in ids):
        problems.append('새 기능 계획에 design 경로가 필요하다. technical-design 을 먼저 완료한다')
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
    problems += check_verification_file(data, plan_path, set(assigned), required=require_verification)
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--require-verification', action='store_true', help='새 기능 계획의 인수 검증 계획을 요구한다')
    parser.add_argument('--design', type=Path, help='기술 설계 문서. 스펙의 기술 설계 절이면 스펙 경로를 준다')
    parser.add_argument('--draft', action='store_true', help='사용자 확인 줄을 요구하지 않는다(인터뷰 중 형식 검사)')
    args = parser.parse_args(argv)
    if args.require_verification and not args.plan:
        parser.error("--require-verification 은 --plan 과 함께 쓴다")
    try:
        spec = inside(Path.cwd(), str(args.spec))
        ids, problems = check_spec(spec.read_text(encoding='utf-8'), draft=args.draft and not args.plan and not args.design)
        if args.design:
            design = inside(Path.cwd(), str(args.design))
            problems += check_design(design.read_text(encoding='utf-8'), ids, inline=design == spec)
        if args.plan:
            problems += check_plan(json.loads(args.plan.read_text(encoding='utf-8')), Path.cwd(), spec, args.plan, args.require_verification)
    except (OSError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 2
    for problem in dict.fromkeys(problems):
        print(problem)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
