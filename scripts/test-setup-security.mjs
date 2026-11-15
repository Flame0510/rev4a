#!/usr/bin/env node
/** SEC-14 boundaries. Isolated files/process mocks; never starts the server or launcher. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validator = require('../lib/env-file.js');
const fingerprint = require('../lib/session-fingerprint.js');
const CODE = 'ABCD-EFGH-JKLM-NPQR';
const ERROR = 'Setup code required: it is printed in the terminal (or the journal) where rev4a serve runs';
const ENV_FILE = '/mock/.env';
let passed = 0;
const envFile = (await import('../lib/env-file.js')).default;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
  }, fileName: file }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name} in ${file}`);
    return dependencies[name];
  }, TextEncoder, Response, ReadableStream, AbortController, ...globals }, { filename: file });
  return module.exports;
}

function harness(env = { REV4A_SETUP_CODE: CODE }, content = '', readError = null) {
  const files = new Map([[ENV_FILE, content]]);
  const modes = new Map([[ENV_FILE, 0o644]]);
  const effects = [];
  const logs = [];
  const mockFs = {
    existsSync: (file) => files.has(file),
    readFileSync: (file) => {
      if (file === ENV_FILE && readError) throw Object.assign(new Error(readError), { code: readError });
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync: (file, value, options) => {
      if (file === ENV_FILE) assert.equal(options.mode, 0o600);
      effects.push(['write', file]); files.set(file, value);
      if (!modes.has(file)) modes.set(file, options?.mode ?? 0o644);
    },
    mkdirSync: () => {},
    statSync: (file) => ({ mode: modes.get(file) }),
    chmodSync: (file, mode) => { assert.ok(files.has(file)); modes.set(file, mode); },
    unlinkSync: (file) => { effects.push(['unlink', file]); files.delete(file); },
  };
  const process = { env: { ...env }, platform: 'linux', pid: 1, kill: () => effects.push(['kill']) };
  const globals = { process, console: { log: (...args) => logs.push(args.join(' ')), error: () => {} },
    setTimeout: () => effects.push(['timer']) };
  const NextResponse = { json: (body, options = {}) => ({
    status: options.status ?? 200, json: async () => body, cookies: { set: () => effects.push(['cookie']) },
  }) };
  const dependencies = {
    'next/server': { NextResponse }, fs: mockFs, 'node:fs': mockFs,
    path, 'node:path': path, crypto, 'node:os': { homedir: () => '/mock' },
    '@/lib/rev4a-paths': { ENV_FILE, REV4A_DATA: '/mock' },
    '@/lib/env-file': validator, './env-file.js': validator, '@/lib/listen-addresses': require('../lib/listen-addresses.js'),
    './session-fingerprint.js': fingerprint,
    jose: { jwtVerify: async (token) => {
      if (token !== 'valid-cookie') throw new Error('Invalid JWT');
      // Fixed issued credential: changing the effective password must invalidate this cookie.
      return { payload: { role: 'admin', pwf: fingerprint.passwordFingerprint('owner-pass', 'test-secret') } };
    } },
    child_process: { execSync: () => effects.push(['exec']) },
    '@/lib/buildAgentImage': {
      getIsDownloading: () => { effects.push(['download-check']); return false; },
      downloadAgentImage: async () => effects.push(['download']),
    },
    '@/lib/docker-socket': { dockerAvailable: () => { effects.push(['docker']); return false; } },
    '@/lib/agent-images': { listLocalAgentImages: async () => [], newestLocalSupportedVersion: () => null },
  };
  const auth = load('lib/rev4a-auth.js', dependencies, globals);
  dependencies['@/lib/rev4a-auth'] = auth;
  dependencies['@/lib/session-cookie'] = load('lib/session-cookie.ts', dependencies, globals);
  return { files, modes, effects, logs, process, auth,
    load: (file) => load(file, dependencies, globals),
    req: (body, code = CODE, extra = {}) => ({
      headers: new Headers({ ...(code === null ? {} : { 'x-rev4a-setup-code': code }), ...extra }),
      json: async () => body,
    }),
  };
}

await test('shared .env boundary: abc and spaces accepted; CR, LF, NUL and non-strings rejected', () => {
  for (const value of ['abc', '   ', '']) validator.assertEnvValue('REV4A_TEST', value);
  for (const value of ['a\nb', 'a\rb', 'a\0b', '\n', 1, false, null, undefined, {}, []]) {
    assert.throws(() => validator.assertEnvValue('REV4A_TEST', value), /REV4A_TEST/);
  }
  assert.throws(() => validator.assertEnvKey('REV4A_X\nNODE_OPTIONS'), /Invalid environment key/);
  validator.assertEnvValue('PROVIDER_VENDOR.OPTION', 'abc');
});

await test('password HTTP boundaries: 7 rejected, 8 accepted; spaces retain previous acceptance', async () => {
  for (const [password, status] of [['1234567', 400], ['12345678', 200], ['123456789', 200], ['        ', 200]]) {
    const h = harness();
    const response = await h.load('app/api/setup/password/route.ts').POST(h.req({ password }));
    assert.equal(response.status, status);
    if (status === 200) assert.equal(h.modes.get(ENV_FILE), 0o600);
  }
  for (const password of ['a\nb', 'a\rb', 'a\0b', '\n', 'xxxxxxxx\nNODE_OPTIONS=payload', 8, false, null, {}, []]) {
    const h = harness();
    const response = await h.load('app/api/setup/password/route.ts').POST(h.req({ password }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /REV4A_PASSWORD/);
    assert.equal(h.effects.length, 0);
  }
});

await test('config PUT rejects every invalid value with its key before writing any part of a batch', async () => {
  for (const value of ['a\nb', 'a\rb', 'a\0b', '\n', 'xxxxxxxx\nNODE_OPTIONS=payload', 8, false, null, {}, []]) {
    const h = harness({ REV4A_TOKEN: 'test-bearer' }); // secret-ok
    const response = await h.load('app/api/config/env/route.ts').PUT(h.req({
      env: { REV4A_GOOD: 'abc', PROVIDER_TEST: value },
    }, null, { authorization: 'Bearer test-bearer' }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /PROVIDER_TEST/);
    assert.equal(h.effects.length, 0);
  }
  for (const value of ['abc', '   ', '']) {
    const h = harness({ REV4A_TOKEN: 'test-bearer' }, 'REV4A_TEST=old\n'); // secret-ok
    const response = await h.load('app/api/config/env/route.ts').PUT(h.req({ env: { REV4A_TEST: value } },
      null, { authorization: 'Bearer test-bearer' }));
    assert.equal(response.status, 200);
    assert.equal(h.files.get(ENV_FILE), value === '' ? '' : `REV4A_TEST=${envFile.serializeEnvValue('REV4A_TEST', value)}\n`);
  }
  const h = harness({ REV4A_TOKEN: 'test-bearer' }); // secret-ok
  const response = await h.load('app/api/config/env/route.ts').PUT(h.req({
    env: { ['REV4A_X\nNODE_OPTIONS']: 'payload' },
  }, null, { authorization: 'Bearer test-bearer' }));
  assert.equal(response.status, 400);
  assert.equal(h.effects.length, 0);
});

await test('writeEnvVar uses the shared boundary before touching files or process.env', () => {
  const h = harness({ REV4A_DATA_DIR: '/mock' });
  const paths = h.load('lib/rev4a-paths.ts');
  for (const value of ['a\nb', 'a\rb', 'a\0b', '\n', 8]) {
    assert.throws(() => paths.writeEnvVar('REV4A_TEST', value), /REV4A_TEST/);
    assert.equal(h.effects.length, 0);
    assert.equal(h.process.env.REV4A_TEST, undefined);
  }
  paths.writeEnvVar('REV4A_TEST', 'abc');
  assert.match(h.files.get(ENV_FILE), /^REV4A_TEST=abc$/m);
});

await test('Config never returns the setup code from disk or runtime and ignores it on PUT', async () => {
  const h = harness({ REV4A_TOKEN: 'test-bearer', REV4A_SETUP_CODE: CODE }, // secret-ok
    'REV4A_SETUP_CODE=old-file-code\nREV4A_TEST=abc\n');
  const route = h.load('app/api/config/env/route.ts');
  const req = (body) => h.req(body, null, { authorization: 'Bearer test-bearer' });
  const response = await route.GET(req({}));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).env.REV4A_SETUP_CODE, undefined);
  h.files.set(ENV_FILE, 'REV4A_TEST=abc\n');
  assert.equal((await (await route.GET(req({}))).json()).env.REV4A_SETUP_CODE, undefined);
  const saved = h.files.get(ENV_FILE);
  const ignored = await route.PUT(req({ env: { REV4A_SETUP_CODE: CODE } }));
  assert.equal(ignored.status, 200);
  assert.equal(h.files.get(ENV_FILE), saved);
  assert.equal(h.effects.length, 0);
});

await test('Config saves preserve legacy dotted keys without applying request key syntax to stored entries', async () => {
  const h = harness({ REV4A_TOKEN: 'test-bearer' }, 'PROVIDER_VENDOR.OPTION=x\nREV4A_TEST=old\n'); // secret-ok
  const response = await h.load('app/api/config/env/route.ts').PUT(h.req({ env: { REV4A_TEST: 'abc' } },
    null, { authorization: 'Bearer test-bearer' }));
  assert.equal(response.status, 200);
  assert.equal(h.files.get(ENV_FILE), 'PROVIDER_VENDOR.OPTION=x\nREV4A_TEST=abc\n');
});

await test('Config GET -> PUT round trip keeps a legacy dotted key for older open tabs', async () => {
  const h = harness({ REV4A_TOKEN: 'test-bearer' }, 'PROVIDER_VENDOR.OPTION=x\nREV4A_TEST=old\n'); // secret-ok
  const route = h.load('app/api/config/env/route.ts');
  const auth = { authorization: 'Bearer test-bearer' };
  const { env } = await (await route.GET(h.req({}, null, auth))).json();
  assert.equal(env['PROVIDER_VENDOR.OPTION'], 'x');
  const response = await route.PUT(h.req({ env: { ...env, REV4A_TEST: 'abc' } }, null, auth));
  assert.equal(response.status, 200);
  assert.match(h.files.get(ENV_FILE), /^PROVIDER_VENDOR\.OPTION=x$/m);
  assert.match(h.files.get(ENV_FILE), /^REV4A_TEST=abc$/m);
});

await test('line-breaking keys are refused; legacy key syntax is accepted', () => {
  for (const k of ['REV4A_TEST', 'PROVIDER_VENDOR.OPTION', 'a-b']) envFile.assertEnvKey(k);
  for (const k of ['', 'A=B', 'A B', '#X', 'A\nB', 'A\u0001', 7]) assert.throws(() => envFile.assertEnvKey(k));
});

await test('.env repair comments out loader keys (Next.js reads .env for the build and the server), idempotent', () => {
  const r = envFile.disableLoaderEnvLines('REV4A_PASSWORD=x\nNODE_OPTIONS=--import=evil\n# NODE_OPTIONS=old\nexport LD_PRELOAD=/x.so\nDYLD_INSERT_LIBRARIES=/y\nPORT=3740\n');
  assert.deepEqual(r.disabled, ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']);
  assert.match(r.content, /^REV4A_PASSWORD=x$/m);
  assert.match(r.content, /^PORT=3740$/m);
  assert.doesNotMatch(r.content, /^(export\s+)?(NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)=/m);
  assert.deepEqual(envFile.disableLoaderEnvLines(r.content).disabled, []);
});

await test('loader repair is line based: it only comments lines out, also inside or after an odd quoted value', () => {
  for (const newline of ['\n', '\r\n']) {
    const content = ['# header', 'OPERATOR_NOTE="open', 'NODE_OPTIONS=--import=payload', 'export LD_PRELOAD=/x.so', 'PORT=3740', ''].join(newline);
    const r = envFile.disableLoaderEnvLines(content);
    assert.deepEqual(r.disabled, ['NODE_OPTIONS', 'LD_PRELOAD']);
    const before = content.split('\n'); const after = r.content.split('\n');
    assert.equal(after.length, before.length);
    after.forEach((line, i) => {
      if (/^(export\s+)?(NODE_OPTIONS|LD_PRELOAD)=/.test(before[i].trim())) assert.ok(line.startsWith('# Disabled by Rev4a:'));
      else assert.equal(line, before[i]);
    });
    assert.deepEqual(envFile.disableLoaderEnvLines(r.content).disabled, []);
  }
});

await test('loader repair covers Next dotenv CR separators, colon assignments and exports, preserving separators', () => {
  for (const separator of ['\r', '\n', '\r\n']) {
    for (const assignment of ['NODE_OPTIONS=--import=/fixture/injected.mjs',
      'NODE_OPTIONS: --import=/fixture/injected.mjs', ' export NODE_OPTIONS = --import=/fixture/injected.mjs']) {
      const prefix = `REV4A_PASSWORD=abcdefgh${separator}`;
      const content = `${prefix}${assignment}\n# keep\rPORT=3740\r\n`;
      const repaired = envFile.disableLoaderEnvLines(content);
      assert.deepEqual(repaired.disabled, ['NODE_OPTIONS']);
      assert.ok(repaired.content.startsWith(prefix));
      assert.ok(repaired.content.endsWith(`${assignment}\n# keep\rPORT=3740\r\n`));
      assert.deepEqual(repaired.content.match(/\r\n|\r|\n/g), content.match(/\r\n|\r|\n/g));
      assert.equal(envFile.disableLoaderEnvLines(repaired.content).content, repaired.content);
      const module = { exports: {} };
      vm.runInNewContext(fs.readFileSync(require.resolve('@next/env'), 'utf8'), {
        module, exports: module.exports, require, __dirname: '/mock', process: { env: {} }, console,
      });
      const [, before] = module.exports.processEnv([{ path: '.env', contents: content, env: {} }], '/mock');
      assert.equal(before.NODE_OPTIONS, '--import=/fixture/injected.mjs', 'the original fixture reaches Next');
      // A fresh isolated parser prevents Next's per-process cache from reusing the original.
      const cleanModule = { exports: {} };
      vm.runInNewContext(fs.readFileSync(require.resolve('@next/env'), 'utf8'), {
        module: cleanModule, exports: cleanModule.exports, require, __dirname: '/mock', process: { env: {} }, console,
      });
      const [, after] = cleanModule.exports.processEnv([{ path: '.env', contents: repaired.content, env: {} }], '/mock');
      assert.equal(after.NODE_OPTIONS, undefined);
      assert.equal(after.REV4A_PASSWORD, 'abcdefgh');
      assert.equal(after.PORT, '3740');
    }
  }
});

await test('all assignment writers fail closed on EACCES/EIO/EISDIR; only ENOENT starts an empty file', async () => {
  for (const error of ['EACCES', 'EIO', 'EISDIR', 'ENOENT']) {
    for (const writer of ['config', 'password', 'writeEnvVar']) {
      const h = harness({ REV4A_SETUP_CODE: CODE, REV4A_DATA_DIR: '/mock', REV4A_TOKEN: 'test-bearer' }, // secret-ok
        'PROVIDER_KEEP=existing\n', error);
      if (writer === 'writeEnvVar') {
        const paths = h.load('lib/rev4a-paths.ts');
        if (error === 'ENOENT') paths.writeEnvVar('REV4A_TEST', 'abc');
        else assert.throws(() => paths.writeEnvVar('REV4A_TEST', 'abc'), { code: error });
      } else {
        const route = writer === 'config' ? 'config/env' : 'setup/password';
        const method = writer === 'config' ? 'PUT' : 'POST';
        const body = writer === 'config' ? { env: { REV4A_TEST: 'abc' } } : { password: '12345678' }; // secret-ok
        const response = await h.load(`app/api/${route}/route.ts`)[method](h.req(body,
          CODE, { authorization: 'Bearer test-bearer' }));
        assert.equal(response.status, error === 'ENOENT' ? 200 : 500, `${writer}: ${error}`);
      }
      if (error !== 'ENOENT') {
        assert.equal(h.files.get(ENV_FILE), 'PROVIDER_KEEP=existing\n');
        assert.equal(h.effects.length, 0, `${writer}: ${error}`);
        assert.equal(h.process.env.REV4A_TEST, undefined);
        assert.equal(h.process.env.REV4A_PASSWORD, undefined);
      } else assert.equal(h.effects.filter(([effect]) => effect === 'write').length, 1);
    }
  }
});

await test('setup code accepts lowercase, no dashes and surrounding/spaced input; rejects one wrong character and empty', async () => {
  const h = harness();
  for (const code of [CODE.toLowerCase(), CODE.replaceAll('-', ''), '  abcd efgh jklm npqr  ']) {
    assert.equal(await h.auth.requireAuthIfConfigured(h.req({}, code)), null);
  }
  for (const code of ['BBCD-EFGH-JKLM-NPQR', '', null]) {
    const response = await h.auth.requireAuthIfConfigured(h.req({}, code));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, ERROR);
  }
});

await test('every pre-setup handler refuses a missing/wrong code before body reads or side effects', async () => {
  for (const [route, method] of [
    ['setup/password', 'POST'], ['setup/agent-image', 'GET'], ['setup/agent-image', 'POST'],
    ['setup/restart', 'POST'], ['wizard/complete', 'POST'], ['wizard/reset', 'POST'], ['wizard/status', 'GET'],
  ]) {
    for (const code of [null, '', 'BBCD-EFGH-JKLM-NPQR']) {
      const h = harness();
      const req = h.req({}, code);
      req.json = () => { throw new Error('Unauthorized body read'); };
      const response = await h.load(`app/api/${route}/route.ts`)[method](req);
      assert.equal(response.status, 403, `${method} ${route}`);
      assert.equal((await response.json()).error, ERROR);
      assert.equal(h.effects.length, 0);
    }
  }
});

await test('correct code reaches each pre-setup handler, including streamed image download', async () => {
  for (const [route, method, status] of [
    ['setup/password', 'POST', 200], ['setup/agent-image', 'GET', 200], ['setup/agent-image', 'POST', 200],
    ['setup/restart', 'POST', 400], ['wizard/complete', 'POST', 200], ['wizard/reset', 'POST', 200],
    ['wizard/status', 'GET', 200],
  ]) {
    const h = harness();
    const response = await h.load(`app/api/${route}/route.ts`)[method](h.req({ password: '12345678' }, CODE.toLowerCase())); // secret-ok
    assert.equal(response.status, status, `${method} ${route}`);
    if (response instanceof Response) await response.text();
  }
});

await test('a paused setup request cannot overwrite the owner; conflict is 409 and secrets stay unchanged', async () => {
  const h = harness();
  const route = h.load('app/api/setup/password/route.ts');
  let release;
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  const body = new Promise((resolve) => { release = resolve; });
  const stale = h.req({});
  stale.json = () => { bodyStarted(); return body; };
  const pending = route.POST(stale);
  await started;
  assert.equal((await route.POST(h.req({ password: 'owner-pass' }))).status, 200); // secret-ok
  const saved = h.files.get(ENV_FILE);
  const writes = h.effects.length;
  release({ password: 'stale-pass' }); // secret-ok
  assert.equal((await pending).status, 409);
  assert.equal(h.files.get(ENV_FILE), saved);
  assert.equal(h.effects.length, writes);
  assert.equal(h.process.env.REV4A_PASSWORD, 'owner-pass');
});

await test('final check detects a password written to disk without an in-memory update, and rereads fresh secrets', async () => {
  const h = harness();
  const route = h.load('app/api/setup/password/route.ts');
  const req = h.req({});
  req.json = async () => {
    h.files.set(ENV_FILE, 'REV4A_PASSWORD=external-owner\n');
    return { password: 'stale-pass' }; // secret-ok
  };
  assert.equal((await route.POST(req)).status, 409);
  assert.equal(h.effects.length, 0);
  h.files.set(ENV_FILE, '');
  req.json = async () => {
    h.files.set(ENV_FILE, '# changed while body was read\nREV4A_TOKEN=fresh-token\n');
    return { password: 'owner-pass' }; // secret-ok
  };
  assert.equal((await route.POST(req)).status, 200);
  assert.match(h.files.get(ENV_FILE), /# changed while body was read\nREV4A_TOKEN=fresh-token\n/);
});

await test('configured installs ignore setup codes: normal bearer/cookie auth applies; password setup stays 409', async () => {
  const h = harness({ REV4A_PASSWORD: 'owner-pass', REV4A_TOKEN: 'test-bearer', REV4A_JWT_SECRET: 'test-secret' }); // secret-ok
  for (const code of [null, CODE, 'wrong']) {
    assert.equal((await h.auth.requireAuthIfConfigured(h.req({}, code))).status, 401);
    assert.equal(await h.auth.requireAuthIfConfigured(h.req({}, code, { authorization: 'Bearer test-bearer' })), null);
    const req = h.req({}, code);
    req.cookies = { get: () => ({ value: 'valid-cookie' }) };
    assert.equal(await h.auth.requireAuthIfConfigured(req), null);
    assert.equal((await h.load('app/api/setup/password/route.ts').POST(req)).status, 409);
  }
  assert.equal(h.logs.length, 0);
  assert.equal(h.process.env.REV4A_SETUP_CODE, undefined);
  h.process.env.REV4A_PASSWORD = 'changed-owner-pass'; // secret-ok: local test fixture
  const stale = h.req({}, CODE);
  stale.cookies = { get: () => ({ value: 'valid-cookie' }) };
  assert.equal((await h.auth.requireAuthIfConfigured(stale)).status, 401);
});

await test('development fallback generates one 80-bit code, logs once and shares it across route bundles', async () => {
  const h = harness({});
  assert.equal((await h.auth.requireAuthIfConfigured(h.req({}, null))).status, 403);
  const code = h.process.env.REV4A_SETUP_CODE;
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /open the dashboard and enter this code/);
  const anotherBundle = h.load('lib/rev4a-auth.js');
  assert.equal(await anotherBundle.requireAuthIfConfigured(h.req({}, code.toLowerCase())), null);
  assert.equal(h.logs.length, 1);
});

// Parse out the actual function declarations. Never evaluate the CLI entrypoint or preflight.
const cliSource = fs.readFileSync(path.join(root, 'bin/rev4a.js'), 'utf8');
const cliAst = ts.createSourceFile('rev4a.js', cliSource, ts.ScriptTarget.Latest, true);
function cliFunction(name) {
  const node = cliAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name.text === name);
  assert.ok(node, name);
  return node.getText(cliAst);
}

/** Model separate temp-file writes and rename, including a symlinked .env target. */
function launcherFiles(content, target = ENV_FILE) {
  const files = new Map([[target, content]]);
  const modes = new Map([[target, 0o600]]);
  const links = new Map(target === ENV_FILE ? [] : [[ENV_FILE, target]]);
  const descriptors = new Map();
  let nextFd = 10;
  const writes = [];
  const resolve = (file) => links.get(file) ?? file;
  const missing = () => Object.assign(new Error('Missing'), { code: 'ENOENT' });
  const storage = {
    files, modes, links, descriptors, writes, beforeWrite: null,
    get content() { return files.get(target); },
    existsSync: (file) => file === '/mock/link' || files.has(resolve(file)),
    realpathSync: (file) => {
      if (!files.has(resolve(file))) throw missing();
      return resolve(file);
    },
    readFileSync: (file) => {
      if (!files.has(resolve(file))) throw missing();
      return files.get(resolve(file));
    },
    openSync: (file, flags, mode) => {
      assert.equal(flags, 'wx');
      assert.equal(mode, 0o600);
      // Exclusive creation refuses even a dangling symlink; it never follows it.
      if (files.has(file) || links.has(file)) throw Object.assign(new Error('Exists'), { code: 'EEXIST' });
      files.set(file, '');
      modes.set(file, mode);
      const fd = nextFd++;
      descriptors.set(fd, file);
      return fd;
    },
    closeSync: (fd) => { assert.ok(descriptors.delete(fd), 'close an open descriptor'); },
    writeFileSync: (fd, next, encoding) => {
      assert.equal(encoding, 'utf-8');
      assert.ok(descriptors.has(fd), 'write through the exclusively opened descriptor');
      const file = descriptors.get(fd);
      writes.push(next);
      storage.beforeWrite?.(file, next);
      files.set(file, next);
    },
    statSync: (file) => {
      if (!files.has(resolve(file))) throw missing();
      return { mode: modes.get(resolve(file)) };
    },
    chmodSync: (file, mode) => {
      assert.ok(files.has(resolve(file)));
      modes.set(resolve(file), mode);
    },
    renameSync: (from, to) => {
      assert.ok(files.has(from));
      assert.ok(!descriptors.size, 'close the descriptor before renaming');
      links.delete(to); // rename replaces a destination link rather than following it.
      files.set(to, files.get(from));
      modes.set(to, modes.get(from));
      files.delete(from);
      modes.delete(from);
    },
    rmSync: (file, options) => {
      assert.equal(options.force, true);
      links.delete(file); // unlink a link, never its target.
      files.delete(file);
      modes.delete(file);
    },
  };
  return storage;
}

