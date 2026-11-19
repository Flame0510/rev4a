---
name: rev4a-models-update
description: Discover upstream models, maintain the Rev4a proxy catalogue and prices, and check which models signed-in OpenClaw agents offer. Use for "update models", "new models", "model catalogue", "model prices", "gateway models", or "subscription models".
---

# Update the Rev4a model catalogue

## Scope

The proxy catalogue covers Google, OpenAI, Anthropic, DeepSeek, Groq, Kimi, GLM, Qwen and OpenRouter. Edit the worktree's `models.config.json` for catalogue entries and optional `info` blocks, and `model-pricing.json` for rates. Generate `model-details.json` with `npm run refresh:pricing` and keep manual edits out of it. Use the Gateway reference for the catalogue, pricing and deprecation rules. [Gateway maintenance reference](../../docs/dev/GATEWAY.md#maintaining-the-model-catalogue)

ChatGPT (Codex) and Claude subscription models come from signed-in OpenClaw agents. Their bare `openai/<id>` and `anthropic/<id>` refs are separate from `rev4a/<provider>/<id>` proxy refs. Keep subscription entries out of the proxy catalogue. Limit changes to the worktree. Treat agent assignments and live host configuration as read-only, and leave publishing to the release workflow. [Subscription and proxy model references](../../docs/dev/GATEWAY.md#subscription-models-and-proxy-models)

## Sources of truth

Start with the vendor's official model catalogue, pricing and deprecation documentation. Use the API product, region and tier that match the proxy configuration and credential. The source links and list routes below were checked on 2026-11-18. [Proxy configuration](../../app/api/provider/upstream.ts#L31)

| Provider | Models page | Pricing page | Deprecations page | `/models` list route and auth header |
|---|---|---|---|---|
| OpenAI (`openai`) | [All models](https://developers.openai.com/api/docs/models/all) | [API pricing](https://developers.openai.com/api/docs/pricing) | [Deprecations](https://developers.openai.com/api/docs/deprecations) | `GET https://api.openai.com/v1/models`, `Authorization: Bearer <key>`. [API reference](https://developers.openai.com/api/reference/resources/models/methods/list) |
| Google Gemini API (`google`) | [Gemini Developer API models](https://aistudio.google.com/docs/models) | [Gemini Developer API pricing](https://aistudio.google.com/docs/pricing) | [Gemini deprecations](https://aistudio.google.com/docs/deprecations) | `GET https://generativelanguage.googleapis.com/v1beta/openai/models`, `Authorization: Bearer <key>`. [Compatibility reference](https://aistudio.google.com/docs/openai#list-models) |
| Anthropic (`anthropic`) | [Claude API models](https://platform.claude.com/docs/en/models/overview) | [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing) | [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) | `GET https://api.anthropic.com/v1/models`, `Authorization: Bearer <key>` and `anthropic-version: 2026-10-21` as shown in the current [API reference](https://platform.claude.com/docs/en/api/models/list). [`x-api-key` is also supported](https://platform.claude.com/docs/en/api/overview#authentication). |
| DeepSeek (`deepseek`) | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | [Retirement notices in the API changelog](https://api-docs.deepseek.com/updates/) | `GET https://api.deepseek.com/models`, `Authorization: Bearer <key>`. [List reference](https://api-docs.deepseek.com/api/list-models/), [API authentication](https://api-docs.deepseek.com/api/deepseek-api/) |
| Qwen (Alibaba Cloud Model Studio / DashScope, `qwen`) | [Text generation and vision models](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/text-generation-model), [regional catalogue links](https://www.alibabacloud.com/help/en/model-studio/regions) | [Model invocation pricing](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/model-pricing) | [Model decommissioning policy and notices](https://www.alibabacloud.com/help/en/model-studio/model-depreciation) | A list route on the proxy's DashScope domain is not documented by the vendor as of 2026-11-18. Beijing workspace alternative: `GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/models`, `Authorization: Bearer <key>`. [Workspace API reference](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/list-models) |
| GLM (Z.ai, `glm`) | [Standard API model overview](https://docs.z.ai/guides/overview/overview) | [Standard API pricing](https://docs.z.ai/guides/overview/pricing) | None published as of 2026-11-18. [Official documentation index](https://docs.z.ai/llms.txt) | Not documented by the vendor as of 2026-11-18. [Standard HTTP API docs](https://docs.z.ai/guides/develop/http/introduction) |
| Kimi (Moonshot, `kimi`) | [Mainland model list](https://platform.kimi.com/docs/models), [international model list](https://platform.kimi.ai/docs/models) | [Mainland pricing](https://platform.kimi.com/docs/pricing/chat), [international pricing](https://platform.kimi.ai/docs/pricing/chat) | [Mainland model list and retirements](https://platform.kimi.com/docs/models), [international deprecations](https://platform.kimi.ai/docs/models#deprecated-models) | Mainland: `GET https://api.moonshot.cn/v1/models`. International: `GET https://api.moonshot.ai/v1/models`. Both use `Authorization: Bearer <key>`. [Mainland API reference](https://platform.kimi.com/docs/api/list-models), [international API reference](https://platform.kimi.ai/docs/api/list-models) |
| Groq (`groq`) | [GroqCloud supported models](https://console.groq.com/docs/models) | [GroqCloud per-model prices](https://console.groq.com/docs/models#production-models) | [Model deprecations](https://console.groq.com/docs/deprecations) | `GET https://api.groq.com/openai/v1/models`, `Authorization: Bearer <key>`. [API reference](https://console.groq.com/docs/api-reference#models-list) |
| OpenRouter (`openrouter`) | [Official public models JSON](https://openrouter.ai/api/v1/models) | [Per-model rates in the same JSON](https://openrouter.ai/api/v1/models) | [Models API guide for `expiration_date`](https://openrouter.ai/docs/guides/overview/models#models-api-standard) | `GET https://openrouter.ai/api/v1/models`, public with no auth header. The public JSON and examples work without a key. The generated API reference marks its bearer header as required. [Models API guide](https://openrouter.ai/docs/guides/overview/models), [API reference](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) |

- **Google.** Use Gemini Developer API pricing and lifecycle docs. The table's listing uses the same OpenAI-compatible base as the proxy. The native listing is also documented at `GET https://generativelanguage.googleapis.com/v1beta/models` with `x-goog-api-key: <key>`. [Native list reference](https://aistudio.google.com/api-reference/models/list-models), [native API authentication](https://aistudio.google.com/api-reference)
- **Qwen.** Use the English international documentation and select China (Beijing) availability and the matching deployment scope and price rows for the configured DashScope endpoint. The Singapore listing and rates apply to that region. A workspace list uses a matching Beijing workspace key and is an optional cross-check. [Regional endpoints](https://www.alibabacloud.com/help/en/model-studio/base-url)
- **Kimi.** The proxy uses Moonshot's mainland endpoint. Use mainland evidence for its catalogue and rates. Keep international findings labelled separately and flag any missing mainland price or conflicting lifecycle status. [Mainland setup](https://platform.kimi.com/docs/get-api-key), [international setup](https://platform.kimi.ai/docs/get-your-api-key)

## Phase 1 — Collect

An agent with web search can complete this phase without shell network access or vendor keys. Use an operator-supplied snapshot if web access is unavailable.

1. Open each direct vendor's official models, pricing and deprecation pages. Prefer the vendor's own domain over blogs, news and aggregators. Never take a figure from a search snippet without opening the source page. Use the published API IDs, display names, supported endpoints, modalities, prices and lifecycle notices. If official pages disagree, record both URLs and read dates and flag the discrepancy. Use OpenRouter's public models JSON as its official source for the same fields.
2. Use the operator's run folder when specified, including a path inside the worktree. Otherwise create a writable `models-update-YYYY-MM-DD` folder outside the worktree using the UTC date. Record the path in the report and always keep the folder untracked. In each `<provider>.sources.md`, record the source URLs, UTC dates read, API product, region, tier, launch cutoff or release baseline, and whether the listing is complete or a selected subset. Copy relevant model and price rows into separate Markdown tables, including OpenRouter. Cite each row against a dated source. Record exact IDs, names, variants, endpoints, modalities, lifecycle status, aliases, retirement dates and replacements. Keep original currency and units, context thresholds, cache rules, promotion dates and off-peak windows. Flag incomplete coverage and missing fields.
3. For direct providers, optionally cross-check with the documented listing API if an authorized key and API access are available. Take keys from the environment or have the operator supply them securely. Use keys only in request headers. Never print, log or save a key, and never read Rev4a's `provider-keys.json` vault. Save successful, credential-free responses as `<provider>.models.json` when available, including the public OpenRouter response. For paginated responses, use `<provider>.models.1.json`, `<provider>.models.2.json` and so on. Follow all continuation links or cursors and record the page order and how you confirmed the last page. Keep request headers and verbose traces out of the run folder. Record failed, empty, partial and account-scoped lists. Check missing IDs against official catalogue and retirement docs before treating them as gone. One key's list can omit available IDs or include models outside the proxy's scope.

`npm run refresh:pricing` and `npm run info:suggest` need shell network access. Have the operator or an agent with shell network access run them when needed, then review the generated diff and suggestions. `info:verify` also needs shell network access when the required card cache is missing or link checks are requested. With snapshots alone, proceed with Phase 2, supported manual edits and local checks. Record pending commands in the handoff. [Pricing refresh](../../scripts/refresh-model-pricing.mjs), [suggestion](../../scripts/model-info-suggest.mjs), [verification](../../scripts/model-info-verify.mjs)

## Phase 2 — Diff

Produce one row per provider in the report. Record old and new values for drift and cite the snapshot or notice. Check display-name and lifecycle changes against the dated model rows. Use `unverified` for a missing or incomplete comparison.

| Provider | New upstream IDs | Catalogue IDs absent upstream | Price drift | Modality drift |
|---|---|---|---|---|
| One row per provider | ID and whether fit for proxy use | ID and confirmed availability or retirement status | ID, old and new rates, tier | ID, old and new capability sets |

For direct providers, compare the documented model table in `<provider>.sources.md` to that provider's entries in `models.config.json`. For OpenRouter, compare the public JSON or its table in `openrouter.sources.md`. To run the ID comparison from a table, copy its raw API IDs into `<provider>.ids.txt`, one per line with no headings or Rev4a prefixes. Set `provider` to the catalogue provider key and `snapshot` to that text file. Run from the repo root. For a JSON comparison, set `snapshot` to the saved response and pass any additional pages in request order after `"$snapshot"` on the first line. Verify the cursor chain in the collection notes, including pagination indicated by response headers or vendor-specific fields. Compare direct-provider JSON results separately as an availability cross-check. Treat apparent absences as candidates and mark incomplete coverage `unverified`.

```bash
node --input-type=module - "$provider" "$snapshot" <<'NODE'
import { readFileSync } from 'node:fs';
const [provider, ...pages] = process.argv.slice(2);
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const local = new Set(read('models.config.json').models
  .filter((model) => model.provider === provider).map((model) => model.id));
if (!pages.length || !local.size) throw new Error('Supply a catalogue provider and saved model list');
const cursorFields = [
  'nextPageToken', 'next_page_token', 'nextCursor', 'next_cursor', 'nextToken', 'next_token',
  'nextPage', 'next_page', 'next',
];
const hasNextPage = (body) => [
  body, body?.pagination, body?.paging, body?.meta, body?.meta?.pagination, body?.links,
].some((page) => page && (
  page.has_more === true || page.hasMore === true || page.hasNextPage === true
    || cursorFields.some((field) => Boolean(page[field]))
));
const upstream = new Set();
for (const [index, page] of pages.entries()) {
  let ids;
  if (page.endsWith('.ids.txt')) {
    ids = readFileSync(page, 'utf8').split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
  } else {
    const body = read(page);
    const workspaceList = provider === 'qwen' ? body?.output : null;
    if (index === pages.length - 1 && (hasNextPage(body)
        || (workspaceList && workspaceList.page_no * workspaceList.page_size < workspaceList.total))) {
      throw new Error(`Pagination is incomplete after ${page}`);
    }
    let rows = body?.data;
    let idField = 'id';
    if (provider === 'google' && Array.isArray(body?.models)) {
      rows = body.models;
      idField = 'name';
    } else if (workspaceList) {
      rows = workspaceList.models;
      idField = 'model';
    }
    if (!Array.isArray(rows)) throw new Error(`Unusable list in ${page}`);
    ids = rows.map((row) => row?.[idField]);
  }
  if (!ids.length) throw new Error(`Unusable list in ${page}`);
  for (const rawId of ids) {
    if (typeof rawId !== 'string' || !rawId.trim()) throw new Error(`Missing model ID in ${page}`);
    const id = provider === 'google' ? rawId.replace(/^models\//, '') : rawId;
    upstream.add(provider === 'openrouter' && id === 'openrouter/auto' ? id : `${provider}/${id}`);
  }
}
const difference = (left, right) => [...left].filter((id) => !right.has(id)).sort();
console.log(JSON.stringify({ newIds: difference(upstream, local), absentIds: difference(local, upstream) }, null, 2));
NODE
```

- Distinguish launches after the recorded cutoff from older IDs missing locally. Classify candidates by endpoint, lifecycle and variant. Review preview, dated, free and media variants individually, and exclude models that only support endpoints outside the proxy, such as embeddings or Batch-only generation.
- Before adding an ID, check aliases, punctuation, version separators and redirects. `matchUpstream` tries exact IDs first, then known aliases and separator variants. It preserves suffixes such as `:batch`, `:free` and `:extended`. Vendor aliases for direct models apply to generated details. For an absent OpenRouter ID, open its public endpoints listing and model page. Record capture freshness, empty endpoints, redirects and any published retirement notice or future `expiration_date`. An empty list leaves formal retirement and account availability unverified. [OpenRouter matching](../../scripts/lib/model-upstream.mjs)
- Compare direct rates to the copied price tables. For OpenRouter, use the peak row at the shortest context tier when rates vary by UTC window. Multiply finite, nonnegative `prompt`, `completion`, `input_cache_read` and `input_cache_write` rates by 1,000,000 and round to six decimals. Carry the dynamic `-1` sentinel through unscaled as the bundled `input: -1`, `output: -1` pair. The refresh retains the existing row if either base rate is negative or missing and omits unusable cache rates from refreshed static rows. Check missing price rows and schedules as well. [Price conversion](../../scripts/refresh-model-pricing.mjs), [OpenRouter pricing overrides](https://openrouter.ai/docs/guides/overview/models#pricing-overrides)
- Compare modalities as sets on each side of `->`. `text+image` and `image+text` are equivalent. Use the input and output types supported by the actual Chat Completions route and check OpenRouter's `architecture.input_modalities` and `architecture.output_modalities` when present. Record capabilities the proxy or supported OpenClaw versions cannot use. [Gateway compatibility rules](../../docs/dev/GATEWAY.md#key-design-decisions)

### Direct provider compatibility

Before enabling a direct model or advertising a new modality, trace the effective URL, auth headers and request body through `callUpstream`. Compare them with the vendor's Chat Completions guide. Check the model's supported content parts, streaming and usage options, tool restrictions and any required upload or follow-on API. Google uses `/v1beta/openai/chat/completions`. Anthropic rejects `file` parts on its chat adapter. Kimi video can require a vendor upload. Record discrepancies and leave affected models off by default and unsupported modalities out of the catalogue until compatible. Record whether an authorized smoke test confirmed the result. [Proxy implementation](../../app/api/provider/upstream.ts), [Google compatibility](https://aistudio.google.com/docs/openai), [Anthropic compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk), [Kimi guide](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)

### Decisions to confirm with the maintainer

Write a proposal at the end of Phase 2 using this default-enabled policy:

1. A configured provider key makes its enabled defaults available to operators, subject to their overrides. Give every direct provider at least one enabled default so its initial model list is never empty.
2. Propose two or three stable, current-generation models per direct provider to cover flagship, balanced, and low-cost or fast use. Use the vendor's own docs to identify the general-purpose or recommended starting model and cite the rationale and price for each pick. Flag any provider with fewer than two eligible choices for the maintainer.
3. Keep older generations, previews, niche variants such as legal and high-speed models, pro tiers priced far above the flagship, free or rate-limited tiers, duplicate spellings, and deprecated names off by default. Keep those IDs in the catalogue so operators can toggle them.
4. Keep every existing default on in the release that proposes disabling it. List the older defaults proposed for disabling in the next release, with their exact IDs and replacements, in the run report. Apply a disablement only after maintainer approval and a complete [assignment audit](#before-disabling-or-removing-an-id).
5. Apply the same policy to OpenRouter in a separate review of its larger catalogue.
6. Show one table per provider, including OpenRouter, with columns `Catalogue ID`, `Default (on/off)`, `Price` (input/output per million tokens, with currency and tier), and `Reason`. Include existing defaults and candidates under review. Show defaults deferred for disabling as on in the current release. Call out any picker-order or preselection change, including the first model in Create Agent. Ask the maintainer to confirm or adjust the proposal, then wait for their answer before Phase 3. Record the confirmed decisions in the run report.

## Phase 3 — Edit

1. **Gone upstream.** Keep the ID, price row and enabled default in the first deprecation release. If an existing OpenRouter ID's public endpoints response is empty, set `deprecated: true`, preserve its `enabled` value and list the ID for the assignment audit. Record formal retirement and account availability as unverified unless independently confirmed. Revisit confirmed withdrawals in a later release after the audit.
2. **Price drift.** Bundle the public Standard rate in force on the run date at the shortest published context tier. Exclude Batch and Flex rates. Record the other tiers, known promotion end dates and any successor billing dates in the snapshot. For CNY prices, record the original rates, the dated CNY-to-USD exchange rate and its source before converting to USD per million tokens. Use peak rates, including published cache rates, for scheduled pricing. Record published cache-hit discounts, such as Groq's 50%, as a `cacheRead` rate and record the applicable `cacheWrite` rate and tier. Use the input rate for `cacheWrite` if the vendor bills cache creation as ordinary input. Omit cache rates that remain unverified and flag pricing the schema cannot express. Put verified off-peak UTC windows in `PRICE_SCHEDULES` when the run includes schedule edits. [Price schema and schedules](../../lib/model-pricing.ts#L14)
3. **Modality drift.** Update the curated `modality` only for a confirmed, supported capability change. Preserve equivalent ordering.
4. **New models.** Use `<provider>/<upstream-id>` for direct entries and `openrouter/<upstream-id>` for OpenRouter, whose upstream ID normally includes a vendor segment. Preserve the existing `openrouter/auto` convention. Keep `provider` aligned with the first segment and use human-readable names in the existing style, such as `GPT-5.6 Sol`. Apply the enabled defaults and order confirmed in Phase 2. OpenRouter copies of DeepSeek ship disabled because the direct provider is preferred. Ensure every enabled addition has a price row. [Catalogue examples](../../models.config.json), [policy and overrides](../../docs/dev/GATEWAY.md#policy-vs-availability)
5. **Retired names.** Mark documented future expirations and retired aliases with `deprecated: true`. A label that preserves the offered state can ship without an assignment audit. Never change `enabled: true` to `false` in the release that first flags the ID as deprecated. Apply a verified successor rate once the vendor starts billing it. Keep deprecation text out of `name`. [Deprecation lifecycle](../../docs/dev/GATEWAY.md#the-deprecation-lifecycle)
6. **Refresh OpenRouter and details (needs network).** Run `npm run refresh:pricing -- --dry-run`, then `npm run refresh:pricing`. OpenRouter's top-level rates can reflect the current UTC window. For a scheduled model, the refresh selects the peak rate row from `pricing.overrides`. When it cannot identify the peak, it preserves the bundled price and prints `time-windowed, review by hand`. Resolve those rows from verified peak evidence. If a known schedule is absent from the payload, verify the peak by hand before applying any change. Offline, use the same rule for new rows and record any deferred live refresh. Review generated rates and preserve curated modalities where the generated change only reorders values or advertises unsupported capabilities. Keep the complete OpenRouter snapshot current with the refresh for the coverage check. [Refresh implementation](../../scripts/refresh-model-pricing.mjs), [OpenRouter pricing overrides](https://openrouter.ai/docs/guides/overview/models#pricing-overrides)
7. **Curate `info` when a new model has a card.** Save the candidate IDs in the run folder. After generating details, pass the IDs as separate arguments to `npm run --silent info:suggest -- --json <id> [<id> …]` and save the output there. Prepare proposals with field-level evidence from the exact variant, then run `npm run info:verify -- "$run_dir/proposals.json"`. Offline verification requires `models[model_id].hf.id` and a cached exact-card README at `/tmp/card-<owner>_<repo>.md`. Suggestion can find an upstream card even when verification skips it for missing generated `hf.id`. Check the warnings and list every skipped proposal with the result of a manual exact-variant check. Keep supported claims only. Fetching an uncached card or using `--check-links` needs network. [Curating an `info` block](../../docs/dev/GATEWAY.md#curating-an-info-block), [card suggestion](../../scripts/model-info-suggest.mjs#L83), [card cache and prerequisite](../../scripts/model-info-verify.mjs#L104)

## Before disabling or removing an ID

1. Collect primaries and all fallbacks. Start with the Agents page or authenticated `GET /api/agents/models-summary` for running and stopped agents. The summary exposes the default primary, fallback count and first fallback only. Read `GET /api/agents/<id>/model` for all default fallbacks on reachable agents. For stopped or unreachable agents, or to check per-agent overrides, use authorized read-only access or ask for a sanitized extract of `agents.defaults.model` and `agents.list[].model` from the container's `/root/.openclaw/openclaw.json`. Check `main` and any other entries. Record unreadable configs as unverified. [Fleet summary](../../app/api/agents/models-summary/route.ts), [per-agent read](../../app/api/agents/%5Bid%5D/model/route.ts), [assignment writer](../../app/api/gateway/agent/route.ts)
2. Audit scheduled jobs on each agent, including disabled jobs. Use the read-only `openclaw_for_agent cron list --json --all` with the [wrapper below](#subscription-models-check), or ask for a complete sanitized job extract from the operator. Check explicit `payload.model` pins on `agentTurn` jobs whose `sessionTarget` is other than `main`. Jobs set to Default follow the agent assignments audited above. Rev4a's SQLite-backed reader shows the read-only source for those pins when that store is available. Defer removal if job assignments are unreadable or the list is incomplete. [CLI listing](../../lib/openclaw-cron.ts#L186), [cron pin reader](../../lib/agent-update-cron-account.ts#L33)
3. For each stored `rev4a/...` reference, including job pins, resolve `extractProviderAndModel({ model: ref })` in the proxy and compare its returned `<provider>/<model>` to the catalogue ID. Pass the model reference with its `rev4a/` prefix. For a job pin qualified by an OpenClaw account, confirm its model portion against the installed version before comparing. The resolver checks `MODEL_ALIASES` first. The current legacy aliases are `rev4a/deepseek-flash` → `deepseek/deepseek-flash` and `rev4a/deepseek-v4-pro` → `deepseek/deepseek-v4-pro`. Report the stored model reference and resolved ID for each match. [Proxy aliases](../../app/api/provider/upstream.ts#L73), [resolver](../../app/api/provider/upstream.ts#L88), [OpenClaw account qualification](../../docs/dev/GATEWAY.md#automation-account-adoption-on-openclaw-20261010)
4. In release N, keep the ID and its enabled default. For a vendor retirement, add the deprecation flag. In N+1 or later, disable the default or remove the ID only after a complete audit confirms no affected configuration or job still relies on it. Account for overrides that may still offer a disabled ID. Report affected assignments and replacements, and record when the audit was skipped. Delete the price row with the ID. Treat the Agents page's `NOT IN CATALOGUE` chip as a hint. Its health check can flag a legacy alias the proxy still serves. [Gateway lifecycle](../../docs/dev/GATEWAY.md#the-deprecation-lifecycle), [fleet health calculation](../../app/api/agents/models-summary/route.ts#L136)

## Subscription models check

Set `container` to the already running, signed-in agent's container and use the matching read-only list command. The example mirrors Rev4a's Gateway CLI wrapper. It sets `OPENCLAW_GATEWAY_PORT=3000` and reads the current token from `/root/.agent-token` inside the container when that file exists. Otherwise it inherits `OPENCLAW_GATEWAY_TOKEN` from the container environment. Keep the token out of output and diagnostics. [Gateway CLI wrapper](../../lib/gateway-cli.ts#L16)

```bash
openclaw_for_agent() {
  docker exec "${container:?Set container to the running agent container}" sh -c '
    export OPENCLAW_GATEWAY_PORT=3000
    if [ -f /root/.agent-token ]; then
      OPENCLAW_GATEWAY_TOKEN=$(head -1 /root/.agent-token | tr -d "[:space:]")
      export OPENCLAW_GATEWAY_TOKEN
    fi
    exec openclaw "$@"
  ' sh "$@"
}
openclaw_for_agent --version
openclaw_for_agent models list --provider openai --json
openclaw_for_agent models list --provider anthropic --json
```

- **ChatGPT (Codex).** Compare the exact `models[].key` in the OpenAI list. Rev4a keeps rows with string keys. [CLI listing](../../lib/subscriptions.ts#L452), [list parser](../../lib/subscriptions-parse.js#L75)
- **Claude.** Rev4a selects a running agent with Claude Code signed in and its `claude-cli` routing rule active. It uses OpenClaw's Anthropic list and keeps only rows with string keys and `available === true`. Compare the exact key after that filter. [Claude model listing and source discovery](../../lib/subscription-claude.ts#L300)
- On **Subscriptions**, open the provider accordion and inspect **MODELS**. On **Agents**, the signed-in agent's **MODEL** panel lists the subscription group in the primary and fallback pickers. Both surfaces use `GET /api/subscriptions/models` (add `?provider=anthropic` for Claude). The server lists one running connected agent per account, caches nonempty results for ten minutes per account and merges by key. A merged result does not establish availability on a specific agent. Empty results are uncached and may be pending after Connect. [Listing API](../../app/api/subscriptions/models/route.ts), [Subscriptions page](../../app/subscriptions/PageClient.tsx#L463), [agent pickers](../../app/agents/ModelSection.tsx#L414)
- If an expected model is absent, distinguish a pending or failed read and a cached dashboard response from a fresh result. Record the installed OpenClaw version, provider and result. Carry absent models confirmed by a fresh read into the OpenClaw agent-image update review. Never add a subscription entry to the catalogue as a workaround. If no signed-in agent or saved CLI output is available, report the check as unverified.

## Verify

Run from the repo root after the refresh, with a writable temporary directory for the Gateway CLI fixture. Set `REV4A_OPENROUTER_SNAPSHOT` to the complete OpenRouter JSON captured for the refresh, or set `run_dir` to the folder containing it as `openrouter.models.json`. The check reads the original catalogue with `git show` using `REV4A_CATALOGUE_BASE`, which defaults to `origin/main`. Set it to the pre-update commit when the run uses another base.

Set `REV4A_APPROVED_DEFAULT_CHANGES` to a JSON object with the `removed` and `disabled` ID lists approved for this release after the assignment audit. Omitted lists default to empty. The check requires both actual lists to match their approvals exactly. It also fails if an added ID matches the upstream snapshot and lacks a generated details row, and lists added IDs that lack both a details row and an upstream match. [URL test](../../scripts/test-provider-upstream-url.mjs), [matching and pricing test](../../scripts/test-model-upstream-match.mjs)

```bash
(
set -e
export REV4A_CATALOGUE_BASE=${REV4A_CATALOGUE_BASE:-origin/main}
snapshot=${REV4A_OPENROUTER_SNAPSHOT:-${run_dir:?Set run_dir or REV4A_OPENROUTER_SNAPSHOT}/openrouter.models.json}
npm test -- agent-proxy-token gateway-agent-subscription subscription-models-pending gateway-cli provider-upstream-url model-upstream-match
npm run typecheck -- --incremental false
npm run check:language
node --input-type=module - "$snapshot" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { matchUpstream } from './scripts/lib/model-upstream.mjs';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const catalogue = read('models.config.json');
const prices = read('model-pricing.json');
const details = read('model-details.json');
const base = process.env.REV4A_CATALOGUE_BASE || 'origin/main';
const previous = JSON.parse(execFileSync('git', ['show', `${base}:models.config.json`], { encoding: 'utf8' }));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const models = catalogue?.models;
assert.ok(Array.isArray(models) && models.length > 0, 'Catalogue must contain a nonempty models array');
assert.ok(isObject(prices), 'Pricing must be an object');
assert.ok(isObject(details) && isObject(details.models), 'Generated details must contain a models object');
const ids = new Set();
for (const model of models) {
  assert.ok(isObject(model), 'Catalogue entry must be an object');
  const { id, provider, enabled } = model;
  assert.ok(typeof id === 'string' && id.length > 0 && id === id.trim(), 'Catalogue ID must be a nonempty trimmed string');
  const slash = id.indexOf('/');
  assert.ok(slash > 0 && slash < id.length - 1, `Expected a provider/model ID for ${id}`);
  assert.equal(provider, id.slice(0, slash), `Provider does not match ID for ${id}`);
  assert.equal(typeof enabled, 'boolean', `Invalid enabled flag for ${id}`);
  assert.ok(!ids.has(id), `Duplicate catalogue ID ${id}`);
  ids.add(id);
  if (enabled) assert.ok(Object.hasOwn(prices, id), `Missing price for ${id}`);
}
const previousById = new Map(previous.models.map((model) => [model.id, model]));
const approved = JSON.parse(process.env.REV4A_APPROVED_DEFAULT_CHANGES || '{}');
assert.ok(isObject(approved), 'Expected a JSON object with the approved removed and disabled IDs');
const removedDefaults = previous.models.filter(({ id, enabled }) => enabled && !ids.has(id)).map(({ id }) => id);
const disabledDefaults = models
  .filter(({ id, enabled }) => previousById.get(id)?.enabled === true && enabled === false)
  .map(({ id }) => id);
for (const [change, actual] of Object.entries({ removed: removedDefaults, disabled: disabledDefaults })) {
  const expected = approved[change] ?? [];
  assert.ok(Array.isArray(expected) && expected.every((id) => typeof id === 'string'), `Expected an approved ID list for ${change}`);
  assert.deepEqual(actual.sort(), expected.sort(), `Defaults ${change} since ${base} differ from release approvals`);
}
console.log(`Default changes since ${base} match the release approvals.`);
for (const [id, row] of Object.entries(details.models)) {
  assert.ok(isObject(row), `Invalid generated details row for ${id}`);
}
const isStaticRate = (value) => Number.isFinite(value) && value >= 0 && value < 1_000_000;
for (const [id, price] of Object.entries(prices)) {
  assert.ok(ids.has(id), `Orphan price for ${id}`);
  assert.ok(isObject(price), `Invalid price row for ${id}`);
  const isDynamic = id.startsWith('openrouter/') && price.input === -1 && price.output === -1;
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const isBaseRate = field === 'input' || field === 'output';
    if (!isBaseRate && !Object.hasOwn(price, field)) continue;
    assert.ok((isBaseRate && isDynamic) || isStaticRate(price[field]), `Invalid ${field} price for ${id}`);
  }
}
const snapshot = read(process.argv[2]);
assert.ok(Array.isArray(snapshot.data) && snapshot.data.length > 0, 'Expected OpenRouter snapshot data');
assert.ok(!snapshot.links?.next && (snapshot.total_count ?? snapshot.data.length) === snapshot.data.length,
  'OpenRouter snapshot is incomplete');
const live = new Map(snapshot.data.map((row) => [row.id, row]));
const withoutDetails = [...ids].filter((id) => !previousById.has(id) && !Object.hasOwn(details.models, id));
const missingDetails = withoutDetails.filter((id) => matchUpstream(live, id));
assert.deepEqual(missingDetails, [], 'Matchable added IDs missing generated details after refresh');
console.log('Catalogue entries, price coverage and generated details passed.');
if (withoutDetails.length) {
  console.log(`No upstream match for ${withoutDetails.length} added IDs without details:\n${withoutDetails.join('\n')}`);
}
NODE
git diff --check "$REV4A_CATALOGUE_BASE"
git diff --cached --check
)
```

Review the diff for unexpected policy changes or modality reordering. Inspect scheduled rates and any explicit free or dynamic pricing against the evidence. Use the repository precheck before a commit. [Repository checks](../../AGENTS.md#23-documentation-first-workflow)

## Upgrade safety and release notes

1. **Existing data.** The tracked catalogue and rates ship in the npm package. User toggles in `<data dir>/model-overrides.json` win over bundled defaults. Catalogue maintenance requires no database, `.env`, provider vault or agent volume migration. A removed ID can break an existing assignment, so audit refs and follow the two-release rule. [Package files](../../package.json#L28), [override merge](../../lib/model-catalogue.ts#L156)
2. **First run.** Ship valid local catalogue, price and details files so startup uses the normal bundle and sync paths. Keep upstream collection and generation in the maintenance run. [Catalogue loader](../../lib/model-catalogue.ts#L91), [sync flow](../../docs/dev/GATEWAY.md#sync-flow)
3. **Older agents.** Preserve existing refs through deprecation and check modality changes against the supported version list used by sync. Keep subscription availability tied to each agent's OpenClaw image. [Gateway compatibility rules](../../docs/dev/GATEWAY.md#key-design-decisions)
4. **User-visible changes.** Record additions, deprecations and successor guidance, removals, price and schedule changes, and changed enabled defaults or capabilities in the release notes. Include any action operators need to take before removal. [Upgrade safety](../../AGENTS.md#22c-upgrade-safety-since-2026-10-05)
5. **Rollback.** The previous package can read existing data because a catalogue update changes no schema. Its catalogue may lack models selected after the update, and a normal toggle can prune an orphan override after removal. Check assignments before rollback and retain the previous compatible refs and override state where needed. [Override pruning](../../lib/model-catalogue.ts#L165)

## Report

Return the dated snapshot sources and per-provider diff table, the files and model IDs changed, assignment checks and any removals deferred, subscription results by provider and OpenClaw version, and the commands run with their results. List evidence gaps, unverified endpoints, prices or modalities, pending generated output and any required release notes. Use the five upgrade-safety points above to explain the impact of this run.
