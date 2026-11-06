#!/usr/bin/env node
/** OC-10 evaluator regressions, using disposable files and controlled snapshot output. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';
import { redact, main, UsageError, jsonProblem, firstJson, shapeOf } from '../skills/rev4a-openclaw-upgrade/scripts/lib.mjs';
let passed = 0; let failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.message); } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-oc10-scripts-'));
function tar() {
  const body = Buffer.from('{}'); const h = Buffer.alloc(512);
  h.write('./.openclaw/openclaw.json'); h.write('0000600\0',100); h.write('0000000\0',108); h.write('0000000\0',116);
  h.write('00000000002\0',124); h.write('00000000000\0',136); h.fill(32,148,156); h.write('0',156); h.write('ustar\0',257);
  h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
  return gzipSync(Buffer.concat([h,body,Buffer.alloc(510+1024)]));
}
try {
  await test('callback UsageError failure text is redacted', async () => {
    const errors = []; const original = console.error; const exit = process.exitCode;
    const argv = process.argv;
    try {
      console.error = message => errors.push(message); process.argv = argv.slice(0, 2);
      await main('', {}, () => { throw new UsageError('command failed: {"password":"fixture-secret"}'); }); // secret-ok: synthetic fixture
      assert.equal(process.exitCode, 1); assert.equal(errors.length, 1);
      assert.ok(!errors[0].includes('fixture-secret')); assert.match(errors[0], /<redacted>/);
    } finally { console.error = original; process.exitCode = exit; process.argv = argv; }
  });
  await test('unmatched diagnostic quotes cannot hide secret keys of any value type', async () => {
    for (const value of ['fixture-secret', 987654321, { private: 'fixture-secret' }, ['fixture-secret']]) {
      for (const prefix of ['x "\n', 'x "ordinary-prefix', 'x "\n[', 'x "password=prefix\\n{', 'x "{\\"password\\":\\"prefix\\"} {']) {
        const input = prefix + JSON.stringify({ token: value, keep: 'visible' });
        const output = redact(input);
        assert.ok(!output.includes('fixture-secret') && !output.includes('987654321'), output);
        assert.ok(output.includes('visible'), output); assert.match(output, /"token":"<redacted>"/);
      }
    }
    const errors = []; const original = console.error; const exit = process.exitCode; const argv = process.argv;
    try {
      console.error = message => errors.push(message); process.argv = argv.slice(0, 2);
      await main('', {}, () => { throw new UsageError('x "\n{"token":{"private":"fixture-secret"}}'); });
      assert.equal(errors.length, 1); assert.ok(!errors[0].includes('fixture-secret')); assert.match(errors[0], /<redacted>/);
    } finally { console.error = original; process.exitCode = exit; process.argv = argv; }
  });
  await test('64 KiB malformed quoted keys and object-valued secrets stay linear', () => {
    const input = ('"x '.repeat(20000) + '"token":{"private":"fixture-secret"}').slice(0, 65536);
    const start = performance.now(); const output = redact(input);
    assert.ok(!output.includes('fixture-secret')); assert.ok(performance.now() - start < 200);
  });
  await test('redaction of 64 KiB unmatched brackets takes less than 200 ms', () => {
    const input = '['.repeat(64 * 1024); const start = performance.now();
    assert.equal(redact(input), input);
    const elapsed = performance.now() - start; assert.ok(elapsed < 200, `redaction took ${elapsed} ms`);
    console.log(`     64 KiB: ${elapsed.toFixed(1)} ms`);
  });
  for (const kind of ['partial-input','partial-symlink','partial-hardlink','output-symlink','output-hardlink']) await test('neutralize preserves input and unrelated partial: ' + kind, () => {
    const output = path.join(dir, kind+'.tar.gz'); const input = kind === 'partial-input' ? output+'.partial' : path.join(dir,kind+'-input.tar.gz');
    const bytes=tar(); fs.writeFileSync(input,bytes);
    if (kind.includes('symlink')) fs.symlinkSync(input,kind.startsWith('output')?output:output+'.partial');
    if (kind.includes('hardlink')) fs.linkSync(input,kind.startsWith('output')?output:output+'.partial');
    const r=spawnSync(process.execPath,['skills/rev4a-openclaw-upgrade/scripts/neutralize-backup.mjs','--in',input,'--out',output,'--force'],{encoding:'utf8'});
    assert.ok(fs.existsSync(input),'input was deleted'); assert.deepEqual(fs.readFileSync(input),bytes,'input was truncated');
    if (kind.startsWith('output')) assert.equal(r.status,1,'input aliases must be refused even with --force');
    else { assert.equal(r.status,0,r.stderr); if(kind!=='partial-input') assert.ok(fs.lstatSync(output+'.partial'),'pre-existing partial was deleted'); }
    assert.equal(fs.readdirSync(dir).filter(n=>n.startsWith(path.basename(output)+'.tmp-')).length,0,'owned temporary output leaked');
  });
  await test('redact recursively masks short and non-string secret JSON values',()=>{
    const result=JSON.parse(redact(JSON.stringify({password:'x',nested:[{apiKey:12},{token:{content:'private'}}],declarationKey:'keep'})));
    assert.equal(result.password,'<redacted>'); assert.equal(result.nested[0].apiKey,'<redacted>'); assert.equal(result.nested[1].token,'<redacted>'); assert.equal(result.declarationKey,'keep');
  });
  await test('round-1 field, environment, URL and key-format cases stay redacted', () => {
    const input = '{"TRELLO_API_KEY":"0123456789","declarationKey":"heartbeat:main","sessionKey":"agent:main:main"}\n'
      + 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstu\n"Authorization":"Bearer sk-or-v1-abcdefghijklmnop"\nx ghp_abcdefghijklmnopqrstuvwxyz0123\n' // secret-ok: synthetic fixtures
      + '{"botToken":"123456789:AAFakeTokenForRev4aUpgradeSeedOnly_x"}\nhttp://localhost:4500/#token=fixture-local-gateway-123456789';
    const out = redact(input);
    assert.ok(!/0123456789"|sk-abc|sk-or-v1|ghp_|AAFake|fixture-local-gateway/.test(out), out);
    assert.match(out, /"declarationKey":"heartbeat:main"/); assert.match(out, /"sessionKey":"agent:main:main"/);
    for (const value of ['x', 'ordinary-password', 'prefix"suffix-private']) {
      const result = JSON.parse(redact(JSON.stringify({ password: value })));
      assert.equal(result.password, '<redacted>');
    }
    assert.equal(JSON.parse(redact('{"pass\\u0077ord":[{"private":"hidden"}]}')).password, '<redacted>');
  });
  await test('malformed bracket prefixes and long URI-like text stay bounded', () => {
    assert.ok(!redact('['.repeat(65536) + '{"token":{"private":"hidden"}}').includes('hidden'));
    const input = 'a.'.repeat(32768); const start = performance.now();
    assert.equal(redact(input), input); assert.ok(performance.now() - start < 200);
  });
  await test('redact handles escaped JSON quotes in noisy text and nested JSON strings',()=>{
    const secret='prefix"suffix-private';
    for(const input of ['warning '+JSON.stringify({password:secret}),JSON.stringify({error:JSON.stringify({password:secret})}), 'password=x OPENAI_API_KEY=z Bearer abc']) {
      const out=redact(input); assert.ok(!out.includes('suffix-private')&&!out.includes('password=x')&&!out.includes('KEY=z')&&!out.includes('Bearer abc'),out);
    }
  });
  // Exercise the production nested item function without running snapshot's Docker preflight.
  const source=fs.readFileSync('skills/rev4a-openclaw-upgrade/scripts/snapshot.mjs','utf8');
  const ast=ts.createSourceFile('snapshot.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let item; const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='item')item=node.getText(ast);ts.forEachChild(node,visit);};visit(ast); assert.ok(item);
  for(const mode of ['stderr','stdout','jsonProblem','validate']) await test('snapshot redacts persisted and logged failures: '+mode,async()=>{
    const index={items:[]}; const written=[]; const logged=[]; const secret='fixture-private-value'; // secret-ok: synthetic offline fixture
    const payload=JSON.stringify({error:{password:secret}});
    const context={fs:{writeFileSync:(_p,s)=>written.push(s)},path,outDir:dir,redact,jsonProblem,firstJson,shapeOf,index,
      writeIndex:()=>written.push(JSON.stringify(index)),console:{log:s=>logged.push(s)},sleep:async()=>{},retryWaitS:0};
    vm.createContext(context);vm.runInContext(item+'\nthis.runItem=item;',context);
    await context.runItem('failure',async()=>mode==='stderr'?{rc:1,stdout:'',stderr:payload}:mode==='stdout'?{rc:1,stdout:payload}:mode==='jsonProblem'?{rc:0,stdout:payload}:{rc:0,stdout:'{}'},{validate:mode==='validate'?()=>payload:undefined});
    assert.ok(![...written,...logged,JSON.stringify(index)].some(s=>s.includes(secret)),'secret escaped into index or console');
  });
} finally {fs.rmSync(dir,{recursive:true,force:true});}
console.log(`\n${passed} passed, ${failed} failed`); if(failed)process.exitCode=1;
