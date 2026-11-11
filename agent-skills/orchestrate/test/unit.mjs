// Unit checks for the pure parts: globs, overlap, front matter, role proposal. node test/unit.mjs
import assert from 'node:assert/strict';
import { grantedBy, matches, matchesAny, patternsOverlap } from '../scripts/lib/glob.mjs';
import { parseFrontMatter, yamlScalar } from '../scripts/lib/frontmatter.mjs';
import { decide } from '../scripts/lib/keeper.mjs';
import { focusedSpecs, proposeRoles } from '../scripts/orch.mjs';
import { cardSpecFiles, DEFAULT_TEST_PATHS, failedSpecFiles, harnessesFor, harnessPlan, ownsTestFile, riskyFiles, shq, testRule } from '../scripts/lib/harness.mjs';

let n = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); n++; };

// matches(pattern, file)
for (const [p, f, want] of [
  ['app/**', 'app/page.tsx', true], ['app/**', 'app/a/b/c.ts', true], ['app/**', 'app', true], ['app/**', 'apps/x.ts', false],
  ['*.ts', 'next.config.ts', true], ['*.ts', 'app/page.ts', false], ['**/*.ts', 'a/b.ts', true], ['**/*.ts', 'b.ts', true],
  ['app/table/[token]/page.tsx', 'app/table/[token]/page.tsx', true], ['app/table/[token]/page.tsx', 'app/table/t/page.tsx', false],
  ['docs', 'docs/a.md', true], ['docs', 'docs', true], ['docs', 'docsx/a.md', false], ['docs/', 'docs/a/b.md', true],
  ['./lib/x.ts', 'lib/x.ts', true], ['lib/?.ts', 'lib/a.ts', true], ['lib/?.ts', 'lib/ab.ts', false],
  ['.env.example', '.env.example', true], ['.env.example', '.envXexample', false], ['', 'a', false],
  ['src/*', 'src/a.ts', true], ['src/*', 'src/a/b.ts', false], ['a/**/z.ts', 'a/z.ts', true], ['a/**/z.ts', 'a/b/c/z.ts', true],
]) eq(matches(p, f), want, `matches(${p}, ${f})`);

// patternsOverlap(a, b): may some path match both?
for (const [a, b, want] of [
  ['app/**', 'app/page.tsx', true], ['app/**', 'lib/**', false], ['*.ts', 'app/**', false], ['*.ts', 'next.config.ts', true],
  ['*.ts', '*.mjs', true /* conservative: two wildcards in one segment */], ['docs', 'docs/a.md', true],
  ['src/a/**', 'src/a/x.mjs', true], ['src/a/**', 'src/b/**', false], ['**/*.test.ts', 'lib/**', true],
  ['package.json', 'package-lock.json', false], ['app/*/page.tsx', 'app/menu/page.tsx', true], ['app/*/page.tsx', 'app/menu/x.tsx', false],
]) {
  eq(patternsOverlap(a, b), want, `overlap(${a}, ${b})`);
  eq(patternsOverlap(b, a), want, `overlap(${b}, ${a})`);
}

// Front matter as Backlog.md writes it (taken from a real tourguide task) and odd variants.
const fm = parseFrontMatter(`---
id: SB-59
title: 'Normalize engineering prose, diagnostics and internal naming to English'
status: In Progress
assignee: []
labels:
  - english-first
dependencies:
  - SB-58
modified_files:
  - app/**
  - '*.ts'
  - 'app/table/[token]/page.tsx'
checks: ["node scripts/x.mjs 'a, b'", plain]
priority: high
ordinal: 1000030000
nested:
  key: value
  - not-a-list-item
empty:
---

## Description
body
`);
eq(fm.data.id, 'SB-59', 'id');
eq(fm.data.title, 'Normalize engineering prose, diagnostics and internal naming to English', 'quoted title');
eq(fm.data.status, 'In Progress', 'status');
eq(fm.data.assignee, [], 'empty inline list');
eq(fm.data.dependencies, ['SB-58'], 'block list');
eq(fm.data.modified_files, ['app/**', '*.ts', 'app/table/[token]/page.tsx'], 'quoted globs');
eq(fm.data.checks, ["node scripts/x.mjs 'a, b'", 'plain'], 'inline list with a comma inside quotes');
eq(fm.data.ordinal, '1000030000', 'ordinal as text');
eq(fm.data.nested, null, 'nested map skipped');
eq(fm.data.empty, null, 'empty value');
eq(fm.body.trim(), '## Description\nbody', 'body');
eq(parseFrontMatter('no front matter').data, {}, 'no front matter');
eq(parseFrontMatter("---\ntitle: 'it''s'\n---\n").data.title, "it's", 'doubled quote');
eq(parseFrontMatter('---\r\nid: X-1\r\ndependencies: [X-2, "X-3"]\r\n---\r\n').data.dependencies, ['X-2', 'X-3'], 'CRLF');

