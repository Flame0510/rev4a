#!/usr/bin/env node
/** Offline regression tests for the proxy's upstream Chat Completions URLs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = new URL('../app/api/provider/upstream.ts', import.meta.url);
const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dependencies = {
  'better-sqlite3': {},
  '@/lib/costs-db': {},
  '@/lib/model-pricing': {},
  '@/lib/proxy-usage': require('../lib/proxy-usage.js'),
};
const module = { exports: {} };
vm.runInNewContext(code, {
  exports: module.exports,
  fetch: (...args) => globalThis.fetch(...args),
  require: (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  },
}, { filename: source.pathname });

const { PROVIDER_ENVS, callUpstream } = module.exports;
const expectedUrls = {
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  kimi: 'https://api.moonshot.cn/v1/chat/completions',
  glm: 'https://api.z.ai/api/paas/v4/chat/completions',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};
assert.deepEqual(Object.keys(PROVIDER_ENVS).sort(), Object.keys(expectedUrls).sort());

const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, { method }) => {
  requests.push({ url, method });
  return new Response();
};
try {
  for (const [provider, url] of Object.entries(expectedUrls)) {
    await callUpstream(provider, 'fixture-model', { messages: [] }, 'fixture-key');
    assert.deepEqual(requests.splice(0), [{ url, method: 'POST' }], provider);
    console.log(`ok   ${provider} uses ${url}`);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${Object.keys(expectedUrls).length} provider URLs passed.`);