function launcher(content, inherited = {}, repair = false) {
  const logs = [];
  const children = [];
  const storage = launcherFiles(content);
  const context = vm.createContext({
    ENV_SOURCE: ENV_FILE, ROOT: '/mock', ENV_LINK: '/mock/link', CONFIG_DIR: '/mock', DATA_DIR: '/mock/data', join: path.join,
    ...storage, log: (tag, message) => logs.push({ tag, message }),
    randomString: (len) => crypto.randomBytes(len).toString('base64url').slice(0, len),
    seedAgentToken: () => {}, refuseIfLoaderKeysLeft: () => {},
    skippedEnvKeys: new Set(), process: { env: inherited, pid: 42, execPath: '/mock/node', on: () => {} }, crypto,
    ...validator,
    preflight: () => { if (repair) vm.runInContext('ensureEnv();', context); },
    checkVersion: () => {}, setTimeout: () => {}, setInterval: () => ({ unref: () => {} }),
    spawn: (_exec, args, options) => {
      children.push({ args, env: options.env });
      return { pid: children.length, on: () => {} };
    },
    require: (name) => { assert.equal(name, 'crypto'); return crypto; },
  });
  vm.runInContext(`${cliFunction('ensureEnv')}\n${cliFunction('loadEnv')}\n${cliFunction('serve')}\nserve(3740);`, context);
  return { logs, children, context, writes: storage.writes, get content() { return storage.content; } };
}

