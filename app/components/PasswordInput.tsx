'use client';

import { useState } from 'react';
import { Input } from './ui';
import { EyeIcon, EyeOffIcon } from './Icons';

function generateKey(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  showGenerate?: boolean;
}

export default function PasswordInput({
  value,
  onChange,
  placeholder = '',
  disabled = false,
  style,
  showGenerate = false,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  const hasRightButton = showGenerate;
  const paddingRight = hasRightButton ? 150 : 44;

  return (
    <div style={{ position: 'relative', ...style }}>
      <Input
        type={visible ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ paddingRight }}
      />
      <div
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {showGenerate && (
          <button
            onClick={() => {
              onChange(generateKey());
              setVisible(true);
            }}
            disabled={disabled}
            type="button"
            tabIndex={-1}
            className="ui-btn ui-btn--ghost ui-btn--sm"
            title="Generate secure key"
            style={{ marginRight: 2 }}
          >
            Generate
          </button>
        )}
        <button
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          type="button"
          tabIndex={-1}
          className="ui-btn ui-btn--ghost ui-btn--sm"
          title={visible ? 'Hide' : 'Show'}
          style={{ minWidth: 32, justifyContent: 'center' }}
        >
          {visible ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
        </button>
      </div>
    </div>
  );
}
