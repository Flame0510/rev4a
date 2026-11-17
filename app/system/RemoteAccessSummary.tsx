'use client';

import Link from 'next/link';
import { Pill, Surface } from '../components/ui';
import { showLanNotice } from '@/lib/remote-access';
import { useRemoteAccess } from '../remote-access/useRemoteAccess';

export function RemoteAccessSummary() {
  const { state, label, pending, location, readError } = useRemoteAccess();
  const lan = !!location && !!state && showLanNotice(location.hostname, state.panel.mode);
  return <Surface compact>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <span className="ui-kicker">Remote access</span>
      <Pill tone="accent">{state ? label : 'Loading…'}</Pill>
      <span className="ui-muted ui-text-small">{readError ? 'Access status unavailable.' : lan ? 'Rev4a is also reachable from your network.' : pending ? 'Restart pending.' : 'Manage panel access and agent ports.'}</span>
      {!!state?.agents.differing && <Pill tone="warning">{state.agents.differing} to recreate</Pill>}
      <Link className="ui-link ui-text-small" href="/remote-access">Manage</Link>
    </div>
  </Surface>;
}
