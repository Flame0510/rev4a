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
/** Generated: descriptions, specs, benchmarks. Never hand-edited (see the plan). */
const DETAILS_FILE = path.join(ROOT, 'model-details.json');
import { CATALOGUE_URL, fetchUpstream, matchUpstream } from './lib/model-upstream.mjs';

const dryRun = process.argv.includes('--dry-run');

/**
 * A direct provider's OpenRouter vendor name, when it differs from ours:
 * `glm/glm-5.3` is `z-ai/glm-5.3` upstream, `kimi/kimi-k3` is `moonshotai/kimi-k3`.
 * Used for details only — prices for direct entries come from the vendor's own price list.
 */
const VENDOR_ALIAS = { glm: 'z-ai', kimi: 'moonshotai' };

/**
 * Same model, different name on OpenRouter. Only exact same-model cases belong here: a
 * different tier (`-highspeed`) or another vendor's copy of the weights is a curated
 * `info` block, not an alias, because description and benchmarks would be someone else's.
 */
const MODEL_ALIAS = {
  'deepseek/deepseek-flash': 'deepseek/deepseek-v4.1-flash',   // our name for DeepSeek's V4.1
};

/**
 * Try the id with its version separators swapped: our `claude-haiku-4-5` is OpenRouter's
 * `claude-haiku-4.5`. A normalisation, not an alias: the name is otherwise identical.
 */
function separatorVariants(id) {
  return [
    id.replace(/-(\d+)-(\d+)$/, '-$1.$2'),   // claude-haiku-4-5 → claude-haiku-4.5
    id.replace(/-(\d+)\.(\d+)$/, '-$1-$2'), // and the other way round
  ].filter((v) => v !== id);
}

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
    .map(([id, p]) => {
      const rates = [['input', p.input], ['output', p.output], ['cacheRead', p.cacheRead], ['cacheWrite', p.cacheWrite]]
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `    "${k}": ${num(v)}`);
      return `  ${JSON.stringify(id)}: {\n${rates.join(',\n')}\n  }`;
    })
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

