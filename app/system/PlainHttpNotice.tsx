'use client';

import { useEffect, useState } from 'react';
import { Surface } from '../components/ui';
import { controlUiExposesSession } from '@/lib/control-ui-navigation';

/**
 * Warning card for the System page: on plain HTTP (host not loopback) every agent port on
 * the same address receives the Rev4a session cookie. Hidden on HTTPS and on loopback.
 */
export function PlainHttpNotice() {
  const [exposed, setExposed] = useState(false);
  useEffect(() => { setExposed(controlUiExposesSession(window.location.protocol, window.location.hostname)); }, []);
  if (!exposed) return null;
  return (
    <Surface tone="warning">
      <div className="ui-kicker">Plain HTTP</div>
      <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
        Rev4a is on plain HTTP: every agent port on this address can read your session. Use HTTPS or an SSH tunnel.{' '}
        <a className="ui-link" href="https://rev4a.app/en/docs/remote-access" target="_blank" rel="noopener noreferrer">Remote access guide ↗</a>
      </p>
    </Surface>
  );
}
