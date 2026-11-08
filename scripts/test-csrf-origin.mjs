#!/usr/bin/env node
/** SEC-18: exercise the actual middleware with NextRequest, without a running server. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const next = require('next/server');
const updates = require('../lib/update-state.js');
const dataDir = mkdtempSync(join(tmpdir(), 'rev4a-csrf-'));
// Use an isolated environment and update file: never read or change the operator's data.
const env = {};
const source = ts.transpileModule(readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dependencies = {
  'next/server': next,
  jose: await import('jose'),
  path: require('node:path'),
  '@/lib/rev4a-auth': { getJwtSecret: () => { throw new Error('API auth belongs to the route'); } },
  '@/lib/rev4a-paths': { REV4A_DATA: dataDir },
  '@/lib/update-state': updates,
};
const context = {
  exports: {}, URL, TextEncoder, process: { env },
  require: (id) => {
    assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
    return dependencies[id];
  },
};
vm.runInNewContext(source, context, { filename: 'proxy.ts' });
const { proxy } = context.exports;

function request({ method = 'POST', path = '/api/agents', cookie = true, headers = {}, body } = {}) {
  return new next.NextRequest(`https://rev4a.example.com:3740${path}`, {
    method,
    body,
    headers: {
      host: 'rev4a.example.com:3740',
      ...(cookie ? { cookie: 'rev4a_token=fixture' } : {}),
      ...headers,
    },
  });
}

let passed = 0;
async function check(name, options, status = 200) {
  const response = await proxy(request(options));
  assert.equal(response.status, status, name);
  if (status === 403) assert.deepEqual(await response.json(), { error: 'Cross-site request refused' }, name);
  if (status === 200) assert.equal(response.headers.get('x-middleware-next'), '1', name);
  passed++;
  console.log(`ok   ${name}`);
  return response;
}

try {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const [origin, status] of [
      ['https://rev4a.example.com:3740', 200],
      ['https://rev4a.example.com:3741', 403],
      ['https://other.example.net:3740', 403],
      ['null', 403],
      ['https://sibling.rev4a.example.com:3740', 403],
      ['https://REV4A.EXAMPLE.COM:3740', 200],
      ['not-an-origin', 403],
      ['', 403],
      ['https://rev4a.example.com:3740/other', 403],
      ['https://user@rev4a.example.com:3740', 403],
      ['file://rev4a.example.com:3740', 403],
    ]) {
      await check(`${method} cookie + Origin ${origin || '(empty)'}`, { method, headers: { origin } }, status);
    }
    for (const [site, status] of [
      ['same-origin', 200], ['none', 200], [undefined, 200], ['cross-site', 403], ['same-site', 403],
    ]) {
      await check(`${method} no Origin, Sec-Fetch-Site ${site ?? '(absent)'}`, {
        method, headers: site ? { 'sec-fetch-site': site } : {},
      }, status);
    }
  }
  await check('Host comparison is case-insensitive', {
    headers: { origin: 'https://rev4a.example.com:3740', host: 'REV4A.EXAMPLE.COM:3740' },
  });
  for (const [scheme, defaultPort, otherDefault] of [['http', '80', '443'], ['https', '443', '80']]) {
    for (const originPort of ['', `:${defaultPort}`]) {
      for (const hostPort of ['', `:${defaultPort}`]) {
        await check(`${scheme} default port: Origin ${originPort || '(implicit)'}, Host ${hostPort || '(implicit)'}`, {
          headers: { origin: `${scheme}://rev4a.example.com${originPort}`, host: `rev4a.example.com${hostPort}` },
        });
      }
    }
    await check(`${scheme} Host port ${otherDefault} is not its scheme default`, {
      headers: { origin: `${scheme}://rev4a.example.com`, host: `rev4a.example.com:${otherDefault}` },
    }, 403);
    await check(`${scheme} Origin port ${otherDefault} is not its scheme default`, {
      headers: { origin: `${scheme}://rev4a.example.com:${otherDefault}`, host: 'rev4a.example.com' },
    }, 403);
    await check(`${scheme} matching non-default port ${otherDefault} stays valid`, {
      headers: { origin: `${scheme}://rev4a.example.com:${otherDefault}`, host: `rev4a.example.com:${otherDefault}` },
    });
  }
  await check('reverse proxy that rewrites Host (nginx default): the browser says same-origin -> allowed', {
    headers: { origin: 'https://rev4a.example.com', host: '127.0.0.1:3740', 'sec-fetch-site': 'same-origin' },
  });
  await check('rewritten Host and a cross-site browser request -> refused', {
    headers: { origin: 'https://evil.example', host: '127.0.0.1:3740', 'sec-fetch-site': 'cross-site' },
  }, 403);
  await check('rewritten Host and a same-site (sibling sub-domain) request -> refused', {
    headers: { origin: 'https://evil.example.com', host: '127.0.0.1:3740', 'sec-fetch-site': 'same-site' },
  }, 403);
  await check('Origin null is refused even with same-origin metadata', {
    headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
  }, 403);
  await check('same Origin takes precedence over fetch metadata', {
    headers: { origin: 'https://rev4a.example.com:3740', 'sec-fetch-site': 'cross-site' },
  });
  await check('forwarded Host does not grant trust', {
    headers: { origin: 'https://foreign.example', 'x-forwarded-host': 'foreign.example' },
  }, 403);
  await check('request URL does not replace Host', {
    headers: { origin: 'https://rev4a.example.com:3740', host: 'internal:3740' },
  }, 403);
  const missingHost = request({ headers: { origin: 'https://rev4a.example.com:3740' } });
  missingHost.headers.delete('host');
  assert.equal((await proxy(missingHost)).status, 403);

  env.REV4A_ALLOWED_ORIGINS = ' , not-an-origin, null, https://dashboard.example.com, https://other.example:8443 ';
  for (const origin of ['https://dashboard.example.com', 'https://other.example:8443', 'https://DASHBOARD.EXAMPLE.COM']) {
    await check(`explicit allowed origin ${origin}`, { headers: { origin, host: 'internal:3740' } });
  }
  for (const origin of ['null', 'http://dashboard.example.com', 'https://dashboard.example.com:8443', 'https://dashboard.example.com.evil.test']) {
    await check(`allowlist does not accept ${origin}`, { headers: { origin } }, 403);
  }
  env.REV4A_ALLOWED_ORIGINS = 'https://foreign.example/path, https://user@foreign.example';
  await check('invalid allowlist URL entries are ignored', { headers: { origin: 'https://foreign.example' } }, 403);
  delete env.REV4A_ALLOWED_ORIGINS;

  await check('Authorization Bearer + cookie + foreign Origin', {
    headers: { authorization: 'Bearer fixture', origin: 'https://foreign.example' },
  });
  await check('any Authorization header bypasses only the origin guard', {
    headers: { authorization: '', origin: 'null' },
  });
  await check('no session cookie leaves authentication to the route', {
    cookie: false, headers: { origin: 'https://foreign.example' },
  });
  await check('an empty session cookie still enables the guard', {
    headers: { cookie: 'rev4a_token=', origin: 'https://foreign.example' }, // secret-ok: deliberately empty fixture cookie
  }, 403);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    await check(`${method} + foreign Origin passes`, { method, headers: { origin: 'https://foreign.example' } });
  }
  await check('agent chat completion: Bearer, no cookie', {
    path: '/api/provider/v1/chat/completions', cookie: false, headers: { authorization: 'Bearer fixture' },
  });
  await check('text/plain JSON cannot bypass the guard', {
    headers: { origin: 'https://foreign.example', 'content-type': 'text/plain' },
    body: JSON.stringify({ action: 'fixture' }),
  }, 403);
  await check('the API root is guarded too', { path: '/api', headers: { origin: 'https://foreign.example' } }, 403);
  await check('page navigation stays untouched', { method: 'GET', path: '/login', headers: { origin: 'https://foreign.example' } });

  assert.ok(updates.writeUpdate(join(dataDir, 'data'), 'building'));
  for (const options of [
    { headers: { origin: 'https://rev4a.example.com:3740' } },
    { headers: { origin: 'https://foreign.example' } },
    { headers: { authorization: 'Bearer fixture', origin: 'https://foreign.example' } },
  ]) {
    const response = await check('update guard still runs first', options, 503);
    assert.deepEqual(await response.json(), { error: 'Rev4a is updating', phase: 'building' });
    assert.equal(response.headers.get('retry-after'), '10');
  }
  await check('GET still passes during update', { method: 'GET', headers: { origin: 'https://foreign.example' } });
  for (const path of ['/api/auth/logout', '/api/update-check', '/api/update-status', '/api/provider/v1/chat/completions']) {
    await check(`update exemption retained: ${path}`, { path, headers: { origin: 'https://rev4a.example.com:3740' } });
    await check(`update exemption does not exempt origin checks: ${path}`, { path, headers: { origin: 'https://foreign.example' } }, 403);
  }
  await check('agent proxy stays available during update', {
    path: '/api/provider/v1/chat/completions', cookie: false, headers: { authorization: 'Bearer fixture' },
  });
  assert.equal(context.exports.config.matcher[0], '/((?!_next/static|_next/image|favicon.ico).*)');
  console.log(`\n${passed} middleware cases passed`);

  // Report-only GET findings must remain in the inventory, without sending alerts.
  const architecture = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
  const apiDir = new URL('../app/api/', import.meta.url);
  const alertGetCalls = [];
  for (const file of readdirSync(apiDir, { recursive: true }).filter((file) => /(^|\/)route\.[jt]s$/.test(file))) {
    const content = readFileSync(new URL(file, apiDir), 'utf8');
    const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== 'GET') continue;
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            ['maybeSendAlert', 'sendTelegramMessage'].includes(node.expression.text)) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          const location = `app/api/${file}:${line}`;
          alertGetCalls.push(location);
          assert.ok(architecture.includes(`\`${location}\``), `Missing GET alert inventory: ${location}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(statement);
    }
  }
  assert.deepEqual(alertGetCalls.sort(), ['app/api/alerts/smoke/route.ts:16', 'app/api/system-health/route.ts:128']);
  console.log('ok   GET alert inventory covers smoke and system-health senders');

  // Keep PULSE guidance consistent with removal, while retaining per-agent login.
  const ragDir = new URL('../docs/rag/', import.meta.url);
  const guidanceFiles = readdirSync(ragDir, { recursive: true }).filter((file) => file.endsWith('.md'))
    .map((file) => new URL(file, ragDir));
  const assistantDir = new URL('../app/api/assistant/', import.meta.url);
  guidanceFiles.push(...readdirSync(assistantDir, { recursive: true }).filter((file) => /\.[jt]s$/.test(file))
    .map((file) => new URL(file, assistantDir)));
  for (const file of guidanceFiles) {
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /\/api\/gateway\/provider\/oauth|The endpoint exists but no page uses it/i, file.pathname);
  }
  const answers = readFileSync(new URL('WHAT-I-CAN-ANSWER.md', ragDir), 'utf8');
  const oauthAnswer = answers.split('\n').find((line) => line.includes('How do I register a new provider via OAuth?'));
  assert.match(oauthAnswer, /not supported.*removed.*API key.*\/gateway.*\/subscriptions.*device-code login stays inside the agent/);
  console.log('ok   RAG and PULSE guidance removes gateway OAuth and preserves Subscriptions login');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
