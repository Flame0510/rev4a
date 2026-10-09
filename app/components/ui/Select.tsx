'use client';

import { useId, type SelectHTMLAttributes, type ReactNode } from 'react';

interface SelectOption { value: string; label: ReactNode; disabled?: boolean }

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  /** `disabled` shows a value that exists but may not be chosen, e.g. a current setting no longer on offer. */
  options: SelectOption[];
  /** Labelled groups (`<optgroup>`) rendered after `options`; a group with no options is not rendered. */
  groups?: { label: string; options: SelectOption[] }[];
}

export function Select({ label, error, options, groups, id, className = '', ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id || generatedId;

  return (
    <div className="ui-field">
      {label && <label className="ui-field__label" htmlFor={selectId}>{label}</label>}
      <select id={selectId} className={`ui-select ${error ? 'ui-select--error' : ''} ${className}`} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
        {groups?.filter((g) => g.options.length > 0).map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {error && <div className="ui-field__error">{error}</div>}
    </div>
  );
}
