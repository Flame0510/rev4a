'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Tone } from './tokens';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: Tone;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'ui-btn--primary',
  secondary: 'ui-btn--secondary',
  danger: 'ui-btn--danger',
  ghost: 'ui-btn--ghost',
  success: 'ui-btn--success',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'ui-btn--sm',
  md: 'ui-btn--md',
};

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  tone,
  loading = false,
  disabled,
  className = '',
  ...rest
}: ButtonProps) {
  const cls = [
    'ui-btn',
    variantClasses[variant],
    sizeClasses[size],
    tone ? `ui-tone--${tone}` : '',
    loading ? 'ui-btn--loading' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="ui-btn__spinner" />}
      {children}
    </button>
  );
}
