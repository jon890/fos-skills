"""진단과 설치. 브라우저를 조작하지 않는 명령이다."""

import os
import shlex
import shutil
from pathlib import Path

from .backends import BACKENDS, EGO_INSTALL_URL, resolve_backend_name
from .commands import COMMANDS
from .config import CONFIG_PATH, CONFIG_RESOLUTION
from .errors import EXIT_USAGE, UsageError

def cmd_doctor():
    print("=== 브라우저 드라이버 진단 ===")
    print("")
    print(f"설정 파일: {CONFIG_PATH}" + ("" if CONFIG_PATH.exists() else "  (없음, 자동 감지로 돈다)"))
    print(f"설정 판정: {CONFIG_RESOLUTION.reason}")

    env = os.environ.get("BROWSER_DRIVER")
    print(f"BROWSER_DRIVER: {env if env else '(비어 있음)'}")

    print("")
    print("백엔드")
    for name, cls in BACKENDS.items():
        path = shutil.which(cls.binary)
        if not path:
            print(f"  ✗ {name:<14} 설치 안 됨")
            continue
        note = cls().prepare_note()
        mark = "✓" if cls.verified else "!"
        print(f"  {mark} {name:<14} {path}")
        if note:
            # 백엔드가 줄을 나눠 오면 그대로 나눠 낸다. ego 의 프로필 해석처럼
            # 한 줄로 이으면 묻히는 판정이 있다.
            head, *rest = note.split("\n")
            print(f"      참고: {head}")
            for line in rest:
                print(f"      {line}")
        missing = sorted({c.name for c in COMMANDS} - cls.supported)
        if missing:
            print(f"      못 쓰는 명령: {', '.join(missing)}")

    print("")
    try:
        name, source = resolve_backend_name()
    except UsageError as e:
        print("판정: 쓸 수 있는 백엔드가 없다")
        print(f"  {e}")
        return EXIT_USAGE
    print(f"판정: {name} ({source})")
    if name != "ego":
        if BACKENDS["ego"].available():
            print("  권고: 로그인 세션이 필요한 자동화는 ego 가 맞다. 설치돼 있으니 driver 를 ego 로 두는 것을 권한다.")
        else:
            print(f"  권고: 로그인 세션이 필요한 자동화는 ego lite 가 맞다. {EGO_INSTALL_URL} 에서 설치하길 권한다.")
    return 0


def _backup_if_real_file(path):
    """심링크가 아닌 실제 파일이면 `.bak.{pid}` 로 옮기고 백업 경로를 돌려준다.

    사용자가 같은 이름으로 만들어 둔 스크립트를 말없이 지우지 않기 위한 보호다.
    """
    if path.is_symlink() or not path.exists():
        return None
    backup = path.with_suffix(path.suffix + f".bak.{os.getpid()}")
    path.rename(backup)
    return backup


def cmd_install(argv):
    """저장소의 이 파일을 ~/.claude/scripts/ 에 심볼릭 링크로 연결한다.

    심링크라 git pull 만으로 최신이 그대로 반영된다 (스킬 설치 방식과 동일).
    """
    dst = Path.home() / ".claude" / "scripts"
    if len(argv) >= 2 and argv[0] == "--dst":
        dst = Path(argv[1]).expanduser()

    src = Path(__file__).resolve()
    dst.mkdir(parents=True, exist_ok=True)

    print("=== 브라우저 드라이버 설치 ===")
    print("")
    for link_name in ("browser-driver",):
        link = dst / link_name
        backup = _backup_if_real_file(link)
        if backup:
            print(f"  기존 파일을 {backup} 로 백업")
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(src)
        print(f"  ✓ {link} → {src}")

    # 셸 시절에 쓰던 이름들이다. 남아 있으면 낡은 사본을 부르게 되므로 지운다.
    # 심링크만 지우고, 사용자가 같은 이름으로 만든 실제 파일은 백업해 남긴다.
    for stale_name in ("orca-browser.sh", "browser-driver.sh"):
        stale = dst / stale_name
        backup = _backup_if_real_file(stale)
        if backup:
            print(f"  기존 파일을 {backup} 로 백업")
            continue
        if stale.is_symlink() or stale.exists():
            stale.unlink()
            print(f"  ✓ 낡은 {stale} 제거")

    print("")
    print("백엔드 확인")
    try:
        name, source = resolve_backend_name()
        print(f"  ✓ {name} ({source})")
    except UsageError as e:
        print("  ✗ 쓸 수 있는 백엔드가 없다")
        print(f"    {e}")

    print("")
    print("설정을 바꾸려면 예시를 복사해 고친다.")
    # 플러그인 데이터 폴더는 설치만으로는 생기지 않아 부모가 없으면 cp 가 실패한다.
    print(f"  mkdir -p {shlex.quote(str(CONFIG_PATH.parent))}")
    print(f"  cp {shlex.quote(str(src.parent / 'browser.config.example.json'))} {shlex.quote(str(CONFIG_PATH))}")
    return 0
