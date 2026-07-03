'use client';

import type { ReactNode } from 'react';

interface ListItemProps {
  children: ReactNode;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}

interface ListItemSeparatorProps {
  label: string;
}

interface ListContainerProps {
  children: ReactNode;
  style?: React.CSSProperties;
}

export function ListContainer({ children, style }: ListContainerProps) {
  return (
    <div
      style={{
        borderRight: '1px solid var(--border)',
        overflow: 'auto',
        flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function ListItem({ children, active, onClick, disabled, style }: ListItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        textAlign: 'left',
        background: active ? '#1a1208' : 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text)',
        padding: '10px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 12,
        fontFamily: 'var(--font-mono-stack)',
        opacity: disabled ? 0.5 : 1,
        outline: 'none',
        transition: 'background 0.1s',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function ListItemSeparator({ label }: ListItemSeparatorProps) {
  return (
    <div
      style={{
        padding: '8px 12px',
        fontSize: 10,
        letterSpacing: '0.08em',
        color: 'var(--copper)',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </div>
  );
}
