'use client';

/**
 * Modality badges for a model.
 *
 * Reads the `modality` string that ships in models.config.json (and matches
 * OpenRouter's `architecture.modality` format verbatim), e.g.
 *   "text+image+file->text"        → accepts text, images, files
 *   "text+image+file+audio+video->text+image"  → also *produces* images
 *
 * Inputs are shown as icons; a non-text output is called out separately,
 * since "can read an image" and "can generate an image" are very different
 * capabilities and collapsing them would be misleading.
 */

interface ModalitySpec {
  label: string;
  icon: React.ReactNode;
}

const ICONS: Record<string, ModalitySpec> = {
  text: {
    label: 'Text',
    icon: (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M3 4h10M3 8h10M3 12h6" />
      </svg>
    ),
  },
  image: {
    label: 'Images',
    icon: (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <circle cx="6" cy="6.5" r="1.2" />
        <path d="M3 11.5l3.2-3 2.3 2.2 2-1.8 2.5 2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  file: {
    label: 'Files / PDF',
    icon: (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z" />
        <path d="M9 2v4h4" />
      </svg>
    ),
  },
  audio: {
    label: 'Audio',
    icon: (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M8 2.5v11" />
        <path d="M5 5.5v5M11 5.5v5" />
        <path d="M2.5 7.5v1M13.5 7.5v1" />
      </svg>
    ),
  },
  video: {
    label: 'Video',
    icon: (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <rect x="2" y="4" width="8.5" height="8" rx="1.5" />
        <path d="M10.5 8l3.5-2v6l-3.5-2z" />
      </svg>
    ),
  },
};

export interface ParsedModality {
  inputs: string[];
  outputs: string[];
}

/** Split "text+image->text+image" into its input and output lists. */
export function parseModality(modality: string | undefined | null): ParsedModality | null {
  if (!modality || typeof modality !== 'string') return null;
  const [rawIn, rawOut] = modality.split('->');
  if (!rawIn) return null;
  const split = (s: string) => s.split('+').map((p) => p.trim()).filter(Boolean);
  return { inputs: split(rawIn), outputs: rawOut ? split(rawOut) : [] };
}

/** Own-property lookup: a token like "constructor" must not resolve to Object.prototype. */
function iconFor(token: string): ModalitySpec | null {
  return Object.hasOwn(ICONS, token) ? ICONS[token] : null;
}

interface ModalityIconsProps {
  modality?: string | null;
  /**
   * Router models (OpenRouter Auto) advertise the union of everything they
   * might route to, which reads as a guarantee it isn't. They already show
   * "Dynamic" for price; capabilities get the same treatment rather than
   * concrete icons.
   */
  dynamic?: boolean;
}

export default function ModalityIcons({ modality, dynamic }: ModalityIconsProps) {
  if (dynamic) {
    return (
      <span
        title="Routed to a different model per request — capabilities vary"
        style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}
      >
        varies
      </span>
    );
  }

  const parsed = parseModality(modality);
  if (!parsed) return null;

  // Anything the model can produce beyond plain text is worth surfacing:
  // only 15 of 422 upstream models do, and "reads images" vs "makes images"
  // are very different capabilities.
  const generates = parsed.outputs.filter((o) => o !== 'text');

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, verticalAlign: 'middle' }}>
      {parsed.inputs.map((input) => {
        const spec = iconFor(input);
        if (!spec) return null;
        return (
          <span
            key={input}
            title={`Accepts ${spec.label.toLowerCase()}`}
            aria-label={`Accepts ${spec.label.toLowerCase()}`}
            style={{ display: 'inline-flex', color: 'var(--text-dim)', opacity: 0.75 }}
          >
            {spec.icon}
          </span>
        );
      })}

      {generates.map((out) => {
        const spec = iconFor(out);
        if (!spec) return null;
        return (
          <span
            key={`out-${out}`}
            title={`Generates ${spec.label.toLowerCase()}`}
            aria-label={`Generates ${spec.label.toLowerCase()}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 2,
              color: 'var(--violet)', fontSize: 9, fontWeight: 600,
            }}
          >
            <span aria-hidden="true">→</span>
            {spec.icon}
          </span>
        );
      })}
    </span>
  );
}
