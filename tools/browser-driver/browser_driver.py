#!/usr/bin/env node
// 옛 이름 진입 — 이 파일은 `skills/browser/browser-driver/browser_driver.ts` 의 자리를 이어 주는 node shebang JS 다.
//
// 이 머신과 팀원의 설정이 `~/.claude/scripts/browser-driver` 링크로 이 경로를 부른다. 이름을 바꾸면 링크가 조용히 깨지므로
// 한 major 동안 같은 이름을 남긴다. 이 저장소의 다음 major 에서 지운다(docs/features/node-runtime/spec.md DECISION17).
// 드라이버 본체는 browser 스킬 폴더 안으로 옮겼다(같은 설계 문서 DECISION13).
//
// 명령의 stdout 과 종료 코드는 새 명령과 같다. stderr 맨 앞에 새 명령을 알리는 한 줄을 붙인다.
// Node 가 MIN_NODE 보다 낮으면 `.ts` 를 불러오지 않고 건너뛰었다는 한 줄을 stderr 에 내고 127 로 끝난다.
//
// 링크로 불려도 실체 옆의 저장소 구조를 찾는다(fs.realpathSync(__filename)).
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// scripts/runtime-policy.json 의 min_node 와 같아야 한다(runtime-policy.ts 가 대조한다)
const MIN_NODE = [24, 0]
const TARGET = path.join(path.dirname(fs.realpathSync(__filename)), '..', '..', 'skills', 'browser', 'browser-driver', 'browser_driver.ts')
const args = process.argv.slice(2)

function tooOld() {
  const parts = process.versions.node.split('.').map(Number)
  return parts[0] < MIN_NODE[0] || (parts[0] === MIN_NODE[0] && parts[1] < MIN_NODE[1])
}

if (tooOld()) {
  process.stderr.write('browser_driver.py: Node ' + MIN_NODE[0] + ' 이상이 필요해 브라우저 드라이버를 건너뛰었다\n')
  process.exitCode = 127
} else {
  const target = path.resolve(TARGET)
  process.stderr.write('이 경로는 다음 major 에 없어진다. 새 명령: node ' + target + '\n')
  import(pathToFileURL(target).href)
    .then((mod) => mod.main(args))
    .then((code) => {
      process.exitCode = code
    })
}
