// orch config show/get/set/unset. 값 검사는 이 명령과 doctor 만 검사표를 동적으로 읽어 쓴다.
// 짧은 출력도 JSON 과 CONFIG-SET/UNSET 을 그대로 낸다. 경고·거절·재시작 안내는 stderr 다.
import { resolve } from 'node:path'
import { ConfigError, REMOVED_CONFIG_KEYS, SECTIONS } from '../core/config.ts'
import { distinctPaths, getAt, parsePath, rejectedProblems, setAt, touched, unsetAt, within } from '../core/config-edit.ts'
import { isObject, jsonEqual } from '../core/json.ts'
import { readConfigFile, updateConfig } from '../lib/config.ts'
import { loopStatus } from '../lib/loop.ts'
import { requireMigrated } from '../lib/paths.ts'

const USAGE = '사용법: orch config show [<절>] | get <절.키> | set <절.키> <값> [<절.키> <값>...] [--json] | unset <경로>... [--repo <폴더>]'
const warn = (text: string) => process.stderr.write(`orch config: ${text}\n`)
class UsageError extends Error {}

function parse(args: string[]) {
  const [verb, ...rest] = args
  if (!['show', 'get', 'set', 'unset'].includes(verb)) throw new UsageError('동작은 show, get, set, unset 중 하나다')
  let repo = process.cwd(), json = false, literal = false
  const values: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]
    if (literal) values.push(word)
    else if (word === '--') literal = true
    else if (word === '--json' && verb === 'set') json = true
    else if (word === '--repo' || word.startsWith('--repo=')) {
      const value = word === '--repo' ? rest[++i] : word.slice(7)
      if (!value || value.startsWith('--')) throw new UsageError('--repo 에 폴더를 준다')
      repo = resolve(value)
    } else if (word.startsWith('--')) throw new UsageError(`모르는 옵션이다: ${word}`)
    else values.push(word)
  }
  if (verb === 'show' ? values.length > 1 : verb === 'get' ? values.length !== 1 : verb === 'set' ? values.length < 2 || values.length % 2 !== 0 : values.length < 1) throw new UsageError('동작에 맞는 인자를 준다')
  const texts = verb === 'set' ? values.filter((_, i) => i % 2 === 0) : verb === 'show' ? [] : values
  let paths: string[][]
  try {
    paths = texts.map(text => parsePath(text, verb === 'unset' ? 1 : 2))
    distinctPaths(paths)
  } catch (error) { throw new UsageError((error as Error).message) }
  return { verb, repo, json, values, paths }
}