await test('launcher filters loader controls already present in old .env, warns once per key, preserves arbitrary other keys', () => {
  const keys = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_CUSTOM'];
  const h = launcher(['REV4A_PASSWORD=owner-pass', 'CUSTOM_OPERATOR_KEY=abc', 'PATH=/operator/bin',
    ...keys.flatMap((key) => [`${key}=SENTINEL_PRIVATE_VALUE`, `${key}=SENTINEL_PRIVATE_VALUE`])].join('\n'));
  vm.runInContext('loadEnv()', h.context);
  for (const child of h.children) {
    for (const key of keys) assert.equal(child.env[key], undefined, key);
    assert.equal(child.env.CUSTOM_OPERATOR_KEY, 'abc');
    assert.equal(child.env.PATH, '/operator/bin');
  }
  for (const key of keys) assert.equal(h.logs.filter(({ message }) => message.endsWith(`key ${key}`)).length, 1);
  assert.ok(!JSON.stringify(h.logs).includes('SENTINEL_PRIVATE_VALUE'));
  assert.equal(h.logs.filter(({ tag }) => tag === 'SETUP').length, 0);
});

await test('launcher skips loader keys after lone CR, with colon syntax and export prefixes', () => {
  const keys = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_CUSTOM'];
  for (const separator of ['\r', '\n', '\r\n']) {
    const content = ['REV4A_PASSWORD=abcdefgh', ...keys.flatMap((key) =>
      [`${key}=SENTINEL_PRIVATE_VALUE`, `${key}: SENTINEL_PRIVATE_VALUE`, `export ${key}=SENTINEL_PRIVATE_VALUE`]),
      'export CUSTOM_OPERATOR_KEY=keep', 'PROVIDER_VENDOR.OPTION=keep-too', 'VENDOR@OPTION=legacy'].join(separator);
    const h = launcher(content);
    const parsed = vm.runInContext('loadEnv()', h.context);
    assert.equal(parsed.REV4A_PASSWORD, 'abcdefgh');
    assert.equal(parsed.CUSTOM_OPERATOR_KEY, 'keep');
    for (const child of h.children) {
      for (const key of keys) assert.equal(child.env[key], undefined);
      assert.equal(child.env['PROVIDER_VENDOR.OPTION'], 'keep-too');
      assert.equal(child.env['VENDOR@OPTION'], 'legacy');
    }
    for (const key of keys) assert.equal(h.logs.filter(({ message }) => message.endsWith(`key ${key}`)).length, 1);
    assert.ok(!JSON.stringify(h.logs).includes('SENTINEL_PRIVATE_VALUE'));
  }
});

