#!/usr/bin/env node
/**
 * Tests for the detect probe parser in lib/credentials/detect.ts: what each container really
 * holds, read from every delivery method (secret store, managed GitHub identity, Vercel files,
 * the files an older release wrote). Sentinel tokens prove that values never appear in the
 * parsed result, only hashes and flags.
 *
 *   node scripts/test-credentials-detect.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// detect.ts imports '@/lib/...' (Next's alias) and extensionless relative paths; this hook gives
// plain Node the same view. Nothing is executed against Docker: only the pure parsers run.
const root = pathToFileURL(import.meta.dirname + '/../').href;
const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = ${JSON.stringify(root)};
const tryExt = (p) => { for (const e of ['.ts', '.js']) if (existsSync(p + e)) return p + e; return null; };
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const p = tryExt(new URL(specifier.slice(2), root).pathname);
    if (p) return next(pathToFileURL(p).href, context);
  } else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\\.\\w+$/.test(specifier)) {
    const p = tryExt(new URL(specifier, context.parentURL).pathname);
    if (p) return next(pathToFileURL(p).href, context);
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(import.meta.dirname + '/'));
const d = await import('../lib/credentials/detect.ts');
const { hashToken } = await import('../lib/credentials/hash.ts');

let passed = 0;
const pending = [];
function test(name, fn) {
  const r = fn();
  const done = () => { passed++; console.log(`ok   ${name}`); };
  if (r && typeof r.then === 'function') pending.push(r.then(done, (e) => { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }));
  else done();
}

const S = {
  trelloKey: 'SENTINEL_TRELLO_KEY_aaaaaaaa',
  trello: 'SENTINEL_TRELLO_TOKEN_bbbbbbbb',
  notion: 'SENTINEL_NOTION_TOKEN_cccccccc',
  supabase: 'SENTINEL_SUPABASE_TOKEN_dddddd',
  ghId: 'SENTINEL_GH_IDENTITY_eeeeeeee',
  ghOld: 'SENTINEL_GH_OLDWAY_ffffffff',
  vercel: 'SENTINEL_VERCEL_TOKEN_gggggg',
};

/** Probe output as the script prints it: key NUL value NUL, repeated. */
function raw(fields) {
  const base = {
    'cli:gh': 'yes', 'cli:vercel': 'yes', 'cli:supabase': 'yes', 'cli:trello': 'no',
    'file:vercelConfig': '', 'file:supabaseConfig': '', digests: '', 'agent:name': 'Test', 'tools:markers': '0',
    'probe:complete': 'ok', 'gh:status': '', 'vercel:whoami': '', 'supabase:projects': '', 'supabase:rc': '1',
  };
  return Object.entries({ ...base, ...fields }).map(([k, v]) => `${k}\0${v}\0`).join('');
}

const H = (t) => hashToken(t);
const everything = JSON.stringify;
const noSecrets = (value) => {
  const text = typeof value === 'string' ? value : everything(value);
  for (const [k, v] of Object.entries(S)) assert.ok(!text.includes(v), `${k} leaked`);
};

/** What DIGEST_SCRIPT prints for an agent holding everything, written by hand from the sentinels. */
const DIGESTS = [
  'store-ok',
  `store\tTRELLO_API_KEY\tenv\t${H(S.trelloKey)}`,
  `store\tTRELLO_TOKEN\tenv\t${H(S.trello)}`,
  `store\tNOTION_API_TOKEN\tenv\t${H(S.notion)}`,
  `store\tSUPABASE_ACCESS_TOKEN\tenv\t${H(S.supabase)}`,
  `store\tgithub-setup-0123456789abcdef0123456789abcdef\tsecret\t${H('SENTINEL_HANDOFF_hhhhhhhh')}`,
  'gh-profile\tghp_0d3f9e9b595ef67a116620f856905c62',
  `gh-identity\t${H(S.ghId)}\tFlame0510`,
  `vercel\t${H(S.vercel)}`,
  'digest-ok',
].join('\n');

