'use client';

import type { ReactNode } from 'react';
import type { Tone } from './tokens';
import { toneVars } from './tokens';

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
}

export function Badge({ children, tone = 'neutral' }: BadgeProps) {
  const c = toneVars[tone] ?? toneVars.neutral;
  return (
    <span
      style={{
        display: 'inline-block',
        border: `1px solid ${c.border}`,
        color: c.text,
        background: c.bg,
        borderRadius: 0,
        padding: '2px 8px',
        fontSize: 10,
        letterSpacing: '0.04em',
      }}
    >
      {children}
    </span>
  );
}
