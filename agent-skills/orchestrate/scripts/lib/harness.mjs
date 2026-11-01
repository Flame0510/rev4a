// Test harnesses: the project's slower suites (Playwright, Cypress, …) that the gate runs only when a task touches
// the paths they cover, plus the rule "a behaviour change comes with a test". Detection only proposes; the owner
// confirms the config.
import fs from 'node:fs';
import path from 'node:path';
import { firstOverlap, matchesAny } from './glob.mjs';
import { OrchError, sh } from './util.mjs';

export const DEFAULT_TEST_PATHS = ['tests/**', 'test/**', 'e2e/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'];
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|sql)$/;
const UI_DIRS = ['app', 'pages', 'components', 'src', 'hooks', 'stores', 'lib', 'public', 'styles'];
// What the suites write next to the code: never part of a change (the gate fails when checks change the tree).
export const OUTPUT_DIRS = ['/test-results/', '/playwright-report/', '/blob-report/', '/cypress/videos/', '/cypress/screenshots/'];

function testDirOf(root, configFile) {
  const m = fs.readFileSync(path.join(root, configFile), 'utf8').match(/testDir\s*:\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1].replace(/^\.\//, '').replace(/\/+$/, '') : null;
}

export function detectHarnesses(root, scripts = {}) {
  const has = f => fs.existsSync(path.join(root, f));
  const scriptFor = re => Object.entries(scripts).find(([, v]) => re.test(String(v)))?.[0];
  const ui = UI_DIRS.filter(has).map(d => `${d}/**`);
  const harnesses = []; const used = new Set(['test', 'check']); const notes = [];

  const suites = [
    { name: 'e2e', configs: ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'], run: /playwright\s+test/, fallback: 'npx playwright test', dirs: ['tests/e2e', 'e2e'] },
    { name: 'cypress', configs: ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs'], run: /cypress\s+run/, fallback: 'npx cypress run', dirs: ['cypress'] },
  ];
  for (const s of suites) {
    const config = s.configs.find(has);
    if (!config) continue;
    const script = scriptFor(s.run);
    if (script) used.add(script);
    const testDir = testDirOf(root, config) ?? s.dirs.find(has) ?? null;
    harnesses.push({
      name: s.name, command: script ? `npm run ${script}` : s.fallback,
      paths: [...ui, ...(testDir ? [`${testDir}/**`] : []), config], when: 'gate', timeoutSec: 1800, env: {},
    });
  }
  const other = Object.keys(scripts).filter(k => !used.has(k) && /e2e|integration|smoke|^test:/i.test(k));
  if (other.length) notes.push(`other test scripts, not used by the gate (add them as harnesses if they should be): ${other.join(', ')}`);
  const wf = path.join(root, '.github', 'workflows');
  if (fs.existsSync(wf)) {
    const ci = fs.readdirSync(wf).filter(f => /\.ya?ml$/.test(f) && /playwright|cypress|e2e/i.test(fs.readFileSync(path.join(wf, f), 'utf8')));
    if (ci.length) notes.push(`CI runs end-to-end tests in: ${ci.join(', ')} (compare its setup with the harness command)`);
  }
  if (!harnesses.length) notes.push('no end-to-end harness found: tasks that change pages are checked only by "checks"');
  return { harnesses, notes };
}

// The harnesses to run for a change: those whose paths match a changed file, or that the task names itself.
export function harnessesFor(cfg, task, changed, when) {
  return cfg.harnesses.filter(h => (h.when ?? 'gate') === when
    && ((task.harnesses ?? []).includes(h.name) || changed.some(f => matchesAny(h.paths ?? ['**'], f))));
}

// The harnesses a task may trigger, from its owned globs (for the briefs, before anything changed).
export function harnessesCovering(cfg, task) {
  return cfg.harnesses.filter(h => (task.harnesses ?? []).includes(h.name) || firstOverlap(task.ownedFiles, h.paths ?? ['**']));
}

export function testRule(cfg, task, changed) {
  if (cfg.tests.rule === 'off') return { level: 'off' };
  const isTest = f => matchesAny(cfg.tests.paths, f);
  const src = changed.filter(f => CODE.test(f) && !isTest(f));
  const tests = changed.filter(isTest);
  if (!src.length) return { level: 'pass', text: 'tests: no source code changed' };
  if (tests.length) return { level: 'pass', text: `tests: ${tests.length} test file(s) changed with ${src.length} source file(s)` };
  if (task.noTests) return { level: 'pass', text: `tests: none, the task says why: ${task.noTests}` };
  return {
    level: cfg.tests.rule === 'fail' ? 'fail' : 'warn',
    text: `tests: ${src.length} source file(s) changed and no test file (${src.slice(0, 3).join(', ')}${src.length > 3 ? ' …' : ''}): add a test, or the owner sets no_tests on the task`,
  };
}

// A concrete path a glob matches, to judge globs by what they cover: app/** → app/x, **/*.test.ts → x/x.test.ts.
export function concreteExample(glob) {
  return glob.trim().replace(/^\.\//, '').replace(/\/+$/, '/x').replace(/\*\*/g, 'x').replace(/[*?]/g, 'x');
}

const DOC_DIRS = /^(docs?|documentation|\.github|backlog)(\/|$)/;

// A database migration: a migrations folder at the root or under a database folder (db/, supabase/, prisma/,
// drizzle/). A route or doc folder that is merely named "migration" (app/migration/**) is not one.
export const isMigrationPath = g => /^(migrations?|(\S*\/)?(db|database|supabase|prisma|drizzle)\/(\S*\/)?migrations?)(\/|$)/i.test(g.trim().replace(/^\.\//, ''));

// Does the card own source code the gate's test rule applies to? A path with an extension counts by it (*.tsx yes,
// *.md no); a folder (app/**, app) counts unless it is a docs folder; anything under the test paths never counts.
export function ownsSourceCode(owned, testPaths) {
  return owned.some(g => {
    const c = concreteExample(g);
    if (matchesAny(testPaths, c)) return false;
    const last = g.trim().replace(/\/+$/, '').split('/').at(-1);
    if (/\.[A-Za-z0-9]+$/.test(last)) return CODE.test(c);
    return !DOC_DIRS.test(c);
  });
}

// Could the worker create or edit a test file inside the owned globs? Glob overlap is useless here (a test glob
// like **/*.test.* overlaps every path), so try concrete test file names under each owned glob.
export function ownsTestFile(owned, testPaths) {
  const EXT = ['.ts', '.tsx', '.js', '.mjs'];
  for (const g of owned) {
    const p = g.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!/[*?]/.test(p) && /\.[^/]+$/.test(p.split('/').at(-1))) { // a single file
      if (matchesAny(testPaths, p)) return true;
      continue;
    }
    const segs = p.split('/'); const prefix = [];
    for (const s of segs) { if (/[*?]/.test(s)) break; prefix.push(s); }
    for (const t of testPaths) {
      const fill = t.replace(/^(\*\*\/)+/, '').replace(/\/\*\*$/, '/x').replace(/\*\*/g, 'x');
      for (const ext of EXT) {
        const name = fill.replace(/\.\*$/, ext).replace(/\*/g, 'x');
        const candidate = [...prefix, ...(/\.[^/]+$/.test(name) ? [name] : [`${name}${ext}`])].join('/');
        if (matchesAny([g], candidate) && matchesAny([t], candidate)) return true;
      }
    }
  }
  return false;
}

// Advice on a task before it starts. Not blocking: the coordinator proposes the fix to the owner.
export function readiness(cfg, task) {
  const out = [];
  if (cfg.tests.rule !== 'off' && task.ownedFiles.length && !task.noTests && !ownsTestFile(task.ownedFiles, cfg.tests.paths)) {
    out.push('owns no test file, so the worker cannot add a test: add one to modified_files (a specific spec, not a whole test folder), or no_tests: <why>');
  }
  if (task.ownedFiles.length && !task.checks.length && !harnessesCovering(cfg, task).length) {
    out.push('nothing but the project checks verifies it: propose a checks: command or a test for its acceptance');
  }
  return out;
}

// One harness at a time across every run of the project (memory, ports). A stale lock (dead pid) is taken over.
function takeLock(lock, maxSec) {
  const t0 = Date.now();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { /* being written */ }
    let alive = true;
    if (pid) { try { process.kill(pid, 0); } catch (err) { alive = err.code === 'EPERM'; } }
    else alive = Date.now() - fs.statSync(lock).mtimeMs < 10_000;
    if (!alive) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
    if (Date.now() - t0 > maxSec * 1000) throw new OrchError(`another harness run (pid ${pid || '?'}) still holds ${lock}`);
    Atomics.wait(pause, 0, 0, 2000);
  }
}

export function runHarness(root, h, cwd) {
  const lock = path.join(root, '.orchestrate', 'harness.lock');
  const timeoutSec = h.timeoutSec ?? 1800;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  takeLock(lock, timeoutSec);
  try { return sh(h.command, { cwd, timeoutSec, env: h.env }); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// ── Fast gate ─────────────────────────────────────────────────────────────────────────────────────────────────
// A harness with a `fast` block ({ critical: [spec files] }) runs only the specs of the card plus the critical ones
// at the gate. The whole suite runs instead for a closure card (one that other cards name as their parent), when the
// change touches one of `risk.paths`, or for a harness without a `fast` block.

/** Single-quoted shell word. */
export function shq(s) {
  return `'${String(s).split("'").join(`'\\''`)}'`;
}

export function riskyFiles(cfg, files) {
  const paths = cfg.risk?.paths ?? [];
  return paths.length ? files.filter((f) => matchesAny(paths, f)) : [];
}

const SPEC_FILE = /\.spec\.[cm]?[jt]sx?$/;

/**
 * The spec files of this harness a card stands behind: specs it changed, plus specs it owns (literal paths or globs
 * expanded over the files of its worktree). Only files inside the harness paths, so a unit test never reaches it.
 */
export function cardSpecFiles(h, task, changed, worktreeFiles) {
  const inHarness = (f) => SPEC_FILE.test(f) && matchesAny(h.paths ?? ['**'], f);
  const owned = worktreeFiles.filter((f) => matchesAny(task.ownedFiles ?? [], f));
  return [...new Set([...changed, ...owned].filter(inHarness))].sort().slice(0, 20);
}

/** What the gate runs for one harness: { mode: 'full' | 'fast' | 'skip', specs, reason }. */
export function harnessPlan(h, { closure, risky, specs }) {
  if (!h.fast) return { mode: 'full', specs: [], reason: '' };
  if (closure) return { mode: 'full', specs: [], reason: 'closure card' };
  if (risky.length) return { mode: 'full', specs: [], reason: `risky paths: ${risky.slice(0, 3).join(', ')}${risky.length > 3 ? ' …' : ''}` };
  const all = [...new Set([...specs, ...(h.fast.critical ?? [])])];
  return all.length ? { mode: 'fast', specs: all, reason: '' } : { mode: 'skip', specs: [], reason: 'no spec of the card and no critical spec' };
}

/** The spec files Playwright reports as failed (`[project] › path/x.spec.ts:12:3 › title`). */
export function failedSpecFiles(output) {
  const out = new Set();
  // Three shapes: `[project] › path:line`, the list reporter's `✘  30 path:line`, and the summary's `1) path:line`.
  for (const m of String(output).matchAll(/(?:›|>|✘\s+\d+|\d+\))\s+((?:[\w.@-]+\/)*[\w.@-]+\.spec\.[cm]?[jt]sx?):\d+/g)) out.add(m[1]);
  return [...out].sort();
}
