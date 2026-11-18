import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { NextRequest } from 'next/server';
import { normalizeDomain } from '@/lib/domain-name';
import { canonicalIPv6, serverAddresses, type DomainDnsRecord } from '@/lib/domain-status-addresses';
import { requireAuthJWT } from '@/lib/rev4a-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };
const TIMEOUT_MS = 5000;
const REUSE_MS = 10_000;

type DnsResult = { status: 200; body: { records: DomainDnsRecord[] } }
  | { status: 502 | 504; body: { error: string } };

interface DnsChecks {
  active?: { domain: string; result: Promise<DnsResult> };
  recent: Map<string, { expiresAt: number; result: Promise<DnsResult> }>;
}

const dnsChecks = globalThis as typeof globalThis & { rev4aDomainDnsChecks?: DnsChecks };
const checks: DnsChecks = dnsChecks.rev4aDomainDnsChecks ??= { recent: new Map() };

async function lookup(query: Promise<string[]>): Promise<string[]> {
  try { return await query; }
  catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw error;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAuthJWT(request);
  if (denied) {
    denied.headers.set('Cache-Control', 'no-store');
    return denied;
  }
  let domain = '';
  try {
    const names = new URL(request.url).searchParams.getAll('domain');
    if (names.length === 1) domain = normalizeDomain(names[0]);
  } catch { /* Invalid hostname. */ }
  if (!domain) return Response.json({ error: 'Enter a valid DNS hostname.' }, { status: 400, headers });

  const now = Date.now();
  for (const [name, check] of checks.recent) {
    if (check.expiresAt <= now) checks.recent.delete(name);
  }
  const result = checks.recent.get(domain)?.result ?? (checks.active?.domain === domain ? checks.active.result : undefined);
  if (result) return dnsResponse(await result);
  if (checks.active) {
    return Response.json({ error: 'A DNS check for another hostname is running. Try again shortly.' }, { status: 429, headers });
  }

  const pending = checkDns(domain).finally(() => {
    checks.recent.set(domain, { expiresAt: Date.now() + REUSE_MS, result: pending });
    checks.active = undefined;
  });
  checks.active = { domain, result: pending };
  return dnsResponse(await pending);
}

function dnsResponse({ status, body }: DnsResult): Response {
  return Response.json(body, { status, headers });
}

async function checkDns(domain: string): Promise<DnsResult> {
  const { ipv4, ipv6 } = serverAddresses();
  const canCompare = ipv4.length > 0 || ipv6.length > 0;
  let resolver: Resolver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const activeResolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    resolver = activeResolver;
    // A new label bypasses cached answers and exact records for earlier wildcard probes.
    const wildcardProbe = `rev4a-check-${randomBytes(8).toString('hex')}.${domain}`;
    timer = setTimeout(() => {
      timedOut = true;
      activeResolver.cancel();
    }, TIMEOUT_MS);
    const records = await Promise.all([[domain, domain], [`*.${domain}`, wildcardProbe]].flatMap(([name, probe]) =>
      (['A', 'AAAA'] as const).map(async (type): Promise<DomainDnsRecord> => {
        const expected = type === 'A' ? ipv4 : ipv6;
        const answers = await lookup(type === 'A' ? activeResolver.resolve4(`${probe}.`) : activeResolver.resolve6(`${probe}.`));
        const found = [...new Set(type === 'A' ? answers : answers.map(canonicalIPv6))].sort();
        const ok = canCompare && expected.length === found.length && expected.every((address, index) => address === found[index]);
        return { name, type, expected, found, ok };
      })));
    return { status: 200, body: { records } };
  } catch (error) {
    if (timedOut || (error as NodeJS.ErrnoException).code === 'ETIMEOUT') {
      return { status: 504, body: { error: 'DNS check timed out. Try again.' } };
    }
    return { status: 502, body: { error: 'The server DNS resolver could not complete the check. Try again.' } };
  } finally {
    clearTimeout(timer);
    resolver?.cancel();
  }
}