async function main(): Promise<number> {
  try {
    const options = parse(process.argv.slice(2))
    const { verb, repo, values, paths, json } = options
    if (!requireMigrated(repo, 'orch-config')) return 2
    let schema: typeof import('../core/config-schema.ts')
    try { schema = await import('../core/config-schema.ts') } catch (error) {
      throw new ConfigError(`의존을 읽지 못했다. 플러그인을 다시 설치하거나 플러그인 폴더에서 npm ci 를 돈다: ${(error as Error).message}`)
    }
    const report = (issues: ReturnType<typeof schema.problems>) => {
      for (const problem of issues) warn(`설정 문제 ${problem.path}: ${problem.reason}`)
    }
    const removed = () => new ConfigError(`옛 설정 칸은 지우거나 바꾸지 않는다. orch doctor migrate-hooks --repo ${JSON.stringify(repo)} --apply 로 핸들러에 옮긴다`)
    if (verb === 'show' || verb === 'get') {
      const read = readConfigFile(repo)
      if (read.error) throw new ConfigError(`설정 파일을 읽지 못했다: ${read.file}: ${read.error}`)
      const raw = read.exists ? read.value : {}
      report(schema.problems(raw))
      if (verb === 'show') {
        const name = values[0]
        if (name !== undefined && !(SECTIONS as readonly string[]).includes(name)) throw new ConfigError(`모르는 절이다: ${name}. ${SECTIONS.join(', ')} 중 하나다`)
        const value = name === undefined ? raw : getAt(raw, [name])
        console.log(JSON.stringify(value === undefined ? {} : value, null, 2))
      } else {
        const names = paths[0]
        if (schema.knownPath(names) === 'unknown') throw new ConfigError(`모르는 키: ${names.join('.')}`)
        const value = getAt(raw, names)
        if (value === undefined) throw new ConfigError(`설정 파일에 없다: ${names.join('.')}`)
        console.log(JSON.stringify(value))
      }
      return 0
    }
    const inputs = verb === 'set' ? paths.map((_, i) => {
      if (!json) return values[i * 2 + 1]
      try { return JSON.parse(values[i * 2 + 1]) as unknown } catch (error) { throw new ConfigError(`값의 JSON 을 읽지 못했다: ${(error as Error).message}`) }
    }) : []
    const changes: { names: string[]; old: unknown; value: unknown; changed: boolean }[] = []
    let created = false
    let existing: ReturnType<typeof schema.problems> = []
    updateConfig(repo, (raw, exists) => {
      if (!isObject(raw)) throw new ConfigError('설정 파일의 최상위는 객체여야 한다')
      const before = schema.problems(raw)
      existing = before.filter(problem => !touched(problem, paths, schema.PAIRS))
      const next = structuredClone(raw)
      for (const [i, names] of paths.entries()) {
        const text = names.join('.')
        if (verb === 'set') {
          const known = schema.knownPath(names)
          if (known === 'removed') throw removed()
          if (known === 'unknown') throw new ConfigError(`모르는 키: ${text}`)
        } else if (before.some(problem => problem.kind === 'removed' && within(problem.path, text)) || REMOVED_CONFIG_KEYS.some(entry => within(text, `${entry.section}.${entry.key}`) && getAt(raw, [entry.section, entry.key]) !== undefined)) throw removed()
        const old = getAt(raw, names)
        if (verb === 'set') setAt(next, names, inputs[i])
        else unsetAt(next, names)
        const value = getAt(next, names)
        changes.push({ names, old, value, changed: !jsonEqual(old, value) })
      }
      if (verb === 'unset' && changes.every(change => !change.changed)) return
      const rejected = rejectedProblems(before, schema.problems(next), paths, schema.PAIRS)
      if (rejected.length > 0) {
        let hint = false
        if (verb === 'set' && !json) for (const [i, names] of paths.entries()) {
          if (!rejected.some(problem => problem.kind !== 'pair' && within(problem.path, names.slice(0, 2).join('.')))) continue
          try {
            const alternative = structuredClone(next)
            setAt(alternative, names, JSON.parse(values[i * 2 + 1]))
            const key = names[1]
            if (!schema.problems({ [names[0]]: { [key]: getAt(alternative, names.slice(0, 2)) } }).some(problem => problem.kind !== 'pair')) hint = true
          } catch { /* JSON 로 읽을 수 없는 글자는 타입 안내를 더하지 않는다. */ }
        }
        throw new ConfigError(rejected.map(problem => `${problem.path}: ${problem.reason}`).join('\n') + (hint ? '\n숫자·참거짓·목록·객체 값은 --json 을 붙인다' : ''))
      }
      created = !exists
      return next
    })
    for (const change of changes) {
      const old = change.old === undefined ? '없음' : JSON.stringify(change.old)
      console.log(verb === 'set' ? `CONFIG-SET ${change.names.join('.')} ${JSON.stringify(change.value)} (이전: ${old})` : `CONFIG-UNSET ${change.names.join('.')} (이전: ${old})`)
    }
    report(existing)
    if (created) warn('설정 파일을 새로 만듦')
    const restart = schema.RESTART_KEYS.filter(key => changes.some(change => change.changed && within(key, change.names.join('.'))))
    if (restart.length > 0) {
      const status = loopStatus(repo, Date.now())
      if (status.alive || status.recheck) {
        const condition = restart.includes('pipeline.tick_sec') ? '' : '루프를 --run 없이 띄웠다면 '
        warn(`${restart.join(', ')}: ${condition}루프를 다시 띄워야 반영된다(orch loop stop 뒤 orch loop start)`)
      }
    }
    return 0
  } catch (error) {
    if (error instanceof UsageError) { warn(error.message); process.stderr.write(`${USAGE}\n`); return 2 }
    warn((error as Error).message)
    return 1
  }
}

process.exitCode = await main()