/** The fields the details modal shows, taken from the OpenRouter entry. */
function detailsFor(up) {
  const a = up.architecture ?? {};
  const tp = up.top_provider ?? {};
  const fields = {
    description: up.description,
    created: up.created ? new Date(up.created * 1000).toISOString().slice(0, 10) : undefined,
    context: up.context_length,
    providerContext: tp.context_length,
    maxOutput: tp.max_completion_tokens,
    tokenizer: a.tokenizer,
    instructType: a.instruct_type,
    knowledgeCutoff: up.knowledge_cutoff,
    huggingFaceId: up.hugging_face_id,
    canonicalSlug: up.canonical_slug,
    url: `https://openrouter.ai/${up.id}`,
    reasoning: up.reasoning,
    supportedParameters: up.supported_parameters,
    moderated: tp.is_moderated === true ? true : undefined,
    benchmarks: up.benchmarks,
  };
  // Drop what upstream does not have: the modal hides absent fields, it never prints "n/a".
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * Parameter count and architecture, from the model's Hugging Face card. OpenRouter does
 * not publish sizes and only the open-weight models have a card: a model without one (or
 * a card without safetensors metadata) simply gets no `params`, and the modal hides the
 * row. `--no-hf` skips the lookups entirely.
 */
async function huggingFaceFacts(hfId) {
  try {
    const [meta, config] = await Promise.all([
      fetch(`https://huggingface.co/api/models/${hfId}?blobs=true`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
      // The API's summary config is reduced; the raw file is what carries the architecture.
      fetch(`https://huggingface.co/${hfId}/raw/main/config.json`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!meta && !config) return null;

    const out = {};
    const total = meta?.safetensors?.total;
    if (typeof total === 'number' && total > 0) out.params = total;

    // A multimodal model nests its language model under text_config; text-only ones are flat.
    const cfg = config ?? meta?.config ?? {};
    const text = cfg.text_config ?? cfg;
    const num = (v) => (typeof v === 'number' ? v : undefined);
    const experts = num(text.num_experts) ?? num(text.n_routed_experts);
    const perToken = num(text.num_experts_per_tok) ?? num(text.n_experts_per_tok);
    const byDtype = meta?.safetensors?.parameters;
    const tags = Array.isArray(meta?.tags) ? meta.tags : [];
    const card = meta?.cardData ?? {};
    // The weights' on-disk size: what pulling this model actually costs.
    const weightsBytes = (Array.isArray(meta?.siblings) ? meta.siblings : [])
      .filter((f) => typeof f?.rfilename === 'string' && f.rfilename.endsWith('.safetensors'))
      .reduce((sum, f) => sum + (Number(f.size) || 0), 0);

    const hf = {
      id: hfId,
      total,
      byDtype: byDtype && Object.keys(byDtype).length ? byDtype : undefined,
      family: (Array.isArray(cfg.architectures) ? cfg.architectures[0] : undefined) ?? undefined,
      modelType: typeof cfg.model_type === 'string' ? cfg.model_type : undefined,
      moe: experts ? { experts, perToken, shared: num(text.n_shared_experts) } : undefined,
      layers: num(text.num_hidden_layers),
      hidden: num(text.hidden_size),
      heads: num(text.num_attention_heads),
      kvHeads: num(text.num_key_value_heads),
      vocab: num(text.vocab_size),
      context: num(text.max_position_embeddings),
      vision: cfg.vision_config ? true : undefined,
      quantization: cfg.quantization_config?.quant_method ?? (tags.includes('compressed-tensors') ? 'compressed-tensors' : undefined),
      task: typeof meta?.pipeline_tag === 'string' ? meta.pipeline_tag : undefined,
      languages: Array.isArray(card.language) ? card.language : undefined,
      license: typeof card.license === 'string' ? card.license : undefined,
      // `license: other` carries a custom name in license_name (often the model's own, not an id).
      licenseName: typeof card.license_name === 'string' && card.license_name !== card.license ? card.license_name : undefined,
      published: typeof meta?.createdAt === 'string' ? meta.createdAt.slice(0, 10) : undefined,
      updated: typeof meta?.lastModified === 'string' ? meta.lastModified.slice(0, 10) : undefined,
      weightsBytes: weightsBytes > 0 ? weightsBytes : undefined,
      // Keep the tags that say something about the model; drop the plumbing
      // (transformers, safetensors, the model type, the task, languages, licence/arxiv markers).
      tags: (() => {
        const drop = new Set(['transformers', 'safetensors', 'eval-results', 'endpoints_compatible', 'region:us',
          'text-generation', 'image-text-to-text', 'feature-extraction', 'conversational', cfg.model_type]);
        const kept = tags.filter((t) => typeof t === 'string' && !t.includes(':') && !drop.has(t) && !/^[a-z]{2}$/.test(t));
        return kept.length ? kept : undefined;
      })(),
      downloads: num(meta?.downloads),
      likes: num(meta?.likes),
    };
    const cleaned = Object.fromEntries(Object.entries(hf).filter(([, v]) => v !== undefined));
    if (Object.keys(cleaned).length > 1) out.hf = cleaned;  // > 1: the id alone says nothing
    out.paramsSource = 'huggingface';
    return out;
  } catch {
    return null;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

async function main() {
  console.log(`Fetching ${CATALOGUE_URL} …`);
  const live = await fetchUpstream().catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
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

    const up = matchUpstream(live, m.id);
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
      // Cache rates when OpenRouter publishes them: OpenClaw prices cached tokens with
      // these, and without one they fall back to the input rate (lib/model-pricing.ts).
      const cacheRead = perMillion(up.pricing?.input_cache_read);
      const cacheWrite = perMillion(up.pricing?.input_cache_write);
      if (cacheRead !== null) next.cacheRead = round(cacheRead);
      if (cacheWrite !== null) next.cacheWrite = round(cacheWrite);
      const show = (x) => `${x.input}/${x.output}` + (x.cacheRead !== undefined ? ` cache ${x.cacheRead}` : '');
      if (!current || ['input', 'output', 'cacheRead', 'cacheWrite'].some((k) => current[k] !== next[k])) {
        priceChanges.push({
          id: m.id,
          from: current ? show(current) : '(none)',
          to: show(next),
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

  // ── Details ────────────────────────────────────────────────────────────────
  // One entry per catalogue model we can match upstream, so the file's key space is
  // our catalogue's. Direct entries are matched through VENDOR_ALIAS for the data
  // only; their price stays in model-pricing.json, from their own vendor.
  const upstreamMatch = (id) => matchUpstream(live, id);
  const details = {};
  for (const m of models) {
    const up = upstreamMatch(m.id);
    if (up) details[m.id] = detailsFor(up);
  }
  // Hugging Face pass: sizes for the open-weight models, small concurrency.
  if (!process.argv.includes('--no-hf')) {
    const withHf = Object.entries(details).filter(([, v]) => v.huggingFaceId);
    const queue = [...withHf];
    const worker = async () => {
      while (queue.length) {
        const [id, entry] = queue.shift();
        const facts = await huggingFaceFacts(entry.huggingFaceId);
        if (facts) Object.assign(entry, facts, { paramsSource: 'huggingface' });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    console.log(`\nParameters: ${withHf.filter(([, v]) => v.params).length} of ${withHf.length} Hugging Face cards answered`);
  }

  const previous = readJson(DETAILS_FILE);
  const sameDetails = previous?.models && JSON.stringify(previous.models) === JSON.stringify(details);
  const generatedAt = sameDetails && previous.generatedAt ? previous.generatedAt : new Date().toISOString();

  console.log(`\nDetails: ${Object.keys(details).length} of ${models.length} models matched upstream` +
    (sameDetails ? ' (unchanged)' : ''));

  console.log(`\nModality: ${modalityChanges.length} changed`);
  for (const c of modalityChanges) console.log(`  ${c.id}\n      ${c.from}  →  ${c.to}`);

  const direct = models.filter((m) => m.provider !== 'openrouter').length;
  console.log(
    `\nSkipped:  ${dynamic} dynamic (router), ${missing} not upstream, ` +
    `${direct} direct-provider (different vendor, different rates — update by hand)`,
  );

  if (priceChanges.length === 0 && modalityChanges.length === 0 && sameDetails) {
    console.log('\n✓ Already up to date.');
    return;
  }

  if (dryRun) {
    console.log('\n(dry run — nothing written)');
    return;
  }

  fs.writeFileSync(PRICING_FILE, serialisePricing(pricing), 'utf-8');
  fs.writeFileSync(MODELS_FILE, JSON.stringify(modelsDoc, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(DETAILS_FILE, JSON.stringify({ source: 'openrouter', generatedAt, models: details }, null, 2) + '\n', 'utf-8');
  console.log('\n✓ Wrote model-pricing.json and models.config.json');
  console.log('  Review the diff before committing.');
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
