import type { StageKind } from './milestones.ts'

export type Evidence =
  | { kind: 'spec' | 'plan'; path: string; text: string }
  | { kind: 'event'; pr: string; event: StageKind; text: string }

const EVIDENCE = /\((스펙\s*:\s*([^()]+)|계획\s*:\s*([^()]+)|앞 사건\s*:\s*#?([1-9]\d*)\s+(pr|merge|deploy|release))\)/g

function evidence(match: RegExpExecArray): Evidence | null {
  if (match[4]) return { kind: 'event', pr: match[4], event: match[5] as StageKind, text: match[1] }
  const path = (match[2] ?? match[3]).trim()
  return path ? { kind: match[2] !== undefined ? 'spec' : 'plan', path, text: match[1] } : null
}

export function parseEvidence(body: string): Evidence[] {
  return [...body.matchAll(EVIDENCE)].flatMap(match => {
    const got = evidence(match)
    return got ? [got] : []
  })
}

export function withoutEvidence(text: string): string {
  return text.replace(EVIDENCE, (...args) => evidence(args as unknown as RegExpExecArray) ? '' : args[0])
}
