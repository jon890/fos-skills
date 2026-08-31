#!/usr/bin/env bash
# 스킬 기계 채점 — 판단 없이 셀 수 있는 축만 산출한다.
# 사용법: evaluation/score.sh            (전체)
#         evaluation/score.sh planning   (지정 스킬만)
# cwd 는 fos-skills 저장소 root.
#
# 판단이 필요한 축(Opus 5 정렬·강제력 등)은 여기서 다루지 않는다 — evaluation/rubric.md 참조.
# 주의: grep 무매치가 exit 1 이므로 set -e 를 쓰지 않는다.
set -u

SKILLS="${*:-planning build-with-teams review-fix docs-check harness-cleanup content-preview pr-review presentation}"
STYLE_CHECK="${KOREAN_STYLE_CHECK:-$HOME/.claude/scripts/korean-style-check.sh}"

printf '%-18s %6s %6s %8s %8s\n' 스킬 본문줄 참조수 끊긴참조 표기위반
printf '%s\n' "---------------------------------------------------------"

for s in $SKILLS; do
  [ -d "$s" ] || { echo "$s — 디렉터리 없음"; continue; }

  lines=$(wc -l < "$s/SKILL.md" | tr -d ' ')
  refs=$(ls "$s"/references/*.md 2>/dev/null | wc -l | tr -d ' ')

  # 끊긴 참조 — 스킬이 자기 번들 안의 파일을 가리키는데 그 파일이 없는 경우.
  #   verify-task.sh 가 잘못된 경로로 적혀 한 번도 실행되지 않았던 사고가 이 축의 근거다.
  #   타깃 레포 경로(docs/·tasks/·.claude/*-overlay.md)는 여기서 판정할 수 없으므로 제외한다.
  broken=0
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    case "$target" in
      "$HOME"/.claude/skills/*)
        [ -e "$target" ] || { echo "  끊긴 참조: $target"; broken=$((broken + 1)); }
        ;;
      *)
        [ -e "$s/$target" ] || { echo "  끊긴 참조: $s/$target"; broken=$((broken + 1)); }
        ;;
    esac
  done < <(
    grep -rhoE '`(references|scripts|templates|examples|assets)/[A-Za-z0-9._*/-]+`' "$s" 2>/dev/null |
      tr -d '`' | grep -v '\*' | sort -u
    grep -rhoE '~/\.claude/skills/[A-Za-z0-9._/-]+' "$s" 2>/dev/null |
      sed "s|^~|$HOME|" | sort -u
  )

  style=0
  if [ -x "$STYLE_CHECK" ]; then
    style=$("$STYLE_CHECK" $(find "$s" -name '*.md') 2>/dev/null | wc -l | tr -d ' ')
  fi

  printf '%-18s %6s %6s %8s %8s\n' "$s" "$lines" "$refs" "$broken" "$style"
done

printf '\n%s\n' "본문줄: SKILL.md 줄 수 (권고 500 이내)"
printf '%s\n' "끊긴참조: 번들 내부 파일을 가리키는데 실재하지 않는 참조 (0 이어야 한다)"
printf '%s\n' "표기위반: 한국어 표기 검사기 검출 수 (0 이어야 한다)"
