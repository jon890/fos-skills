// pylike.ts 가 옛 Python 표준 라이브러리(shlex, fnmatch, pathlib, posixpath, urllib.parse)와 같은 결과를 내는지 본다.
// 기대값은 Python 3.14 로 같은 입력을 돌려 얻은 값이다. 내부 함수 테스트라 구현과 함께 옮겼다.

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parseCli, UsageError } from '../scripts/cli.ts'
import {
  fnmatchcase,
  globRel,
  isAbsolutePath,
  pathName,
  pathParent,
  pathParts,
  pathStem,
  pathSuffix,
  posixJoin,
  posixNormpath,
  pyPath,
  pyRepr,
  shlexSplit,
  unquote,
  urlsplitPath,
} from '../scripts/pylike.ts'
import { tempDir } from './helpers.ts'

const SHLEX: [string, string[] | null][] = [["pytest tests/test_app.py", ["pytest", "tests/test_app.py"]], ["echo 'a b' \"c d\" e\\ f", ["echo", "a b", "c d", "e f"]], ["a && b || c; d | e", ["a", "&&", "b", "||", "c", ";", "d", "|", "e"]], ["(cd web && npm test)", ["(", "cd", "web", "&&", "npm", "test", ")"]], ["grep x src # 기존 설정", ["grep", "x", "src"]], ["pytest # 전체", ["pytest"]], ["a#b c", ["a"]], ["echo ''", ["echo", ""]], ["echo \"\"", ["echo", ""]], ["echo \"a\\\"b\" 'c\\d'", ["echo", "a\"b", "c\\d"]], ["echo \"a\\nb\"", ["echo", "a\\nb"]], ["A=1 B=2 cmd arg", ["A=1", "B=2", "cmd", "arg"]], ["env FLAG=1 /usr/bin/ssh dev", ["env", "FLAG=1", "/usr/bin/ssh", "dev"]], ["x;;y", ["x", ";;", "y"]], ["x&&&y", ["x", "&&&", "y"]], ["a |& b", ["a", "|&", "b"]], ["'unclosed", null], ["trail\\", null], ["echo ${HOME}/x", ["echo", "${HOME}/x"]], ["! git grep \"legacyKey\" -- src", ["!", "git", "grep", "legacyKey", "--", "src"]], ["cmd --opt='a b'c", ["cmd", "--opt=a bc"]], ["cmd 'a'\"b\"c", ["cmd", "abc"]], ["  lead   trail  ", ["lead", "trail"]], ["", []], ["# only comment", []], ["a;#c", ["a", ";"]], ["echo $(date)", ["echo", "$", "(", "date", ")"]], ["a>b", ["a>b"]], ["echo \"한글 공백\" '둘'", ["echo", "한글 공백", "둘"]], ["x \\ y", ["x", " y"]], ["a\\\\b", ["a\\b"]], ["'a\\'b'", null], ["\"a'b\"", ["a'b"]], ["echo a\tb", ["echo", "a", "b"]], ["cmd;", ["cmd", ";"]], [";cmd", [";", "cmd"]], ["((x))", ["((", "x", "))"]]]

test('shlexSplit 은 shlex(posix, 구두점 분리, whitespace_split)와 같게 나눈다', () => {
  for (const [input, expected] of SHLEX) {
    let got: string[] | null
    try {
      got = shlexSplit(input)
    } catch {
      got = null
    }
    assert.deepEqual(got, expected, JSON.stringify(input))
  }
})

const FNMATCH: [string, string, boolean][] = [["src/a.py", "src/*.py", true], ["src/n/a.py", "src/*.py", true], ["a", "[a-c]", true], ["d", "[!a-c]", true], ["[", "[[]", true], ["id", "[[]id]", false], ["[id]", "[[]id]", true], ["a.py", "?.py", true], ["ab.py", "?.py", false], ["x", "[]", false], ["]", "[]]", true], ["a", "[a", false], ["A", "a", false], ["a/b", "*", true], ["a\nb", "a*b", true], ["file1.py", "file[0-9].py", true], ["^", "[^a]", true], ["b", "[^a]", false], ["a-", "[a\\-]", false], ["é", "[à-ü]", true], ["a.b", "a.b", true], ["axb", "a.b", false], ["(x)", "(x)", true]]

