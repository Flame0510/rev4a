'use client';

import type { ReactNode } from 'react';

interface TemplateOptionProps {
  id: string;
  selected: boolean;
  description: string;
  onClick: () => void;
  badge?: ReactNode;
}

export function TemplateOption({ id, selected, description, onClick, badge }: TemplateOptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '14px 16px',
        textAlign: 'left',
        fontSize: 14,
        fontFamily: 'var(--font-mono-stack)',
        color: 'var(--text)',
        cursor: 'pointer',
        outline: 'none',
        transition: 'background 0.1s, border-color 0.1s',
        background: selected ? 'var(--copper-bg)' : 'transparent',
        border: `1px solid ${selected ? 'var(--copper)' : 'var(--border)'}`,
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: selected ? 'var(--copper)' : 'var(--border)',
          color: selected ? '#111' : '#666',
          fontSize: 12,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {id[0].toUpperCase()}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{id}</div>
        <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{description}</div>
      </div>
      {badge}
    </button>
  );
}