await test('launcher generates a fresh code only before configuration and passes it only to server.js', () => {
  const a = launcher('REV4A_PASSWORD=\nREV4A_SETUP_CODE=untrusted-file-value\n');
  const b = launcher('');
  const code = a.children[0].env.REV4A_SETUP_CODE;
  assert.equal(vm.runInContext('loadEnv()', a.context).REV4A_SETUP_CODE, undefined);
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.notEqual(code, b.children[0].env.REV4A_SETUP_CODE);
  assert.equal(a.children[0].args[0], 'server.js');
  for (const child of a.children.slice(1)) assert.equal(child.env.REV4A_SETUP_CODE, undefined);
  assert.equal(a.logs.filter(({ tag }) => tag === 'SETUP').length, 1);
  assert.ok(a.logs.some(({ message }) => message.includes(code) && message.includes('open the dashboard and enter this code')));
  for (const [file, inherited] of [['REV4A_PASSWORD=existing\n', {}], ['', { REV4A_PASSWORD: 'existing' }]]) { // secret-ok
    const configured = launcher(file, inherited);
    assert.equal(configured.logs.filter(({ tag }) => tag === 'SETUP').length, 0);
    for (const child of configured.children) assert.equal(child.env.REV4A_SETUP_CODE, undefined);
  }
});

await test('launcher strips inherited runtime-only state before supplying per-boot child credentials', () => {
  const inherited = Object.fromEntries(validator.RUNTIME_ONLY_ENV_KEYS.map((key) => [key, 'stale-runtime']));
  inherited.CUSTOM_OPERATOR_KEY = 'preserved';
  for (const configured of [false, true]) {
    const content = (configured ? 'REV4A_PASSWORD=existing\n' : '') // secret-ok
      + validator.RUNTIME_ONLY_ENV_KEYS.map((key) => `${key}=stale-file\n`).join('');
    const h = launcher(content, inherited);
    for (const child of h.children) {
      const entry = child.args[0];
      for (const key of validator.RUNTIME_ONLY_ENV_KEYS) {
        const value = child.env[key];
        if (key === 'REV4A_TERMINAL_SECRET' && entry !== 'daemon.js') {
          assert.match(value, /^[a-f0-9]{64}$/);
        } else if (key === 'REV4A_SETUP_CODE' && entry === 'server.js' && !configured) {
          assert.match(value, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/);
        } else if (key === 'REV4A_DOTENV_KEYS') {
          // Names of the keys that came from .env (SEC-9B); never a runtime-only key and never a value.
          assert.equal(typeof value, 'string');
          for (const runtime of validator.RUNTIME_ONLY_ENV_KEYS) assert.ok(!value.split(',').includes(runtime), runtime);
          assert.ok(!value.includes('stale-file'));
          if (configured) assert.ok(value.split(',').includes('REV4A_PASSWORD'), 'names the keys that came from .env');
        } else assert.equal(value, undefined, `${entry}: ${key}`);
      }
      assert.equal(child.env.CUSTOM_OPERATOR_KEY, 'preserved');
    }
    assert.equal(h.children[0].env.REV4A_TERMINAL_SECRET, h.children[2].env.REV4A_TERMINAL_SECRET);
    assert.ok(!JSON.stringify(h.logs).includes('stale-runtime'));
    assert.equal(inherited.REV4A_SERVER_PID, 'stale-runtime');
  }
});

await test('launcher preserves operator-inherited loader controls even when .env contains the same keys', () => {
  const inherited = Object.fromEntries(['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD',
    'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_CUSTOM'].map((key) => [key, 'operator-value']));
  inherited.NODE_OPTIONS = '--max-old-space-size=4096';
  const h = launcher(['REV4A_PASSWORD=existing', ...Object.keys(inherited).map((key) => `${key}=file-value`)].join('\n'), inherited);
  for (const child of h.children) {
    for (const [key, value] of Object.entries(inherited)) assert.equal(child.env[key], value);
  }
});

await test('server snapshots before requiring Next and strips only newly loaded controls after prepare, before serving', async () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true);
  const main = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'main');
  const keys = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_CUSTOM'];
  for (const inherited of [{}, { NODE_OPTIONS: '--max-old-space-size=4096' },
    Object.fromEntries(keys.map((key) => [key, 'operator-value']))]) {
    const env = { ...inherited, CUSTOM_OPERATOR_KEY: 'abc' };
    const logs = [];
    const assertEnv = () => {
      for (const key of keys) assert.equal(env[key], inherited[key]);
      assert.equal(env.CUSTOM_OPERATOR_KEY, 'abc');
    };
    let prepared = false;
    let listening = false;
    const context = vm.createContext({
      require: (name) => { assert.equal(name, './lib/env-file.js'); return validator; },
      process: { env, on: () => {} }, console: { warn: (message) => logs.push(message) },
      parseTrustedProxies: () => ({ invalid: [], wide: [] }), __dirname: '/mock', PORT: 3740,
      // Listener start-up (REV4A_LISTEN) is covered by test-listen-addresses.mjs; here it only records that it ran.
      startListeners: async (server) => { listening = true; return [server]; },
      next: () => {
        // Model env loading both during Next construction and during prepare().
        if (!('NODE_OPTIONS' in env)) env.NODE_OPTIONS = 'SENTINEL_PRIVATE_VALUE';
        return {
          prepare: async () => {
            for (const key of keys) if (!(key in env)) env[key] = 'SENTINEL_PRIVATE_VALUE';
            prepared = true;
          },
          getRequestHandler: () => { assert.equal(prepared, true); assertEnv(); return () => {}; },
        };
      },
      http: { createServer: () => {
        assertEnv();
        return { on: () => {}, close: () => {} };
      } },
    });
    const snapshot = source.slice(source.indexOf("'use strict';"), source.indexOf("const http = require('http');"));
    vm.runInContext(snapshot, context);
    await vm.runInContext(`${main.getText(ast)}\nmain();`, context);
    assert.equal(listening, true);
    for (const key of keys) {
      assert.equal(logs.filter((message) => message.endsWith(`key ${key}`)).length, key in inherited ? 0 : 1);
    }
    assert.ok(!JSON.stringify(logs).includes('SENTINEL_PRIVATE_VALUE'));
    validator.stripUninheritedLoaderEnv(env, new Set(Object.keys(inherited)), (message) => logs.push(message));
    assert.equal(logs.length, keys.length - Object.keys(inherited).length);
  }
});

