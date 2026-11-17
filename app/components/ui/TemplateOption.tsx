'use client';

import type { ReactNode } from 'react';

interface TemplateOptionProps {
  id: string;
  selected: boolean;
  description: string;
  onClick: () => void;
  badge?: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  avatarVariant?: 'letter' | 'icon';
  disabledReason?: string;
  current?: boolean;
}

export function TemplateOption({ id, selected, description, onClick, badge, disabled, icon, avatarVariant = 'letter', disabledReason, current = false }: TemplateOptionProps) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={selected}
      className={`ui-template-option${selected ? ' ui-template-option--selected' : ''}${current ? ' ui-template-option--current' : ''}`}>
      <span className={`ui-template-option__avatar${avatarVariant === 'icon' ? ' ui-template-option__avatar--icon' : ''}`}>{icon ?? id[0].toUpperCase()}</span>
      <span className="ui-template-option__body">
        <span className="ui-template-option__title">{id}</span>
        <span className="ui-template-option__description">{description}</span>
        {disabledReason && <span className="ui-template-option__description">{disabledReason}</span>}
      </span>
      {badge}
    </button>
  );
}
