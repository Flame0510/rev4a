'use client';

import { useState, useCallback, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { isWizardComplete } from '../wizard/storage';
import { Button, Input } from '../components/ui';
import { EyeIcon, EyeOffIcon } from '../components/Icons';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  // Redirect to /setup if no password is configured
  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d: { configured: boolean }) => {
        if (!d.configured) {
          router.replace('/setup');
          return;
        }
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  // Enter key handler for the password input
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && password) {
      const form = (e.target as HTMLInputElement).closest('form');
      if (form) form.requestSubmit();
    }
  }, [password]);

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
        // Check wizard completion via API
        try {
          const done = await isWizardComplete();
          if (!done) {
            router.replace('/wizard');
            return;
          }
        } catch { /* fallback to dashboard */ }
        router.replace('/');
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? 'Invalid password');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  if (checking) return null;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at top, rgba(146,91,252,0.12), transparent 32%), var(--bg)',
        fontFamily: 'var(--font-mono-stack, monospace)',
        padding: '24px',
      }}
    >
      <div
        style={{
          width: 'min(92vw, 392px)',
          background: 'linear-gradient(180deg, rgba(18,18,18,0.98), rgba(12,12,12,0.98))',
          border: '1px solid var(--border)',
          borderRadius: 0,
          boxShadow: '0 24px 64px rgba(0,0,0,0.42)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '22px 24px 18px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          <img src="/rev4a-logo.svg" alt="Rev4a" width="76" height="76" style={{ objectFit: 'contain', display: 'block', marginBottom: 14, filter: 'drop-shadow(0 0 12px rgba(146,91,252,0.25))' }} />
          <div style={{ fontFamily: 'var(--font-serif-stack, serif)', fontSize: 26, letterSpacing: 4, color: 'var(--violet)' }}>REV4A</div>
          <div style={{ marginTop: 8, color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.12em' }}>
            AGENCY MONITOR — RESTRICTED ACCESS
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px 24px 24px' }}>
          <div style={{ color: 'var(--violet)', fontSize: 10, letterSpacing: '0.12em', marginBottom: 8 }}>
            PASSWORD
          </div>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter admin password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--violet)',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'none',
                border: 'none',
                outline: 'none',
              }}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          {error && (
            <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{error}</div>
          )}
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={loading}
            disabled={!password || loading}
            style={{ width: '100%' }}
          >
            {loading ? 'ACCESSING...' : 'LOGIN'}
          </Button>
          <div style={{ marginTop: 14, fontSize: 10, color: 'var(--text-dim)', textAlign: 'center', letterSpacing: '0.06em' }}>
            Internal Rev4a access
          </div>
        </form>
      </div>
    </div>
  );
}