// Folded and literal blocks, as Backlog.md writes long titles (seen on tourguide SB-67).
const fb = parseFrontMatter("---\nid: SB-67\ntitle: >-\n  Gate English-first engineering and\n  localized browser behavior\nstatus: To Do\nnote: |\n  line one\n  line two\ndependencies:\n  - SB-66\n---\n").data;
eq(fb.title, 'Gate English-first engineering and localized browser behavior', 'folded title');
eq(fb.status, 'To Do', 'key after a folded block');
eq(fb.note, 'line one\nline two', 'literal block');
eq(fb.dependencies, ['SB-66'], 'list after a literal block');
eq(parseFrontMatter('---\ntitle: >-\n---\n').data.title, '', 'empty folded block');

eq(yamlScalar('In Progress'), 'In Progress', 'plain');
eq(yamlScalar('Done: really'), "'Done: really'", 'colon quoted');
eq(yamlScalar("it's"), "'it''s'", 'quote doubled');
eq(yamlScalar('yes'), "'yes'", 'yaml boolean word quoted');

// Roles from the models the agent has.
eq(proposeRoles(['openai/gpt-6.1-sol', 'rev4a/deepseek/deepseek-flash']).worker, 'rev4a/deepseek/deepseek-flash', 'cheap worker');
eq(proposeRoles(['openai/gpt-6.1-sol', 'rev4a/deepseek/deepseek-flash']).checker, 'openai/gpt-6.1-sol', 'strong checker');
eq(proposeRoles(['only/model']).checker, 'only/model', 'one model: same checker');
eq(proposeRoles(['a/flash', 'b/mini']).worker, 'b/mini', 'all cheap: worker'); eq(proposeRoles(['a/flash', 'b/mini']).checker, 'a/flash', 'all cheap: a different checker');
eq(proposeRoles(['a/big', 'b/huge']).worker, 'a/big', 'no cheap model: primary works');
eq(proposeRoles(['a/big', 'b/huge']).checker, 'b/huge', 'no cheap model: another checks');
eq(proposeRoles([]).worker, null, 'no models');

// Could a worker add a test inside these owned globs?
for (const [owned, want] of [
  [['scripts/tool.mjs'], false], [['src/a/**'], true], [['src/a/x.mjs'], false], [['tests/e2e/greet.spec.ts'], true],
  [['tests/e2e/**'], true], [['app/menu/**'], true], [['*.ts'], true], [['docs'], true], [['public/sw.js'], false],
  [['app/admin/page.tsx'], false], [['lib/i18n/*.ts'], true], [['src/x.test.ts'], true], [['src/*.css'], false],
  [['app/admin/page.tsx', 'tests/e2e/admin.spec.ts'], true], [[], false],
]) eq(ownsTestFile(owned, DEFAULT_TEST_PATHS), want, `ownsTestFile(${owned.join(', ')})`);

// The test rule on a change.
const cfgT = { tests: { rule: 'warn', paths: DEFAULT_TEST_PATHS } };
eq(testRule(cfgT, {}, ['README.md', 'docs/a.md']).level, 'pass', 'docs only: no test needed');
eq(testRule(cfgT, {}, ['src/a.ts']).level, 'warn', 'source without test: warn');
eq(testRule({ tests: { ...cfgT.tests, rule: 'fail' } }, {}, ['src/a.ts']).level, 'fail', 'fail mode');
eq(testRule(cfgT, {}, ['src/a.ts', 'src/a.test.ts']).level, 'pass', 'source with test');
eq(testRule(cfgT, { noTests: 'rename' }, ['src/a.ts']).level, 'pass', 'no_tests');
eq(testRule({ tests: { ...cfgT.tests, rule: 'off' } }, {}, ['src/a.ts']).level, 'off', 'off');
eq(testRule(cfgT, {}, ['tests/e2e/a.spec.ts']).level, 'pass', 'test only');

