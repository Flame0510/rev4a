#!/usr/bin/env node
/** Update startup safety and native cron-account adoption, no Docker/network or real waits. */
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cronNames, parseCronListForUpdate } from '../lib/agent-update-cron.ts';
import { gatewayCliArgv } from '../lib/gateway-cli.ts';
const module={exports:{}};const code=ts.transpileModule(fs.readFileSync('lib/agent-update-cron-account.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(code,{module,exports:module.exports,console,Date,require:()=>({})});
const adopt=module.exports.adoptCronInferenceAccount;
let passed=0;
async function test(name,fn){await fn();passed++;console.log('ok   '+name);}
function fixture({count=1,bound=false,model=null,effectiveModel='openai/gpt-6-luna',fail, native=false, cli=false}={}){
 const job={id:'job',model,effectiveModel,bound,account:bound?'openai:fixture-0':null,native};let revision=1;const calls=[];let payload={kind:'agentTurn',...(model!==null?{model}:{})};
 const records=new Map();
 const journal={get:id=>records.get(id)??null,remember:r=>{if(!records.has(r.job_id))records.set(r.job_id,{...r,finished_at:null});return records.get(r.job_id);},finish:id=>{records.get(id).finished_at=Date.now();}};
 const ports={journal,isCliRoute:async()=>cli,profiles:async()=>Array.from({length:count},(_,i)=>({id:'openai:fixture-'+i})),candidates:async()=>[structuredClone(job)],call:async(method,params)=>{
  calls.push({method,params:structuredClone(params)});if(fail?.(method,params,calls.length))throw Error('private native stderr');
  if(method==='cron.update'){assert.ok(journal.get('job'),'original model not saved before mutation');assert.equal(params.expectedConfigRevision,String(revision));const value=params.patch.payload.model;if(value===null)delete payload.model;else payload.model=value;job.model=value;job.bound=!cli;job.account=cli?null:'openai:fixture-0';revision++;}
  return{id:'job',configRevision:String(revision),payload:structuredClone(payload)};
 }};
 return{ports,job,calls,get payload(){return payload;}};
}
for(const count of [0,2])await test(count+' accounts leave jobs unchanged with guidance',async()=>{const m=fixture({count});const r=await adopt('container','2026.9.9','2026.10.10',1,m.ports);assert.equal(m.calls.length,0);assert.match(r.note,/Select the intended account/);});
await test('one account adopts through native model@profile then restores Default',async()=>{const m=fixture();const r=await adopt('container','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.associated,1);assert.equal(m.calls[1].params.patch.payload.model,'openai/gpt-6-luna@openai:fixture-0');assert.equal(m.calls[2].params.patch.payload.model,null);assert.equal(m.payload.model,undefined);assert.equal(m.job.bound,true);assert.match(r.note,/fallback inheritance/);});
await test('already associated jobs are unchanged and a second pass is idempotent',async()=>{const m=fixture();await adopt('c','2026.9.9','2026.10.10',1,m.ports);const n=m.calls.length;const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.alreadyAssociated,1);assert.equal(m.calls.length,n);const bound=fixture({bound:true});await adopt('c','2026.9.9','2026.10.10',1,bound.ports);assert.equal(bound.calls.length,0);});
for (const model of [null, '', 'openai/gpt-6-sol']) await test('CLI no-binding outcome preserves model, reports honestly and is idempotent: '+JSON.stringify(model), async()=>{
 const m=fixture({cli:true,model});const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);
 assert.equal(r.associated,0);assert.equal(r.noBindingNeeded,1);assert.equal(r.failed,0);assert.equal(m.job.bound,false);assert.equal(m.job.model,model);
 assert.match(r.note,/0 job\(s\); 1 no binding needed \(model left\/restored\)/);
 assert.equal(m.ports.journal.get('job'),null,'no journal on the CLI route');assert.equal(m.calls.filter(call=>call.method==='cron.update').length,0,'no mutation on the CLI route');
 const count=m.calls.length;const again=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(m.calls.length,count);assert.equal(again.noBindingNeeded,1);assert.equal(again.associated,0);
});
for (const model of [null, '', 'openai/gpt-6-sol']) await test('CLI route never mutates, so a rejecting transport cannot fail it: '+JSON.stringify(model), async()=>{
 const m=fixture({cli:true,model,fail:method=>method==='cron.update'});const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);
 assert.equal(r.failed,0);assert.equal(r.noBindingNeeded,1);assert.equal(m.calls.filter(call=>call.method==='cron.update').length,0);assert.equal(m.job.model,model);
});
for (const model of [null, '', 'openai/gpt-6-sol']) await test('reject-before-commit stays pending and retries selection: '+JSON.stringify(model), async()=>{
 let rejecting=true;const m=fixture({model,fail:method=>rejecting&&method==='cron.update'});
 for(let pass=0;pass<2;pass++){
  const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);
  assert.equal(r.failed,1);assert.equal(r.associated,0);assert.equal(r.noBindingNeeded,0);
  assert.equal(m.ports.journal.get('job').finished_at,null);assert.equal(m.job.model,model);
 }
 assert.equal(m.calls.filter(call=>call.method==='cron.update').length,2);
 rejecting=false;const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);
 assert.equal(r.associated,1);assert.equal(r.noBindingNeeded,0);assert.equal(m.job.model,model);
 assert.ok(m.ports.journal.get('job').finished_at);
});
await test('an unbound successful response on a binding route remains unverified', async()=>{
 const m=fixture({cli:true});m.ports.isCliRoute=async()=>false;
 const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);
 assert.equal(r.failed,1);assert.equal(r.noBindingNeeded,0);assert.equal(m.ports.journal.get('job').finished_at,null);
});
await test('route classification is required before mutation and unknown routes stay pending', async()=>{
 for (const known of [true,false]) {
  const m=fixture();let classified=false;const call=m.ports.call;
  m.ports.isCliRoute=async()=>{if(!known)throw Error('private route error');classified=true;return false;};
  m.ports.call=async(method,params)=>{if(method==='cron.update')assert.equal(classified,true);return call(method,params);};
  const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);
  assert.equal(r.failed,known?0:1);assert.equal(r.noBindingNeeded,0);
  if(!known){assert.equal(m.calls.filter(call=>call.method==='cron.update').length,0);assert.equal(m.ports.journal.get('job'),null,'an unknown route writes no journal');assert.ok(!r.note.includes('private'));}
 }
});
for (const cli of [false,true]) await test('production route script resolves native capabilities before classifying: CLI='+cli, async()=>{
 const modules={
  'agent-scope-config-fixture.mjs': 'export function resolveDefaultAgentId(cfg) { if(cfg.marker!==42)throw Error();return "worker"; }',
  'simple-completion-selection-fixture.mjs': 'export function resolveSimpleCompletionSelectionForAgent(p) { if(p.cfg.marker!==42||p.agentId!=="worker"||p.modelRef!=="openai/model@profile")throw Error();return {provider:"openai",modelId:"model",profileId:"profile"}; }',
  'model-runtime-aliases-fixture.mjs': 'export function resolveCliRuntimeExecutionProvider(p) { if(p.cfg.marker!==42||p.agentId!=="worker"||p.provider!=="openai"||p.modelId!=="model"||p.authProfileId!=="profile")throw Error();return '+(cli?'"fixture-cli"':'undefined')+'; }',
 };
 const bootstrap='const nativeRequire=require;const modules='+JSON.stringify(modules)+';require=name=>{if(name==="node:fs")return {readFileSync:()=>JSON.stringify({marker:42}),readdirSync:()=>Object.keys(modules)};if(name==="node:url")return {pathToFileURL:file=>({href:"data:text/javascript,"+encodeURIComponent(modules[file.split("/").at(-1)])})};if(name==="node:sqlite")return {DatabaseSync:class {constructor(file,opts){if(!opts.readOnly)throw Error();}prepare(){return {all:()=>[{job_json:JSON.stringify({id:"job",payload:{kind:"agentTurn"}})}]};}close(){}}};return nativeRequire(name);};';
 const r=spawnSync(process.execPath,['-e',bootstrap+'\n'+module.exports.CRON_ACCOUNT_CLI_ROUTE,'job','openai/model@profile'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout),cli);
});
await test('association is counted only after verifying the intended persisted binding',async()=>{
 const m=fixture();const read=m.ports.candidates;let reads=0;m.ports.candidates=async()=>{const jobs=await read();if(++reads===3)jobs[0].account='openai:another';return jobs;};
 const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.associated,0);assert.equal(r.noBindingNeeded,0);assert.equal(r.failed,1);assert.equal(m.ports.journal.get('job').finished_at,null);
});
await test('explicit job models are preserved after association',async()=>{const m=fixture({model:'openai/gpt-6-sol',effectiveModel:'openai/gpt-6-sol'});const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.associated,1);assert.equal(m.payload.model,'openai/gpt-6-sol');});
await test('native jobs, other providers and explicit profile pins are unchanged',async()=>{for(const opt of [{native:true},{effectiveModel:'rev4a/model'},{effectiveModel:'openai/model@chosen'}]){const m=fixture(opt);const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.skipped,1);assert.equal(m.calls.length,0);}});
await test('adoption failure never throws or leaks native output',async()=>{const m=fixture({fail:method=>method==='cron.update'});const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.failed,1);assert.ok(!r.note.includes('private native'));assert.equal(m.payload.model,undefined);});
await test('failed clear is durably pending and next pass restores with a freshly read revision',async()=>{const m=fixture({fail:(_method,_params,n)=>n===3});const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.failed,1);assert.equal(m.ports.journal.get('job').finished_at,null);const recovered=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(recovered.associated,1);assert.equal(m.payload.model,undefined);assert.equal(m.calls[3].method,'cron.get');});
await test('other version transitions do not read accounts or modify jobs',async()=>{const m=fixture();assert.equal(await adopt('c','2026.9.9','2026.10.11',1,m.ports),null);assert.equal(m.calls.length,0);});
await test('unreadable account discovery is reported best-effort',async()=>{const m=fixture();m.ports.profiles=async()=>{throw Error('private');};const r=await adopt('c','2026.9.9','2026.10.10',1,m.ports);assert.equal(r.failed,1);assert.match(r.note,/update succeeded/);});
await test('actual Update records account-adoption failure as a successful update result',async()=>{
  const source=fs.readFileSync('lib/agent-update.ts','utf8');const ast=ts.createSourceFile('update.ts',source,ts.ScriptTarget.Latest,true);
  const run=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='runUpdate');
  const compiled=ts.transpileModule(run.getText(ast)+';this.runUpdate=runUpdate;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const writes=[];let verified=false;let attempts=0;
  const context={console,cronJobIdentities:async()=>[],cronNames:()=>[],countTranscripts:async()=>({}),updateRow:(_id,v)=>writes.push(v),startColdBackup:async()=>({file:'backup'}),waitForColdBackup:async()=>({status:'succeeded'}),
    COLD_BACKUP_WAIT_TIMEOUT_MS:1,MIGRATION_READY_TIMEOUT_MS:1,DEFAULT_FINISH_TIMINGS:{},waitForGatewayReady:async()=>true,inspectAgentContainer:async()=>({State:{Running:true}}),localImageRef:v=>v,recreateAgentContainer:async()=>{},
    finishAfterRecreate:async ports=>{await ports.verify();verified=true;},verifyNow:async()=>({verification:{ok:true}}),verifyJsonForStore:()=>null,
    adoptCronInferenceAccount:async(...args)=>{assert.equal(args[3],1);assert.equal(verified,true);attempts++;throw Error('controlled failure');},pruneAgentImages:async()=>[],shortError:e=>e.message};
  vm.createContext(context);vm.runInContext(compiled,context);await context.runUpdate(1,'agent_fixture','container','2026.9.9','2026.10.10');
  assert.equal(attempts,1);assert.equal(writes.at(-1).status,'done');assert.equal(JSON.parse(writes.at(-1).cron_account_json).failed,1);
});

