import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { watchLost } from '../scripts/lib/lost-workers.ts'
const env = { ...process.env }
test('끊긴 worker 는 한 번 알리고 일부러 종료하거나 다른 dispatch 로 재시도한 작업은 뺀다', async t => {
  t.after(() => { for(const k of Object.keys(process.env)) if(!(k in env)) delete process.env[k]; Object.assign(process.env,env) })
  const repo=tempDir('lost-workers-',t); process.env.ORCH_DIR=join(repo,'.orch'); process.env.GIT_CEILING_DIRECTORIES=repo
  const rows=[{dispatchId:'lost',taskId:'t',dispatchStatus:'failed',workerState:'terminal_missing'}, {dispatchId:'closed',taskId:'c',dispatchStatus:'failed',workerState:'terminal_missing'}, {dispatchId:'retry',taskId:'r',dispatchStatus:'failed'}, {dispatchId:'live',taskId:'r',dispatchStatus:'running'}]
  const json=(v:unknown)=>JSON.stringify({ok:true,result:v})
  const bin=fakeBin(repo,'orca',[
    {args:['worker-list'],stdout:json({workers:rows,page:{}})}, {args:['task-list'],stdout:json({tasks:[{id:'t',status:'running'},{id:'c',status:'running'}]})},
    {args:['dispatch-show','t'],stdout:json({dispatch:{id:'lost'}})}, {args:['dispatch-show','c'],stdout:json({dispatch:{id:'closed',terminationReason:'operator_close'}})},
    {args:['send'],stdout:json({message:{id:'notice'}})},
  ]);process.env.ORCA=bin.path
  await watchLost(repo,'R','main'); await watchLost(repo,'R','main')
  assert.equal(bin.calls().filter(c=>c.argv.includes('send')).length,1)
  const state=JSON.parse(readFileSync(join(repo,'.orch','state','wait-important-lost.json'),'utf8'));assert.match(state.R.lost,/^lost /);assert.match(state.R.closed,/^operator_close /)
})

test('전송 실패는 기록하지 않고 다음 틱에 다시 보내며 이벤트 예외는 재전송하지 않는다', async t => {
  t.after(() => { for(const k of Object.keys(process.env)) if(!(k in env)) delete process.env[k]; Object.assign(process.env,env) })
  const repo=tempDir('lost-retry-',t);process.env.ORCH_DIR=join(repo,'.orch');process.env.GIT_CEILING_DIRECTORIES=repo
  const json=(result:unknown)=>JSON.stringify({ok:true,result})
  const common=[{args:['worker-list'],stdout:json({workers:[{dispatchId:'d',taskId:'t',dispatchStatus:'failed'}],page:{}})}, {args:['task-list'],stdout:json({tasks:[{id:'t',status:'running'}]})}, {args:['dispatch-show'],stdout:json({dispatch:{id:'d'}})}]
  const bin=fakeBin(repo,'orca',[...common,{args:['send'],code:1,stderr:'offline'}]);process.env.ORCA=bin.path
  await assert.rejects(watchLost(repo,'R','main'),/NOTICE-FAIL/)
  bin.setRules([...common,{args:['send'],stdout:json({message:{id:'notice'}})}])
  mkdirSync(join(repo,'.orch'),{recursive:true});writeFileSync(join(repo,'.orch','config.json'),'{')
  await watchLost(repo,'R','main');await watchLost(repo,'R','main')
  assert.equal(bin.calls().filter(c=>c.argv.includes('send')).length,2)
})