test('fnmatchcase 는 fnmatch.fnmatchcase 와 같다', () => {
  for (const [name, pattern, expected] of FNMATCH) assert.equal(fnmatchcase(name, pattern), expected, `${JSON.stringify(name)} ${JSON.stringify(pattern)}`)
})

// [입력, str(Path), name, suffix, stem, parts, str(parent), is_absolute]
const PATHS: [string, string, string, string, string, string[], string, boolean][] = [["a/b.py", "a/b.py", "b.py", ".py", "b", ["a", "b.py"], "a", false], ["./a/b", "a/b", "b", "", "b", ["a", "b"], "a", false], ["a//b/", "a/b", "b", "", "b", ["a", "b"], "a", false], ["/", "/", "", "", "", ["/"], "/", true], ["", ".", "", "", "", [], ".", false], ["a/.bashrc", "a/.bashrc", ".bashrc", "", ".bashrc", ["a", ".bashrc"], "a", false], [".bashrc", ".bashrc", ".bashrc", "", ".bashrc", [".bashrc"], ".", false], ["a.", "a.", "a.", ".", "a", ["a."], ".", false], ["a/b.tar.gz", "a/b.tar.gz", "b.tar.gz", ".gz", "b.tar", ["a", "b.tar.gz"], "a", false], ["..", "..", "..", "", "..", [".."], ".", false], ["a/../b", "a/../b", "b", "", "b", ["a", "..", "b"], "a/..", false], ["tests/", "tests", "tests", "", "tests", ["tests"], ".", false], ["./", ".", "", "", "", [], ".", false], ["x/.", "x", "x", "", "x", ["x"], ".", false], ["/abs/p.md", "/abs/p.md", "p.md", ".md", "p", ["/", "abs", "p.md"], "/abs", true], ["a/b/c.d/e", "a/b/c.d/e", "e", "", "e", ["a", "b", "c.d", "e"], "a/b/c.d", false]]

test('pathlib 의 문자열, name, suffix, stem, parts, parent', () => {
  for (const [input, str, name, suffix, stem, parts, parent, absolute] of PATHS) {
    const label = JSON.stringify(input)
    assert.equal(pyPath(input), str, label)
    assert.equal(pathName(input), name, label)
    assert.equal(pathSuffix(input), suffix, label)
    assert.equal(pathStem(input), stem, label)
    assert.deepEqual(pathParts(input), parts, label)
    assert.equal(pathParent(input), parent, label)
    assert.equal(isAbsolutePath(input), absolute, label)
  }
})

const NORMPATH: [string, string][] = [["a/b/../c", "a/c"], ["a/./b", "a/b"], ["", "."], ["/", "/"], ["//a", "//a"], ["///a", "/a"], ["a/..", "."], ["../a", "../a"], ["/../a", "/a"], ["a//b/", "a/b"], ["./", "."], ["a/b/..//..", "."], ["x/../../y", "../y"]]
const JOIN: [string[], string][] = [[["", "x"], "x"], [["a", "b"], "a/b"], [["a/", "b"], "a/b"], [["a", "/b"], "/b"], [["", "/b"], "/b"], [["a/b", "../c"], "a/b/../c"], [["a", ""], "a/"]]

test('posixpath.normpath 와 join', () => {
  for (const [input, expected] of NORMPATH) assert.equal(posixNormpath(input), expected, JSON.stringify(input))
  for (const [parts, expected] of JOIN) assert.equal(posixJoin(parts[0], ...parts.slice(1)), expected, JSON.stringify(parts))
})

