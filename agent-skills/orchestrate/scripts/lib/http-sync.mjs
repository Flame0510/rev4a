// A synchronous HTTP request for tracker adapters (the orch commands call trackers synchronously). The request runs
// in a child node process that reads it from stdin: headers with credentials never appear in a process list, an
// argument or a URL. Node built-ins only.
import { spawnSync } from 'node:child_process';
import { OrchError } from './util.mjs';

const CHILD = `
let raw = '';
process.stdin.on('data', d => { raw += d; }).on('end', async () => {
  const q = JSON.parse(raw);
  try {
    const r = await fetch(q.url, { method: q.method, headers: q.headers, body: q.body, signal: AbortSignal.timeout(q.timeoutMs) });
    process.stdout.write(JSON.stringify({ status: r.status, text: await r.text(), retryAfter: r.headers.get('retry-after') }));
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message;
    process.stdout.write(JSON.stringify({ status: 0, text: '', error: e.name === 'TimeoutError' ? 'timed out' : \`\${e.message}\${cause ? \` (\${cause})\` : ''}\` }));
  }
});`;

// What fetch may need from the environment: proxies, extra certificate authorities, and Windows' system root.
const PASS = ['PATH', 'SystemRoot', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_OPTIONS'];
const CHILD_ENV = () => Object.fromEntries(PASS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));

/**
 * { method, url, headers, json, timeoutSec } → { status, data (parsed JSON or null), text }. A 429 is retried after a
 * pause (Trello allows bursts of about 100 requests per 10 s); any other non-2xx status is returned, never thrown, so
 * the adapter can name what failed. Network errors throw an OrchError without the headers.
 */
export function httpSync({ method = 'GET', url, headers = {}, json, timeoutSec = 30, secrets = [] }) {
  // Any credential value is cut out of every text this returns or throws (an HTTP library may quote a bad header).
  const redact = t => secrets.filter(v => v && v.length >= 8).reduce((s, v) => s.split(v).join('[redacted]'), String(t ?? ''));
  const req = {
    method, url, timeoutMs: timeoutSec * 1000,
    headers: { Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  };
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
      input: JSON.stringify(req), encoding: 'utf8', timeout: (timeoutSec + 15) * 1000, maxBuffer: 64 * 1024 * 1024,
      env: CHILD_ENV(), // network settings only: no credential reaches the child through its environment
    });
    let out;
    try { out = JSON.parse(r.stdout || '{}'); } catch { out = {}; }
    if (!out.status) throw new OrchError(redact(`${method} ${new URL(url).pathname}: ${out.error || r.stderr?.trim().split('\n').at(-1) || 'no response'}`));
    if (out.status === 429 && attempt < 3) {
      const wait = Math.min(30, Number(out.retryAfter) || 10 * (attempt + 1));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait * 1000);
      continue;
    }
    let data = null;
    try { data = out.text ? JSON.parse(out.text) : null; } catch { /* not JSON */ }
    return { status: out.status, data, text: redact(out.text) };
  }
}
