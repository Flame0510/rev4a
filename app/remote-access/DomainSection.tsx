'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CADDY_FILE, DEFAULT_CADDY_MAIN, normalizeDomain } from '@/lib/domain-name';
import type { DomainStatus } from '@/lib/domain-status';
import type { DomainDnsRecord, ServerAddresses } from '@/lib/domain-status-addresses';
import { Button, DataTable, Input, Pill, PropertyList, Surface } from '../components/ui';

type Action = 'check' | 'credential' | 'dry-run' | 'setup' | 'password';
type Credential = { user: string; password: string };

async function readJson<T>(url: string, signal: AbortSignal, fallback: string): Promise<T> {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', signal });
    if (response.ok) return await response.json();
  } catch {
    throw new Error(fallback);
  }
  const result = await response.json().catch(() => null);
  throw new Error(typeof result?.error === 'string' ? result.error : fallback);
}

async function copyText(value: string) {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Try a selection on plain HTTP. */ }
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.className = 'domain-clipboard-field';
  field.setAttribute('readonly', '');
  const focused = document.activeElement;
  document.body.appendChild(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable. Select and copy the text manually.');
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus();
  }
}

function DnsTable({ domain, serverAddresses, results, checking }: {
  domain: string; serverAddresses: ServerAddresses; results: DomainDnsRecord[] | null; checking: boolean;
}) {
  const { ipv4, ipv6 } = serverAddresses;
  const hasAddresses = results ? results.some((row) => row.expected.length > 0) : ipv4.length > 0 || ipv6.length > 0;
  const rows = [domain, `*.${domain}`].flatMap((name) => (['A', 'AAAA'] as const).map((type) => ({
    name, type, expected: type === 'A' ? ipv4 : ipv6,
    result: results?.find((row) => row.name === name && row.type === type),
  })));
  return <>
    {!hasAddresses && <p className="ui-text-small ui-muted">No public interface addresses were detected. Use the server’s public IP and compare the DNS answers manually.</p>}
    <div aria-live="polite">
      <DataTable label="Required DNS records" columns={['Name', 'Type', 'Expected', 'Found', 'Status']}
        rows={rows.map(({ name, type, expected: initial, result }) => {
          const expected = result?.expected ?? initial;
          const missing = result?.found.length === 0;
          return { id: `${name} ${type}`, cells: [
            <code>{name}</code>,
            type,
            expected.length ? <code>{expected.join(', ')}</code> : hasAddresses ? 'None' : 'Server public IP, if available',
            result ? (missing ? 'None' : <code>{result.found.join(', ')}</code>) : '—',
            !result ? <Pill>{checking ? 'Checking…' : 'Not checked'}</Pill> : !hasAddresses ? <Pill>Unverified</Pill>
              : result.ok ? <Pill tone="success">OK</Pill>
                : missing ? <Pill tone="warning">Missing</Pill> : <Pill tone="danger">Wrong</Pill>,
          ] };
        })} />
    </div>
  </>;
}

