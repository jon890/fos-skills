#!/usr/bin/env node
// 옛 이름 진입 — 이 파일은 `korean-style-check.ts` 의 자리를 이어 주는 node shebang JS 다.
//
// 이 머신과 팀원의 훅 설정이 `~/.claude/scripts/korean-style-check.py` 링크로 이 검사기를 `--hook` 으로 부른다.
// 이름을 바꾸면 훅이 조용히 깨지므로(훅 실패는 작업을 막지 않아 눈에 띄지 않는다) 한 major 동안 같은 이름을 남긴다.
// 이 저장소의 다음 major 에서 지운다(docs/features/node-runtime/spec.md DECISION17).
//
// 일반 명령 모드의 출력과 종료 코드는 새 명령과 같다. 훅 모드는 발견이 있을 때만 출력하고,
// additionalContext 맨 앞에 새 명령을 알리는 한 줄을 붙인다. 발견이 없으면 새 명령처럼 아무것도 쓰지 않는다.
// Node 가 MIN_NODE 보다 낮으면 `.ts` 를 불러오지 않는다. 훅 모드는 발견과 상관없이 건너뛰었다는 한 줄을
// additionalContext 로 내고 0 으로 끝난다. 일반 모드는 같은 문장을 stderr 에 내고 127 로 끝난다.
//
// 링크로 불려도 실체 옆의 `.ts` 를 찾는다(fs.realpathSync(__filename)).
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// scripts/runtime-policy.json 의 min_node 와 같아야 한다(runtime-policy.ts 가 대조한다)
const MIN_NODE = [24, 0]
const TARGET = path.join(path.dirname(fs.realpathSync(__filename)), 'korean-style-check.ts')
const args = process.argv.slice(2)
const isHook = args[0] === '--hook'

function tooOld() {
  const parts = process.versions.node.split('.').map(Number)
  return parts[0] < MIN_NODE[0] || (parts[0] === MIN_NODE[0] && parts[1] < MIN_NODE[1])
}

if (tooOld()) {
  const line = 'Node ' + MIN_NODE[0] + ' 이상이 필요해 한국어 검사를 건너뛰었다'
  if (isHook) {
    // Python json.dumps(ensure_ascii=False) 와 같은 꼴이다
    const context = JSON.stringify(line)
    process.stdout.write('{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": ' + context + '}}\n')
  } else {
    process.stderr.write('korean-style-check.py: ' + line + '\n')
    process.exitCode = 127
  }
} else {
  const notice = '이 훅 경로는 다음 major 에 없어진다. 새 명령: node ' + TARGET + ' --hook'
  import(pathToFileURL(TARGET).href)
    .then((mod) => mod.main(args, { hookNotice: notice }))
    .then((code) => {
      process.exitCode = code
    })
}