test('the probe script is fixed text; the digest script holds no raw read of a token', () => {
  assert.ok(d.PROBE_SCRIPT.endsWith('exit 0'));
  assert.ok(!d.DIGEST_SCRIPT.includes("'"), 'sits inside a shell single-quoted argument');
  assert.ok(d.PROBE_SCRIPT.includes(d.DIGEST_SCRIPT));
  assert.ok(!/cat \/root\/\.(config\/gh|supabase|config\/trello|config\/notion)/.test(d.PROBE_SCRIPT), 'no raw token file is cat-ed');
  assert.ok(!/auth\.json 2>\/dev\/null/.test(d.PROBE_SCRIPT), 'the vercel auth.json is not cat-ed');
  assert.ok(!/secrets store list/.test(d.PROBE_SCRIPT), 'the CLI masks values: read the database instead');
});

test('DIGEST_SCRIPT, run for real against a sandbox, prints hashes only and matches hashToken', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-digest-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(box, rel)), { recursive: true }); fs.writeFileSync(path.join(box, rel), text); };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.join(box, 'root/.openclaw/state'), { recursive: true });
    const db = new DatabaseSync(path.join(box, 'root/.openclaw/state/openclaw.sqlite'));
    db.exec('CREATE TABLE secret_store_entries (scope_kind TEXT, scope_id TEXT, name TEXT, value TEXT, kind TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, updated_by TEXT, deleted_at_ms INTEGER, allowed_hosts TEXT)');
    const ins = db.prepare('INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, deleted_at_ms) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('global', '', 'TRELLO_TOKEN', S.trello, 'env', null);
    ins.run('global', '', 'SUPABASE_ACCESS_TOKEN', '  ' + S.supabase + '\n', 'env', null);
    ins.run('global', '', 'NOTION_API_TOKEN', S.notion, 'env', 123); // deleted
    ins.run('global', '', 'SHORT', 'abc', 'env', null);
    db.close();
    // A decoy first: auth profiles carry a profileId of their own.
    w('root/.openclaw/openclaw.json', JSON.stringify({ auth: { profiles: [{ profileId: 'decoy_auth_profile' }] }, agents: { entries: { main: { tools: { github: { profileId: 'ghp_abc123' } } } } } }));
    w('root/.openclaw/credentials/github/agents/' + 'a'.repeat(64) + '/ghp_old/hosts.yml', 'github.com:\n  user: Old\n  oauth_token: SENTINEL_RETIRED_PROFILE_zzzz\n');
    w('root/.openclaw/credentials/github/agents/' + 'a'.repeat(64) + '/ghp_abc123/hosts.yml', 'github.com:\n  user: Flame0510\n  oauth_token: ' + S.ghId + '\n  users:\n    Flame0510:\n      oauth_token: ' + S.ghId + '\n');
    w('root/.local/share/com.vercel.cli/auth.json', JSON.stringify({ token: S.vercel }));
    w('root/.config/gh/hosts.yml', 'github.com:\n    user: olduser\n    oauth_token: ' + S.ghOld + '\n');
    w('root/.supabase/access-token', S.supabase + '\n');
    w('root/.config/trello/config.json', JSON.stringify({ apiKey: S.trelloKey, token: S.trello }));
    // Same text as the probe, with the container root swapped for the sandbox.
    const src = d.DIGEST_SCRIPT.replaceAll('/root/', box + '/root/');
    const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    noSecrets(r.stdout);
    assert.ok(!r.stdout.includes('SENTINEL_RETIRED_PROFILE_zzzz'));
    const dg = d.parseDigests(r.stdout);
    assert.deepEqual(dg.store.filter((e) => e.hash).map((e) => e.name).sort(), ['SHORT', 'SUPABASE_ACCESS_TOKEN', 'TRELLO_TOKEN']);
    assert.equal(dg.store.find((e) => e.name === 'SHORT').hash, H('abc'), 'short non-empty values match hashToken');
    assert.ok(!dg.store.some((e) => e.name === 'NOTION_API_TOKEN'), 'a deleted entry is skipped');
    assert.equal(dg.store.find((e) => e.name === 'SUPABASE_ACCESS_TOKEN').hash, H(S.supabase), 'trimmed, same as hashToken');
    assert.equal(dg.githubProfileId, 'ghp_abc123', 'the profile id comes from agents.entries.main.tools.github only');
    assert.equal(dg.ghIdentityFound, true);
    assert.equal(dg.storeOk, true);
    assert.equal(dg.digestOk, true);
    assert.deepEqual(dg.ghIdentity, { hash: H(S.ghId), login: 'Flame0510' });
    assert.deepEqual(dg.ghLegacy, { hash: H(S.ghOld), login: 'olduser' });
    assert.equal(dg.vercel, H(S.vercel));
    assert.equal(dg.supabaseLegacy, H(S.supabase));
    assert.equal(dg.trelloLegacy, H(S.trello));
    assert.equal(dg.notionLegacy, '');
    // Nothing at all in the container: no output, no error.
    const empty = spawnSync(process.execPath, ['-e', d.DIGEST_SCRIPT.replaceAll('/root/', box + '/nowhere/')], { encoding: 'utf8' });
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(d.parseDigests(empty.stdout).store.length, 0);
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
});

