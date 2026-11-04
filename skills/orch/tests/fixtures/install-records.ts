// 번들 고르기 사례 표(install-records.json)를 읽고 사례 하나를 임시 폴더로 펼친다.
// lib-install-record.spec.ts, orch-launcher.spec.ts, template-script-path.spec.ts 가 같은 표로 세 구현을 대조한다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Case = {
  name: string
  record: { scope: string; path: string }[] | null | 'broken'
  bundles: string[]
  legacy: string[]
  expect: { bundle: string } | { error: true }
}

export const CASES: Case[] = JSON.parse(readFileSync(fileURLToPath(new URL('./install-records.json', import.meta.url)), 'utf8')).cases

// 사례 하나를 root 아래 폴더로 펼친다. 설정 폴더는 root/config, 번들은 root/<이름> 이다
export function layout(root: string, c: Case): { config: string; path: (name: string) => string } {
  const path = (name: string) => join(root, name)
  for (const name of c.bundles) {
    mkdirSync(join(path(name), 'skills', 'orch', 'scripts'), { recursive: true })
    mkdirSync(join(path(name), 'skills', 'orch', 'bin'), { recursive: true })
    writeFileSync(join(path(name), 'skills', 'orch', 'bin', 'orch.ts'), '')
  }
  for (const name of c.legacy) mkdirSync(join(path(name), 'orch', 'scripts'), { recursive: true })
  const config = join(root, 'config')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  const file = join(config, 'plugins', 'installed_plugins.json')
  if (c.record === 'broken') writeFileSync(file, '{broken')
  else if (c.record !== null) {
    const entries = c.record.map((e) => ({ scope: e.scope, installPath: path(e.path) }))
    writeFileSync(file, JSON.stringify({ version: 2, plugins: { 'fos-skills@fos-skills': entries, 'other@x': [{ scope: 'user', installPath: '/no' }] } }))
  }
  return { config, path }
}
