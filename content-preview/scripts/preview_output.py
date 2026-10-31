"""미리보기 생성기가 공유하는 출력 파일 처리.

생성기가 실패했을 때 이전 미리보기가 남아 새 본문으로 오인되지 않게 한다.
호출하는 쪽이 `rm -f` 로 미리 지우지 않아도 되도록 생성기가 직접 처리한다.
"""

import os
from pathlib import Path


def clear_output(out: str) -> None:
    """시작할 때 이전 산출물을 지운다. 이후 어느 단계에서 실패해도 낡은 파일이 남지 않는다."""
    Path(out).unlink(missing_ok=True)


def write_output(out: str, text: str) -> None:
    """같은 폴더의 임시 파일에 쓴 뒤 이름을 바꿔 덮어쓴다. 쓰다 실패해도 반쪽 파일이 남지 않는다."""
    target = Path(out)
    tmp = target.with_name(f".{target.name}.tmp-{os.getpid()}")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
