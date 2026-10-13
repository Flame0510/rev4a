'use client';

import type { ReactNode } from 'react';
import { Switch } from './Switch';

interface AgentCardProps {
  /** Display name. Truncated with a CSS ellipsis, never sliced in JS, so an emoji is never cut in half. */
  name: string;
  /** Template label (a small pill on the meta line). */
  template?: string | null;
  /** The container is running: the state of the status switch. */
  running: boolean;
  /** The switch shows its spinner and ignores clicks. */
  toggling?: boolean;
  /** The switch cannot be used (state unknown, or a long operation is running). */
  toggleDisabled?: boolean;
  onToggle: () => void;
  /** Right end of line 1, for example the "Open Control UI" button. Clicks on it never select the card. */
  action?: ReactNode;
  /** Line 2, muted: image, ports. Falsy entries are skipped. */
  meta?: ReactNode[];
  /** Line 3: the model and its chips. */
  model?: ReactNode;
  /** Status chips (operation, channel, browsers waiting): one wrapping row. */
  chips?: ReactNode;
  /** Highlighted as the current selection (desktop split view). */
  selected?: boolean;
  /** Selects the agent (opens the detail). */
  onSelect: () => void;
}

/**
 * AgentCard: one agent in the Agents list. Three lines: status switch + name + action,
 * muted meta, model. Status chips wrap in one row below.
 *
 * The card is not a button around other buttons (invalid HTML): a transparent
 * button covers the whole card and selects it, and the switch and the action sit
 * above it, so touching them never opens the detail. Touch targets are at least
 * 44 px high on a phone (`.agent-card` rules in `globals.css`).
 */
export function AgentCard({
  name,
  template,
  running,
  toggling = false,
  toggleDisabled = false,
  onToggle,
  action,
  meta,
  model,
  chips,
  selected = false,
  onSelect,
}: AgentCardProps) {
  const metaItems = (meta ?? []).filter((m) => m !== null && m !== undefined && m !== false && m !== '');
  return (
    <div className={`agent-card${selected ? ' agent-card--selected' : ''}`}>
      <button
        type="button"
        className="agent-card__hit"
        onClick={onSelect}
        aria-label={`Open ${name}`}
        aria-current={selected || undefined}
      />
      <div className="agent-card__row">
        <span className="agent-card__control">
          <Switch
            checked={running}
            loading={toggling}
            disabled={toggleDisabled}
            onChange={onToggle}
            ariaLabel={`${name} running`}
          />
        </span>
        <span className="agent-card__name" title={name}>{name}</span>
        {action && <span className="agent-card__control agent-card__action">{action}</span>}
      </div>
      {(template || metaItems.length > 0) && (
        <div className="agent-card__meta">
          {template && <span className="agent-card__template">{template}</span>}
          {metaItems.map((m, i) => <span key={i} className="agent-card__meta-item">{m}</span>)}
        </div>
      )}
      {model && <div className="agent-card__model">{model}</div>}
      {chips && <div className="agent-card__chips">{chips}</div>}
    </div>
  );
}
