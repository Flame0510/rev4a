#!/usr/bin/env node
/**
 * Verifies proposed `info` blocks against the model cards they cite — the gate between a
 * curator agent's proposal and `models.config.json`. Nothing is written: the script says
 * which proposals hold and which do not.
 *
 * What it checks, per model:
 *  - the id exists in the catalogue, and the model has a Hugging Face card;
 *  - `evidence` is present (a proposal without it is not verifiable);
 *  - every number in `params` appears in the card text;
 *  - every benchmark value sits in a row named after the benchmark, under a column whose
 *    header names this model (or its instruct variant) — the nearest header row that
 *    carries the model's name, so a card with a stacked or merged header still resolves;
 *  - `docUrl`, when asked with `--check-links`, answers 200.
 *
 * Usage:
 *   node scripts/model-info-verify.mjs <file with the proposals|->   [--check-links]
 * The file may be raw agent output: JSON objects are extracted from it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--')) ?? '-';
const checkLinks = args.includes('--check-links');

const catalogue = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'models.config.json'), 'utf-8')).models.map((m) => m.id));
const details = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'model-details.json'), 'utf-8')).models ?? {}; } catch { return {}; }
})();

const decode = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every table row of a card, markdown and HTML, as normalised `| a | b |` strings. */
function tableRows(md) {
  const rows = md.split('\n').filter((l) => l.trim().startsWith('|')).map(decode);
  for (const tr of md.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decode(c[1]));
    if (cells.length) rows.push(`| ${cells.join(' | ')} |`);
  }
  return rows;
}

const cellsOf = (row) => row.split('|').slice(1, -1).map((c) => c.replace(/\*/g, '').trim());

/**
 * A header cell names the model when it carries the same distinctive run of characters:
 * cards label columns with a display name ("Kimi K2.5 (Thinking)", "Nemotron-3-Super")
 * that is not the id, and an exact match would miss every one of them.
 */
function namesModel(cell, modelNames) {
  const c = norm(cell);
  if (!c) return false;
  return modelNames.some((n) => {
    const m = norm(n);
    if (!m) return false;
    for (let len = Math.min(c.length, m.length); len >= 6; len--) {
      for (let i = 0; i + len <= c.length; i++) if (m.includes(c.slice(i, i + len))) return true;
    }
    return false;
  });
}

/** The nearest row above `row` that names the model: the header this value belongs under. */
function headerNaming(rows, rowIndex, modelNames) {
  for (let i = rowIndex - 1; i >= 0; i--) {
    if (!rows[i]) break;
    const cells = cellsOf(rows[i]);
    if (cells.some((c) => namesModel(c, modelNames))) return cells;
  }
  return null;
}

function proposalObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue; // an unclosed fragment (engine logs) must not stop the scan
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      if (parsed && parsed.id && (parsed.info || parsed.skipped)) out.push(parsed);
    } catch { /* not a proposal object */ }
    i = end;
  }
  return out;
}

async function cardFor(hfId) {
  const cached = path.join('/tmp', `card-${hfId.replace('/', '_')}.md`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf-8');
  const res = await fetch(`https://huggingface.co/${hfId}/raw/main/README.md`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`card HTTP ${res.status}`);
  const md = await res.text();
  fs.writeFileSync(cached, md);
  return md;
}

async function verify(model, catalogueId) {
  const problems = [];
  const warnings = [];
  if (!catalogue.has(catalogueId)) problems.push('id not in the catalogue');
  if (model.skipped) return { problems, warnings: [`skipped: ${model.skipped}`] };
  const hfId = details[catalogueId]?.hf?.id;
  if (!hfId) return { problems, warnings: ['no Hugging Face card: not verifiable'] };
  if (!model.evidence?.length) problems.push('evidence missing');
  let md;
  try {
    md = await cardFor(hfId);
  } catch (e) {
    if (e instanceof Error) return { problems, warnings: [`card unavailable: ${e.message}`] };
    return { problems, warnings: ['card unavailable'] };
  }
  const rows = tableRows(md);
  const shortName = hfId.split('/').pop();
  const modelNames = [shortName, catalogueId.split('/').pop(), shortName.replace(/-/g, '')];

  const info = model.info ?? {};
  if (info.params) {
    const numbers = info.params.match(/\d+(?:\.\d+)?\s*[BT]/g) ?? [];
    const missing = numbers.filter((n) => !md.replace(/\s/g, '').includes(n.replace(/\s/g, '')));
    if (missing.length) problems.push(`params: numbers not in the card (${missing.join(', ')})`);
  }
  if (info.docUrl && checkLinks) {
    try {
      const res = await fetch(info.docUrl, { method: 'GET', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) problems.push(`docUrl: HTTP ${res.status}`);
    } catch {
      problems.push('docUrl: unreachable');
    }
  }
  const sameNumber = (cell, value) => {
    const parsed = Number(String(cell).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(parsed) && Math.abs(parsed - value) < 1e-9;
  };
  for (const bench of info.benchmarks ?? []) {
    // A benchmark name can appear in more than one table (or in prose rows); accept the
    // value when any row named after it carries it, then check the column of that row.
    const candidates = rows
      .map((r, index) => ({ r, index }))
      .filter(({ r }) => r.toLowerCase().includes(String(bench.name).toLowerCase()) && /\d/.test(r));
    if (candidates.length === 0) { problems.push(`${bench.name}: no matching row`); continue; }
    const hit = candidates.find(({ r }) => cellsOf(r).some((c) => sameNumber(c, bench.value)));
    if (!hit) { problems.push(`${bench.name}: value ${bench.value} not in any row named after it`); continue; }
    const cells = cellsOf(hit.r);
    const header = headerNaming(rows, hit.index, modelNames);
    if (!header) { warnings.push(`${bench.name}: no header naming the model above the row — check by hand`); continue; }
    const valueAt = cells.map((c, i) => (sameNumber(c, bench.value) ? i : -1)).filter((i) => i >= 0);
    const owns = valueAt.some((i) => header[i] && namesModel(header[i], modelNames));
    if (!owns) problems.push(`${bench.name}: value sits under "${valueAt.map((i) => header[i] ?? '?').join(', ')}"`);
  }
  return { problems, warnings };
}

const raw = input === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(input, 'utf-8');
let models;
try {
  const parsed = JSON.parse(raw);
  models = Array.isArray(parsed) ? parsed : Object.values(parsed);
} catch {
  models = proposalObjects(raw);
}

let clean = 0, flagged = 0, warned = 0;
for (const model of models) {
  const { problems, warnings } = await verify(model, model.id);
  if (problems.length) {
    flagged++;
    console.log(`✗ ${model.id}\n   ${problems.join('\n   ')}`);
  } else if (warnings.length) {
    warned++;
    console.log(`! ${model.id}\n   ${warnings.join('\n   ')}`);
  } else {
    clean++;
    console.log(`✓ ${model.id}`);
  }
}
console.log(`\n${models.length} proposal(s): ${clean} verified, ${warned} to check by hand, ${flagged} rejected`);
process.exit(flagged > 0 ? 1 : 0);