// Which harnesses run for a change.
const cfgH = { harnesses: [{ name: 'e2e', paths: ['app/**', 'tests/e2e/**'] }, { name: 'db', paths: ['db/**'], when: 'merge' }] };
eq(harnessesFor(cfgH, { harnesses: [] }, ['app/x.tsx'], 'gate').map(h => h.name), ['e2e'], 'covered path');
eq(harnessesFor(cfgH, { harnesses: [] }, ['lib/x.ts'], 'gate').map(h => h.name), [], 'uncovered path');
eq(harnessesFor(cfgH, { harnesses: ['e2e'] }, ['lib/x.ts'], 'gate').map(h => h.name), ['e2e'], 'named by the task');
eq(harnessesFor(cfgH, { harnesses: [] }, ['db/m.sql'], 'gate').map(h => h.name), [], 'merge harness not at the gate');
eq(harnessesFor(cfgH, { harnesses: [] }, ['db/m.sql'], 'merge').map(h => h.name), ['db'], 'merge harness at the merge');

// The spec files a worker/checker runs instead of the whole suite.
eq(focusedSpecs({ ownedFiles: ['app/menu/**', 'tests/e2e/02-session-orders.spec.ts', 'components/menu/**'] }), ['tests/e2e/02-session-orders.spec.ts'], 'a spec file');
eq(focusedSpecs({ ownedFiles: ['app/**', 'tests/**'] }), [], 'no specific spec: none');
eq(focusedSpecs({ ownedFiles: ['tests/e2e/kitchen-*.spec.ts', 'src/a.test.ts'] }), ['tests/e2e/kitchen-*.spec.ts', 'src/a.test.ts'], 'spec globs and unit tests');

// Fast gate: what the gate runs per harness.
const fullH = { name: 'e2e', paths: ['app/**', 'tests/e2e/**'] };
const fastH = { ...fullH, fast: { critical: ['tests/e2e/02-orders.spec.ts'] } };
eq(harnessPlan(fullH, { closure: false, risky: [], specs: ['tests/e2e/x.spec.ts'] }).mode, 'full', 'no fast block: whole suite');
eq(harnessPlan(fastH, { closure: true, risky: [], specs: [] }), { mode: 'full', specs: [], reason: 'closure card' }, 'closure card: whole suite');
eq(harnessPlan(fastH, { closure: false, risky: ['db/m.sql'], specs: [] }).mode, 'full', 'risky path: whole suite');
eq(harnessPlan(fastH, { closure: false, risky: [], specs: ['tests/e2e/13.spec.ts'] }).specs, ['tests/e2e/13.spec.ts', 'tests/e2e/02-orders.spec.ts'], 'fast: card specs + critical');
eq(harnessPlan({ ...fullH, fast: { critical: [] } }, { closure: false, risky: [], specs: [] }).mode, 'skip', 'fast, nothing to run');
eq(harnessPlan(fastH, { closure: false, risky: [], specs: ['tests/e2e/02-orders.spec.ts'] }).specs, ['tests/e2e/02-orders.spec.ts'], 'no duplicate spec');
eq(riskyFiles({ risk: { paths: ['db/**', 'middleware.ts'] } }, ['app/a.tsx', 'db/x.sql', 'middleware.ts']), ['db/x.sql', 'middleware.ts'], 'risky files');
eq(riskyFiles({}, ['db/x.sql']), [], 'no risk config: nothing risky');
const task = { ownedFiles: ['app/menu/**', 'tests/e2e/13-*.spec.ts', 'tests/ux/a.test.tsx'] };
const wt = ['app/menu/page.tsx', 'tests/e2e/13-iso.spec.ts', 'tests/e2e/01-other.spec.ts', 'tests/ux/a.test.tsx', 'lib/x.spec.ts'];
eq(cardSpecFiles(fullH, task, ['app/menu/page.tsx'], wt), ['tests/e2e/13-iso.spec.ts'], 'owned glob expanded; unit test and foreign specs left out');
eq(cardSpecFiles(fullH, { ownedFiles: [] }, ['tests/e2e/09.spec.ts'], []), ['tests/e2e/09.spec.ts'], 'a changed spec counts');
const pwOut = '  2 failed\n    [chromium] › tests/e2e/02-session-orders.spec.ts:14:3 › orders › sends\n    [chromium] › tests/e2e/07-kitchen.spec.ts:8:1 › kitchen\n  1) [chromium] › tests/e2e/02-session-orders.spec.ts:14:3 › orders\n  27 passed (7.9m)';
eq(failedSpecFiles(pwOut), ['tests/e2e/02-session-orders.spec.ts', 'tests/e2e/07-kitchen.spec.ts'], 'failed specs from Playwright output');
eq(failedSpecFiles('29 passed (8.1m)'), [], 'nothing failed');
eq(failedSpecFiles('  ✘  30 tests/e2e/13-ux-theme-isolation.spec.ts:101:5 › two venues (2.5m)\n  1 failed\n    tests/e2e/13-ux-theme-isolation.spec.ts:101:5 › two venues\n  29 passed (9.0m)'), ['tests/e2e/13-ux-theme-isolation.spec.ts'], 'list reporter without projects (tourguide)');
eq(failedSpecFiles('  1) tests/e2e/02-orders.spec.ts:14:3 › orders ─────'), ['tests/e2e/02-orders.spec.ts'], 'summary line');
eq(failedSpecFiles('  ✓  22 tests/e2e/10-room.spec.ts:12:5 › ok (10.4s)'), [], 'a passed test is not a failure');

