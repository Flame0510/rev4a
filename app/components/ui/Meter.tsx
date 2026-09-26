export type MeterLevel = 'ok' | 'warning' | 'critical';

/** The level a percentage falls in, given its warning and critical thresholds. */
export function meterLevel(percent: number, warning: number, critical: number): MeterLevel {
  if (percent >= critical) return 'critical';
  if (percent >= warning) return 'warning';
  return 'ok';
}

const LEVEL_LABEL: Record<MeterLevel, string> = { ok: 'ok', warning: 'high', critical: 'critical' };

/**
 * A horizontal fill for a 0-100 % share. The fill carries the level (accent → warning →
 * danger), the track is a dim step behind it, and the level is also written out, so it
 * never rests on colour alone.
 */
export function Meter({ percent, level, label }: { percent: number; level: MeterLevel; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="ui-meter">
      <div
        className="ui-meter__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
      >
        <div className={`ui-meter__fill ui-meter__fill--${level}`} style={{ width: `${clamped}%` }} />
      </div>
      {level !== 'ok' && <span className={`ui-meter__level ui-meter__level--${level}`}>{LEVEL_LABEL[level]}</span>}
    </div>
  );
}
