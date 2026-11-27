'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from '../components/ui';
import { ArrowRightIcon, CheckCircleIcon } from '../wizard/icons';
import { rememberSetupCode } from '../wizard/storage';

type Step = 'password' | 'done';

const STEPS = [
  { key: 'password' as const, label: 'Password' },
  { key: 'done' as const,     label: 'Done' },
];

export default function SetupPageClient() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const statusAbortRef = useRef<AbortController | null>(null);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // Redirect if already configured
  useEffect(() => {
    statusAbortRef.current?.abort();
    const controller = new AbortController();
    statusAbortRef.current = controller;
    fetch('/api/auth/status', { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { configured: boolean }) => {
        if (!controller.signal.aborted && d.configured) router.replace('/login');
      })
      .catch(() => {});
    return () => controller.abort();
  }, [router]);



  // ─── Password ─────────────────────────────────────────────────────

  const handleSetPassword = useCallback(async () => {
    if (savingRef.current) return;
    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setPasswordError('');

    try {
      const res = await fetch('/api/setup/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-rev4a-setup-code': setupCode },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        // Password saved to .env — login route reads it from file.
        // Retain the code only for this tab's wizard requests.
        rememberSetupCode(setupCode);
        setStep('done');
        return;
      }

      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      setPasswordError(err.error || 'Failed to set password');
    } catch {
      setPasswordError('Network error — please try again');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [password, setupCode]);



  // ─── Done — go straight to login ───────────────────────────────────

  const handleDone = useCallback(async () => {
    router.push('/login');
  }, [router]);

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div className="setup-outer">
      <div className="setup-card">
        <div className="setup-header">
          <div className="setup-logo">REV4A</div>
          <div className="setup-stepper">
            {STEPS.map((s, i) => (
              <div
                key={s.key}
                className={`setup-step${i < stepIndex ? ' done' : ''}${i === stepIndex ? ' active' : ''}`}
              />
            ))}
          </div>
        </div>

        <div className="setup-body">
          {step === 'password' && (
            <div style={{ display: 'grid', gap: 14 }}>
              <h2 style={{
                fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5,
                color: 'var(--violet)', margin: 0,
              }}>
                Set Admin Password
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                Choose a password to protect your Rev4a dashboard.
                You'll use this to log in as admin.
              </p>
              <Input
                label="Setup code"
                placeholder="ABCD-EFGH-JKLM-NPQR"
                value={setupCode}
                onChange={(e) => { setSetupCode(e.target.value); setPasswordError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby="setup-code-hint"
                disabled={saving}
                autoFocus
              />
              <p id="setup-code-hint" style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>
                Find this code in the terminal where rev4a serve runs, or in the service journal
                (journalctl -u rev4a). For npm run dev, check its terminal after submitting.
              </p>
              <Input
                label="Password"
                type="password"
                placeholder="Minimum 8 characters"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
                autoComplete="new-password"
                disabled={saving}
                error={passwordError}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <Button variant="primary" size="md" onClick={handleSetPassword} loading={saving} disabled={saving}>
                  {saving ? 'Setting Password…' : 'Set Password'} <ArrowRightIcon />
                </Button>
              </div>
            </div>
          )}



          {step === 'done' && (
            <div style={{ display: 'grid', gap: 14, textAlign: 'center' }}>
              <div style={{ margin: '0 auto', display: 'flex', justifyContent: 'center' }}>
                <CheckCircleIcon size={48} color="var(--violet)" />
              </div>
              <h2 style={{
                fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5,
                color: 'var(--violet)', margin: 0,
              }}>
                Ready to Go
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                The essentials are done. After logging in, the setup wizard
                will help you add a provider key (optional with a ChatGPT or Claude
                subscription) and create your first agent.
              </p>
              <div style={{ display: 'grid', gap: 6, textAlign: 'left', padding: '10px 12px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                {[
                  'Set admin password',
                  'Agent base image: download it from the banner on the Agents page',
                  'Next: add providers & agents in the wizard',
                ].map((t) => (
                  <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)' }}>
                    <span style={{ color: 'var(--violet)' }}>•</span> {t}
                  </div>
                ))}
              </div>
              <Button variant="primary" size="md" onClick={handleDone}>
                Start Using Rev4a <ArrowRightIcon />
              </Button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .setup-outer {
          min-height: 100vh; min-height: 100dvh;
          display: flex; align-items: flex-start; justify-content: center;
          background: radial-gradient(circle at top, rgba(146,91,252,0.12), transparent 40%), var(--bg);
          font-family: var(--font-mono-stack);
          padding: 0;
        }
        .setup-card {
          width: 100%;
          background: var(--bg);
          overflow: hidden;
        }
        .setup-header {
          padding: 14px 16px 10px;
          border-bottom: 1px solid var(--border);
          display: flex; flex-direction: column; align-items: center; gap: 8px;
        }
        .setup-logo {
          font-family: var(--font-serif-stack);
          font-size: 20px; letter-spacing: 3px;
          color: var(--violet);
        }
        .setup-stepper {
          display: flex; gap: 6px; align-items: center;
        }
        .setup-step {
          width: 8px; height: 8px;
          border-radius: 50%;
          background: var(--border);
          opacity: 0.3;
          transition: all 0.2s;
          flex-shrink: 0;
        }
        .setup-step.done { background: var(--violet); opacity: 0.7; }
        .setup-step.active { background: var(--violet); opacity: 1; box-shadow: 0 0 6px rgba(146,91,252,0.5); }
        .setup-body { padding: 16px; }
        @media (min-width: 481px) {
          .setup-outer { align-items: center; padding: 24px; }
          .setup-card {
            width: min(92vw, 480px);
            background: linear-gradient(180deg, rgba(18,18,18,0.98), rgba(12,12,12,0.98));
            border: 1px solid var(--border);
            box-shadow: 0 24px 64px rgba(0,0,0,0.42);
          }
          .setup-header { padding: 18px 24px 14px; }
          .setup-body { padding: 20px 24px 24px; }
        }
      `}</style>
    </div>
  );
}
