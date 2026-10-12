'use client';

import type { MouseEvent, ReactNode } from 'react';

type SwitchSize = 'sm' | 'md';
type SwitchTone = 'default' | 'danger';

interface SwitchProps {
  checked: boolean;
  /** Called with the next value when the user toggles. Not called while `disabled` or `loading`. */
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Shows a small spinner in the thumb, sets `aria-busy` and ignores clicks. */
  loading?: boolean;
  /** Visible text next to the switch. */
  label?: ReactNode;
  /** Accessible name. Required when there is no visible `label`. */
  ariaLabel?: string;
  /** `danger` marks a failed or pending state. */
  tone?: SwitchTone;
  size?: SwitchSize;
  title?: string;
  className?: string;
}

/**
 * Switch: the shared on/off control (`role="switch"`). Square track and thumb, violet when on.
 * Clicks never reach a clickable parent (list rows), so it is safe inside one.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  loading = false,
  label,
  ariaLabel,
  tone = 'default',
  size = 'md',
  title,
  className = '',
}: SwitchProps) {
  const cls = [
    'ui-switch',
    `ui-switch--${size}`,
    checked ? 'ui-switch--on' : '',
    tone === 'danger' ? 'ui-switch--danger' : '',
    loading ? 'ui-switch--loading' : '',
    className,
  ].filter(Boolean).join(' ');

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (disabled || loading) return;
    onChange(!checked);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className={cls}
      onClick={handleClick}
    >
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__thumb">
          {loading && <span className="ui-switch__spinner" />}
        </span>
      </span>
      {label != null && label !== false && <span className="ui-switch__label">{label}</span>}
    </button>
  );
}
