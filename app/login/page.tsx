'use client';

import { useState, type FormEvent } from 'react';
import { Button, Input } from '../components/ui';
import { EyeIcon, EyeOffIcon } from '../components/Icons';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.replace('/');
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? 'Password errata');
      }
    } catch {
      setError('Errore di rete');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at top, rgba(212,155,53,0.12), transparent 32%), var(--bg)',
        fontFamily: 'var(--font-mono-stack, monospace)',
        padding: '24px',
      }}
    >
      <div
        style={{
          width: 'min(92vw, 392px)',
          background: 'linear-gradient(180deg, rgba(18,18,18,0.98), rgba(12,12,12,0.98))',
          border: '1px solid var(--border)',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.42)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '22px 24px 18px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          <img src="/olympus-logo.png" alt="Olympus" width="76" height="76" style={{ objectFit: 'contain', display: 'block', marginBottom: 14 }} />
          <div style={{ fontFamily: 'var(--font-serif-stack, serif)', fontSize: 26, letterSpacing: 4, color: 'var(--copper)' }}>OLYMPUS</div>
          <div style={{ marginTop: 8, color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.12em' }}>
            AGENCY MONITOR — ACCESSO RISERVATO
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px 24px 24px' }}>
          <div style={{ color: 'var(--copper)', fontSize: 10, letterSpacing: '0.12em', marginBottom: 8 }}>
            PASSWORD
          </div>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Inserisci la password"
              autoFocus
            />
            <span
              onClick={() => setShowPassword(!showPassword)}
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--copper)',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </span>
          </div>
          {error && (
            <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{error}</div>
          )}
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={loading}
            disabled={!password}
            style={{ width: '100%', borderRadius: 10, padding: '0.82rem', fontSize: 13 }}
          >
            {loading ? 'ACCESSO...' : 'ACCEDI'}
          </Button>
          <div style={{ marginTop: 14, fontSize: 10, color: 'var(--text-dim)', textAlign: 'center', letterSpacing: '0.06em' }}>
            Accesso interno Olympus
          </div>
        </form>
      </div>
    </div>
  );
}
