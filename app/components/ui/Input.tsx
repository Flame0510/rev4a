'use client';

import { useId, type InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;

  return (
    <div className="ui-field">
      {label && <label className="ui-field__label" htmlFor={inputId}>{label}</label>}
      <input
        id={inputId}
        className={`ui-input ${error ? 'ui-input--error' : ''} ${className}`}
        {...rest}
      />
      {error && <div className="ui-field__error">{error}</div>}
    </div>
  );
}
