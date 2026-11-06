#!/usr/bin/env node
/** Exercise production startup/panel dispatch on a temporarily unavailable cron-repair candidate. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import * as cron from '../lib/agent-update-cron.ts';
const text=fs.readFileSync('lib/agent-update.ts','utf8');const ast=ts.createSourceFile('update.ts',text,ts.ScriptTarget.Latest,true);
const names=['resolveFailedUpdatesAtStartup','agentUpdateView','repairRetiredCronUpdate','checkFailedUpdateResolution','readCronAccountAdoption'];
const declarations=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
const code=ts.transpileModule(declarations+'\nmodule.exports={resolveFailedUpdatesAtStartup,agentUpdateView};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const owned={id:'retired',name:'skill-collection-review-main',declarationKey:'skill-collection-review:main',agentId:'main'};
const row={id:1,agent_id:'agent_fixture',status:'failed',from_version:'2026.9.9',to_version:'2026.10.10',backup_file:'archive.tar.gz',baseline_json:JSON.stringify({transcripts:{},cronJobs:[owned.name]}),verify_json:JSON.stringify({ok:false,lostEvents:[],missingCronJobs:[owned.name]}),error:'Cron jobs missing after the update: '+owned.name,resolved_at:null};
const original=JSON.stringify(row);let ready=false;let reads=0;let generic=0;let writes=0;let pending;let clock=0;
const context={module:{exports:{}},console,Date:{now:()=>clock},resolutionChecked:new Map(),resolutionChecking:new Set(),running:new Set(),...cron,
  isValidAgentId:()=>true,latestUpdate:()=>row,unresolvedFailedUpdates:()=>row.resolved_at?[]:[row],
  agentBusyReason:async()=>null,latestRecreate:()=>null,latestRestore:()=>null,laterJob:()=>null,
  inspectAgentContainer:async()=>({State:{Running:ready}}),probeGateway:async()=>ready?'ready':'down',runningVersion:async()=>'2026.10.10',
  readPreUpdateCronEvidence:async()=>{reads++;return{kind:'verified',file:'archive.tar.gz',sha256:'a'.repeat(64),jobs:[owned]};},
  verifyNow:async()=>{if(pending)await pending;return{error:null,verification:{ok:true,lostEvents:[],missingCronJobs:[],retiredCronJobs:[owned.name]}};},
  recordCronRepairAudit:(_row,audit)=>{row.cron_repair_json=JSON.stringify(audit);writes++;if(audit.status==='verified')row.resolved_at=clock;return true;},shortError:e=>e.message,
  checkUpdateResolution:async()=>{generic++;return false;},dueForRecheck:(last,now)=>last===undefined||now-last>=300000,
  ACTIVE_STATUSES_FOR_VIEW:[],offersRollback:()=>false,offersRollbackAnyway:()=>false,readUpdateBaseline:cron.readUpdateBaseline,coldBackupStatus:()=>null,
};context.exports=context.module.exports;vm.runInNewContext(code,context);
const flush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
await context.module.exports.resolveFailedUpdatesAtStartup(context.readPreUpdateCronEvidence);
assert.equal(JSON.parse(row.cron_repair_json).status,'unresolved');assert.equal(row.resolved_at,null);ready=true;clock=300001;
await context.module.exports.agentUpdateView('agent_fixture');await flush();
assert.equal(row.resolved_at,clock,'panel retry never reached retirement-aware repair');assert.equal(reads,2);assert.equal(generic,0);
assert.equal(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k])=>!['cron_repair_json','resolved_at'].includes(k)))),JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(original)).filter(([k])=>k!=='resolved_at'))));
console.log('ok   startup-unavailable retirement audit repairs on later panel check without replacing original diagnosis');
await context.module.exports.agentUpdateView('agent_fixture');await flush();assert.equal(writes,2);console.log('ok   resolved panel refresh is idempotent');
row.resolved_at=null;clock+=300001;let release;pending=new Promise(r=>{release=r;});
await context.module.exports.agentUpdateView('agent_fixture');await context.module.exports.agentUpdateView('agent_fixture');await flush();assert.equal(reads,3);release();pending=null;await flush();assert.equal(writes,3);console.log('ok   repeated panel refresh shares concurrency guard and five-minute bound');
console.log('\n3 passed');
