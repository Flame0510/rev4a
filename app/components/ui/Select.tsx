'use client';

import { useId, type SelectHTMLAttributes, type ReactNode } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  /** `disabled` shows a value that exists but may not be chosen, e.g. a current setting no longer on offer. */
  options: { value: string; label: ReactNode; disabled?: boolean }[];
}

export function Select({ label, error, options, id, className = '', ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id || generatedId;

  return (
    <div className="ui-field">
      {label && <label className="ui-field__label" htmlFor={selectId}>{label}</label>}
      <select id={selectId} className={`ui-select ${error ? 'ui-select--error' : ''} ${className}`} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      {error && <div className="ui-field__error">{error}</div>}
    </div>
  );
}
