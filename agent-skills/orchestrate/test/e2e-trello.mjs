// End to end for the Trello tracker against a local mock board (test/mock-trello.mjs): ids, the orch block, open
// lists only (an archived list has the same name), the label filter, orch card on Trello, all-or-none create, the
// loop from start to finish, and credentials only in the Authorization header. node test/e2e-trello.mjs [dir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.resolve(HERE, '..', 'scripts', 'orch.mjs');
const base = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-trello-'));
fs.rmSync(base, { recursive: true, force: true });
const REPO = path.join(base, 'p');
fs.mkdirSync(REPO, { recursive: true });
const STATE = path.join(base, 'board.json');

const block = (o) => `\n\n<!-- orch: written by the orchestrate skill, change it with orch card -->\n\`\`\`orch\n${JSON.stringify(o, null, 2)}\n\`\`\`\n`;
fs.writeFileSync(STATE, JSON.stringify({
  lists: [
    { id: 'Lprop', name: 'Proposals' }, { id: 'Lold', name: 'Backlog', closed: true }, { id: 'Lback', name: 'Backlog' },
    { id: 'Lprog', name: 'In Progress' }, { id: 'Lrev', name: 'In Review' }, { id: 'Ldone', name: 'Done' },
  ],
  labels: [
    { id: 'p1', name: 'P1-Critico' }, { id: 'p2', name: 'P2-Normale' }, { id: 'p3', name: 'P3-Minore' },
    { id: 'site', name: 'Sito' }, { id: 'plat', name: 'Piattaforma' },
  ],
  cards: [
    { id: 'c1', idShort: 1, shortLink: 'aB1', name: '[P2] Menu prices in the venue currency', idList: 'Lback', idLabels: ['p2', 'plat'], pos: 100,
      desc: `Menu prices use the venue currency formatter instead of a hard-coded euro sign.${block({ kind: 'code', owned: ['app/menu/list.tsx', 'tests/menu.test.ts'], acceptance: [{ text: 'The menu list shows prices in the venue currency.', done: false }], dependencies: [], parent: null, checks: [], external: [], noTests: null })}` },
    { id: 'c2', idShort: 2, shortLink: 'Ab1', name: '[P3] Fix the orders total', idList: 'Lback', idLabels: ['p3'], pos: 200,
      desc: 'The orders page shows the wrong total when a line is removed.' },
    { id: 'c3', idShort: 3, shortLink: 'cC3', name: '[P2] Sito — Pricing page copy', idList: 'Lback', idLabels: ['p2', 'site'], pos: 300,
      desc: `New pricing copy on the public site.${block({ kind: 'content', owned: ['site/pricing.mdx'], acceptance: [{ text: 'The pricing page shows the new plans and prices.', done: true }], dependencies: [], parent: null, checks: [], external: [], noTests: null })}` },
    { id: 'c4', idShort: 4, shortLink: 'dD4', name: 'Shipped long ago', idList: 'Ldone', idLabels: [], pos: 50, desc: 'Old.' },
  ],
  requests: [], comments: [],
}, null, 2));

const mock = spawn(process.execPath, [path.join(HERE, 'mock-trello.mjs'), STATE], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => mock.kill());
const port = await new Promise((resolve) => mock.stdout.once('data', d => resolve(String(d).trim())));
const ENV = { ...process.env, HOME: base, TRELLO_API_BASE: `http://127.0.0.1:${port}`, TRELLO_KEY: 'test-key', TRELLO_TOKEN: 'test-token' }; // secret-ok: test fixture