const REPR: [unknown, string][] = [[null, "None"], [true, "True"], [false, "False"], [3, "3"], ["abc", "'abc'"], ["it's", "\"it's\""], ["say \"x\"", "'say \"x\"'"], ["both ' and \"", "'both \\' and \"'"], ["a\nb\t\\", "'a\\nb\\t\\\\'"], ["한글", "'한글'"], ["\u0001", "'\\x01'"], [[1, "a", null], "[1, 'a', None]"], [{"k": "v", "n": [true]}, "{'k': 'v', 'n': [True]}"], ["tab", "'tab\\x7f'"]]

test('repr 은 JSON 에서 읽은 값을 Python 꼴로 쓴다', () => {
  for (const [value, expected] of REPR) assert.equal(pyRepr(value), expected, JSON.stringify(value))
})

const URLS: [string, string, string, string][] = [["https://example.com/a.md", "https", "example.com", "/a.md"], ["#anchor", "", "", ""], ["mailto:a@b.c", "mailto", "", "a@b.c"], ["/docs/x.md", "", "", "/docs/x.md"], ["../a/b.md#sec", "", "", "../a/b.md"], ["a.md?x=1#y", "", "", "a.md"], ["//host/path", "", "host", "/path"], ["C:/x", "c", "", "/x"], ["docs/adr/001%2Dx.md", "", "", "docs/adr/001%2Dx.md"], ["ftp:x", "ftp", "", "x"], ["a b.md", "", "", "a b.md"], ["1ab:c", "", "", "1ab:c"], ["./x.md", "", "", "./x.md"]]
const UNQUOTE: [string, string][] = [["a%20b", "a b"], ["%EC%97%86.md", "없.md"], ["100%", "100%"], ["%zz", "%zz"], ["%E4%BD", "�"], ["a%2fb", "a/b"], ["한글%20", "한글 "], ["%", "%"]]

test('urlsplit 의 scheme, netloc, path 와 unquote', () => {
  for (const [url, scheme, netloc, path] of URLS) assert.deepEqual(urlsplitPath(url), { scheme, netloc, path }, url)
  for (const [input, expected] of UNQUOTE) assert.equal(unquote(input), expected, input)
})

const GLOB = {"files": ["src/a.py", "src/b.py", "src/n/c.py", "src/n/m/d.txt", "src/.hid/e.py", "web/[id]/x.ts", "web/i/y.ts", "top.md", "backend/tasks/t1/index.json", "backend/src/z.kt"], "results": [["src/*.py", ["src/a.py", "src/b.py"]], ["src/**", ["src", "src/.hid", "src/.hid/e.py", "src/a.py", "src/b.py", "src/n", "src/n/c.py", "src/n/m", "src/n/m/d.txt"]], ["src/**/*.py", ["src/.hid/e.py", "src/a.py", "src/b.py", "src/n/c.py"]], ["**/*.py", ["src/.hid/e.py", "src/a.py", "src/b.py", "src/n/c.py"]], ["backend/**", ["backend", "backend/src", "backend/src/z.kt", "backend/tasks", "backend/tasks/t1", "backend/tasks/t1/index.json"]], ["backend/tasks/**", ["backend/tasks", "backend/tasks/t1", "backend/tasks/t1/index.json"]], ["src/*", ["src/.hid", "src/a.py", "src/b.py", "src/n"]], ["*", ["backend", "linkdir", "src", "top.md", "web"]], ["web/[[]id]/x.ts", ["web/[id]/x.ts"]], ["web/*/x.ts", ["web/[id]/x.ts"]], ["nope/*", []], ["src/n/m", ["src/n/m"]], ["top.md", ["top.md"]], ["src/.hid/*", ["src/.hid/e.py"]], ["src/**/", ["src", "src/.hid", "src/n", "src/n/m"]], ["linkdir/*", ["linkdir/.hid", "linkdir/a.py", "linkdir/b.py", "linkdir/n"]], ["src/a.p?", ["src/a.py"]], ["**", [".", "backend", "backend/src", "backend/src/z.kt", "backend/tasks", "backend/tasks/t1", "backend/tasks/t1/index.json", "linkdir", "src", "src/.hid", "src/.hid/e.py", "src/a.py", "src/b.py", "src/n", "src/n/c.py", "src/n/m", "src/n/m/d.txt", "top.md", "web", "web/[id]", "web/[id]/x.ts", "web/i", "web/i/y.ts"]]]} as { files: string[]; results: [string, string[]][] }

