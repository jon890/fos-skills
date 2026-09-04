# Conflict 해결 절차

`mergeable: CONFLICTING` 또는 `mergeStateStatus: DIRTY` 일 때만 읽는다.
작업 트리 정렬(체크아웃)은 이 문서를 읽기 전 2단계에서 이미 끝났다.

CONFLICTING 인 채로 fix 를 push 하면 여전히 머지 불가라 fix 효과가 무력화된다.

## base 가져와 머지

레포 머지 정책에 맞춰 merge 또는 rebase 한다.

```bash
BASE=$(gh pr view <N> --json baseRefName --jq '.baseRefName')
git fetch origin "$BASE"
git merge "origin/$BASE" --no-commit --no-ff   # rebase 정책이면 git rebase origin/$BASE
git status --short | grep "^UU"
```

## 충돌 분류와 처리 (언어 무관)


| 카테고리                            | 예시                            | 처리                                  |
| ------------------------------- | ----------------------------- | ----------------------------------- |
| **양쪽 추가** (서로 다른 항목)            | 서로 다른 파일/섹션 추가                | ✅ 둘 다 보존                            |
| **수치/카운트 갱신**                   | 인덱스 카운트가 다른 PR 머지로 증가         | ✅ 더 큰 수치와 본 PR 의미 합성                |
| **lockfile 충돌**                 | 아래 "lockfile 처리"              | ✅ main 채택 후 재생성                     |
| **same-line different-content** | 같은 시그니처 양쪽 수정                 | ⚠️ 사용자 confirm 필수                   |
| **delete vs modify**            | 한쪽 제거, 한쪽 수정                  | 🛑 사용자 confirm 필수                   |
| **import 누락**                   | 한쪽이 import 제거하고 다른 쪽이 그 모듈 사용 | ⚠️ import 재추가 — silent NameError 회피 |


## lockfile 처리

lockfile 은 수동 머지하지 않는다. 무결성이 깨진다.
main 을 채택한 뒤 그 레포 패키지 매니저로 재생성한다.
패키지 매니저는 lockfile 종류로 감지한다.

- `pnpm-lock.yaml` → `pnpm install`
- `package-lock.json` → `npm install`
- `yarn.lock` → `yarn install`
- 위 lockfile 이 없으면 (예: Gradle·Maven 등 lockfile 미사용 프로젝트) 이 단계는 스킵한다.

```bash
git checkout --theirs <lockfile>  # merge 중 --theirs 가 base 다. rebase 중에는 --ours 가 base 다
<감지된 install 명령>            # lock 재생성
git add <lockfile>
```

## 해결 확인

conflict 마커가 0건인지 확인하고, 레포 CLAUDE.md 의 검증 명령으로 빌드를 확인한다.

```bash
git grep -nE "^(<<<<<<< |=======$|>>>>>>> )" -- . ; echo "exit=$?"   # exit 1 이면 마커 0건 = OK
```

미해결 파일 목록(`--diff-filter=U`)을 `grep` 인자로 넘기면, 해결이 끝나 목록이 비었을 때
인자 없는 재귀 grep 으로 의미가 바뀐다. 추적 파일 전체를 보는 `git grep` 이 안전하다.

`=======` 뒤에 줄 끝을 요구하고 나머지 둘 뒤에 공백을 요구하는 이유는,
마크다운의 setext 제목과 구분선이 등호를 일곱 개 넘게 쓰는 경우가 있어서다.
좁히지 않으면 마커가 0건인데도 검출된다.

## 커밋

conflict 해결 결과는 commit 전에 `AskUserQuestion` 으로 confirm 한다 (충돌 파일별 1줄 요약 노출).

**머지·rebase commit 은 review fix commit 과 별도로 둔다.** 회귀했을 때 따로 revert 할 수 있다.
base 동기화를 먼저 push 한 후 fix 를 진행한다.