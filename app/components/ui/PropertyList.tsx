'use client';

import { Fragment, type ReactNode } from 'react';
import type { Tone } from './tokens';

interface PropertyListProps {
  rows: { label: string; value: ReactNode; tone?: Tone; dim?: boolean }[];
}

export function PropertyList({ rows }: PropertyListProps) {
  return (
    <div className="ui-property-list">
      {rows.map((r, i) => (
        <Fragment key={i}>
          <span className="ui-property-label">{r.label}</span>
          <span
            className="ui-property-value"
            data-tone={r.tone || (r.dim ? 'dim' : '')}
          >{r.value}</span>
        </Fragment>
      ))}
    </div>
  );
}
