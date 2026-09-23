#!/usr/bin/env node
/**
 * Refresh model-pricing.json and models.config.json from the live OpenRouter
 * catalogue.
 *
 * Why this exists: both files are maintained by hand and drift. When this was
 * written, 16 of 79 OpenRouter entries had stale prices — google/gemini-2.5-flash
 * understated the real cost by ~8x. The dashboard reads these files, and so does
 * daemon.js when it writes cost_usd rows, so a wrong number here is a wrong
 * number in every spend figure the product reports.
 *
 * SCOPE — deliberately limited to `openrouter/*` models.
 *   OpenRouter resells models we also offer direct (openai, anthropic, google,
 *   deepseek, qwen). Their rates are NOT the same: at time of writing 8 of the
 *   25 overlapping models differ — openai/gpt-5.6-sol is $5/$30 direct in our
 *   file but $2/$10 on OpenRouter. We can't tell from OpenRouter's catalogue
 *   what the direct vendor charges, so those entries are left alone. Keep them
 *   updated by hand from each provider's own pricing page.
 *
 * The endpoint is public — no API key, CDN-cached, never billed.
 *
 * Usage:
 *   node scripts/refresh-model-pricing.mjs            # apply
 *   node scripts/refresh-model-pricing.mjs --dry-run  # preview only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRICING_FILE = path.join(ROOT, 'model-pricing.json');
const MODELS_FILE = path.join(ROOT, 'models.config.json');
const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';

const dryRun = process.argv.includes('--dry-run');

function perMillion(raw) {
  if (raw === undefined || raw === null) return null;
  const n = parseFloat(raw);
  // -1 marks router models (OpenRouter Auto): dynamic, not a real price.
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

/** Round to the precision the file already uses, so we don't churn on float noise. */
function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Serialise model-pricing.json in the shape the committed file has: integers as
 * integers (`5`, not `5.0`) and up to six decimals otherwise. `perMillion` already
 * rounds there, so `String` cannot emit float noise, and a run rewrites only the lines
 * whose price actually moved — which is what makes the diff reviewable.
 */
function serialisePricing(pricing) {
  const num = (n) => String(n);
  const body = Object.entries(pricing)
    .map(([id, p]) => `  ${JSON.stringify(id)}: {\n    "input": ${num(p.input)},\n    "output": ${num(p.output)}\n  }`)
    .join(',\n');
  return `{\n${body}\n}\n`;
}

/**
 * Our catalogue namespaces OpenRouter entries as `openrouter/<upstream id>`,
 * but OpenRouter also publishes house models under a literal `openrouter/`
 * vendor prefix (openrouter/auto). Try the stripped form, then the id as-is.
 */
function upstreamCandidates(id) {
  const stripped = id.slice('openrouter/'.length);
  return stripped === id ? [id] : [stripped, id];
}

async function main() {
  console.log(`Fetching ${CATALOGUE_URL} …`);
  const res = await fetch(CATALOGUE_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    console.error(`✗ Catalogue returned HTTP ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  if (!Array.isArray(body?.data) || body.data.length === 0) {
    console.error('✗ Unexpected catalogue shape');
    process.exit(1);
  }
  const live = new Map(body.data.map((m) => [m.id, m]));
  console.log(`  ${live.size} models upstream\n`);

  const modelsDoc = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf-8'));
  const models = Array.isArray(modelsDoc) ? modelsDoc : modelsDoc.models;
  const pricing = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf-8'));

  const priceChanges = [];
  const modalityChanges = [];
  let missing = 0;
  let dynamic = 0;

  for (const m of models) {
    if (m.provider !== 'openrouter') continue;

    let up = null;
    for (const candidate of upstreamCandidates(m.id)) {
      if (live.has(candidate)) { up = live.get(candidate); break; }
    }
    if (!up) {
      missing++;
      console.log(`  ? ${m.id} — not in the upstream catalogue, left as-is`);
      continue;
    }

    // Pricing
    const input = perMillion(up.pricing?.prompt);
    const output = perMillion(up.pricing?.completion);
    if (input === null || output === null) {
      dynamic++; // router model — keep whatever the file says (-1/-1)
    } else {
      const current = pricing[m.id];
      const next = { input: round(input), output: round(output) };
      if (!current || current.input !== next.input || current.output !== next.output) {
        priceChanges.push({
          id: m.id,
          from: current ? `$${current.input}/$${current.output}` : '(none)',
          to: `$${next.input}/$${next.output}`,
        });
        pricing[m.id] = next;
      }
    }

    // Modality — updating the curated file (rather than overriding at runtime)
    // keeps the UI and app/api/gateway/sync.ts, which provisions containers
    // from this same value, in agreement.
    const upModality = up.architecture?.modality;
    if (upModality && upModality !== m.modality) {
      modalityChanges.push({ id: m.id, from: m.modality ?? '(none)', to: upModality });
      m.modality = upModality;
    }
  }

  console.log(`\nPricing:  ${priceChanges.length} changed`);
  for (const c of priceChanges) console.log(`  ${c.id}\n      ${c.from}  →  ${c.to}`);

  console.log(`\nModality: ${modalityChanges.length} changed`);
  for (const c of modalityChanges) console.log(`  ${c.id}\n      ${c.from}  →  ${c.to}`);

  const direct = models.filter((m) => m.provider !== 'openrouter').length;
  console.log(
    `\nSkipped:  ${dynamic} dynamic (router), ${missing} not upstream, ` +
    `${direct} direct-provider (different vendor, different rates — update by hand)`,
  );

  if (priceChanges.length === 0 && modalityChanges.length === 0) {
    console.log('\n✓ Already up to date.');
    return;
  }

  if (dryRun) {
    console.log('\n(dry run — nothing written)');
    return;
  }

  fs.writeFileSync(PRICING_FILE, serialisePricing(pricing), 'utf-8');
  fs.writeFileSync(MODELS_FILE, JSON.stringify(modelsDoc, null, 2) + '\n', 'utf-8');
  console.log('\n✓ Wrote model-pricing.json and models.config.json');
  console.log('  Review the diff before committing.');
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
