"""백엔드 공통 계약. 새 백엔드는 이것을 상속한다."""

import shutil

class Backend:
    name = ""
    binary = ""
    #: 이 백엔드가 대응 명령을 확인한 것만 적는다. 나머지는 종료 코드 2 로 거절한다.
    supported = set()
    #: 실제로 돌려 확인했는지. 거짓이면 doctor 가 경고 표시를 붙인다.
    verified = True

    @classmethod
    def available(cls):
        return shutil.which(cls.binary) is not None

    def prepare_note(self):
        """쓰기 전에 사람이 해둬야 하는 것. 없으면 빈 문자열."""
        return ""

    def dispatch(self, cmd, args):
        raise NotImplementedError
