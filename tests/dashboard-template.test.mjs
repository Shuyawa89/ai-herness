import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProgress, agentHealth, elapsed, duration, eventsFor, planCounts } from '../skills/task-dashboard/assets/state.mjs';
import { escapeHtml } from '../skills/task-dashboard/assets/format.mjs';

test('a minimal file has no harness, model or timing requirements',()=>{
 const run=normalizeProgress({title:'作業',agents:[{id:'main',name:'担当'}]});
 assert.equal(run.agents[0].model,null);
 assert.equal(duration(elapsed(run.agents[0],Date.now())),'—');
 assert.equal(duration(elapsed(run,Date.now())),'—');
 assert.deepEqual(run.events,[]);
});
test('reported state never ages into stopped or unknown',()=>{
 const run=normalizeProgress({title:'作業',agents:[{id:'main',name:'担当',status:'running',startedAt:'2020-01-01T00:00:00Z'}]});
 assert.deepEqual(agentHealth(run.agents[0],Date.now()+1e12),agentHealth(run.agents[0],0));
 assert.equal(agentHealth(run.agents[0]).label,'実行中');
});
test('nested work, independent participants and filtered histories are data-driven',()=>{
 const run=normalizeProgress({title:'作業',phases:[{name:'独自フェーズ',items:[{name:'API',children:[{name:'仕様',status:'completed'},{name:'実装',status:'running'}]}]}],agents:[{id:'pi',name:'Pi'},{id:'codex',name:'Codex',launchMethod:'command'}],events:[{agentId:'pi',title:'Piの記録',at:1000},{agentId:'codex',title:'Codexの記録',at:2000}]});
 assert.deepEqual(planCounts(run),{total:2,completed:1});
 assert.equal(eventsFor(run,'codex')[0].title,'Codexの記録');
 assert.equal(run.agents[1].parentId,null);
});
test('completed durations freeze when reported; missing finish time stays unknown',()=>{
 const run=normalizeProgress({title:'作業',status:'completed',startedAt:1000,endedAt:4000,agents:[{id:'main',name:'担当',status:'completed',startedAt:1000}]});
 assert.equal(elapsed(run,1e10),3000);
 assert.equal(duration(elapsed(run.agents[0],1e10)),'—');
});
test('malformed or inconsistent snapshots reject instead of partially replacing valid data',()=>{
 assert.throws(()=>normalizeProgress({title:'作業',agents:'unfinished'}));
 assert.throws(()=>normalizeProgress({title:'作業',agents:[{id:'a',name:'A'},{id:'a',name:'Duplicate'}]}));
 assert.throws(()=>normalizeProgress({title:'作業',phases:[{name:'A',items:[]}],phase:3}));
 assert.throws(()=>normalizeProgress({title:'作業',startedAt:'not a date'}));
});
test('untrusted task and history text remains encoded',()=>{
 const run=normalizeProgress({title:'<img src=x onerror="alert(1)">'});
 assert.equal(escapeHtml(run.title),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('timestamps outside the Date range reject before rendering',()=>{
 assert.throws(()=>normalizeProgress({title:'作業',startedAt:1e20}));
 assert.throws(()=>normalizeProgress({title:'作業',events:[{title:'Bad date',at:-1e20}]}));
});
