import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordHistory } from '../../scripts/lib/launch-history.ts'
import type { LaunchHistory } from '../../scripts/lib/launch-history.ts'
import { routingRecords } from '../../scripts/lib/routing-log.ts'

export const PR = { number: 7, url: 'https://github.com/test/repo/pull/7', headRefName: 'feat/a', headRefOid: 'head2',
  createdAt: '2026-11-06T01:10:00Z', mergedAt: '2026-11-06T02:00:00Z', closedAt: null, state: 'MERGED' }
export const launch = (extra: Partial<LaunchHistory> = {}): LaunchHistory => ({ dispatch: 'ctx_a', task: 'task_a', terminal: 'term_a', run: 'run_a',
  worktree: '/temp/worktree', branch: 'feat/a', at: '2026-11-06T01:00:00Z', title: '작업', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium',
  effective: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, row: 'impl-explore', retry_of: null, ...extra })
export const msg = (id: string, extra: Record<string, unknown> = {}) => ({ id, run_id: 'run_a', from_handle: 'term_a', to_handle: 'run:run_a',
  dispatch_id: 'ctx_a', type: 'status', created_at: '2026-11-06T01:30:00Z', ...extra })
export function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'routing-')))
  const saved = Object.fromEntries(['GH', 'ORCA', 'ORCH_DIR', 'ORCA_USAGE_DIR', 'GIT_CEILING_DIRECTORIES', 'ROUTING_FAKE'].map(key => [key, process.env[key]]))
  const state = {
    pr: { ...PR }, siblings: [] as Record<string, unknown>[], history: [] as unknown[], inbox: {} as Record<string, unknown[]>,
    comments: [{ user: { login: 'review-bot' }, body: '| P1 | P2 | P3 | P4 | P5 |\n| --- | --- | --- | --- | --- |\n| 0 | 1 | 2 | 0 | 0 |\nPR 크기 등급: **B', created_at: '2026-11-06T01:20:00Z' }],
    reviews: [], commits: [{ sha: 'head1', commit: { committer: { date: '2026-11-06T01:10:00Z' } } }, { sha: 'head2', commit: { committer: { date: '2026-11-06T01:40:00Z' } } }],
    attempts: {} as Record<string, unknown>,
    runs: { head1: [{ id: 1, conclusion: 'failure' }], head2: [{ id: 2, conclusion: 'success' }] }, fail: '',
  }
  const file = join(dir, 'fake.json'), log = join(dir, 'calls.jsonl')
  process.env.ROUTING_FAKE = file
  process.env.ORCH_DIR = join(dir, '.orch')
  process.env.ORCA_USAGE_DIR = join(dir, 'usage')
  process.env.GIT_CEILING_DIRECTORIES = dir
  mkdirSync(process.env.ORCH_DIR)
  mkdirSync(process.env.ORCA_USAGE_DIR)
  const bin = join(dir, 'fake')
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.ROUTING_FAKE, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
const value = name => args[args.indexOf(name)+1];
const out = data => { fs.writeSync(1, JSON.stringify(data)); process.exit(0) };
if (state.fail && args.join(' ').includes(state.fail)) process.exit(1);
if (args[0] === 'pr' && args[1] === 'view') out(state.pr);
if (args[0] === 'pr' && args[1] === 'list') out(state.siblings.length ? state.siblings : [state.pr]);
if (args[0] === 'api') {
 const endpoint = args[3];
 if (endpoint.includes('/comments')) out([state.comments]);
 if (endpoint.includes('/reviews')) out([state.reviews]);
 if (endpoint.includes('/commits')) out([state.commits]);
 if (endpoint.includes('/attempts/')) out(state.attempts[endpoint.split('/').slice(-3).join('/')]);
 if (endpoint.includes('/actions/runs')) out([{workflow_runs:Object.values(state.runs).flat()}]);
}
if (args[0] === 'orchestration') {
 if (!args.includes('--full')) process.exit(5);
 const rows = (state.inbox[value('--terminal')]||[]).slice().sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 out({ok:true,result:{messages:rows.slice(0,Number(value('--limit')))}});
}
if (args[0] === 'worktree') out({ok:true,result:{worktrees:[{id:'wt_a',path:'/temp/worktree'}],truncated:false}});
process.exit(3);
`)
  chmodSync(bin, 0o755)
  process.env.GH = bin
  process.env.ORCA = bin
  const save = () => writeFileSync(file, JSON.stringify(state))
  save()
  return {
    dir, state, log, save,
    config: () => writeFileSync(join(dir, '.orch/config.json'), JSON.stringify({ routing: { review_author: 'review-bot', size_pattern: 'PR 크기 등급: \\**([A-D])' } })),
    history: (...rows: LaunchHistory[]) => rows.forEach(row => recordHistory(dir, row)),
    rows: () => routingRecords(dir),
    usage: (agent: string, sessions: unknown[]) => writeFileSync(join(dir, 'usage', `orca-${agent}-usage.json`), JSON.stringify({ schemaVersion: 7, sessions })),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]),
    close: () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } rmSync(dir, { recursive: true, force: true }) },
  }
}
