'use client';

import { Button, Modal, Pill, PropertyList, Surface, Switch } from '../components/ui';
import { PRESETS, REMOTE_ACCESS_GUIDE, type AccessSettings } from '@/lib/remote-access';
import type { RemoteAccessData } from './useRemoteAccess';

export function ConfirmPresetModal({ data, managedDomain = false }: { data: RemoteAccessData; managedDomain?: boolean }) {
  const { selection, settings, guard, busy, state, hasChanges } = data;
  return <Modal open={!!selection} title={<>Switch to <span className="ui-text-accent">{PRESETS.find((preset) => preset.id === selection?.preset)?.title}</span></>}
    onClose={data.close} maxWidth={640}>
    <div style={{ display: 'grid', gap: 16 }}>
      <p className="ui-muted ui-text-small">Save to .env, then restart the panel; agent ports change on Recreate, Update or port Edit.</p>
      <PropertyList wrap rows={Object.entries(selection?.edits || {}).map(([key, value]) => ({
        label: <code>{key}</code>, value: <><code className="ui-text-accent">{value}</code>{' '}{settings[key as keyof AccessSettings] === value && <Pill>unchanged</Pill>}</>,
      }))} />
      {managedDomain && <Surface tone="warning" compact>
        <div className="ui-kicker">Domain mode stays on</div>
        <p className="ui-text-small" style={{ marginTop: 8 }}>Caddy keeps serving the dashboard and the agent subdomains over HTTPS. A preset does not turn Domain mode off.</p>
        <a className="ui-link ui-text-small" href={`${REMOTE_ACCESS_GUIDE}#disable-managed-domain`} target="_blank" rel="noopener noreferrer">Turn off Domain mode ↗</a>
      </Surface>}
      {selection?.preset === 'domain' && <Surface tone="warning" compact>
        <div className="ui-kicker">Proxy target required</div>
        <p className="ui-text-small" style={{ marginTop: 8 }}>Forward to <code className="ui-text-accent">127.0.0.1:{state?.panel.port}</code> or <code className="ui-text-accent">[::1]:{state?.panel.port}</code>. In Docker, use <code className="ui-text-accent">the Docker bridge address</code> on port {state?.panel.port}.</p>
        <p className="ui-muted ui-text-small" style={{ marginTop: 8 }}>LAN, public and Tailscale IP targets stop answering after restart.</p>
      </Surface>}
      {guard?.needsConfirm && <Switch checked={data.proxyConfirmed} onChange={data.setProxyConfirmed}
        label="My proxy already serves Rev4a at https://… and I tested it" disabled={!!busy} />}
      {data.error && <p role="alert" className="ui-text-small">{data.error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button type="button" variant="ghost" onClick={data.close} disabled={!!busy}>Cancel</Button>
        <Button type="button" variant="primary" onClick={data.apply} disabled={!hasChanges || !!busy || !guard?.allowed || (!!guard?.needsConfirm && !data.proxyConfirmed)} loading={busy === 'apply'}>
          {busy === 'apply' ? 'Applying…' : hasChanges ? 'Apply' : 'Already applied'}
        </Button>
      </div>
    </div>
  </Modal>;
}
