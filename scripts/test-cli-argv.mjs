#!/usr/bin/env node
/** FIX-133: evaluate isolated declarations with mocked processes; never run the CLI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../bin/rev4a.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('rev4a.js', source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok   ${name}`); }

test('image inspect, pull, tags and untag pass registry text as a single literal argument', () => {
  for (const pin of [null, 'r2']) {
    const registry = 'registry.example/space path/$(touch fixture);echo "$VALUE"';
    const calls = [];
    const logs = [];
    const context = vm.createContext({
      AGENT_VERSIONS: { supported: [{ version: '2026.9.9' }], localRepository: 'local/agent', registryRepository: 'unused' },
      IMAGE_REVISION: { pinnedRevision: () => pin, registryTag: () => pin ? `2026.9.9-${pin}` : '2026.9.9',
        revisionRef: () => 'local/agent:2026.9.9-r2' },
      process: { env: { REV4A_AGENT_IMAGE_REGISTRY: registry } },
      hasCmd: () => true, log: (...args) => logs.push(args),
      execFileSync: (command, args, options) => {
        calls.push({ command, args: [...args], options });
        if (args[0] === 'image') throw new Error('fixture image absent');
      },
    });
    vm.runInContext(`${declaration('ensureAgentImage')}\nensureAgentImage();`, context);
    const remote = `${registry}:2026.9.9${pin ? '-r2' : ''}`;
    const expected = [['image', 'inspect', 'local/agent:2026.9.9', '--format', '{{.Id}}'], ['pull', remote],
      ...(pin ? [['tag', remote, 'local/agent:2026.9.9-r2']] : []),
      ['tag', remote, 'local/agent:2026.9.9'], ['rmi', remote]];
    assert.deepEqual(calls.map((call) => call.args), expected);
    assert.ok(calls.every((call) => call.command === 'docker' && !call.options.shell));
    assert.equal(calls[1].options.stdio, 'inherit');
    assert.equal(calls[1].options.timeout, 1_800_000);
    assert.equal(calls.at(-1).options.stdio, 'pipe');
    assert.ok(logs.some((line) => line[1].includes('pulled and tagged')));
  }
});

test('image fallback build preserves paths as argv and an existing image skips pulling', () => {
  for (const existing of [true, false]) {
    const calls = [];
    const dockerfile = '/mock/space path/$(fixture)/Dockerfile';
    const context = vm.createContext({
      AGENT_VERSIONS: { supported: [{ version: '2026.9.9' }], localRepository: 'local/agent', registryRepository: 'registry/agent' },
      IMAGE_REVISION: { pinnedRevision: () => null, registryTag: () => '2026.9.9' },
      process: { env: {} }, hasCmd: () => true, log: () => {}, DOCKERFILE: dockerfile, join: path.join,
      existsSync: () => true, readFileSync: () => 'ARG OPENCLAW_VERSION=2026.9.9\n',
      execFileSync: (command, args, options) => {
        calls.push({ command, args: [...args], options });
        if (args[0] === 'image') { if (existing) return Buffer.from('image-id'); throw new Error('absent'); }
        if (args[0] === 'pull') throw new Error('fixture pull failed');
      },
    });
    vm.runInContext(`${declaration('ensureAgentImage')}\nensureAgentImage();`, context);
    if (existing) assert.equal(calls.length, 1);
    else assert.deepEqual(calls.at(-1).args, ['build', '--build-arg', 'OPENCLAW_VERSION=2026.9.9',
      '-t', 'local/agent:2026.9.9', '-f', dockerfile, path.dirname(dockerfile)]);
  }
});

test('git updates run sequential argv commands in the literal checkout path with one deadline', () => {
  const checkout = '/mock/repo with spaces;$(touch fixture)';
  const calls = [];
  let now = 0;
  const context = vm.createContext({ Date: { now: () => now },
    execFileSync: (command, args, options) => { calls.push({ command, args: [...args], options }); now += 1000; },
  });
  vm.runInContext(declaration('updateGitCheckout'), context);
  context.updateGitCheckout(checkout);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]),
    [['git', ['pull']], ['npm', ['install']], ['npm', ['run', 'build']]]);
  calls.forEach(({ options }, index) => {
    assert.equal(options.cwd, checkout);
    assert.equal(options.stdio, 'inherit');
    assert.equal(options.timeout, 1_800_000 - index * 1000);
    assert.ok(!options.shell);
  });
  // Check that the real update branch invokes the tested declaration.
  assert.match(source, /updateGitCheckout\(root\);/);
  assert.doesNotMatch(source, /execSync\(`cd /);
  assert.match(source, /execFileSync\('npm', \['install', '-g',/);
});

test('a failed git update stops before install/build, and a spent deadline stops before the next command', () => {
  for (const failure of ['command', 'timeout']) {
    let calls = 0;
    let now = 0;
    const context = vm.createContext({ Date: { now: () => now }, execFileSync: () => {
      calls++;
      if (failure === 'command') throw new Error('fixture git failure');
      now = 1_800_000;
    } });
    vm.runInContext(declaration('updateGitCheckout'), context);
    assert.throws(() => context.updateGitCheckout('/mock'), failure === 'command' ? /fixture git failure/ : /timed out/);
    assert.equal(calls, 1);
  }
});

console.log(`\n${passed} CLI argv checks passed`);
