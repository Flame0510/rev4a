#!/usr/bin/env node
/**
 * Suggests what to write in a catalogue entry's curated `info` block — the facts no API
 * publishes in a usable shape: an active parameter count, real benchmark numbers, the
 * vendor's documentation link, notes.
 *
 * **It never writes.** Prints the material and, with `--json`, a skeleton to complete:
 * the assistant or the maintainer reads the model card, transcribes the numbers and
 * records the source, exactly as the plan requires (plans/MODEL-DETAILS-PLAN.md: facts
 * plus curation, never derived).
 *
 * Sources, in order: the model card on Hugging Face (a README, so readable), then the
 * vendor's documentation, which the card usually links. No card and no citable page means
 * the model keeps its automatic data only.
 *
 * Usage:
 *   node scripts/model-info-suggest.mjs <model id> [<model id> …]
 *   node scripts/model-info-suggest.mjs <model id> --json
 *   node scripts/model-info-suggest.mjs --all            # every model with a card
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUpstream, matchUpstream } from './lib/model-upstream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_FILE = path.join(ROOT, 'models.config.json');
const DETAILS_FILE = path.join(ROOT, 'model-details.json');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const ids = args.filter((a) => !a.startsWith('--'));
const catalogue = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf-8')).models;
const details = (() => {
  try { return JSON.parse(fs.readFileSync(DETAILS_FILE, 'utf-8')).models ?? {}; } catch { return {}; }
})();

const readmeUrl = (hfId) => `https://huggingface.co/${hfId}/raw/main/README.md`;

/** Lines that read like the vendor describing its own size or sparsity. */
function sizeSentences(md) {
  // Raw markdown carries HTML blocks and images with no sentence boundaries: strip them
  // first, or the first "sentence" is the whole badge header.
  const text = md
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\|/g, ' ');
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 20 && s.length < 320)
    .filter((s) => /(active|activated|backbone|total)\s+(parameter|params)|Mixture-of-Experts|number of experts|routed experts/i.test(s))
    .slice(0, 6);
}

/** Markdown tables that look like benchmark results, header included. */
function benchmarkTables(md) {
  const lines = md.split('\n');
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const block = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) { block.push(lines[i].trim()); i++; }
    const head = block[0] ?? '';
    const body = block.slice(1);
    const numeric = body.filter((row) => (row.match(/\b\d+(\.\d+)?\b/g) ?? []).length >= 2).length;
    if (/bench|eval|score|metric/i.test(head) || numeric >= 3) tables.push(block);
  }
  return tables.slice(0, 3);
}

/** Candidate documentation links the card points at. */
function docLinks(md) {
  const urls = new Set();
  for (const m of md.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
    const url = m[0].replace(/[.,;]$/, '');
    if (/docs\.|github\.com|arxiv\.org|platform\.|api-docs/.test(url)) urls.add(url);
  }
  return [...urls].slice(0, 8);
}

async function suggest(entry, live) {
  const upstream = matchUpstream(live, entry.id);
  const detail = details[entry.id] ?? {};
  const hfId = detail.hf?.id ?? upstream?.hugging_face_id ?? null;

  const out = {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    currentInfo: entry.info ?? null,
    upstreamId: upstream?.id ?? null,
    huggingFaceId: hfId,
    cardUrl: hfId ? `https://huggingface.co/${hfId}` : null,
  };

  if (!hfId) {
    console.log(`${entry.id}  —  no Hugging Face card: look for the vendor's own model page (no card → no citable size).`);
    return out;
  }

  const res = await fetch(readmeUrl(hfId), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    console.log(`${entry.id}  —  card ${hfId}: README returned HTTP ${res.status}`);
    return out;
  }
  const md = await res.text();
  out.paramsSentences = sizeSentences(md);
  out.benchmarkTables = benchmarkTables(md);
  out.docLinks = docLinks(md);

  if (!asJson) {
    console.log(`\n=== ${entry.id} — ${entry.name}`);
    console.log(`  card: ${out.cardUrl}`);
    if (detail.hf) {
      const h = detail.hf;
      console.log(`  automatic: total ${h.total ?? '—'}, experts ${h.moe ? `${h.moe.experts} (${h.moe.perToken ?? '?'}/token)` : '—'}, licence ${h.license ?? '—'}, published ${h.published ?? '—'}`);
    }
    if (out.paramsSentences.length) {
      console.log('  size sentences (candidates for info.params):');
      for (const s of out.paramsSentences) console.log(`    · ${s}`);
    }
    for (const t of out.benchmarkTables) {
      console.log('  benchmark table (pick the model\'s own column):');
      for (const row of t.slice(0, 10)) console.log(`    ${row}`);
    }
    if (out.docLinks.length) {
      console.log(`  doc link candidates: ${out.docLinks.join(' , ')}`);
    }
    if (out.currentInfo) console.log(`  current info: ${JSON.stringify(out.currentInfo)}`);
  }
  return out;
}

async function main() {
  const live = await fetchUpstream();
  const targets = args.includes('--all')
    ? catalogue.filter((m) => details[m.id]?.hf?.id)
    : ids.map((id) => catalogue.find((m) => m.id === id) ?? { id, name: '(not in the catalogue)', provider: '?' });
  const out = [];
  for (const entry of targets) out.push(await suggest(entry, live));
  if (asJson) console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
