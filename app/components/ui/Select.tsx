'use client';

import { useId, type SelectHTMLAttributes, type ReactNode } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: ReactNode }[];
}

export function Select({ label, error, options, id, className = '', ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id || generatedId;

  return (
    <div className="ui-field">
      {label && <label className="ui-field__label" htmlFor={selectId}>{label}</label>}
      <select id={selectId} className={`ui-select ${error ? 'ui-select--error' : ''} ${className}`} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && <div className="ui-field__error">{error}</div>}
    </div>
  );
}
