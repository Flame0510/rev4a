#!/usr/bin/env node
/**
 * The check a contributor runs before opening a PR: `npm run precheck`.
 *
 * Runs, in order: npm test, check:language, typecheck, check:package-types, then a secret
 * scan of the lines you added (staged and unstaged, against origin/main, or HEAD when
 * origin/main is not available). It runs every step even when one fails and prints what to
 * do next. Needs no network. Nothing is committed, staged or changed.
 *
 * The secret scan is a heuristic: it warns, it does not prove. A line carrying `secret-ok`
 * is skipped (a test fixture or a placeholder).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const STEPS = [
  ['npm test', ['test']],
  ['check:language', ['run', 'check:language']],
  ['typecheck', ['run', 'typecheck']],
  ['check:package-types', ['run', 'check:package-types']],
];

// Quoted literals in code, unquoted values in env/YAML-style lines, and well-known token shapes.
const SECRET = /sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|(password|passwd|token|secret|api_?key)[A-Za-z_]*\s*[:=]\s*['"][^'"\s]{8,}['"]|^\s*(export\s+)?[A-Z0-9_]*(PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY)[A-Z0-9_]*\s*[=:]\s*[^\s'"$#{]{8,}\s*$/im; // secret-ok

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function scanSecrets() {
  let base = 'HEAD';
  const mb = git(['merge-base', 'origin/main', 'HEAD']);
  if (mb.status === 0 && mb.stdout.trim()) base = mb.stdout.trim();
  // `git diff <base>` compares the working tree (staged and unstaged) with the base commit.
  const d = git(['diff', '--no-color', '-U0', base]);
  if (d.status !== 0) return { base, error: (d.stderr || 'git diff failed').trim(), hits: [] };
  const hits = [];
  let file = '';
  let line = 0;
  for (const l of d.stdout.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(6); continue; }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      if (SECRET.test(l) && !l.includes('secret-ok')) hits.push(`${file}:${line}`);
      line++;
    }
  }
  // Untracked files are part of the change too.
  const u = git(['ls-files', '--others', '--exclude-standard']);
  for (const f of u.stdout.split('\n').filter(Boolean)) {
    const c = spawnSync('grep', ['-nIE', SECRET.source, f], { cwd: root, encoding: 'utf8' });
    for (const m of (c.stdout || '').split('\n').filter(Boolean)) if (!m.includes('secret-ok')) hits.push(`${f}:${m.split(':')[0]}`);
  }
  return { base, hits };
}

const failed = [];
for (const [name, args] of STEPS) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(npm, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) failed.push(name);
}

console.log('\n=== secret scan (staged + unstaged + untracked) ===');
const s = scanSecrets();
if (s.error) {
  console.log(`Could not scan: ${s.error}`);
  failed.push('secret scan');
} else if (s.hits.length) {
  console.log(`Possible secrets in your changes (compared with ${s.base.slice(0, 12)}):`);
  for (const h of s.hits) console.log(`  ${h}`);
  console.log('If a line is a real secret, remove it and rotate the secret. If it is a placeholder or a fixture, add `secret-ok` to the line.');
  failed.push('secret scan');
} else {
  console.log(`No suspicious added lines (compared with ${s.base.slice(0, 12)}).`);
}

console.log('\n=== precheck summary ===');
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  console.log('Fix them, run `npm run precheck` again, and only then open the PR.');
  console.log('Also reread your diff and commit message for Italian the word list cannot catch (AGENTS.md §2.1).');
  process.exit(1);
}
console.log('All checks passed. Reread your diff and commit message for Italian the word list cannot catch (AGENTS.md §2.1), then open the PR.');
console.log('Behaviour changes still need a check on a running instance: `npm run check:ui` covers the browser checks.');
