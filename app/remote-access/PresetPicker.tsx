'use client';

import { PRESETS, presetGuard, REMOTE_ACCESS_GUIDE } from '@/lib/remote-access';
import { PresetOption } from './PresetOption';
import type { RemoteAccessData } from './useRemoteAccess';

export function PresetPicker({ data }: { data: RemoteAccessData }) {
  return <section style={{ display: 'grid', gap: 12 }} aria-labelledby="access-presets">
    <h2 id="access-presets" className="ui-kicker">Access presets</h2>
    {PRESETS.map((preset) => {
      const guard = data.location ? presetGuard(preset.id, data.location) : null;
      const current = !!data.state && data.mode === preset.id;
      return <PresetOption key={preset.id} preset={preset.id} id={preset.title} description={preset.description}
        selected={current} current={current} disabled={!data.state || !data.location || !!data.busy || !guard?.allowed}
        disabledReason={guard?.reason} onClick={() => data.choose(preset.id)} />;
    })}
    <a className="ui-link ui-text-small" href={REMOTE_ACCESS_GUIDE} target="_blank" rel="noopener noreferrer">Remote access guide ↗</a>
  </section>;
}