eq(shq("a b'c"), "'a b'\\''c'", 'shell quoting');

// Keeper at the round limit: a gate that failed on files outside the card still gets its scope round (wake the
// coordinator); once used, or on any other failure, the owner decides.
{
  const now = Date.now(); const t = new Date(now - 3.6e6).toISOString();
  const ctx = { campaign: { active: true, startedAt: t }, now, lastActivity: now - 3.6e6, blocked: [], eligible: [], selfDecides: false,
    limits: { correctionRounds: 2, workerTimeoutSec: 3600, checkerTimeoutSec: 1800 }, scopeRoundsMax: 1, nextFor: st => `next ${st.id}`, progress: 'p' };
  const run = extra => ({ id: 'X', phase: 'gate-failed', round: 2, events: [{ t, kind: 'gate' }], ...extra });
  eq(decide({ ...ctx, runs: [run({ gate: { outside: 1 } })] }).action, 'wake', 'scope failure at the limit: the coordinator adds the files');
  eq(decide({ ...ctx, runs: [run({ gate: { outside: 1 }, scopeRounds: 1, round: 3 })] }).action, 'escalate', 'scope round used: the owner');
  eq(decide({ ...ctx, runs: [run({ gate: { outside: 0 } })] }).action, 'escalate', 'other failure at the limit: the owner');
  eq(decide({ ...ctx, runs: [run({ gate: { outside: 0 }, scopeRounds: 1, round: 2 })] }).action, 'wake', 'a granted round raises the limit');
}

// A name that differs from an allowed one only by edge whitespace or a control character is never granted
// ownership or inertness; plain matching (which only adds checks) keeps trimming.
for (const odd of ['docs/safe.md\t', 'docs/safe.md\n', '\tdocs/safe.md', ' docs/safe.md', 'docs/safe.md ', 'docs/sa\x7ffe.md']) {
  assert.equal(grantedBy(['docs/safe.md', 'docs/**'], odd), false, JSON.stringify(odd)); n++;
}
assert.equal(grantedBy(['docs/safe.md'], 'docs/safe.md'), true); n++;
assert.equal(grantedBy(['docs/**'], 'docs/caf\u00e9 \u00e9.md'), true, 'non-ASCII and inner spaces are ordinary names'); n++;
assert.equal(matchesAny(['docs/**'], 'docs/safe.md\t'), true, 'trigger matching unchanged'); n++;

console.log(`unit: ${n} assertions passed`);
