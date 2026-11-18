import { Pill, PropertyList, Surface } from '../components/ui';
import { SkeletonLines } from '../components/Skeleton';
import type { RemoteAccessData } from './useRemoteAccess';

export function CurrentSetup({ data, managedDomain }: { data: RemoteAccessData; managedDomain: boolean }) {
  const { state, label, startupSettings } = data;
  return <Surface>
    <h2 className="ui-kicker">Current setup</h2>
    <div style={{ marginTop: 12 }}>
      {state ? <PropertyList wrap spacious rows={[
        { label: 'Mode', value: <Pill tone="accent">{managedDomain ? 'Domain (Caddy, managed by Rev4a)' : label}</Pill> },
        { label: 'Panel', value: <code>{state.panel.addresses.length ? state.panel.addresses.map((address) => `${address.includes(':') ? `[${address}]` : address}:${state.panel.port}`).join(', ') : `${state.panel.mode === 'all' ? 'Every interface' : state.panel.mode === 'local' ? 'This host' : 'One address'} · port ${state.panel.port}`}</code> },
        { label: 'Agent ports', value: <code>{state.agents.mode === 'keep' ? 'Each agent keeps its address' : state.agents.mode === 'all' ? 'Every interface' : state.agents.mode === 'local' ? 'This host only' : data.settings.REV4A_AGENT_PORTS_LISTEN || state.agents.mode}</code> },
        { label: 'Trusted proxies', value: <code>{startupSettings.REV4A_TRUSTED_PROXIES || 'None'}</code> },
      ]} /> : <SkeletonLines count={4} />}
    </div>
  </Surface>;
}
