export function pyRegExp(source: string): RegExp {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\' && i + 1 < source.length) {
      const next = source[++i]
      out += next === 'A' ? '^' : next === 'Z' ? '$' : `\\${next}`
      continue
    }
    if (source.startsWith('(?P<', i)) {
      out += '(?<'
      i += 3
      continue
    }
    const backref = /^\(\?P=([^)]+)\)/.exec(source.slice(i))
    if (backref) {
      out += `\\k<${backref[1]}>`
      i += backref[0].length - 1
      continue
    }
    out += ch
  }
  try {
    return new RegExp(out)
  } catch (e) {
    throw new Error(`정규식 ${JSON.stringify(source)} 를 읽지 못했다: ${(e as Error).message}`)
  }
}
