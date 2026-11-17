'use client';

import { Fragment, type ReactNode } from 'react';
import type { Tone } from './tokens';

interface PropertyListProps {
  wrap?: boolean;
  /** Taller rows, centred: for a list whose values include a Pill or a Button (default compact rows stay unchanged). */
  spacious?: boolean;
  rows: { label: ReactNode; value: ReactNode; tone?: Tone; dim?: boolean }[];
}

export function PropertyList({ rows, wrap = false, spacious = false }: PropertyListProps) {
  return (
    <div className={`ui-property-list${wrap ? ' ui-property-list--wrap' : ''}${spacious ? ' ui-property-list--spacious' : ''}`}>
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
