'use client';

/**
 * Remove an item from a list.
 *
 * A small `×` at the end of a row, rather than a "Remove" label: the word reads
 * as an action already carried out, which is wrong wherever the change only
 * lands on save.
 *
 * One style everywhere — the `danger` treatment the credentials page already
 * used. Whether the removal is immediate or pending is said in the tooltip, not
 * in the colour: two tones for the same gesture made the button look like two
 * different controls.
 *
 * Deliberately separate from dismissing a dialog, which looks similar and means
 * something else. See rule 8 in docs/FRONTEND-ARCHITECTURE.md.
 */
import { Button } from './Button';

export function RemoveButton({
  onClick,
  label,
  disabled,
  title,
}: {
  onClick: () => void;
  /** What is being removed. Becomes the accessible name: "Remove <label>". */
  label: string;
  disabled?: boolean;
  /** Override when the consequence is worth spelling out, e.g. a pending edit. */
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="danger"
      size="sm"
      disabled={disabled}
      aria-label={`Remove ${label}`}
      title={title ?? `Remove ${label}`}
      onClick={onClick}
    >
      ×
    </Button>
  );
}