test('globRel 은 Path.glob 과 같은 경로를 낸다', () => {
  const root = tempDir('plan-glob-')
  for (const file of GLOB.files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'x')
  }
  symlinkSync(join(root, 'src'), join(root, 'linkdir'))
  for (const [pattern, expected] of GLOB.results) assert.deepEqual(globRel(root, pattern).sort(), expected, pattern)
})

test('globRel 은 빈 패턴과 절대 패턴을 거부한다', () => {
  const root = tempDir('plan-glob-')
  assert.throws(() => globRel(root, ''))
  assert.throws(() => globRel(root, '/etc/*'))
})

const SPEC = {
  options: [
    { name: 'audit', value: false },
    { name: 'staged', value: true },
    { name: 'tasks-dir', value: true },
    { name: 'skill', value: true, required: true, choices: ['spec', 'technical-design'] },
  ],
  positionals: [{ name: 'plan', nargs: '?' as const }],
}

const usage = (argv: string[]) => {
  try {
    parseCli(argv, SPEC)
    return null
  } catch (error) {
    if (error instanceof UsageError) return error.message
    throw error
  }
}

test('parseCli 는 argparse 의 옵션 해석을 따른다', () => {
  const ok = (argv: string[]) => parseCli(argv, SPEC)
  assert.deepEqual(ok(['--skill', 'spec', 'x']).positionals, { plan: 'x' })
  assert.deepEqual(ok(['x', '--skill=spec', '--aud']).options, { skill: 'spec', audit: true })
  assert.deepEqual(ok(['--skill', 'spec', '--tasks-dir', '-5']).options['tasks-dir'], '-5')
  assert.equal(ok(['--skill', 'spec', '--', '-x']).positionals.plan, '-x')
  assert.equal(ok(['--skill', 'spec', '- x']).positionals.plan, '- x')
  assert.equal(ok(['--skill', 'spec', '--skill', 'technical-design']).options.skill, 'technical-design')
  assert.equal(ok(['-h']).help, true)
  assert.equal(ok(['--he']).help, true)
  // 옵션 앞에서 비어 있던 위치 인자는 뒤 덩어리를 기다린다
  assert.equal(ok(['--audit', 'x', '--skill', 'spec']).positionals.plan, 'x')
  assert.match(usage(['--skill', 'spec', 'a', '--audit', 'b']) ?? '', /unrecognized arguments: b/)
  assert.match(usage(['--skill', 'spec', 'a', 'b']) ?? '', /unrecognized arguments: b/)
  assert.match(usage(['--skill', 'spec', '--nope']) ?? '', /unrecognized arguments: --nope/)
  assert.match(usage(['--skill', 'spec', '-x']) ?? '', /unrecognized arguments: -x/)
  assert.match(usage(['--skill']) ?? '', /expected one argument/)
  assert.match(usage(['--skill', 'spec', '--tasks-dir', '-x']) ?? '', /expected one argument/)
  assert.match(usage(['--skill', 'spec', '--audit=1']) ?? '', /ignored explicit argument '1'/)
  assert.match(usage(['x']) ?? '', /required: --skill/)
  assert.match(usage(['--skill', 'orch']) ?? '', /invalid choice/)
  assert.match(usage(['--skill', 'spec', '--s']) ?? '', /ambiguous option: --s could match --staged, --skill/)
  assert.match(usage(['-hx']) ?? '', /ignored explicit argument 'x'/)
})
