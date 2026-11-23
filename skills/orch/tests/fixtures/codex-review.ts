export const MARKER = '<!-- codex-review-receipt:v1 -->'
export const BOT_SETTING = {
  login: 'chatgpt-codex-connector[bot]',
  receipt_marker: MARKER,
  reviewed_commit: '^\\*\\*Reviewed commit:\\*\\* `([0-9a-fA-F]{7,40})`[ \\t]*\\r?$',
}
export const BOT = { __typename: 'Bot', login: 'chatgpt-codex-connector' }
export const REVIEWED_AT = '2026-01-01T00:02:00Z'

// 실제 영수증에서 커밋과 시각을 바꾸고 본문 중 판정에 쓰는 형식을 남겼다.
export function receipt(head: string, at = REVIEWED_AT, text = "Didn't find any major issues. What shall we delve into next?") {
  return {
    author: BOT,
    createdAt: at,
    body: `${MARKER}\n\nCodex Review: ${text}\n\n**Reviewed commit:** \`${head.slice(0, 10)}\``,
  }
}