let n = 0;
const orch = (args, code = 0) => {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: REPO, encoding: 'utf8', env: ENV });
  assert.equal(r.status, code, `orch ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`); n++;
  return r.stdout + r.stderr;
};
const g = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (rel, t, root = REPO) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), t); };
// A checker's report path for the run's current round, as the checker brief names it.
const ckr = id => `.orchestrate/runs/${id}/inbox/checker-r${JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/runs', id, 'state.json'), 'utf8')).round}-a.md`;
const has = (t, re, label) => { assert.match(t, re, label); n++; };
const board = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const card = id => board().cards.find(c => c.id === id);
const cardOf = t => ({ title: t.title, goal: t.description, acceptance: t.acceptance.split('\n').map(l => l.replace(/^- \[[ x]\] #\d+ /, '')).filter(Boolean), owned: t.ownedFiles, kind: t.kind ?? 'code', parent: t.parent, dependencies: t.dependencies, checks: t.checks, external: t.external, noTests: t.noTests, priority: t.priority, labels: t.labels });
const json = (name, v) => { const f = path.join(base, `${name}.json`); fs.writeFileSync(f, JSON.stringify(v)); return f; };

g('init', '-q', '-b', 'develop'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t.invalid');
write('package.json', JSON.stringify({ type: 'module', scripts: { check: 'node -e 0' } }));
for (const f of ['app/menu/list.tsx', 'app/orders/page.tsx', 'site/pricing.mdx', 'docs/x.md']) write(f, '// x\n');
write('tests/menu.test.ts', '// t\n');
g('add', '-A'); g('commit', '-q', '-m', 'p');

// 1. init reads the board's open lists and proposes the statuses; the archived "Backlog" is never picked.
let o = orch(['init', '--tracker', 'trello', '--board', 'B1', '--id-prefix', 'rdz', '--models', 'w,c']);
has(o, /tracker: trello board B1 · ids RDZ-<n> · statuses todo="Backlog" inProgress="In Progress" inCheck="In Review" done="Done"/, 'statuses proposed from open lists');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, '.orchestrate/config.json'), 'utf8'));
assert.equal(cfg.tracker.dir, undefined); n++;
Object.assign(cfg, { confirmed: true, baseBranch: 'develop', links: [], checks: ['npm run check'], tests: { rule: 'warn', paths: ['tests/**', '**/*.test.*'] },
  merge: { approval: 'standing', standing: { by: 'Owner', at: 'now' }, protectedBranches: ['main'] }, roles: { worker: 'w', checker: 'c' } });
cfg.tracker.status = { todo: 'Backlog', inProgress: 'In Progress', inCheck: 'In Progress', done: 'In Review', blocked: null };
cfg.tracker.priority = { labels: { 'P1-Critico': 'high', 'P2-Normale': 'medium', 'P3-Minore': 'low' }, create: { high: 'P1-Critico', medium: 'P2-Normale', low: 'P3-Minore' }, bracket: true };
cfg.tracker.filter = { label: 'Sito', mode: 'exclude' }; // the app's repository: every card but the site's
fs.writeFileSync(path.join(REPO, '.orchestrate/config.json'), JSON.stringify(cfg, null, 2));

// 2. Reading: ids from the board number, the block, priority from the label, the site card filtered out.
o = orch(['next', '--all']);
has(o, /^RDZ-1 {2}Menu prices in the venue currency$/m, 'card with a block is eligible, bracket stripped');
has(o, /not RDZ-2: no modified_files/, 'card without a block waits');
assert.ok(!/RDZ-3|Pricing/.test(o), 'site card filtered out of the app repository'); n++;
assert.ok(!/RDZ-4/.test(o), 'cards in other lists are not todo'); n++;
has(orch(['card', 'check', 'RDZ-1']), /RDZ-1: ok/, 'block card valid');
has(orch(['card', 'check', 'rdz-1']), /RDZ-1: ok/, 'ids without case');

// 3. normalise a free-text card: the block is added, the goal kept, labels and priority kept.
const c2 = JSON.parse(orch(['card', 'normalise', 'RDZ-2']).split('\n}')[0] + '\n}');
assert.equal(c2.priority, 'low'); assert.equal(c2.goal, 'The orders page shows the wrong total when a line is removed.'); n += 2;
orch(['card', 'normalise', 'RDZ-2', '--from', json('c2', { ...c2, acceptance: ['Removing a line updates the order total immediately.'], owned: ['app/orders/page.tsx', 'tests/orders.test.ts'] })]);
has(card('c2').desc, /^The orders page shows the wrong total when a line is removed\.\n\n<!-- orch: [^\n]+-->\n```orch\n\{\n {2}"kind": "code",\n {2}"owned": \[/, 'block appended after the goal');
assert.equal(card('c2').name, '[P3] Fix the orders total'); assert.deepEqual(card('c2').idLabels, ['p3']); n += 2;
has(orch(['card', 'check', 'RDZ-2']), /RDZ-2: ok/, 'normalised card valid');

// 4. orch card new on Trello: the backlog list (the open one), the priority label and bracket, the area label.
o = orch(['card', 'new', '--from', json('new', { title: 'Orders: show the venue name', goal: 'The orders page shows the venue name at the top, from the venue settings.', acceptance: ['The venue name appears at the top of the orders page.'], owned: ['app/orders/header.tsx', 'tests/orders-header.test.ts'], priority: 'high', labels: ['Piattaforma'] })]);
has(o, /created RDZ-5: https:\/\/trello\.com\/c\//, 'created with the next board number');
const c5 = board().cards.find(c => c.idShort === 5);
assert.equal(c5.idList, 'Lback'); assert.equal(c5.name, '[P1] Orders: show the venue name'); assert.deepEqual(c5.idLabels.sort(), ['p1', 'plat']); n += 3;
o = orch(['card', 'new', '--from', json('badlabel', { title: 'Unknown label card', goal: 'A card with a label the board does not have.', acceptance: ['The label must exist on the board.'], owned: ['docs/x.md'], kind: 'content', labels: ['Nope'] })], 1);
has(o, /no label "Nope" on the board/, 'unknown label refused before any write');

// 5. split all or none: the second create fails, the first is archived, nothing reported as created.
const before = board().cards.filter(c => !c.closed).length;
o = orch(['card', 'split', 'RDZ-1', '--from', json('split', [
  { title: 'Child one', goal: 'First half of the menu currency change.', acceptance: ['The list shows the currency.'], owned: ['app/menu/a.tsx', 'tests/a.test.ts'] },
  { title: 'FAIL-CREATE child two', goal: 'Second half of the menu currency change.', acceptance: ['The detail shows the currency.'], owned: ['app/menu/b.tsx', 'tests/b.test.ts'] },
])], 1);
has(o, /creating the cards failed .*archived 1 of the 1 made before it/, 'rollback reported');
assert.equal(board().cards.filter(c => !c.closed).length, before); n++;

// 6. The loop: start → gate → checker → finish moves the card through the open lists and comments on it.
o = orch(['start', 'RDZ-1']);
assert.equal(card('c1').idList, 'Lprog'); n++;
const WT = path.resolve(REPO, '../.worktrees/orch-RDZ-1');
write('app/menu/list.tsx', '// venue currency\n', WT); write('tests/menu.test.ts', '// covers currency\n', WT);
write('.orchestrate/runs/RDZ-1/inbox/worker.md', 'done\n'); orch(['record', 'RDZ-1', 'worker']);
has(fs.readFileSync(path.join(REPO, '.orchestrate/runs/RDZ-1/prompts/worker-r0.md'), 'utf8'), /any change to `\.orchestrate\/`/, 'brief names no tracker folder');
has(orch(['gate', 'RDZ-1']), /GATE: PASS/, 'gate passes');
write(ckr('RDZ-1'), 'EXECUTED: x -> ok\nVERDICT: PASS\n'); orch(['record', 'RDZ-1', 'checker']);
o = orch(['finish', 'RDZ-1']);
has(o, /merged RDZ-1 into develop: [0-9a-f]+ · status In Review/, 'merged, status In Review');
assert.equal(card('c1').idList, 'Lrev'); n++;
const notes = board().comments.filter(c => c.card === 'c1').map(c => c.text);
assert.ok(notes.some(t => /^orch: started: branch orch\/RDZ-1/.test(t)) && notes.some(t => /^orch: merged into develop/.test(t)), 'progress comments'); n++;
has(orch(['card', 'check', 'RDZ-3'], 1), /task RDZ-3 not found/, 'a filtered-out card is not this repository\'s');

// 7. Credentials: only in the Authorization header, never in a URL; the archived list was never used.
const reqs = board().requests;
assert.ok(reqs.length > 10 && reqs.every(r => r.auth && !r.leak), 'every request authorized by header, no credential in a URL'); n++;
assert.ok(!board().cards.some(c => c.idList === 'Lold'), 'the archived Backlog list was never used'); n++;
const leaks = fs.readdirSync(path.join(REPO, '.orchestrate/runs/RDZ-1/logs')).map(f => fs.readFileSync(path.join(REPO, '.orchestrate/runs/RDZ-1/logs', f), 'utf8')).join('\n');
assert.ok(!/test-key|test-token/.test(leaks), 'no credential in the run logs'); n++;

// 8. Findings of the first checker, against the adapter directly (the mock is another process).
process.env.TRELLO_API_BASE = ENV.TRELLO_API_BASE; process.env.TRELLO_KEY = 'test-key';
const { createTracker } = await import(path.resolve(HERE, '..', 'scripts', 'trackers', 'trello.mjs'));
const tcBase = { kind: 'trello', board: 'B1', idPrefix: 'RDZ', priority: cfg.tracker.priority };
const throws = (fn, re, label) => { let msg = ''; try { fn(); } catch (e) { msg = e.message; } assert.match(msg, re, label); n++; return msg; };
// H1: a token with a line break is refused, and the token never appears in the message.
process.env.TRELLO_TOKEN = 'secret\ntok'; // secret-ok: test fixture
const m1 = throws(() => createTracker(REPO, tcBase).statuses(), /token \(TRELLO_TOKEN\) has characters a token cannot have/, 'bad token refused');
assert.ok(!/secret|tok\b/.test(m1.replace('TRELLO_TOKEN', '')), 'token not echoed'); n++;
process.env.TRELLO_TOKEN = 'test-token\n'; // a pasted trailing newline is trimmed // secret-ok: test fixture
assert.ok(createTracker(REPO, tcBase).statuses().includes('Backlog'), 'trailing newline trimmed'); n++;
process.env.TRELLO_TOKEN = 'test-token'; // secret-ok: test fixture
// M1: an invalid block is reported by check and next, not read as an empty card.
const s1 = board(); s1.cards.push({ id: 'c7', idShort: 7, shortLink: 'g7', name: '[P2] Broken block', idList: 'Lback', idLabels: ['p2'], pos: 700,
  desc: 'Goal of the broken card, long enough to count.\n\n<!-- orch: written by the orchestrate skill, change it with orch card -->\n```orch\n{ owned: [x] }\n```\n' });
// M2: a block written by a person in the middle of the text stays part of the goal.
s1.cards.push({ id: 'c8', idShort: 8, shortLink: 'h8', name: 'Mid block', idList: 'Lback', idLabels: [], pos: 800,
  desc: 'Intro.\n\n<!-- orch: a note -->\n```orch\n{"owned":["x"]}\n```\n\nMore text after it that must stay.' });
// LOW: a description saved with CRLF still has its block.
s1.cards.push({ id: 'c9', idShort: 9, shortLink: 'i9', name: 'Crlf card', idList: 'Lback', idLabels: ['zz'], pos: 900,
  desc: 'Goal written on Windows, long enough.\r\n\r\n<!-- orch: written by the orchestrate skill, change it with orch card -->\r\n```orch\r\n{"kind":"content","owned":["docs/x.md"],"acceptance":[{"text":"The doc says it.","done":true}]}\r\n```\r\n' });
s1.labels.push({ id: 'zz', name: '' }); // an unnamed color label
fs.writeFileSync(STATE, JSON.stringify(s1, null, 2));
has(orch(['card', 'check', 'RDZ-7'], 2), /ERROR RDZ-7: the orch block is not valid JSON/, 'check names the broken block');
has(orch(['next', '--all']), /not RDZ-7: the orch block is not valid JSON/, 'next names the broken block');
const tr = createTracker(REPO, tcBase);
const t8 = tr.get('RDZ-8');
assert.ok(t8.description.includes('More text after it that must stay.') && t8.ownedFiles.length === 0, 'mid-text block is goal text'); n++;
tr.update('RDZ-8', { title: 'Mid block', goal: t8.description, acceptance: ['The text after the note stays.'], owned: ['docs/x.md'], kind: 'content', parent: null, dependencies: [], checks: [], external: [], noTests: null, priority: null, labels: [] });
const t8b = tr.get('RDZ-8');
assert.ok(t8b.description.includes('More text after it that must stay.') && t8b.description.includes('<!-- orch: a note -->'), 'goal with a person-written block round-trips'); n++;
assert.deepEqual(t8b.ownedFiles, ['docs/x.md']); n++;
// N1: a note a person adds below the skill's block: the block still reads, the note joins the goal, the next write
// puts the block back at the end.
const s2 = board(); const c1 = s2.cards.find(c => c.id === 'c1'); c1.desc += '\nPS: talked with the client, also check mobile.'; fs.writeFileSync(STATE, JSON.stringify(s2, null, 2));
const fresh = () => createTracker(REPO, tcBase); // each orch command is a new process: a new read of the board
const t1 = fresh().get('RDZ-1');
assert.ok(t1.ownedFiles.length > 0 && /PS: talked with the client/.test(t1.description), 'note after the block: block read, note in the goal'); n++;
fresh().update('RDZ-1', cardOf(t1));
assert.match(card('c1').desc, /PS: talked with the client, also check mobile\.\n\n<!-- orch: [^\n]+-->\n```orch\n[\s\S]*\n```\n$/, 'block back at the end, note kept'); n++;
// N4: the highest priority label wins.
const s3 = board(); s3.cards.find(c => c.id === 'c9').idLabels = ['zz', 'p3', 'p1']; fs.writeFileSync(STATE, JSON.stringify(s3, null, 2));
assert.equal(fresh().get('RDZ-9').priority, 'high'); n++;
const s4 = board(); s4.cards.find(c => c.id === 'c9').idLabels = ['zz']; fs.writeFileSync(STATE, JSON.stringify(s4, null, 2));
// N7: half the environment is an error, not silently the file.
delete process.env.TRELLO_TOKEN;
throws(() => createTracker(REPO, tcBase).statuses(), /set both TRELLO_KEY and TRELLO_TOKEN, or neither/, 'half the env refused');
process.env.TRELLO_TOKEN = 'test-token'; // secret-ok: test fixture
const t9 = tr.get('RDZ-9');
assert.deepEqual(t9.ownedFiles, ['docs/x.md']); assert.match(t9.acceptance, /- \[x\] #1 The doc says it\./); n += 2;
// M4: no priority added to a card that had none, the unnamed label and an existing bracket kept with bracket:false.
const noBracket = createTracker(REPO, { ...tcBase, priority: { ...tcBase.priority, bracket: false } });
noBracket.update('RDZ-9', { ...cardOf(t9) });
assert.equal(card('c9').name, 'Crlf card'); assert.deepEqual(card('c9').idLabels, ['zz']); n += 2;
noBracket.update('RDZ-2', cardOf(noBracket.get('RDZ-2')));
assert.equal(card('c2').name, '[P3] Fix the orders total'); assert.deepEqual(card('c2').idLabels, ['p3']); n += 2;
// M5: in exclude mode the filter label is never given from here.
const app = createTracker(REPO, { ...tcBase, filter: { label: 'Sito', mode: 'exclude' } });
throws(() => app.create([{ ...cardOf(t9), title: 'Sneaky', labels: ['Sito'] }], 'Backlog'), /label "Sito" moves a card to the other repository/, 'exclude: create refused');
throws(() => app.update('RDZ-2', { ...cardOf(app.get('RDZ-2')), labels: ['Sito'] }), /moves a card to the other repository/, 'exclude: update refused');
// M3: an archive that fails is reported as still open.
const openBefore = board().cards.filter(c => !c.closed).length;
throws(() => tr.create([{ ...cardOf(t9), title: 'FAIL-ARCHIVE first' }, { ...cardOf(t9), title: 'FAIL-CREATE second' }], 'Backlog'),
  /archived 0 of the 1 made before it; still open, archive them by hand: RDZ-\d+/, 'incomplete rollback named');
assert.equal(board().cards.filter(c => !c.closed).length, openBefore + 1); n++;
// LOW: a non-JSON answer is an OrchError, not a crash.
throws(() => createTracker(REPO, { ...tcBase, board: 'HTML' }).statuses(), /the answer is not JSON/, 'non-JSON answer');

console.log(`e2e-trello: ${n} checks passed in ${REPO}`);
process.exit(0);