function shellValue(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

function SetupCommands({ domain, status, busy, copy }: {
  domain: string; status: DomainStatus;
  busy: Action | null; copy: (action: 'dry-run' | 'setup', value: string) => void;
}) {
  const { port, caddyMain, caddyFile } = status.savedSetup ?? status;
  const { dataDir } = status;
  // Setup runs under sudo, so the standard directory is the root CLI's default.
  const dirSetting = dataDir === '/root/.config/rev4a' ? '' : ` REV4A_DATA_DIR=${shellValue(dataDir)}`;
  const mainSetting = caddyMain === DEFAULT_CADDY_MAIN ? '' : ` REV4A_CADDY_MAIN=${shellValue(caddyMain)}`;
  const fileSetting = caddyFile === DEFAULT_CADDY_FILE ? '' : ` REV4A_CADDY_FILE=${shellValue(caddyFile)}`;
  const command = `sudo PORT=${port}${dirSetting}${mainSetting}${fileSetting} rev4a domain setup ${domain}`;
  return <>
    <p className="ui-text-small">On the server, run the dry run first, then run setup. Setup installs Caddy if needed and backs up and adopts the existing Caddyfile when it needs changes.</p>
    {!domain && <p className="ui-text-small ui-muted">Enter a valid dashboard hostname to enable the copy buttons.</p>}
    <PropertyList wrap spacious rows={[
      { label: 'Dry run', value: <span className="domain-inline">
        {domain && <code>{command} --dry-run</code>}
        <Button type="button" size="sm" loading={busy === 'dry-run'} disabled={!!busy || !domain}
          onClick={() => { if (domain) copy('dry-run', `${command} --dry-run`); }}>{busy === 'dry-run' ? 'Copying…' : 'Copy dry run'}</Button>
      </span> },
      { label: 'Setup', value: <span className="domain-inline">
        {domain && <code>{command}</code>}
        <Button type="button" size="sm" loading={busy === 'setup'} disabled={!!busy || !domain}
          onClick={() => { if (domain) copy('setup', command); }}>{busy === 'setup' ? 'Copying…' : 'Copy setup command'}</Button>
      </span> },
    ]} />
  </>;
}

function validatedDomain(value: string) {
  try { return { domain: normalizeDomain(value), inputError: '' }; }
  catch { return { domain: '', inputError: 'Enter a DNS hostname such as rev4a.example.com.' }; }
}

export function useDomainAccess() {
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [results, setResults] = useState<DomainDnsRecord[] | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const active = useRef<{ action: Action; controller: AbortController } | null>(null);
  const run = useCallback(async (action: Action, operation: (signal: AbortSignal) => Promise<void>) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = { action, controller };
    setBusy(action);
    setError('');
    setFeedback('');
    try {
      await operation(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The action failed. Try again.');
    } finally {
      if (active.current?.controller === controller) {
        active.current = null;
        setBusy(null);
      }
    }
  }, []);
  const check = useCallback((name: string | null, checkDraft: boolean) => run('check', async (signal) => {
    setCredential(null);
    setResults(null);
    const next = await readJson<DomainStatus>('/api/domain/status', signal, 'Could not check Domain mode.');
    if (signal.aborted) return;
    setStatus(next);
    const lookup = next.enabled ? next.domain : checkDraft ? validatedDomain(name ?? next.domain ?? '').domain : null;
    if (!lookup) return;
    const result = await readJson<{ records: DomainDnsRecord[] }>(`/api/domain/dns?domain=${encodeURIComponent(lookup)}`, signal, 'Could not check DNS.');
    if (!signal.aborted) setResults(result.records);
  }), [run]);
  useEffect(() => {
    void check(null, false);
    return () => {
      active.current?.controller.abort();
      active.current = null;
    };
  }, [check]);

  const input = draft ?? status?.domain ?? '';
  const { domain, inputError } = status?.enabled
    ? { domain: status.domain ?? '', inputError: '' } : validatedDomain(input);

  const updateDomain = (value: string) => {
    if (active.current?.action === 'check') {
      active.current.controller.abort();
      active.current = null;
      setBusy(null);
    }
    setDraft(value);
    setResults(null);
    setError('');
    setFeedback('');
  };
  const show = () => run('credential', async (signal) => {
    const response = await fetch('/api/domain/credential', { cache: 'no-store', referrerPolicy: 'no-referrer', signal }).catch(() => null);
    if (!response) throw new Error('Could not reveal the dev-port password.');
    if (response.status === 404) throw new Error('No dev-port credential is available. Rev4a creates it when configuring a published dev-port route.');
    const next = response.ok ? await response.json().catch(() => null) : null;
    if (next?.user !== 'rev4a' || typeof next.password !== 'string') throw new Error('Could not reveal the dev-port password.');
    if (!signal.aborted) setCredential(next);
  });
  const copy = (action: 'dry-run' | 'setup' | 'password', value: string) => run(action, async (signal) => {
    await copyText(value);
    if (!signal.aborted) setFeedback(action === 'password' ? 'Password copied.' : 'Command copied.');
  });

  return { status, results, credential, busy, error, feedback, input, inputError, domain, updateDomain, show, copy,
    hide: () => { setCredential(null); setFeedback(''); setError(''); }, check: () => check(draft, true) };
}

function yesNo(value: boolean) {
  return value ? <Pill tone="success">Yes</Pill> : <Pill tone="warning">No</Pill>;
}

export function DomainSection({ data }: { data: ReturnType<typeof useDomainAccess> }) {
  const { status, results, credential, busy, error, feedback, input, inputError, domain, updateDomain, show, copy, hide, check } = data;
  const caddy = status?.caddy;
  const healthy = caddy?.installed && caddy.managedFile === 'ok' && caddy.imported && caddy.onDemandAsk;
  const staleAsk = caddy?.askTarget === 'stale';
  return <Surface className="domain-section">
    <h2 className="ui-kicker">Domain mode</h2>
    {status?.enabled && caddy ? <>
      <PropertyList wrap spacious rows={[
        { label: 'Domain', value: <code>{domain}</code> },
        { label: 'Dashboard', value: <a className="ui-link" href={`https://${domain}`}>{`https://${domain}`}</a> },
        { label: 'Caddy installed', value: yesNo(caddy.installed) },
        { label: 'Managed file', value: <Pill tone={caddy.managedFile === 'ok' ? 'success' : 'warning'}>
          {{ ok: 'OK', missing: 'Missing', pending: 'Pending', unmanaged: 'Unmanaged', incomplete: 'Incomplete' }[caddy.managedFile]}
        </Pill> },
        { label: 'Imported', value: yesNo(caddy.imported) },
        { label: 'On-demand TLS ask', value: yesNo(caddy.onDemandAsk) },
        { label: 'Agent routes', value: status.routes },
        { label: 'Restart pending', value: status.restartPending ? <Pill tone="warning">Yes</Pill> : 'No' },
        { label: 'Dev-port credential', value: <span className="domain-inline">
          <code>{credential?.user ?? 'rev4a'}</code>
          <code aria-label={credential ? undefined : 'Password hidden'}>{credential?.password ?? '••••••••'}</code>
          {credential ? <>
            <Button type="button" size="sm" disabled={!!busy} onClick={hide}>Hide</Button>
            <Button type="button" size="sm" loading={busy === 'password'} disabled={!!busy}
              onClick={() => copy('password', credential.password)}>{busy === 'password' ? 'Copying…' : 'Copy'}</Button>
          </> : <Button type="button" size="sm" loading={busy === 'credential'} disabled={!!busy}
            onClick={show}>{busy === 'credential' ? 'Showing…' : 'Show'}</Button>}
        </span> },
      ]} />
      <p className="ui-text-small ui-muted">Managed HTTPS dev-port names (<code>{`<agent>-<3001..3009>.${domain}`}</code>) use Basic authentication with this credential. Direct host-port access follows <code>REV4A_AGENT_PORTS_LISTEN</code>. With the Domain mode setting, Recreate makes the agent ports loopback only.</p>
    </> : status && <>
      <p className="ui-text-small">Domain mode is off. Set up Caddy to serve the dashboard and agent subdomains over HTTPS.</p>
      <Input label="Dashboard domain" value={input} placeholder="rev4a.example.com" autoComplete="off"
        autoCapitalize="none" spellCheck={false} aria-invalid={!!inputError} error={inputError}
        onChange={(event) => updateDomain(event.target.value)} />
    </>}
    {status && domain && <>
      {!status.enabled && <p className="ui-text-small">Create one record per expected address for the dashboard and wildcard names.</p>}
      <DnsTable domain={domain} serverAddresses={status.serverAddresses} results={results} checking={busy === 'check'} />
    </>}
    {staleAsk && <p className="ui-text-small" role="status">Caddy points to an old Rev4a address: run the setup command again.</p>}
    {status && (!status.enabled || staleAsk || (!healthy && !status.restartPending))
      && <SetupCommands domain={domain} status={status} busy={busy} copy={copy} />}
    {status?.restartPending && <p className="ui-text-small" role="status">Restart Rev4a to load the saved Domain settings, then check again.</p>}
    {status && !status.enabled && domain && <p className="ui-text-small ui-muted">
      After setup and restart, open <a className="ui-link" href={`https://${domain}`}>{`https://${domain}`}</a>.
      Recreate running agents to apply the local port settings.
    </p>}
    {error && <p className="ui-text-small" role="alert">{error}</p>}
    {feedback && <p className="ui-text-small" role="status">{feedback}</p>}
    <div><Button type="button" size="sm" loading={busy === 'check'} disabled={!!busy} onClick={check}>
      {busy === 'check' ? 'Checking…' : 'Check'}
    </Button></div>
  </Surface>;
}