// Run the production update, cron reader and readiness polling together. Only Docker
// and the later migration/backup boundaries are stubbed; virtual timers use the full
// five-minute budget without making the test wait in real time.
const updateSource = fs.readFileSync('lib/agent-update.ts', 'utf8');
const updateAst = ts.createSourceFile('update.ts', updateSource, ts.ScriptTarget.Latest, true);
const updateFunctions = updateAst.statements
  .filter(n => ts.isFunctionDeclaration(n) && ['runUpdate', 'cronJobIdentities'].includes(n.name?.text))
  .map(n => n.getText(updateAst)).join('\n');
const updateCode = ts.transpileModule(updateFunctions + '\nthis.runUpdate = runUpdate;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const readinessCode = ts.transpileModule(fs.readFileSync('lib/agent-readiness.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const startupError = "The agent's Gateway did not finish starting within 5 minutes; nothing was stopped or backed up. Wait until the agent is ready and try again.";
const cronError = 'The cron job list could not be read before the update; nothing was stopped or backed up';

async function startupFixture({ startingProbes = 0, cronReplies = ['[]'], stopAtProbe, stoppedAfterReady = false } = {}) {
  let clock = 0, probes = 0, ready = false, cronReads = 0;
  const row = { status: 'pending' }, events = [], pauses = [];
  const setTimeout = (resolve, ms) => { pauses.push(ms); clock += ms; resolve(); };
  const dockerExec = async (container, argv) => {
    assert.equal(container, 'container');
    assert.match(argv[2], /\/startupz/);
    assert.equal(row.status, 'pending', 'readiness must leave the row pending');
    assert.equal(cronReads, 0, 'cron must not be read before readiness');
    probes++;
    if (stopAtProbe && probes >= stopAtProbe) throw Error('container is not running');
    ready = probes > startingProbes;
    events.push(ready ? 'ready' : 'starting');
    return ready ? '{"status":"started"}\n200' : '{"status":"starting"}\n503';
  };
  const readiness = { exports: {} };
  vm.runInNewContext(readinessCode, {
    module: readiness, exports: readiness.exports, Date: { now: () => clock }, setTimeout,
    require: name => { assert.equal(name, '@/lib/docker-exec'); return { dockerExec }; },
  });
  const context = {
    console, setTimeout, cronNames, parseCronListForUpdate, gatewayCliArgv,
    waitForGatewayReady: async (container, timeout) => {
      assert.equal(container, 'container');
      assert.equal(timeout, 300_000);
      return readiness.exports.waitForGatewayReady(container, timeout);
    },
    inspectAgentContainer: async () => ({ State: { Running: !stoppedAfterReady } }),
    dockerExecNoFail: async (container, argv) => {
      assert.equal(container, 'container');
      assert.deepEqual(Array.from(argv.slice(-4)), ['cron', 'list', '--all', '--json']);
      assert.equal(ready, true, 'cron list read before Gateway readiness');
      assert.equal(row.status, 'pending');
      events.push('cron');
      return cronReplies[cronReads++] ?? '';
    },
    countTranscripts: async () => { events.push('transcripts'); return {}; },
    updateRow: (_id, values) => Object.assign(row, values),
    startColdBackup: async () => { events.push('backup', 'stop'); return { file: 'backup' }; },
    waitForColdBackup: async () => ({ status: 'succeeded' }),
    COLD_BACKUP_WAIT_TIMEOUT_MS: 1, MIGRATION_READY_TIMEOUT_MS: 1, DEFAULT_FINISH_TIMINGS: {},
    localImageRef: v => v, recreateAgentContainer: async () => { events.push('recreate'); },
    finishAfterRecreate: async ports => { await ports.onVerifying(); await ports.verify(); },
    verifyNow: async () => ({ verification: { ok: true } }), verifyJsonForStore: () => null,
    adoptCronInferenceAccount: async () => null, pruneAgentImages: async () => [], shortError: e => e.message,
  };
  vm.createContext(context);
  vm.runInContext(updateCode, context);
  await context.runUpdate(1, 'agent_fixture', 'container', '2026.9.9', '2026.10.10');
  return { row, events, pauses, clock, probes, cronReads };
}

function assertUntouched(result, error) {
  assert.equal(result.row.status, 'failed');
  assert.equal(result.row.error, error);
  for (const event of ['backup', 'stop', 'recreate', 'transcripts']) assert.ok(!result.events.includes(event), event);
  assert.equal(result.row.backup_file, undefined);
  assert.equal(result.row.baseline_json, undefined);
}

await test('Update waits through starting probes before reading cron and completes', async () => {
  const r = await startupFixture({ startingProbes: 3 });
  assert.equal(r.row.status, 'done');
  assert.deepEqual(r.events, ['starting', 'starting', 'starting', 'ready', 'cron', 'transcripts', 'backup', 'stop', 'recreate']);
  assert.equal(r.clock, 6_000);
  assert.equal(r.cronReads, 1);
});
await test('Update startup timeout fails with guidance and no backup or stop', async () => {
  const r = await startupFixture({ startingProbes: Infinity });
  assertUntouched(r, startupError);
  assert.equal(r.cronReads, 0);
  assert.equal(r.probes, 150);
  assert.equal(r.clock, 298_000); // Shared waiter skips a sleep that would exhaust the budget.
});
await test('Update stopped during startup reaches the bounded failure without backup or stop', async () => {
  const r = await startupFixture({ startingProbes: Infinity, stopAtProbe: 2 });
  assertUntouched(r, startupError);
  assert.equal(r.cronReads, 0);
  assert.equal(r.probes, 150);
});
await test('Update rechecks container power after readiness before reading cron', async () => {
  const r = await startupFixture({ stoppedAfterReady: true });
  assertUntouched(r, startupError);
  assert.equal(r.cronReads, 0);
});
await test('Update retries an unreadable cron list once after five seconds and succeeds', async () => {
  const r = await startupFixture({ cronReplies: ['', '[{"id":"job","name":"fixture"}]'] });
  assert.equal(r.row.status, 'done');
  assert.equal(r.cronReads, 2);
  assert.deepEqual(r.pauses, [5_000]);
  assert.equal(JSON.parse(r.row.baseline_json).cronJobIdentities[0].id, 'job');
});
await test('Update unreadable cron list twice keeps the existing failure and never backs up or stops', async () => {
  const r = await startupFixture({ cronReplies: ['', ''] });
  assertUntouched(r, cronError);
  assert.equal(r.cronReads, 2);
  assert.deepEqual(r.pauses, [5_000]);
});

await test('metadata reader projects safe ownership and the internal agent primary model',async()=>{
  const native={id:'native',agentId:'worker',sessionTarget:'isolated',payload:{kind:'agentTurn'},runtimeAuthority:{private:'never export'}};
  const rows=[{id:'default',agentId:'worker',sessionTarget:'isolated',payload:{kind:'agentTurn'},inferenceBinding:{private:'never export'}},native,{id:'inherited-agent',sessionTarget:'isolated',payload:{kind:'agentTurn'}}];
  const output=[];let closed=false;
  class DatabaseSync {
    constructor(_file,options){assert.equal(options.readOnly,true);}
    prepare(sql){if(sql.includes('sqlite_master'))return{get:()=>({exists:1})};if(sql.includes('cron_job_runtime_authorities'))return{all:()=>[{job_id:'native'}]};assert.equal(sql,'SELECT job_json FROM cron_jobs');return{all:()=>rows.map(job=>({job_json:JSON.stringify(job)}))};}
    close(){closed=true;}
  }
  vm.runInNewContext(module.exports.CRON_ACCOUNT_CANDIDATES,{require:name=>name==='node:fs'?{readFileSync:()=>JSON.stringify({agents:{defaults:{model:{primary:'rev4a/default'}},list:[{id:'worker',model:{primary:'openai/gpt-6-luna',fallbacks:['openai/other']}}]}})}:{DatabaseSync},process:{stdout:{write:text=>output.push(text)}}});
  const projected=JSON.parse(output[0]);assert.equal(projected[0].effectiveModel,'openai/gpt-6-luna');assert.equal(projected[0].model,null);assert.equal(projected[0].bound,true);assert.equal(projected[1].native,true);assert.equal(projected[2].effectiveModel,'openai/gpt-6-luna');assert.ok(!output[0].includes('never export'));assert.equal(closed,true);
});
console.log(`\n${passed} passed`);
