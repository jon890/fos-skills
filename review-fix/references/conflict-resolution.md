# Conflict 해결

`mergeable: CONFLICTING` 또는 `mergeStateStatus: DIRTY` 일 때만 읽는다.
작업 트리 정렬은 「작업 트리 정렬」 단계에서 이미 끝났다.

CONFLICTING 인 채로 fix 를 push 하면 여전히 머지 불가라 fix 효과가 사라진다.

**base 를 가져와 그 저장소의 머지 정책에 맞춰 merge 또는 rebase 한다.**
어느 쪽을 썼는지 기억해 둔다. 아래 lockfile 처리에서 갈린다.

## 사용자에게 확인받는 충돌

아래 둘은 스스로 정하지 않는다. 어느 쪽을 남겨도 상대의 의도를 지우기 때문이다.

- **같은 줄을 양쪽이 다르게 고쳤다.** 같은 시그니처를 양쪽에서 수정한 경우가 여기 해당한다.
- **한쪽이 지우고 한쪽이 고쳤다.**

나머지 충돌은 판단해서 해결한다.

## lockfile

**lockfile 은 수동으로 머지하지 않는다. 무결성이 깨진다.**
base 를 채택한 뒤 그 저장소의 패키지 매니저로 재생성한다.

| lockfile | 재생성 명령 |
|---|---|
| `pnpm-lock.yaml` | `pnpm install` |
| `package-lock.json` | `npm install` |
| `yarn.lock` | `yarn install` |

위 셋이 없으면 lockfile 을 쓰지 않는 프로젝트이므로 이 절을 건너뛴다.

```bash
git checkout --theirs <lockfile>   # merge 중에는 --theirs 가 base 다
git checkout --ours   <lockfile>   # rebase 중에는 --ours 가 base 다
<재생성 명령>
git add <lockfile>
```

## 해결 확인

conflict 마커가 0건인지 확인하고, 그 저장소의 검증 명령으로 빌드를 확인한다.

```bash
git grep -nE "^(<<<<<<< |=======$|>>>>>>> )" -- . ; echo "exit=$?"   # exit 1 이면 마커 0건
```

미해결 파일 목록(`--diff-filter=U`)을 `grep` 인자로 넘기면, 해결이 끝나 목록이 비었을 때
인자 없는 재귀 grep 으로 의미가 바뀐다. 추적 파일 전체를 보는 `git grep` 이 안전하다.

`=======` 뒤에 줄 끝을 요구하고 나머지 둘 뒤에 공백을 요구하는 이유는,
마크다운의 setext 제목과 구분선이 등호를 일곱 개 넘게 쓰는 경우가 있어서다.
좁히지 않으면 마커가 0건인데도 검출된다.

## 커밋

해결 결과는 커밋 전에 사용자에게 확인받는다. 충돌 파일마다 한 줄로 요약해 보여준다.

**머지나 rebase 커밋은 fix 커밋과 별도로 둔다.** 회귀했을 때 따로 revert 할 수 있다.
base 동기화를 먼저 push 한 뒤 fix 를 진행한다.
