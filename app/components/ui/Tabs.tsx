'use client';

import type { ReactNode } from 'react';

interface TabItem {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number | string;
}

interface TabsProps {
  items: TabItem[];
  className?: string;
}

export function Tabs({ items, className }: TabsProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 0,
        borderBottom: '1px solid var(--border)',
        marginBottom: 20,
      }}
      className={className}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.onClick}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: item.active ? '2px solid var(--copper)' : '2px solid transparent',
            color: item.active ? 'var(--copper)' : 'var(--text-dim)',
            padding: '12px 16px',
            fontSize: 13,
            fontFamily: 'var(--font-mono-stack)',
            cursor: 'pointer',
            letterSpacing: '0.04em',
            transition: 'color 0.12s, border-color 0.12s',
            flex: 1,
            fontWeight: item.active ? 600 : 400,
            textTransform: 'capitalize',
          }}
        >
          {item.label}
          {item.count !== undefined ? ` (${item.count})` : ''}
        </button>
      ))}
    </div>
  );
}
