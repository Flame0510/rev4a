'use client';

interface LoadingSpinnerProps {
  label?: string;
  compact?: boolean;
}

export function LoadingSpinner({ label, compact }: LoadingSpinnerProps) {
  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '40px 20px' }}>
        <div className="ui-spinner" />
        {label && <span style={{ fontSize: 11, color: 'var(--text-dim)', letterSpacing: '0.06em' }}>{label}</span>}
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 16,
    }}>
      <div className="ui-spinner ui-spinner--lg" />
      {label && <div style={{ color: 'var(--text)', fontSize: 14, letterSpacing: '0.03em' }}>{label}</div>}
    </div>
  );
}
