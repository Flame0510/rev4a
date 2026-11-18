'use client';

import { useEffect, useState } from 'react';
import { Button } from '../components/ui';
import { PresetOption } from '../remote-access/PresetOption';
import { LOCAL_ACCESS_DESCRIPTION, presetGuard, REMOTE_ACCESS_GUIDE } from '@/lib/remote-access';

type Choice = 'local' | 'devices' | 'ip';
export function AccessStep({ onNext, onSkip, localChosen, onChoice }: { onNext: () => void; onSkip: () => void; localChosen: boolean; onChoice: (local: boolean) => void }) {
  const [choice, setChoice] = useState<Choice | null>(localChosen ? 'local' : null);
  const [location, setLocation] = useState<{ protocol: string; hostname: string; port: string } | null>(null);
  useEffect(() => {
    setLocation({ protocol: window.location.protocol, hostname: window.location.hostname, port: window.location.port });
  }, []);
  const guard = location ? presetGuard('local', location) : null;
  const next = () => {
    if (!choice || (choice === 'local' && !guard?.allowed)) return;
    onChoice(choice === 'local'); onNext();
  };
  return <div style={{ display: 'grid', gap: 14 }}>
    <h2 className="wizard-title">Access</h2>
    <p className="wizard-text">How will you reach Rev4a?</p>
    <PresetOption preset="local" id="Only this computer" description={LOCAL_ACCESS_DESCRIPTION}
      selected={choice === 'local'} disabled={!guard?.allowed} disabledReason={guard?.reason} onClick={() => { setChoice('local'); onChoice(true); }} />
    <PresetOption preset="domain" id="From other devices" description="Use your own domain or Tailscale" selected={choice === 'devices'} onClick={() => { setChoice('devices'); onChoice(false); }} />
    <a className="ui-link ui-text-small" href={REMOTE_ACCESS_GUIDE} target="_blank" rel="noopener noreferrer">Remote access guide ↗</a>
    <PresetOption preset="direct" id="By IP for now (not secure)" description="Keep the current access settings. The warnings will remind you." selected={choice === 'ip'} onClick={() => { setChoice('ip'); onChoice(false); }} />
    {choice === 'local' && <p className="wizard-text">Finish saves REV4A_LISTEN=local and REV4A_AGENT_PORTS_LISTEN=local, then restarts Rev4a. You can change this choice before finishing.</p>}
    <div className="wizard-actions">
      <Button type="button" variant="ghost" onClick={() => { onChoice(false); onSkip(); }}>Skip for now</Button>
      <Button type="button" variant="primary" disabled={!choice || (choice === 'local' && !guard?.allowed)} onClick={next}>Continue</Button>
    </div>
  </div>;
}
