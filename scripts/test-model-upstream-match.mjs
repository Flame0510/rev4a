#!/usr/bin/env node
/** Offline regression tests for OpenRouter model IDs and scheduled prices. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { matchUpstream, peakOpenRouterPricing } from './lib/model-upstream.mjs';

const index = (rows) => new Map(rows.map((row) => [row.id, row]));
const standard = {
  id: 'deepseek/deepseek-v4.1-flash',
  canonical_slug: 'deepseek/deepseek-v4.1-flash-20260910',
  pricing: { prompt: '0.00000006', completion: '0.00000018', input_cache_read: '0.000000012' },
};
const batch = {
  ...standard,
  id: `${standard.id}:batch`,
  pricing: { prompt: '0.0000000507', completion: '0.0000002028', input_cache_read: '0.000000001014' },
};
const standardId = `openrouter/${standard.id}`;
for (const rows of [[standard, batch], [batch, standard]]) {
  assert.equal(matchUpstream(index(rows), standardId), standard);
  assert.equal(matchUpstream(index(rows), `${standardId}:batch`), batch);
}
assert.equal(matchUpstream(index([batch]), standardId), null);
assert.equal(matchUpstream(new Map([[standard.id, batch]]), standardId), null);
assert.equal(matchUpstream(index([batch, standard]), 'deepseek/deepseek-flash'), standard);
assert.equal(matchUpstream(index([batch]), 'deepseek/deepseek-flash'), null);

const free = { ...standard, id: `${standard.id}:free` };
const extended = { ...standard, id: `${standard.id}:extended` };
assert.equal(matchUpstream(index([extended, free, standard]), `${standardId}:free`), free);
assert.equal(matchUpstream(index([extended, free]), standardId), null);
assert.equal(matchUpstream(index([standard, extended]), `${standardId}:free`), null);

const dotted = { id: 'anthropic/claude-haiku-4.5' };
const dashedFree = { id: 'anthropic/claude-haiku-4-5:free' };
assert.equal(matchUpstream(index([dotted]), 'anthropic/claude-haiku-4-5'), dotted);
assert.equal(matchUpstream(index([dotted]), 'openrouter/anthropic/claude-haiku-4-5'), dotted);
assert.equal(matchUpstream(index([dotted, dashedFree]), `openrouter/${dotted.id}:free`), dashedFree);
assert.equal(matchUpstream(index([dashedFree]), `openrouter/${dotted.id}`), null);

const offPeak = { prompt: '0.000000075', completion: '0.0000003', input_cache_read: '0.0000000075' };
const peak = { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000015' };
const scheduled = {
  ...offPeak,
  input_cache_write: '0.00000003',
  overrides: [
    { ...offPeak, utc_start: 1500, utc_end: 100 },
    { ...peak, utc_start: 100, utc_end: 1500 },
    { utc_start: 100, utc_end: 1500, min_prompt_tokens: 200000, prompt: '0.0000003' },
  ],
};
const expected = { ...scheduled.overrides[1], input_cache_write: '0.00000003' };
assert.deepEqual(peakOpenRouterPricing(scheduled), expected);
assert.deepEqual(peakOpenRouterPricing({ ...scheduled, ...peak, overrides: [...scheduled.overrides].reverse() }), expected);
assert.equal(peakOpenRouterPricing({ ...scheduled, overrides: [scheduled.overrides[0]] }), null);
assert.equal(peakOpenRouterPricing({ ...scheduled, overrides: [
  { ...offPeak, utc_start: 1500, utc_end: 100, completion: '0.0000007' },
  scheduled.overrides[1],
] }), null);

const weekend = { ...offPeak, utc_days: ['saturday', 'sunday'] };
const weekdays = { ...peak, utc_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] };
assert.equal(peakOpenRouterPricing({ ...offPeak, overrides: [weekend, weekdays] }).prompt, peak.prompt);
const contextOnly = { ...offPeak, overrides: [{ ...peak, min_prompt_tokens: 200000 }] };
assert.equal(peakOpenRouterPricing(contextOnly), contextOnly);

console.log('OpenRouter model matching and peak pricing fixtures passed.');

const skill = readFileSync(new URL('../skills/rev4a-models-update/SKILL.md', import.meta.url), 'utf8');
const approvalCheck = /const previousById = [\s\S]*?(?=\nfor \(const \[id, row\])/.exec(skill)?.[0];
assert.ok(approvalCheck, 'The documented verification must check release approvals');
const model = (id, enabled = true) => ({ id, enabled });
const removed = 'openrouter/vendor/removed';
const disabled = 'openrouter/vendor/disabled';
const retained = 'openrouter/vendor/retained';
const previous = { models: [model(removed), model(disabled), model(retained)] };
const changed = [model(disabled, false), model(retained)];
function verifyApprovals(models, approved) {
  runInNewContext(approvalCheck, {
    assert: { ...assert, deepEqual: (actual, expected, message) => assert.deepEqual([...actual], [...expected], message) },
    console: { log() {} },
    process: { env: { REV4A_APPROVED_DEFAULT_CHANGES: JSON.stringify(approved) } },
    isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    previous, models, ids: new Set(models.map(({ id }) => id)), base: 'fixture',
  });
}
verifyApprovals(previous.models);
verifyApprovals(changed, { removed: [removed], disabled: [disabled] });
assert.throws(() => verifyApprovals(changed), /removed.*differ from release approvals/);
assert.throws(() => verifyApprovals(changed, { removed: [removed] }), /disabled.*differ from release approvals/);
assert.throws(() => verifyApprovals(changed, { removed: [disabled], disabled: [removed] }), /removed.*differ from release approvals/);
assert.throws(() => verifyApprovals(previous.models, { removed: [removed] }), /removed.*differ from release approvals/);
console.log('Documented catalogue verification accepts exactly the release-approved removed and disabled IDs.');