await test('the default .env generator validates assignments too, before any write', () => {
  for (const value of ['abc', 'abc\nNODE_OPTIONS=payload']) {
    const writes = [];
    const context = vm.createContext({
      existsSync: () => false, ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', CONFIG_DIR: '/mock',
      readFileSync: () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
      log: () => {}, mkdirSync: () => {}, randomString: () => value,
      assertEnvValue: validator.assertEnvValue, seedAgentToken: () => {}, loaderKeysNextWouldLoad: () => [], refuseIfLoaderKeysLeft: () => {},
      writeFileSync: (_file, content) => writes.push(content), require: () => ({ symlinkSync: () => {} }),
      chmodSync: (file, mode) => { assert.equal(file, ENV_FILE); assert.equal(mode, 0o600); },
      statSync: () => ({ mode: 0o600 }),
    });
    const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
    if (value.includes('\n')) {
      assert.throws(run, /REV4A_JWT_SECRET/);
      assert.equal(writes.length, 0);
    } else {
      run();
      assert.equal(writes.length, 1);
      assert.match(writes[0], /^REV4A_JWT_SECRET=abc$/m);
    }
  }
});

await test('default .env generation preserves existing files and aborts on read errors other than ENOENT', () => {
  for (const error of [null, 'EACCES', 'EIO', 'EISDIR']) {
    const writes = [];
    const context = vm.createContext({
      ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', existsSync: () => true,
      readFileSync: () => {
        if (error) throw Object.assign(new Error(error), { code: error });
        return 'PROVIDER_KEEP=existing\n';
      },
      log: () => {}, seedAgentToken: () => {}, loaderKeysNextWouldLoad: () => [], refuseIfLoaderKeysLeft: () => {}, writeFileSync: (...args) => writes.push(args),
      statSync: () => ({ mode: 0o600 }),
      chmodSync: (file, mode) => { assert.equal(file, ENV_FILE); assert.equal(mode, 0o600); },
      parseEnvValues: envFile.parseEnvValues, applyEnvEdits: envFile.applyEnvEdits, process: { env: {} },
      disableLoaderEnvLines: envFile.disableLoaderEnvLines,
      removeRuntimeEnvLines: envFile.removeRuntimeEnvLines,
    });
    const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
    if (error) assert.throws(run, { code: error });
    else run();
    assert.equal(writes.length, 0);
  }
});

await test('wizard sends the code only on setup/wizard calls and tolerates unavailable sessionStorage', async () => {
  const storage = new Map();
  const calls = [];
  const sessionStorage = {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const client = load('app/wizard/storage.ts', {}, { sessionStorage,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ done: true }) }; },
  });
  client.rememberSetupCode(CODE);
  assert.equal(await client.isWizardComplete(), true);
  assert.equal(await client.resetWizard(), true);
  assert.equal(await client.markWizardComplete(), true);
  for (const call of calls) assert.equal(call.options.headers['x-rev4a-setup-code'], CODE);
  assert.equal(Object.keys(client.setupCodeHeaders()).length, 0);
  const unavailable = load('app/wizard/storage.ts', {}, { sessionStorage: {
    getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Denied'); },
  } });
  unavailable.rememberSetupCode(CODE);
  assert.equal(Object.keys(unavailable.setupCodeHeaders()).length, 0);
});

await test('setup UI uses the shared Input, sends the code header and guards repeated submission', async () => {
  const callbacks = [];
  const calls = [];
  const saved = [];
  let stateIndex = 0;
  const Input = () => {};
  const client = load('app/setup/PageClient.tsx', {
    'react/jsx-runtime': require('react/jsx-runtime'),
    react: {
      useState: (initial) => [[initial, '12345678', CODE, initial, initial][stateIndex++], () => {}],
      useCallback: (fn) => { callbacks.push(fn); return fn; }, useEffect: () => {}, useRef: (value) => ({ current: value }),
    },
    'next/navigation': { useRouter: () => ({ push: () => {} }) },
    '../components/ui': { Input, Button: () => {} },
    '../wizard/icons': { ArrowRightIcon: () => {}, CheckCircleIcon: () => {} },
    '../wizard/storage': { rememberSetupCode: (code) => saved.push(code) },
  }, { fetch: async (url, options) => { calls.push({ url, options }); return { ok: true }; } });
  const nodes = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    nodes.push(node);
    visit(node.props?.children);
  }
  visit(client.default());
  assert.ok(nodes.some((node) => node.type === Input && node.props.label === 'Setup code'));
  await Promise.all([callbacks[0](), callbacks[0]()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/setup/password');
  assert.equal(calls[0].options.headers['x-rev4a-setup-code'], CODE);
  assert.deepEqual(JSON.parse(calls[0].options.body), { password: '12345678' }); // secret-ok
  assert.deepEqual(saved, [CODE]);
});

await test('FIX-133: when Next would still load a loader key from .env, the launcher refuses to start', () => {
  const exits = []; const logs = [];
  const context = vm.createContext({
    ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', existsSync: () => true,
    readFileSync: () => 'REV4A_PASSWORD=x\nNODE_OPTIONS\n=--import=/x.mjs\n', writeFileSync: () => {}, chmodSync: () => {}, statSync: () => ({ mode: 0o100600 }),
    log: (_t, m) => logs.push(m), seedAgentToken: () => {}, loaderKeysNextWouldLoad: () => ['NODE_OPTIONS'], ROOT: '/mock/root',
    parseEnvValues: envFile.parseEnvValues, applyEnvEdits: envFile.applyEnvEdits,
    disableLoaderEnvLines: envFile.disableLoaderEnvLines, removeRuntimeEnvLines: envFile.removeRuntimeEnvLines,
    process: { env: {}, exit: (c) => { exits.push(c); throw new Error('exit'); } },
  });
  assert.throws(() => vm.runInContext(cliFunction('refuseIfLoaderKeysLeft') + '\n' + cliFunction('ensureEnv') + '\nensureEnv();', context), /exit/);
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((m) => m.startsWith('Refusing to start') && m.includes('NODE_OPTIONS')));
  assert.ok(!logs.join('\n').includes('/x.mjs'), 'the value is never logged');
});

await test('FIX-133: setup keeps existing secrets in every accepted line form (CR, CRLF, export, spaces)', async () => {
  for (const content of ['REV4A_JWT_SECRET=keepjwt\rREV4A_TOKEN=keeptok\r', 'REV4A_JWT_SECRET=keepjwt\r\nREV4A_TOKEN=keeptok\r\n',
    'export REV4A_JWT_SECRET=keepjwt\nREV4A_TOKEN = keeptok\n']) {
    const h = harness({ REV4A_SETUP_CODE: CODE }, content);
    const r = await h.load('app/api/setup/password/route.ts').POST(h.req({ password: 'abcdefgh' }, CODE)); // secret-ok
    assert.equal(r.status, 200, JSON.stringify(content));
    const saved = h.files.get(ENV_FILE);
    assert.ok(saved.includes('keepjwt') && saved.includes('keeptok'), JSON.stringify(saved));
    assert.equal((saved.match(/REV4A_JWT_SECRET/g) || []).length, 1);
  }
});

