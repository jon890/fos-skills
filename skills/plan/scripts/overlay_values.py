"""레포 설정(오버레이)의 표에서 이름 붙은 값을 읽는다.

값의 이름과 형식은 references/monorepo.md 의 「스크립트가 직접 읽는 값」 이 소유한다.
파일을 찾는 순서는 overlay_paths.py 가 정한다. 값 하나마다 그 순서로 찾고, 앞의 파일에 있으면 그것을 쓴다.
verify_task.py 와 run_doc_checks.py 가 모듈로 불러 쓴다. 단독 실행 명령은 없다.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location("overlay_paths", Path(__file__).with_name("overlay_paths.py"))
overlay_paths = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(overlay_paths)


def targets(root: Path, paths) -> list:
    """경로가 속한 하위 프로젝트 목록이다. 단일 저장소이거나 정하지 못하면 [None] 이다(루트만 본다)."""
    subs = overlay_paths.subprojects(root)
    found, _ = overlay_paths.resolve(root, root, subs, None, None, [str(p) for p in paths])
    return found or [None]


def cell(text: str, name: str) -> str | None:
    """`| <name> | <값> |` 행의 값 칸이다. 표가 어느 절에 있든 행 이름으로 찾는다."""
    m = re.search(rf"^\|\s*{re.escape(name)}\s*\|\s*(.*?)\s*\|\s*$", text, re.M)
    return m.group(1) if m else None


def lookup(root: Path, skills, name: str, sub=None):
    """(값 칸, 찾은 파일의 루트 기준 경로) 를 낸다. 없으면 (None, None) 이다.

    skills 는 앞에서부터 찾을 스킬 이름이다. 스킬마다 overlay_paths 의 탐색 순서를 따른다.
    """
    for skill in skills:
        for rel in overlay_paths.search_order(root, skill, sub):
            if rel.startswith("(없음)"):
                continue
            value = cell((root / rel).read_text(encoding="utf-8"), name)
            if value is not None and value.strip():
                return value, rel
    return None, None


def codes(value: str) -> list:
    """값 칸의 인라인 코드 조각들이다. 인라인 코드가 없으면 칸 전체를 하나로 본다."""
    found = re.findall(r"`([^`]+)`", value)
    return [c.strip() for c in found if c.strip()] or [value.strip()]


def number(root: Path, value: str) -> int:
    """정수, 또는 `<JSON 파일>#<키.키>` 가 가리키는 정수를 낸다. 읽지 못하면 ValueError 다."""
    text = codes(value)[0]
    if re.fullmatch(r"\d+", text):
        return int(text)
    rel, sep, keys = text.partition("#")
    if not sep or not keys:
        raise ValueError(f"정수나 `<JSON 파일>#<키>` 가 아니다: {text}")
    try:
        data = json.loads((root / rel).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{rel} 을 읽지 못했다: {exc}") from exc
    for key in keys.split("."):
        if not isinstance(data, dict) or key not in data:
            raise ValueError(f"{rel} 에 {keys} 가 없다")
        data = data[key]
    if isinstance(data, bool) or not isinstance(data, int):
        raise ValueError(f"{rel} 의 {keys} 가 정수가 아니다: {data!r}")
    return data
