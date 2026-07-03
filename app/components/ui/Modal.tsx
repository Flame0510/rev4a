'use client';

import { useEffect, type ReactNode } from 'react';
import type { Tone } from './tokens';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  tone?: Tone;
  maxWidth?: number;
}

export function Modal({ open, onClose, title, children, maxWidth = 800, tone }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ui-modal-overlay" onClick={onClose}>
      <div
        className={`ui-modal ${tone ? `ui-tone--${tone}` : ''}`}
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ui-modal__head">
          <span className="ui-modal__title">{title}</span>
          <button type="button" className="ui-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ui-modal__body">
          {children}
        </div>
      </div>
    </div>
  );
}
