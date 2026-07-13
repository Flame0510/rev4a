'use client';

import { useState } from 'react';
import { Input } from './ui';
import { EyeIcon, EyeOffIcon } from './Icons';

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export default function PasswordInput({
  value,
  onChange,
  placeholder = '',
  disabled = false,
  style,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div style={{ position: 'relative', ...style }}>
      <Input
        type={visible ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ paddingRight: 36 }}
      />
      <button
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        type="button"
        tabIndex={-1}
        style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'none',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: 'var(--text-dim)',
          padding: '4px 6px',
          display: 'flex',
          alignItems: 'center',
        }}
        title={visible ? 'Hide' : 'Show'}
      >
        {visible ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
      </button>
    </div>
  );
}