await test('BUG-15: setup replaces empty generated secrets, keeps non-empty secrets, and repairs only once', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const empty of ['', '   ', '""', "''", '``', ' # copied template']) {
      const content = ['# operator settings', 'REV4A_PASSWORD=', 'REV4A_JWT_SECRET=old',
        `export REV4A_JWT_SECRET = ${empty}`, `REV4A_TOKEN=${empty}`, 'PORT=3740', ''].join(newline);
      const h = harness({ REV4A_SETUP_CODE: CODE }, content);
      const route = h.load('app/api/setup/password/route.ts');
      assert.equal((await route.POST(h.req({ password: 'abcdefgh' }))).status, 200); // secret-ok
      const saved = h.files.get(ENV_FILE);
      assert.match(validator.readEnvValue(saved, 'REV4A_JWT_SECRET'), /^[A-Za-z0-9_-]{64}$/);
      assert.match(validator.readEnvValue(saved, 'REV4A_TOKEN'), /^[A-Za-z0-9_-]{32}$/);
      assert.equal(h.auth.getJwtSecret(), validator.readEnvValue(saved, 'REV4A_JWT_SECRET'));
      assert.equal((saved.match(/REV4A_JWT_SECRET/g) || []).length, 1);
      assert.ok(saved.startsWith(`# operator settings${newline}`));
      assert.ok(saved.endsWith(`PORT=3740${newline}`));
      assert.equal((await route.POST(h.req({ password: 'abcdefgh' }))).status, 409); // secret-ok
      assert.equal(h.files.get(ENV_FILE), saved);
    }
    const content = ['REV4A_JWT_SECRET=keep-jwt # note', 'REV4A_TOKEN=keep-token # note', ''].join(newline);
    const h = harness({ REV4A_SETUP_CODE: CODE }, content);
    assert.equal((await h.load('app/api/setup/password/route.ts').POST(h.req({ password: 'abcdefgh' }))).status, 200); // secret-ok
    assert.ok(h.files.get(ENV_FILE).startsWith(content), 'non-empty secrets and their comments stay byte-for-byte intact');
  }
  for (const raw of ['0', '-1', 'NaN', "' '"]) {
    const initial = `REV4A_JWT_SECRET=${raw}\nREV4A_TOKEN=${raw}\n`;
    const h = harness({ REV4A_SETUP_CODE: CODE }, initial);
    assert.equal((await h.load('app/api/setup/password/route.ts').POST(h.req({ password: 'abcdefgh' }))).status, 200); // secret-ok
    assert.ok(h.files.get(ENV_FILE).startsWith(initial));
  }
});

await test('BUG-15: setup does not shadow secrets the service environment already provides', async () => {
  const content = 'REV4A_PASSWORD=\nREV4A_JWT_SECRET=\nREV4A_TOKEN=\nPORT=3740\n';
  const h = harness({ REV4A_SETUP_CODE: CODE, REV4A_JWT_SECRET: 'service-jwt', REV4A_TOKEN: 'service-token' }, content); // secret-ok
  const route = h.load('app/api/setup/password/route.ts');
  assert.equal((await route.POST(h.req({ password: 'abcdefgh' }))).status, 200); // secret-ok
  const saved = h.files.get(ENV_FILE);
  assert.equal(validator.readEnvValue(saved, 'REV4A_PASSWORD'), 'abcdefgh');
  assert.ok(saved.includes('REV4A_JWT_SECRET=\n') && saved.includes('REV4A_TOKEN=\n'), 'empty lines stay unchanged');
  assert.equal(validator.readEnvValue(saved, 'REV4A_JWT_SECRET'), '');
  assert.equal(validator.readEnvValue(saved, 'REV4A_TOKEN'), '');
});

await test('BUG-15: launcher, auth fallback and terminal auth read the same file values, with inherited precedence retained', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true);
  const reader = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'authEnvValue');
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const [raw, expected] of [['abc # note', 'abc'], ['abc#note', 'abc'], ['"abc # literal" # note', 'abc # literal'],
      ["'abc # literal'", 'abc # literal'], ['`abc # literal`', 'abc # literal'], ['"line\\nnext"', 'line\nnext'],
      ['', ''], ['""', ''], ["''", ''], [' # empty', '']]) {
      const content = ['REV4A_PASSWORD=earlier', `export REV4A_PASSWORD = ${raw}`,
        'REV4A_JWT_SECRET=earlier', `REV4A_JWT_SECRET: ${raw || ' '}`, ''].join(newline);
      const h = harness({}, content);
      assert.equal(h.auth.getPassword(), expected);
      assert.equal(h.auth.getJwtSecret(), expected);
      const launch = launcher(content);
      const parsed = vm.runInContext('loadEnv()', launch.context);
      assert.equal(parsed.REV4A_PASSWORD, expected);
      assert.equal(parsed.REV4A_JWT_SECRET, expected);
      const env = {};
      const context = vm.createContext({ process: { env }, fs: { readFileSync: () => content },
        path, DATA_DIR: '/mock', readEnvValue: validator.readEnvValue });
      vm.runInContext(reader.getText(ast), context);
      for (const key of ['REV4A_PASSWORD', 'REV4A_JWT_SECRET']) {
        assert.equal(context.authEnvValue(key), expected);
        env[key] = 'service-value';
        assert.equal(context.authEnvValue(key), 'service-value');
        h.process.env[key] = 'service-value';
      }
      assert.equal(h.auth.getPassword(), 'service-value');
      assert.equal(h.auth.getJwtSecret(), 'service-value');
    }
  }
});

await test('BUG-15: setup/restart checks the parsed final password before scheduling a restart', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const [raw, status] of [['abcdefgh # note', 200], ['"abc # literal" # note', 200],
      ["'abcdefgh'", 200], ["' '", 200], ['0', 200], ['-1', 200], ['NaN', 200],
      [' # empty', 400], ['""', 400], ["''", 400], ['``', 400], ['', 400]]) {
      const content = ['REV4A_PASSWORD=old', `export REV4A_PASSWORD = ${raw}`, ''].join(newline);
      const h = harness({ REV4A_TOKEN: 'test-bearer', REV4A_SETUP_CODE: CODE }, content); // secret-ok
      const req = h.req({}, CODE, { authorization: 'Bearer test-bearer' });
      const response = await h.load('app/api/setup/restart/route.ts').POST(req);
      assert.equal(response.status, status);
      assert.equal(h.effects.some(([effect]) => effect === 'timer'), status === 200);
      assert.equal(h.files.get(ENV_FILE), content);
    }
  }
  for (const readError of ['EACCES', 'ENOENT']) {
    const h = harness({ REV4A_TOKEN: 'test-bearer', REV4A_PASSWORD: 'abcdefgh' }, '', readError); // secret-ok
    const response = await h.load('app/api/setup/restart/route.ts').POST(h.req({}, null,
      { authorization: 'Bearer test-bearer' }));
    assert.equal(response.status, 500);
    assert.equal(h.effects.length, 0);
  }
});

await test('BUG-15: repair, file loading and serve preserve inherited secrets in all three child environments', async () => {
  const jose = await import('jose');
  for (const assignment of ['', ' # note']) {
    const initial = `REV4A_PASSWORD=abcdefgh # note\nREV4A_JWT_SECRET=${assignment}\nREV4A_TOKEN=${assignment}\n`;
    for (const [label, inherited, expectedWrites] of [
      ['neither', {}, 1],
      ['both', { REV4A_JWT_SECRET: '# note', REV4A_TOKEN: '# note' }, 0],
      ['JWT only', { REV4A_JWT_SECRET: '# note' }, 1],
      ['token only', { REV4A_TOKEN: '# note' }, 1],
    ]) {
      const h = launcher(initial, inherited, true);
      assert.equal(h.writes.length, expectedWrites);
      assert.deepEqual(h.children.map((child) => child.args[0]), ['server.js', 'daemon.js', 'terminal-ws-server.js']);
      const fileValues = validator.parseEnvValues(h.content);
      for (const child of h.children) {
        assert.equal(child.env.REV4A_PASSWORD, 'abcdefgh');
        for (const [key, length] of [['REV4A_JWT_SECRET', 64], ['REV4A_TOKEN', 32]]) {
          if (inherited[key]) {
            assert.equal(child.env[key], inherited[key]);
            assert.equal(fileValues[key], '', 'inherited secrets must not be written to the file');
          } else {
            assert.match(child.env[key], new RegExp(`^[A-Za-z0-9_-]{${length}}$`));
            assert.equal(child.env[key], fileValues[key]);
          }
        }
        const auth = harness(child.env, h.content);
        assert.equal(auth.auth.isConfigured(), true);
        assert.equal(auth.auth.getJwtSecret(), child.env.REV4A_JWT_SECRET);
        assert.equal(await auth.auth.requireAuthJWT(auth.req({}, null,
          { authorization: `Bearer ${child.env.REV4A_TOKEN}` })), null);
        const login = load('app/api/auth/login/route.ts', {
          'next/server': require('next/server'), jose, '@/lib/rev4a-auth': auth.auth,
          '@/lib/login-throttle': require('../lib/login-throttle.js'),
          '@/lib/client-address': require('../lib/client-address.js'),
          '@/lib/session-cookie': load('lib/session-cookie.ts', {}, { process: { env: child.env } }),
        }, { process: { env: child.env } });
        const response = await login.POST(auth.req({ password: 'abcdefgh' })); // secret-ok: local fixture
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        const { payload } = await jose.jwtVerify(response.cookies.get('rev4a_token').value,
          new TextEncoder().encode(child.env.REV4A_JWT_SECRET));
        assert.equal(payload.pwf, fingerprint.passwordFingerprint('abcdefgh', child.env.REV4A_JWT_SECRET));
        assert.equal(child.env.REV4A_SETUP_CODE, undefined);
      }
      const saved = h.content;
      vm.runInContext('serve(3740);', h.context);
      assert.equal(h.content, saved);
      assert.equal(h.writes.length, expectedWrites);
      assert.equal(h.logs.filter(({ message }) => message.startsWith('Filled empty .env secret(s):')).length, expectedWrites);
      for (let i = 0; i < 3; i++) {
        assert.equal(h.children[i + 3].env.REV4A_JWT_SECRET, h.children[i].env.REV4A_JWT_SECRET);
        assert.equal(h.children[i + 3].env.REV4A_TOKEN, h.children[i].env.REV4A_TOKEN);
      }
      const child = h.children[0].env;
      console.log(`     ${JSON.stringify({ file: assignment ? 'comment-only' : 'empty', inherited: label,
        writes: h.writes.length, children: 3, jwtLength: child.REV4A_JWT_SECRET.length,
        tokenLength: child.REV4A_TOKEN.length, auth: 'ok', loginStatus: 200, secondStart: 'unchanged' })}`);
    }
  }
});