/** Run the real DIGEST_SCRIPT against a sandbox laid out by `setup(w, box)`. */
async function runDigest(setup) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-digest-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(box, rel)), { recursive: true }); fs.writeFileSync(path.join(box, rel), text); };
  try {
    await setup(w, box, path);
    const r = spawnSync(process.execPath, ['-e', d.DIGEST_SCRIPT.replaceAll('/root/', box + '/root/')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    noSecrets(r.stdout);
    return d.parseDigests(r.stdout);
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}

test('DIGEST_SCRIPT: an older store has no entries; a corrupt store stays unknown', async () => {
  // Older OpenClaw has a database but no secret_store_entries table.
  const noTable = await runDigest(async (w, box, path) => {
    const fs = await import('node:fs');
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.join(box, 'root/.openclaw/state'), { recursive: true });
    const db = new DatabaseSync(path.join(box, 'root/.openclaw/state/openclaw.sqlite'));
    db.exec('CREATE TABLE other (x TEXT)');
    db.close();
  });
  assert.equal(noTable.storeOk, true);
  assert.deepEqual(noTable.store, []);
  assert.equal(noTable.digestOk, true);
  // A file that is not a database at all (corrupt).
  const corrupt = await runDigest((w) => w('root/.openclaw/state/openclaw.sqlite', 'this is not sqlite'));
  assert.equal(corrupt.storeOk, false);
  assert.equal(corrupt.digestOk, true);
  // No database file: nothing was ever stored, which is a successful read of an empty store.
  const none = await runDigest(() => {});
  assert.equal(none.storeOk, true);
  assert.equal(none.digestOk, true);
  // Raw script text that never reached its end: digestOk false.
  assert.equal(d.parseDigests('store-ok\nvercel\t' + H(S.vercel)).digestOk, false);
  assert.equal(d.parseDigests('').digestOk, false);
});

test('unreadable means unknown (present: null), never "holds nothing"', () => {
  const profiles = [{ profileId: 'cred_t', providerId: 'trello', tokenHash: H(S.trello) }];
  // Store unreadable: only the store-delivered providers are unknown; vercel and github still answer.
  const noStore = d.parseDigests('digest-ok\nvercel\t' + H(S.vercel));
  const a = Object.fromEntries(d.resolveCredentials(d.detectHoldings({ digests: noStore }), profiles, noStore).map((c) => [c.providerId, c]));
  for (const id of ['trello', 'notion', 'supabase']) assert.equal(a[id].present, null, id);
  assert.equal(a.vercel.present, true);
  assert.equal(a['github-pat'].present, false);
  // The script never finished: everything is unknown.
  const none = d.parseDigests('');
  for (const c of d.resolveCredentials(d.detectHoldings({ digests: none }), profiles, none)) assert.equal(c.present, null, c.providerId);
  // A successful read of an empty container stays a plain false.
  const ok = d.parseDigests('store-ok\ndigest-ok');
  for (const c of d.resolveCredentials(d.detectHoldings({ digests: ok }), profiles, ok)) assert.equal(c.present, false, c.providerId);
});

test('DIGEST_SCRIPT: the gh profile id comes only from agents.entries.main.tools.github', async () => {
  const dg = await runDigest((w) => w('root/.openclaw/openclaw.json', JSON.stringify({ auth: { profiles: [{ profileId: 'decoy_auth_profile' }] }, agents: { entries: { main: {} } } })));
  assert.equal(dg.githubProfileId, '', 'a profileId elsewhere in the file is not the GitHub identity');
  const bad = await runDigest((w) => w('root/.openclaw/openclaw.json', JSON.stringify({ agents: { entries: { main: { tools: { github: { profileId: '../../etc' } } } } } })));
  assert.equal(bad.githubProfileId, '');
});

test('a profile id with no hosts.yml of its own is not a GitHub credential', async () => {
  const dg = await runDigest((w) => {
    w('root/.openclaw/openclaw.json', JSON.stringify({ agents: { entries: { main: { tools: { github: { profileId: 'ghp_orphan' } } } } } }));
    w('root/.openclaw/credentials/github/agents/' + 'b'.repeat(64) + '/ghp_other/hosts.yml', 'github.com:\n  user: X\n  oauth_token: ' + S.ghId + '\n');
  });
  assert.equal(dg.githubProfileId, 'ghp_orphan');
  assert.equal(dg.ghIdentityFound, false);
  const h = d.detectHoldings({ digests: dg });
  assert.deepEqual(h.filter((x) => x.providerId === 'github-pat'), []);
  assert.equal(d.resolveCredentials(h, [], dg).find((c) => c.providerId === 'github-pat').present, false);
});

test('DIGEST_SCRIPT: quoted CRLF oauth_token and user are unquoted; a non-string token is no token', async () => {
  const dg = await runDigest((w) => {
    w('root/.openclaw/openclaw.json', JSON.stringify({ agents: { entries: { main: { tools: { github: { profileId: 'ghp_q' } } } } } }));
    w('root/.openclaw/credentials/github/agents/' + 'c'.repeat(64) + '/ghp_q/hosts.yml', 'github.com:\r\n  user: "Flame0510"\r\n  oauth_token: "' + S.ghId + '"\r\n');
    w('root/.config/gh/hosts.yml', "github.com:\r\n  user: 'olduser'\r\n  oauth_token: '" + S.ghOld + "'\r\n");
    w('root/.local/share/com.vercel.cli/auth.json', JSON.stringify({ token: { nested: S.vercel } }));
    w('root/.config/trello/config.json', JSON.stringify({ token: 12345678901234 }));
    w('root/.config/notion/config.json', JSON.stringify({ token: ['SENTINEL_NOTION_IN_ARRAY_xxxx'] }));
  });
  assert.deepEqual(dg.ghIdentity, { hash: H(S.ghId), login: 'Flame0510' });
  assert.deepEqual(dg.ghLegacy, { hash: H(S.ghOld), login: 'olduser' });
  assert.equal(dg.vercel, '', 'an object is not a token');
  assert.equal(dg.trelloLegacy, '', 'a number is not a token');
  assert.equal(dg.notionLegacy, '', 'an array is not a token');
});

test('parseDigests keeps only well-formed hashes and a safe profile id and login', () => {
  const dg = d.parseDigests('store\tTRELLO_TOKEN\tenv\tnot-a-hash\ngh-profile\t../../etc\ngh-identity\t' + H(S.ghId) + '\tbad login!\nvercel\t' + S.vercel + '\n');
  assert.equal(dg.store[0].hash, '');
  assert.equal(dg.githubProfileId, '');
  assert.deepEqual(dg.ghIdentity, { hash: H(S.ghId), login: '' });
  assert.equal(dg.vercel, '', 'a raw value is never taken for a hash');
});

test('parseProbeOutput carries digests, never a raw token, and an incomplete probe holds nothing', () => {
  const output = raw({ digests: DIGESTS });
  noSecrets(output);
  const p = d.parseProbeOutput(output);
  assert.equal(p.ok, true);
  assert.equal(p.digests.githubProfileId, 'ghp_0d3f9e9b595ef67a116620f856905c62');
  noSecrets(p);
  const cut = d.parseProbeOutput(raw({ 'probe:complete': '', digests: DIGESTS }));
  assert.equal(cut.ok, false);
  assert.deepEqual(d.detectHoldings(cut), []);
});

const holdings = (digests) => Object.fromEntries(d.detectHoldings(d.parseProbeOutput(raw({ digests }))).map((x) => [x.providerId, x]));

test('holdings: store entries, the managed GitHub identity and Vercel files', () => {
  const h = holdings(DIGESTS);
  assert.equal(h.trello.method, 'store');
  assert.equal(h.trello.tokenHash, H(S.trello));
  assert.equal(h.notion.method, 'store');
  assert.equal(h.supabase.method, 'store');
  assert.equal(h.supabase.tokenHash, H(S.supabase));
  assert.equal(h['github-pat'].method, 'github-identity');
  assert.equal(h['github-pat'].tokenHash, H(S.ghId));
  assert.equal(h['github-pat'].login, 'Flame0510');
  assert.equal(h.vercel.method, 'vercel-files');
  assert.equal(h.vercel.tokenHash, H(S.vercel));
  noSecrets(h);
});

test('holdings: the files an older release wrote still count', () => {
  const h = holdings([
    `gh-legacy\t${H(S.ghOld)}\tolduser`, `supabase-legacy\t${H(S.supabase)}`,
    `trello-legacy\t${H(S.trello)}`, `notion-legacy\t${H(S.notion)}`,
  ].join('\n'));
  for (const id of ['github-pat', 'supabase', 'trello', 'notion']) assert.equal(h[id].method, 'legacy-files', id);
  assert.equal(h['github-pat'].login, 'olduser');
  assert.equal(h.trello.tokenHash, H(S.trello));
  assert.equal(h.vercel, undefined);
  noSecrets(h);
});

test('holdings: the current method wins over an old file, and an identity with no readable token is still present', () => {
  const h = holdings([
    `store\tTRELLO_TOKEN\tenv\t${H(S.trello)}`, `trello-legacy\t${H('SENTINEL_STALE_TRELLO_jjjjjj')}`,
    'gh-profile\tghp_abc', 'gh-identity\t\t', `gh-legacy\t${H(S.ghOld)}\told`,
  ].join('\n'));
  assert.equal(h.trello.tokenHash, H(S.trello));
  assert.equal(h['github-pat'].method, 'github-identity');
  assert.equal(h['github-pat'].tokenHash, '');
});

test('holdings: a store entry of another kind or name is not a credential', () => {
  const h = holdings(`store\tTRELLO_TOKEN\tsecret\t${H(S.trello)}\nstore\tOTHER\tenv\t${H(S.notion)}`);
  assert.equal(h.trello, undefined);
  assert.equal(h.notion, undefined);
});

test('an empty container holds nothing', () => {
  assert.deepEqual(d.detectHoldings(d.parseProbeOutput(raw({}))), []);
});

test('resolveCredentials matches by hash, names every provider and returns no values', () => {
  const p = d.parseProbeOutput(raw({ digests: DIGESTS }));
  const profiles = [
    { profileId: 'cred_trello', providerId: 'trello', tokenHash: H(S.trello) },
    { profileId: 'cred_trello_other', providerId: 'trello', tokenHash: hashToken('SENTINEL_NOT_HELD_kkkkkkkk') },
    { profileId: 'cred_gh', providerId: 'github-pat', tokenHash: hashToken(S.ghId) },
    { profileId: 'cred_vercel_other', providerId: 'vercel', tokenHash: hashToken('SENTINEL_NOT_HELD_llllllll') },
  ];
  const r = Object.fromEntries(d.resolveCredentials(d.detectHoldings(p), profiles).map((c) => [c.providerId, c]));
  assert.deepEqual(Object.keys(r).sort(), ['github-pat', 'notion', 'supabase', 'trello', 'vercel']);
  assert.equal(r.trello.profileId, 'cred_trello');
  assert.deepEqual(r.trello.profileIds, ['cred_trello']);
  assert.equal(r['github-pat'].profileId, 'cred_gh');
  assert.equal(r['github-pat'].login, 'Flame0510');
  // Held, but matching no stored profile: present with no profile.
  assert.equal(r.vercel.present, true);
  assert.equal(r.vercel.profileId, null);
  assert.equal(r.notion.present, true);
  assert.equal(r.notion.profileId, null);
  noSecrets(r);
});

test('resolveCredentials: a container with nothing is present:false everywhere', () => {
  const r = d.resolveCredentials([], []);
  assert.equal(r.length, 5);
  for (const c of r) assert.deepEqual({ ...c }, { providerId: c.providerId, present: false, profileId: null, profileIds: [], method: null });
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
