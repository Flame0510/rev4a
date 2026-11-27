// Offline PR delivery regression, loaded by e2e-lean.mjs. Only transport is mocked: real local Git trees,
// gates, pushes' checker briefs, base merges and path-selected merge harnesses exercise the production commands.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-filename-pr-'));
// Removed on exit, pass or fail (it holds a repository and its worktrees).
process.on('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });
const repo = path.join(base, 'p');
const transport = path.join(base, 'transport.json');
const count = path.join(base, 'count.log');
const mock = path.join(base, 'transport.mjs');
fs.mkdirSync(repo);
const write = (f, text, cwd = repo) => {
  fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
  fs.writeFileSync(path.join(cwd, f), text);
};
const g = (...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const state = id => JSON.parse(fs.readFileSync(path.join(repo, '.orchestrate/runs', id, 'state.json'), 'utf8'));
const runs = name => fs.readFileSync(count, 'utf8').split('\n').filter(l => l === name).length;
const orch = (args, code = 0) => {
  const r = spawnSync(process.execPath, ['--import', mock, ORCH, ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: base, ORCH_GATE_FOREGROUND: '1', ORCH_SESSIONS_JSON: path.join(base, 'absent-sessions.json') },
  });
  assert.equal(r.status, code, `orch ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
};

// No remote subprocess is ever launched. The publication refusal lets finish run all checks without publishing.
fs.writeFileSync(mock, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
const original = cp.spawnSync;
const file = ${JSON.stringify(transport)};
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
cp.spawnSync = (cmd, args, options) => {
  if (cmd === 'openclaw') throw Error('runtime forbidden in offline fixture');
  if (cmd === 'git' && ['fetch', 'push', 'ls-remote', 'pull', 'clone'].includes(args[0])) {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (args[0] === 'fetch') {
      const r = original('git', ['update-ref', 'refs/remotes/origin/develop', t.base], options);
      if (r.status !== 0) throw Error(r.stderr); return ok();
    }
    if (args[0] === 'ls-remote') {
      const ref = args.at(-1), sha = t.heads[ref];
      return ok(sha ? sha + '\\t' + ref + '\\n' : '');
    }
    if (args[0] === 'push') {
      const [sha, ref] = args.at(-1).split(':');
      t.heads[ref] = sha; fs.writeFileSync(file, JSON.stringify(t)); return ok();
    }
    throw Error('unexpected transport: ' + args.join(' '));
  }
  if (cmd === 'gh') {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (args[0] === 'repo') return ok(args.includes('-q') ? 'fixture/project' : '{"nameWithOwner":"fixture/project"}');
    if (args[0] === 'api') return ok('{}');
    if (args[0] === 'pr' && args[1] === 'list') return ok('[{"number":1}]');
    if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ number: 1, url: 'https://example.invalid/pull/1',
      state: 'OPEN', baseRefName: 'develop', headRefName: t.branch, headRefOid: t.heads['refs/heads/' + t.branch] }));
    if (args[0] === 'pr' && args[1] === 'merge') return { status: 1, stdout: '', stderr: 'offline fixture refuses publication' };
    throw Error('unexpected GitHub call: ' + args.join(' '));
  }
  return original(cmd, args, options);
};
syncBuiltinESMExports();
`);

g('init', '-q', '-b', 'develop'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t.invalid');
write('package.json', '{"type":"module"}');
write('backlog/config.yml', 'statuses: ["To Do", "In Progress", "In Check", "Done", "Blocked"]\ntask_prefix: "SB"\n');
write('scripts/count.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(count)}, process.argv[2] + '\\n');\n`);

for (const [i, move] of ['none', 'inert', 'active'].entries()) {
  const id = `SB-${400 + i}`;
  const names = ['docs/café é.md', 'docs/say"hello.md'];
  write(`backlog/tasks/${id.toLowerCase()} - Card.md`, `---\nid: ${id}\ntitle: Filename paths\nstatus: To Do\ndependencies: []\nmodified_files:\n${names.map(f => `  - ${f}`).join('\n')}\npriority: medium\n---\n`);
  g('add', '-A'); g('commit', '-q', '-m', 'offline filename fixture');
  fs.writeFileSync(transport, JSON.stringify({ base: g('rev-parse', 'HEAD'), heads: {}, branch: `orch/${id}` }));
  write('.orchestrate/config.json', JSON.stringify({
    confirmed: true, baseBranch: 'develop', links: [], checks: ['node scripts/count.mjs check'], tests: { rule: 'off' },
    delivery: { mode: 'pr', remote: 'origin' }, roles: { worker: 'w', checker: 'c' },
    merge: { approval: 'standing', standing: { by: 'Owner', at: 'now' }, protectedBranches: ['main'], recheck: 'if-changed', inertPaths: ['notes/**'] },
    harnesses: names.map((f, j) => ({ name: `named-${j}`, paths: [f], when: 'merge', command: `node scripts/count.mjs named-${j}` })),
  }));
  orch(['start', id, '--force']);
  for (const f of names) write(f, `# ${id}\n`, state(id).worktree);
  write(`.orchestrate/runs/${id}/inbox/worker.md`, 'done\n'); orch(['record', id, 'worker']);
  orch(['gate', id]);
  assert.match(orch(['push', id]), /pushed SB-\d+/);
  const pushed = state(id);
  for (const f of names) assert.equal(g('show', `${pushed.sha}:${f}`), `# ${id}`, 'mock push contains real filename');
  write(`.orchestrate/runs/${id}/inbox/checker-r0-a.md`, 'EXECUTED: fixture -> ok\nVERDICT: PASS\n');
  orch(['record', id, 'checker']);
  const before = runs('check');
  const beforeMerge = names.map((_, j) => runs(`named-${j}`));
  if (move !== 'none') {
    for (const f of names) write(f.replace('docs/', move === 'inert' ? 'notes/' : 'src/'), '# base moved\n');
    g('add', '-A'); g('commit', '-q', '-m', 'offline base move');
    const t = JSON.parse(fs.readFileSync(transport, 'utf8')); t.base = g('rev-parse', 'HEAD');
    fs.writeFileSync(transport, JSON.stringify(t));
  }
  assert.match(orch(['finish', id], 1), /offline fixture refuses publication.*Nothing was merged/);
  assert.equal(runs('check'), before + (move === 'active' ? 1 : 0), `${move}: correct recheck decision`);
  names.forEach((f, j) => assert.equal(runs(`named-${j}`), beforeMerge[j] + 1, `${move}: merge harness selected for ${f}`));
  assert.equal(state(id).phase, 'ready', 'publication refusal keeps the run ready');
}
console.log('filenames: offline push preserves names; PR finish selects exact-name harnesses with stationary, inert and active base moves');