await test('BUG-15: empty file values preserve every non-empty inherited value; non-empty file values still win', () => {
  const content = 'CUSTOM_EMPTY=\nCUSTOM_COMMENT= # note\nCUSTOM_QUOTES=""\nCUSTOM_BACKTICKS=``\n'
    + "CUSTOM_SINGLE=''\nCUSTOM_SPACE=' '\nCUSTOM_ZERO=0\nCUSTOM_FILE=file # note\nCUSTOM_UNSET=\n";
  for (const value of ['service-value', '# note', '0', ' ']) {
    const inherited = Object.fromEntries(['CUSTOM_EMPTY', 'CUSTOM_COMMENT', 'CUSTOM_QUOTES', 'CUSTOM_BACKTICKS',
      'CUSTOM_SINGLE', 'CUSTOM_SPACE', 'CUSTOM_ZERO', 'CUSTOM_FILE'].map((key) => [key, value]));
    const h = launcher(content, inherited);
    for (const child of h.children) {
      for (const key of ['CUSTOM_EMPTY', 'CUSTOM_COMMENT', 'CUSTOM_QUOTES', 'CUSTOM_BACKTICKS', 'CUSTOM_SINGLE']) {
        assert.equal(child.env[key], value);
      }
      assert.equal(child.env.CUSTOM_SPACE, ' ');
      assert.equal(child.env.CUSTOM_ZERO, '0');
      assert.equal(child.env.CUSTOM_FILE, 'file');
      assert.equal(child.env.CUSTOM_UNSET, '');
    }
  }
  const h = launcher('REV4A_PASSWORD=file-password\nREV4A_JWT_SECRET=file-secret\nREV4A_TOKEN=file-token\n', {
    REV4A_PASSWORD: 'service-password', REV4A_JWT_SECRET: 'service-secret', REV4A_TOKEN: 'service-token', // secret-ok: local fixtures
  }, true);
  assert.equal(h.writes.length, 0);
  for (const child of h.children) {
    assert.equal(child.env.REV4A_PASSWORD, 'file-password');
    assert.equal(child.env.REV4A_JWT_SECRET, 'file-secret');
    assert.equal(child.env.REV4A_TOKEN, 'file-token');
  }
});

await test('BUG-15: startup repairs already-configured empty secrets once, logs names only, and preserves service secrets', () => {
  const initial = '# keep\r\nREV4A_PASSWORD=abcdefgh # note\r\nREV4A_JWT_SECRET=""\r\nREV4A_TOKEN= # empty\r\nPORT=3740\r\n';
  for (const inherited of [{}, { REV4A_JWT_SECRET: 'service-secret', REV4A_TOKEN: 'service-token' }]) { // secret-ok: local fixtures
    const storage = launcherFiles(initial);
    const logs = [];
    const { writes } = storage;
    const context = vm.createContext({
      ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', ...storage, process: { env: inherited, pid: 42 },
      log: (_tag, message) => logs.push(message), seedAgentToken: () => {}, refuseIfLoaderKeysLeft: () => {},
      ...validator, randomString: (len) => crypto.randomBytes(len).toString('base64url').slice(0, len),
    });
    const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
    run();
    const saved = storage.content;
    if (inherited.REV4A_JWT_SECRET) {
      assert.equal(saved, initial);
      assert.equal(writes.length, 0);
    } else {
      assert.match(validator.readEnvValue(saved, 'REV4A_JWT_SECRET'), /^[A-Za-z0-9_-]{64}$/);
      assert.match(validator.readEnvValue(saved, 'REV4A_TOKEN'), /^[A-Za-z0-9_-]{32}$/);
      assert.ok(saved.startsWith('# keep\r\nREV4A_PASSWORD=abcdefgh # note\r\n'));
      assert.ok(saved.endsWith('PORT=3740\r\n'));
      assert.equal(writes.length, 1);
      assert.equal(logs.filter((line) => line === 'Filled empty .env secret(s): REV4A_JWT_SECRET, REV4A_TOKEN').length, 1);
      for (const key of ['REV4A_JWT_SECRET', 'REV4A_TOKEN']) assert.ok(!logs.join('\n').includes(validator.readEnvValue(saved, key)));
    }
    run();
    assert.equal(storage.content, saved);
    assert.equal(storage.modes.get(ENV_FILE), 0o600);
    assert.deepEqual([...storage.files.keys()], [ENV_FILE], 'rename leaves only the final file');
    assert.equal(writes.length, inherited.REV4A_JWT_SECRET ? 0 : 1);
  }
});

await test('BUG-15: startup leaves unusual files intact and retries a failed empty-secret repair on the next start', () => {
  for (const suffix of ['', 'NOTE="first\nlast"\n', 'NOTE="unterminated\n',
    'NOTE="value" # comment\n', 'NOTE: value\n', 'NOTE=\n"next line"\n', 'NOTE="escaped\\"quote"\n']) {
    const unusual = suffix !== '';
    const initial = 'REV4A_PASSWORD=abcdefgh\nREV4A_JWT_SECRET=\nREV4A_TOKEN=kept\n'
      + suffix;
    const storage = launcherFiles(initial);
    let failWrite = true;
    let writeAttempts = 0;
    const logs = [];
    storage.beforeWrite = () => {
      writeAttempts++;
      if (failWrite) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    };
    const context = vm.createContext({
      ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', ...storage, process: { env: {}, pid: 42 },
      log: (_tag, message) => logs.push(message), seedAgentToken: () => {}, refuseIfLoaderKeysLeft: () => {},
      ...validator, randomString: (len) => 'x'.repeat(len),
    });
    const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
    run();
    assert.equal(storage.content, initial);
    assert.deepEqual([...storage.files.keys()], [ENV_FILE]);
    assert.ok(logs.some((line) => line.startsWith('Warning:')));
    assert.ok(!logs.some((line) => line.startsWith('Filled empty')));
    failWrite = false;
    run();
    const content = storage.content;
    assert.equal(storage.modes.get(ENV_FILE), 0o600);
    assert.equal(validator.readEnvValue(content, 'REV4A_TOKEN'), 'kept');
    assert.equal(validator.readEnvValue(content, 'REV4A_JWT_SECRET'), unusual ? '' : 'x'.repeat(64));
    if (unusual) {
      assert.equal(content, initial);
      assert.equal(writeAttempts, 0, `Non-plain file must never be written: ${JSON.stringify(suffix)}`);
      assert.equal(logs.filter((line) => line.startsWith('Warning: empty .env secrets were not repaired')).length, 2);
    } else {
      assert.equal(writeAttempts, 2, 'Failed writes are retried on the next start');
    }
  }
});

