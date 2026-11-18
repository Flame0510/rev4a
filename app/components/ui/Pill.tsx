import type { ReactNode } from 'react';
import type { Tone } from './tokens';

export function Pill({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return <span className={`ui-pill ui-tone--${tone}`} title={title}>{children}</span>;
}
