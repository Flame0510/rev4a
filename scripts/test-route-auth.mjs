import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const methods = /^(GET|POST|PUT|PATCH|DELETE)$/;

// These routes deliberately use a different boundary from dashboard session auth.
const allowlist = {
  'app/api/auth/check/route.ts': 'Reports whether the supplied cookie is valid, checking its JWT and current password fingerprint.',
  'app/api/auth/login/route.ts': 'Checks the dashboard password with login throttling and issues the first session cookie.',
  'app/api/auth/logout/route.ts': 'Clears the browser cookie even when it is missing or expired.',
  'app/api/auth/status/route.ts': 'Reports only whether a password is configured so the browser can choose setup or login.',
  'app/api/domain/ask/route.ts': 'Caddy certificate authorization uses a supervised loopback check and returns only an allow or deny status.',
  'app/api/provider/v1/chat/completions/route.ts': 'Requires a derived agent proxy token, shared provider gateway key, or REV4A_API_KEY before processing a completion.',
  'app/api/provider/v1/models/route.ts': 'Uses the same provider gateway credentials as completions and returns an empty catalogue without them.',
};

// These existing statements are allowed only in the named handler, before its guard.
const preludes = {
  'app/api/models/route.ts GET': /^\s*const request = _req;/,
  'app/api/plugins/route.ts GET': /^\s*const arrivedAt = Date\.now\(\);/,
  'app/api/setup/password/route.ts POST': /^\s*if \(isConfigured\(\)\)\s*\{\s*return NextResponse\.json\(\s*\{ error: '' \},\s*\{ status: 409 \},?\s*\);\s*\}/,
};

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\\r\n])*'|"(?:\\[\s\S]|[^"\\\r\n])*"|`(?:\\[\s\S]|[^`\\])*`/g, (token) => {
    if (/^['"](?:@\/lib\/rev4a-auth|GET|POST|PUT|PATCH|DELETE)['"]$/.test(token)) return token;
    if (token[0] === '/') return token.replace(/[^\n]/g, ' ');
    return "''" + token.replace(/[^\n]/g, '');
  });
}

// The route files use named functions and local aliases. Also recognize arrow
// handlers and named exports, so an unfamiliar export cannot hide a missing guard.
function* exportedHandlers(code) {
  for (const match of code.matchAll(/\bexport\s+(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+|\{([^}]+)\}(\s*from\b)?|(\*))/g)) {
    const [, name, names, reexport, wildcard] = match;
    const tail = code.slice(match.index + match[0].length);
    if (name) {
      if (methods.test(name)) yield [name, tail];
    } else if (names) {
      for (const entry of names.split(',')) {
        const [local, exported = local] = entry.trim().split(/\s+as\s+/);
        const method = exported.replace(/^['"]|['"]$/g, '');
        if (methods.test(method)) yield [method, reexport ? '' : localFunction(code, local)];
      }
    } else if (wildcard) {
      yield ['GET/POST/PUT/PATCH/DELETE', ''];
    } else {
      for (const [binding, value] of exportedBindings(tail)) {
        if (methods.test(binding)) {
          yield [binding, /^\w+$/.test(value) ? localFunction(code, value) : value];
        }
      }
    }
  }
}

// Commas inside parameters and bodies are part of the initializer.
function* exportedBindings(tail) {
  for (;;) {
    const binding = /^\s*(\w+|\{[^}]+\}|\[[^\]]+\])\s*(?::[^=]+)?=\s*/.exec(tail);
    if (!binding) return;
    tail = tail.slice(binding[0].length);
    let depth = 0;
    let end;
    // An initializer can reach EOF without a semicolon or newline.
    for (const token of tail.matchAll(/[()[\]{};,\n]|$/g)) {
      const [character] = token;
      if (!character) {
        end = token;
        break;
      } else if ('([{'.includes(character)) depth++;
      else if (')]}'.includes(character)) depth--;
      else if (depth === 0 && (character !== '\n' || !/^\s*,/.test(tail.slice(token.index)))) {
        end = token;
        break;
      }
    }
    const value = tail.slice(0, end.index).trim();
    if (/^\w+$/.test(binding[1])) {
      yield [binding[1], value];
    } else {
      for (const name of binding[1].matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\b/g)) yield [name[0], ''];
    }
    if (end[0] !== ',') return;
    tail = tail.slice(end.index + 1);
  }
}

function localFunction(code, name) {
  if (!/^\w+$/.test(name)) return '';
  const declaration = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'm').exec(code);
  return declaration ? code.slice(declaration.index + declaration[0].length) : '';
}

// requireAuthIfConfigured lets requests through until a password exists (first-run setup), so only
// the setup and wizard routes may use it; every other route needs requireAuthJWT.
const firstRunRoute = /^app\/api\/(?:setup|wizard)\//;

