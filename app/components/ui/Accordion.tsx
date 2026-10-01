'use client';

import { useId, type ReactNode } from 'react';

interface AccordionProps {
  /** What the header says first: a name and its pills. */
  title: ReactNode;
  /** The figures kept in the header whether it is open or closed. */
  summary?: ReactNode;
  /** A second, muted line under the header. */
  detail?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** DOM id of the whole accordion, for a link to land on it. */
  id?: string;
  /** The body, mounted only while open — a chart inside fetches nothing while closed. */
  children: ReactNode;
}

/**
 * A row that opens to show more: the header is a real `<button>` carrying the title, the
 * summary figures and an optional detail line, so the answer to "what is this now" is on
 * screen closed; the body holds what takes more room (charts). Controlled: the parent owns
 * `open`, which lets a link or a fetch follow it. Square, flat, tokens only.
 */
export function Accordion({ title, summary, detail, open, onToggle, id, children }: AccordionProps) {
  const bodyId = `${useId().replace(/:/g, '')}-body`;
  return (
    <section className={`ui-accordion${open ? ' ui-accordion--open' : ''}`} id={id}>
      <button
        type="button"
        className="ui-accordion__header"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
      >
        <span className="ui-accordion__caret" aria-hidden="true">▶</span>
        <span className="ui-accordion__title">{title}</span>
        {summary !== undefined && <span className="ui-accordion__summary">{summary}</span>}
        {detail !== undefined && <span className="ui-accordion__detail">{detail}</span>}
      </button>
      {open && <div className="ui-accordion__body" id={bodyId}>{children}</div>}
    </section>
  );
}
