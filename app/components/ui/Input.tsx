'use client';

import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className = '', ...rest }: InputProps) {
  return (
    <div className="ui-field">
      {label && <label className="ui-field__label">{label}</label>}
      <input
        className={`ui-input ${error ? 'ui-input--error' : ''} ${className}`}
        {...rest}
      />
      {error && <div className="ui-field__error">{error}</div>}
    </div>
  );
}
