import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../lib/agent-model-setup.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { resolveCreateModel, pickSubscriptionModel, needsModelSetup } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const defaultModel = 'rev4a/deepseek/deepseek-flash';
const alternative = 'rev4a/deepseek/deepseek-v4-pro';
const offered = (id) => [defaultModel, alternative].includes(id);
const notOffered = () => false;
const modelResult = (model) => ({ kind: 'model', model });
const badRequest = (error) => ({ kind: 'error', status: 400, error });
const unavailable = (model) => badRequest(
  `Model '${model}' is not offered by this deployment: it is not in the catalogue, is disabled, or its provider has no API key.`,
);

test('create uses and validates the default when no model is supplied', () => {
  assert.deepEqual(resolveCreateModel({}, offered, defaultModel), modelResult(defaultModel));
  assert.deepEqual(resolveCreateModel({}, notOffered, defaultModel), unavailable(defaultModel));
  assert.deepEqual(resolveCreateModel({ noModel: false, model: '' }, offered, defaultModel), modelResult(defaultModel));
  assert.deepEqual(resolveCreateModel({ model: 42 }, offered, defaultModel), modelResult(defaultModel));
});

test('create uses a non-empty model only when offered', () => {
  assert.deepEqual(resolveCreateModel({ noModel: false, model: alternative }, offered, defaultModel), modelResult(alternative));
  assert.deepEqual(resolveCreateModel({ model: alternative }, notOffered, defaultModel), unavailable(alternative));
});

test('explicit no-model create accepts absent and empty model fields without checking the catalogue', () => {
  const unexpectedCatalogueRead = () => assert.fail('The catalogue should not be read');
  assert.deepEqual(resolveCreateModel({ noModel: true }, unexpectedCatalogueRead, defaultModel), { kind: 'none' });
  assert.deepEqual(resolveCreateModel({ noModel: true, model: '' }, unexpectedCatalogueRead, defaultModel), { kind: 'none' });
});

test('explicit no-model create rejects a model and requires a boolean flag', () => {
  assert.deepEqual(resolveCreateModel({ noModel: true, model: 'x' }, offered, defaultModel),
    badRequest('Send either model or noModel, not both'));
  assert.deepEqual(resolveCreateModel({ noModel: true, model: 42 }, offered, defaultModel),
    badRequest('Send either model or noModel, not both'));
  for (const noModel of ['yes', null, 1, undefined]) {
    assert.deepEqual(resolveCreateModel({ noModel }, offered, defaultModel), badRequest('noModel must be a boolean'));
  }
});

const models = (...keys) => keys.map((key) => ({ key }));

test('ChatGPT prefers GPT-6.1 Sol and otherwise takes the first OpenAI key', () => {
  assert.equal(pickSubscriptionModel('openai', models('openai/other', 'openai/gpt-6-astra', 'openai/gpt-6.1-sol')), 'openai/gpt-6.1-sol');
  assert.equal(pickSubscriptionModel('openai', models('anthropic/sonnet', 'openai/first', 'openai/second')), 'openai/first');
  assert.equal(pickSubscriptionModel('openai', models('rev4a/openai/gpt-6-astra')), null);
  assert.equal(pickSubscriptionModel('openai', []), null);
});

test('Claude prefers the first Anthropic Sonnet and otherwise takes the first Anthropic key', () => {
  assert.equal(pickSubscriptionModel('anthropic',
    models('openai/sonnet', 'anthropic/opus', 'anthropic/sonnet-one', 'anthropic/sonnet-two')), 'anthropic/sonnet-one');
  assert.equal(pickSubscriptionModel('anthropic', models('openai/other', 'anthropic/opus', 'anthropic/haiku')), 'anthropic/opus');
  assert.equal(pickSubscriptionModel('anthropic', models('openai/sonnet')), null);
  assert.equal(pickSubscriptionModel('anthropic', []), null);
});

test('model setup is only required on a confirmed unset row', () => {
  assert.equal(needsModelSetup({ health: 'unset' }), true);
  for (const row of [{ health: 'ok' }, { health: 'missing' }, { health: 'unknown' }, {}, undefined, null]) {
    assert.equal(needsModelSetup(row), false);
  }
});