function unguardedHandlers(file, source) {
  const code = codeOnly(source);
  // Fail closed on export forms this scanner does not parse (destructuring, re-export of everything).
  if (/\bexport\s+(?:(?:const|let|var)\s*[{[]|\*)/.test(code)) return ['unsupported export form'];
  const imports = code.matchAll(/\bimport\s+\{([^}]+)\}\s+from\s+['"]@\/lib\/rev4a-auth['"]/g);
  const guards = new Set([...imports].flatMap(([, names]) => names.split(',').map((name) => name.trim())));
  if (!firstRunRoute.test(file)) guards.delete('requireAuthIfConfigured');
  return [...exportedHandlers(code)].filter(([method, definition]) => {
    const signature = /^\s*(?:async\s+)?(?:\(\s*(\w+)\b[^)]*\)\s*(?::\s*[\w<>]+\s*)?(?:=>\s*)?|(\w+)\s*=>\s*)\{/.exec(definition);
    if (!signature) return true;
    const request = signature[1] || signature[2];
    const prelude = preludes[`${file} ${method}`];
    let body = definition.slice(signature[0].length);
    const hasPrelude = prelude?.test(body);
    if (hasPrelude) body = body.replace(prelude, '');
    const guard = /^\s*const\s+(\w+)\s*=\s*await\s+(requireAuthJWT|requireAuthIfConfigured)\(\s*(\w+)\s*\)\s*;?\s*if\s*\(\s*\1\s*\)\s*([\s\S]*)/.exec(body);
    if (!guard) return true;
    const [, denied, helper, argument, branch] = guard;
    const guardedRequest = hasPrelude && file === 'app/api/models/route.ts' ? 'request' : request;
    if (!guards.has(helper) || argument !== guardedRequest) return true;
    const returnsDenial = new RegExp(`^return[ \\t]+${denied}(?:[ \\t]+as[ \\t]+(?:any|NextResponse))?\\s*[;}]`);
    // Domain handlers may attach headers to the denial before returning it.
    const block = /^\{\s*((?:for \(const \[name, value\] of Object\.entries\(headers\)\) )?denied\.headers\.set\([^;\n]+\);\s*)?/.exec(branch);
    return !returnsDenial.test(block ? branch.slice(block[0].length) : branch);
  }).map(([method]) => method);
}

const fixture = 'app/api/example/route.ts';
const importedGuard = "import { requireAuthJWT } from '@/lib/rev4a-auth';";
const guarded = 'const denied = await requireAuthJWT(request); if (denied) return denied;';
assert.deepEqual(unguardedHandlers(fixture, 'export function GET(request: Request) { return new Response(); }'), ['GET']);
assert.deepEqual(unguardedHandlers(fixture, `${importedGuard} export async function GET(request: Request) { ${guarded} }`), []);
assert.deepEqual(unguardedHandlers(fixture, 'export const GET = () => new Response()'), ['GET']);
assert.deepEqual(unguardedHandlers(fixture, `${importedGuard} export const GET = async request => { ${guarded} }, POST = () => new Response();`), ['POST']);
assert.deepEqual(unguardedHandlers(fixture, `
  ${importedGuard}
  export async function GET(request: Request) { ${guarded} }
  export async function POST(request: Request) { await doWork(); ${guarded} }
  export const PUT = async (request: Request) => { /* ${guarded} */ return new Response(); };
  export { PUT as PATCH };
`), ['POST', 'PUT', 'PATCH']);
assert.deepEqual(unguardedHandlers(fixture, 'export const { routes: { GET } } = handlers;'), ['unsupported export form']);
assert.deepEqual(unguardedHandlers(fixture, "export * from './handlers';"), ['unsupported export form']);
const weakGuard = "import { requireAuthIfConfigured } from '@/lib/rev4a-auth'; export async function GET(request: Request) { const denied = await requireAuthIfConfigured(request); if (denied) return denied; }";
assert.deepEqual(unguardedHandlers(fixture, weakGuard), ['GET']);
assert.deepEqual(unguardedHandlers('app/api/setup/example/route.ts', weakGuard), []);

const files = globSync('app/api/**/route.ts', { cwd: root }).sort();
const errors = Object.keys(allowlist).filter((file) => !files.includes(file))
  .map((file) => `${file}: stale route-auth allowlist entry`);
for (const file of files) {
  if (Object.hasOwn(allowlist, file)) continue;
  for (const method of unguardedHandlers(file, readFileSync(join(root, file), 'utf8'))) {
    errors.push(`${file} ${method}: start the handler with an imported requireAuthJWT or requireAuthIfConfigured guard and return its denial`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Route auth checks passed for ${files.length} routes (${Object.keys(allowlist).length} allowlisted).`);
}