await test('BUG-15: mocked EIO, exclusive temp creation and partial ENOSPC preserve config and retry safely', () => {
  for (const symlink of [false, true]) {
    for (const failure of ['EIO', 'EEXIST link', 'EEXIST file', 'EEXIST dangling link', 'ENOSPC']) {
      const target = symlink ? '/mock/target.env' : ENV_FILE;
      const initial = '# keep\r\nREV4A_PASSWORD=abcdefgh # note\r\nREV4A_JWT_SECRET=\r\nREV4A_TOKEN= # note\r\nGATEWAY_TOKEN=preserved\r\nPORT=3740\r\n';
      const storage = launcherFiles(initial, target);
      const tmp = `${target}.tmp-42`;
      const error = failure.split(' ')[0];
      if (failure === 'EEXIST file') {
        storage.files.set(tmp, 'pre-existing file');
        storage.modes.set(tmp, 0o640);
      } else if (error === 'EEXIST') {
        storage.links.set(tmp, failure === 'EEXIST dangling link' ? '/mock/missing' : ENV_FILE);
      }
      const originalFiles = [...storage.files];
      const originalLinks = [...storage.links];
      const originalModes = [...storage.modes];
      let fail = true;
      let opens = 0;
      let removals = 0;
      const logs = [];
      storage.beforeWrite = (file, next) => {
        if (fail && error === 'ENOSPC') {
          storage.files.set(file, next.slice(0, 29)); // Real progress after open, before failure.
          throw Object.assign(new Error('Disk full'), { code: error });
        }
      };
      const context = vm.createContext({
        ...storage, ...validator, ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link',
        realpathSync: (file) => {
          if (fail && error === 'EIO') throw Object.assign(new Error('I/O error'), { code: error });
          return storage.realpathSync(file);
        },
        openSync: (...args) => { opens++; return storage.openSync(...args); },
        rmSync: (...args) => { removals++; return storage.rmSync(...args); },
        process: { env: {}, pid: 42 }, randomString: (length) => 'x'.repeat(length),
        log: (_tag, message) => logs.push(message), seedAgentToken: () => {}, refuseIfLoaderKeysLeft: () => {},
      });
      const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
      for (let start = 1; start <= 2; start++) {
        const logStart = logs.length;
        run();
        assert.equal(storage.content, initial, 'preserve every byte, including unrelated config');
        assert.deepEqual([...storage.files], originalFiles);
        assert.deepEqual([...storage.links], originalLinks, 'source and pre-existing temp links stay intact');
        assert.deepEqual([...storage.modes], originalModes);
        assert.equal(storage.descriptors.size, 0, 'close the fd even after a partial write');
        assert.equal(opens, error === 'EIO' ? 0 : start);
        assert.equal(storage.writes.length, error === 'ENOSPC' ? start : 0);
        assert.equal(removals, error === 'ENOSPC' ? start : 0, 'remove only a temp file created by this attempt');
        const warnings = logs.slice(logStart).filter((line) => line.startsWith('Warning:'));
        assert.deepEqual(warnings, [`Warning: could not write the .env repair (${error})`]);
        assert.ok(!logs.some((line) => line.startsWith('Filled empty')));
        console.log(`     ${JSON.stringify({ fs: 'mock', file: symlink ? 'symlink' : 'plain', failure, start,
          originalIntact: true, sourceLinkIntact: symlink, preExistingTempUntouched: error === 'EEXIST',
          partialTempRemoved: error === 'ENOSPC', writes: storage.writes.length, warnings: warnings.length })}`);
      }
      fail = false;
      // The operator clears the conflicting entry; the repair must not have removed it.
      storage.files.delete(tmp);
      storage.modes.delete(tmp);
      storage.links.delete(tmp);
      run();
      const repaired = storage.content;
      assert.equal(repaired, validator.applyEnvEdits(initial, [
        ['REV4A_JWT_SECRET', 'x'.repeat(64)], ['REV4A_TOKEN', 'x'.repeat(32)],
      ]).content);
      assert.equal(storage.modes.get(target), 0o600);
      assert.deepEqual([...storage.files.keys()], [target]);
      assert.equal(storage.links.has(ENV_FILE), symlink);
      assert.equal(storage.descriptors.size, 0);
      const writes = storage.writes.length;
      run();
      assert.equal(storage.content, repaired);
      assert.equal(storage.writes.length, writes);
      assert.equal(logs.filter((line) => line.startsWith('Filled empty')).length, 1);
    }
  }
});

await test('BUG-15: real EIO, temp-symlink EEXIST and partial ENOSPC preserve the original, warn once and retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-bug15-repair-'));
  try {
    for (const symlink of [false, true]) {
      for (const error of ['EIO', 'EEXIST', 'ENOSPC']) {
        const target = path.join(dir, `${symlink ? 'linked-target' : 'plain.env'}-${error}`);
        const source = symlink ? path.join(dir, `linked-${error}.env`) : target;
        const initial = Buffer.from('# keep\r\nREV4A_PASSWORD=abcdefgh # note\r\nREV4A_JWT_SECRET=\r\nREV4A_TOKEN= # note\r\nGATEWAY_TOKEN=preserved\r\nPORT=3740\r\n');
        fs.writeFileSync(target, initial, { mode: 0o600 });
        if (symlink) fs.symlinkSync(target, source);
        const tmp = `${fs.realpathSync(source)}.tmp-${process.pid}`;
        if (error === 'EEXIST') fs.symlinkSync(source, tmp);
        let failWrite = true;
        let attempts = 0;
        const logs = [];
        const context = vm.createContext({
          ENV_SOURCE: source, ENV_LINK: source, ...validator,
          readFileSync: fs.readFileSync, existsSync: fs.existsSync, statSync: fs.statSync,
          realpathSync: (file) => {
            if (failWrite && error === 'EIO') throw Object.assign(new Error('I/O error'), { code: error });
            return fs.realpathSync(file);
          },
          renameSync: fs.renameSync, rmSync: fs.rmSync, chmodSync: fs.chmodSync,
          openSync: fs.openSync, closeSync: fs.closeSync,
          writeFileSync: (file, next, options) => {
            attempts++;
            if (failWrite && error === 'ENOSPC') {
              // The exclusively opened temp fd makes real progress before disk-full is injected.
              fs.writeFileSync(file, next.slice(0, 29), options);
              throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
            }
            fs.writeFileSync(file, next, options);
          },
          process: { env: {}, pid: process.pid }, randomString: (length) => 'x'.repeat(length),
          log: (_tag, message) => logs.push(message), seedAgentToken: () => {}, refuseIfLoaderKeysLeft: () => {},
        });
        const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
        for (let start = 1; start <= 2; start++) {
          const logStart = logs.length;
          run();
          assert.deepEqual(fs.readFileSync(source), initial, 'failed partial writes must preserve every original byte');
          assert.equal(fs.existsSync(tmp), error === 'EEXIST');
          if (error === 'EEXIST') assert.equal(fs.readlinkSync(tmp), source, 'never remove or follow a pre-existing temp symlink');
          if (symlink) assert.equal(fs.readlinkSync(source), target);
          assert.equal(fs.lstatSync(source).isSymbolicLink(), symlink);
          assert.equal(fs.statSync(source).mode & 0o777, 0o600);
          assert.equal(attempts, error === 'ENOSPC' ? start : 0);
          const warnings = logs.slice(logStart).filter((line) => line.startsWith('Warning:'));
          assert.deepEqual(warnings, [`Warning: could not write the .env repair (${error})`]);
          assert.ok(!logs.some((line) => line.startsWith('Filled empty')));
          console.log(`     ${JSON.stringify({ fs: 'real', file: symlink ? 'symlink' : 'plain', start, attempts,
            originalIntact: true, gateway: 'preserved', tempLeft: error === 'EEXIST', warnings: warnings.length, error })}`);
        }
        failWrite = false;
        if (error === 'EEXIST') fs.unlinkSync(tmp); // Remove only the test's pre-existing link to allow retry.
        run();
        const expectedAttempts = error === 'ENOSPC' ? 3 : 1;
        assert.equal(attempts, expectedAttempts);
        const repaired = fs.readFileSync(source, 'utf8');
        assert.equal(repaired, validator.applyEnvEdits(initial.toString(), [
          ['REV4A_JWT_SECRET', 'x'.repeat(64)], ['REV4A_TOKEN', 'x'.repeat(32)],
        ]).content);
        assert.equal(fs.existsSync(tmp), false);
        assert.equal(fs.lstatSync(source).isSymbolicLink(), symlink);
        assert.equal(fs.statSync(source).mode & 0o777, 0o600);
        run();
        assert.equal(attempts, expectedAttempts, 'successful repair is idempotent');
        assert.equal(fs.readFileSync(source, 'utf8'), repaired);
        assert.equal(logs.filter((line) => line.startsWith('Filled empty')).length, 1);
        console.log(`     ${JSON.stringify({ fs: 'real', file: symlink ? 'symlink' : 'plain', error, recovered: true, attempts,
          mode: '0600', repairLogs: 1, secondSuccessfulStart: 'unchanged' })}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nEXECUTED: test-setup-security.mjs — ${passed} setup security checks passed`);
