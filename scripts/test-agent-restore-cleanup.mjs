#!/usr/bin/env node
/** Production restore failure paths with a controlled Docker transport; no Docker is invoked. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
const source=fs.readFileSync('lib/agent-restore.ts','utf8');
const ast=ts.createSourceFile('restore.ts',source,ts.ScriptTarget.Latest,true);
const declarations=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&!['pinBackup','prepareRestore','startAgentRestore','agentRestoreView'].includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
const code=ts.transpileModule(declarations+'\nmodule.exports={runRestore};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let passed=0;let failed=0;
async function test(name,fn){try{await fn();passed++;console.log('ok   '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}
function fixture(opts={}){
  const row={id:7,agent_id:'agent_fixture',status:'restoring',phase:'preflight',error:null}; const events=[]; let alive=false;let agentRunning=true;let sourceDeleted=false;let stopAttempted=false;
  const container={Id:'agent-container',Image:'agent-image',Name:'/fixture',State:{Running:true}};
  const context={module:{exports:{}},console,path,randomUUID,EXTRACT_TIMEOUT_MS:1,READY_TIMEOUT_MS:1,BACKUPS_DIR:'/fixture-backups',
    RestoreRefusedError:Error,BackupInspectionError:class extends Error{},safeFailure:()=>'',
    prepareRestore:async()=>({directory:'/fixture-backups/.rev4a-restore-source-fixture',container:structuredClone(container),name:'fixture',targetVersion:'2026.10.10',inspection:{sha256:'hash'}}),
    inspectAgentContainer:async()=>opts.inspectUnknown&&stopAttempted?null:{...container,State:{Running:agentRunning}},
    updateRestoreRow:(id,patch)=>{Object.assign(row,patch);events.push(['state',structuredClone(patch)]);},
    startColdBackup:async()=>{agentRunning=false;return{file:'recovery.tar.gz'};},waitForColdBackup:async()=>({status:'succeeded',file:'recovery.tar.gz'}),isColdBackupRunning:async()=>false,
    startAndVerifyContainer:async()=>{events.push(['agent-start']);agentRunning=true;return{ok:true};},waitForGatewayReady:async()=>opts.ready!==false,reapplyWhenReady:async()=>{},
    fsp:{rm:async()=>{sourceDeleted=true;events.push(['delete-source']);}},
    runDocker:async args=>{events.push(Array.from(args));if(args[0]==='run'||(args[0]==='start'&&args.includes('--attach'))){alive=true;if(opts.timeout)throw Error('docker start timed out');alive=false;}
      if(args[0]==='stop'){if(args.at(-1)==='fixture'){stopAttempted=true;if(opts.stopFails)throw Error('stop failed');agentRunning=false;}else if(!opts.cleanupFails)alive=false;}
      if(args[0]==='rm'){if(opts.cleanupFails)throw Error('remove failed');alive=false;opts.removed=true;}
    },
    dockerRequestJson:async(_method,p)=>{events.push(['inspect-helper',p]);if(p.startsWith('/containers/json?'))return (opts.legacy||row.helper_name)&&!opts.removed?[{Id:'helper-id'}]:[];if(opts.inspectDockerUnknown)throw Error('Docker request timed out');if(!alive&&opts.removed)throw Error('Docker error 404: no container');return {Id:'helper-id',State:{Running:alive,ExitCode:opts.badExit?1:0},Mounts:[{Name:'agent-agent_fixture-data',Destination:'/target'}],Config:opts.legacy?{Cmd:['sh','-c','tar xzf /backup/source.tar.gz -C /target']}:{Labels:{'rev4a.restore.agent':opts.wrongLabels?'other':'agent_fixture','rev4a.restore.id':'7'}}};},
  };
  context.running=new Set();context.Error=Error;context.exports=context.module.exports;vm.runInNewContext(code,context);
  return{row,events,api:context.module.exports,get alive(){return alive;},get sourceDeleted(){return sourceDeleted;},get agentRunning(){return agentRunning;}};
}
await test('restore timeout removes named labelled writer before releasing claim or source',async()=>{
  const m=fixture({timeout:true});await m.api.runRestore(7,'agent_fixture','input.tar.gz');
  assert.ok(m.row.helper_name,'helper identity was not persisted');assert.match(m.row.helper_name,/agent_fixture.*7/);
  const create=m.events.find(e=>e[0]==='create');assert.ok(create);assert.ok(create.includes('--name'));assert.ok(create.includes('rev4a.restore.agent=agent_fixture'));assert.ok(create.includes('rev4a.restore.id=7'));
  assert.equal(m.alive,false);assert.equal(m.row.status,'failed');assert.equal(m.sourceDeleted,true);
  const confirm=m.events.findLastIndex(e=>e[0]==='inspect-helper');const release=m.events.findIndex(e=>e[0]==='state'&&e[1].status==='failed');assert.ok(confirm<release&&confirm>=0);
});
await test('unconfirmed helper cleanup keeps unresolved reservation and pinned source',async()=>{
  for(const opts of [{timeout:true,cleanupFails:true},{timeout:true,inspectDockerUnknown:true}]){const m=fixture(opts);await m.api.runRestore(7,'agent_fixture','input.tar.gz');assert.equal(m.row.status,'unresolved');assert.equal(m.sourceDeleted,false);assert.match(m.row.error,/reservation|reserved/);}
});
await test('restore stop failure reports still running and keeps unresolved claim',async()=>{
  const m=fixture({ready:false,stopFails:true});await m.api.runRestore(7,'agent_fixture','input.tar.gz');assert.equal(m.agentRunning,true);assert.equal(m.row.status,'unresolved');assert.match(m.row.error,/still running/);assert.doesNotMatch(m.row.error,/was left stopped|stopped volume/);
});
await test('restore stop verified stopped and unknown are accurately distinguished',async()=>{
  const stopped=fixture({ready:false});await stopped.api.runRestore(7,'agent_fixture','input.tar.gz');assert.match(stopped.row.error,/agent is stopped/);assert.equal(stopped.row.status,'failed');
  const unknown=fixture({ready:false,inspectUnknown:true});await unknown.api.runRestore(7,'agent_fixture','input.tar.gz');assert.match(unknown.row.error,/state is unknown/);assert.equal(unknown.row.status,'unresolved');
});
await test('helper identity mismatch cannot remove another container or release its claim',async()=>{
  const m=fixture({timeout:true,wrongLabels:true});await m.api.runRestore(7,'agent_fixture','input.tar.gz');assert.equal(m.row.status,'unresolved');assert.equal(m.sourceDeleted,false);assert.ok(!m.events.some(e=>e[0]==='rm'));
});
await test('unsuccessful helper exit cannot start restored data or report done',async()=>{
  const m=fixture({badExit:true});await m.api.runRestore(7,'agent_fixture','input.tar.gz');assert.equal(m.row.status,'failed');assert.ok(!m.events.some(e=>e[0]==='agent-start'));assert.match(m.row.error,/successful exit/);
});
console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
