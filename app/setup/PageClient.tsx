'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../components/ui';
import { ArrowRightIcon, CheckCircleIcon } from '../wizard/icons';

type Step = 'password' | 'image' | 'done';

const STEPS = [
  { key: 'password' as const, label: 'Password' },
  { key: 'image' as const,    label: 'Image' },
  { key: 'done' as const,     label: 'Done' },
];

interface ImageStatus {
  exists: boolean;
  building: boolean;
  error: string | null;
  logs: string[];
}

export default function SetupPageClient() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [saving, setSaving] = useState(false);

  const [imageStatus, setImageStatus] = useState<ImageStatus>({
    exists: false, building: false, error: null, logs: [],
  });

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // Redirect if already configured
  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d: { configured: boolean }) => {
        if (d.configured) router.replace('/login');
      })
      .catch(() => {});
  }, [router]);

  // Check agent image status
  useEffect(() => {
    fetch('/api/setup/agent-image')
      .then((r) => r.json())
      .then((d: { exists: boolean }) => setImageStatus((prev) => ({ ...prev, exists: d.exists })))
      .catch(() => {});
  }, []);

  // ─── Password ─────────────────────────────────────────────────────

  const handleSetPassword = useCallback(async () => {
    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }
    setSaving(true);
    setPasswordError('');

    try {
      const res = await fetch('/api/setup/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        // Password saved to .env — login route reads it from file.
        // No restart needed: JWT_SECRET was inlined at build time.
        setSaving(false);
        setStep('image');
        return;
      }

      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      setPasswordError(err.error || 'Failed to set password');
    } catch {
      setPasswordError('Network error — please try again');
    }
    setSaving(false);
  }, [password]);

  // ─── Image build ──────────────────────────────────────────────────

  const buildImage = useCallback(async () => {
    setImageStatus((prev) => ({ ...prev, building: true, error: null, logs: [] }));

    try {
      const res = await fetch('/api/setup/agent-image', { method: 'POST' });
      if (!res.ok || !res.body) throw new Error('Failed to start build');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const data = line.replace(/^data: /, '').trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            setImageStatus((prev) => {
              if (parsed.type === 'step') {
                return { ...prev, logs: [...prev.logs.slice(-20), parsed.message] };
              }
              if (parsed.type === 'complete') {
                return { ...prev, building: false, exists: true, logs: [...prev.logs.slice(-20), parsed.message] };
              }
              if (parsed.type === 'error') {
                return { ...prev, building: false, error: parsed.message };
              }
              return prev;
            });
          } catch { /* skip */ }
        }
      }
    } catch (e: unknown) {
      setImageStatus((prev) => ({
        ...prev,
        building: false,
        error: (e as Error).message || 'Build failed',
      }));
    }
  }, []);

  // ─── Done — go straight to login, no restart needed ─────────────────

  const handleDone = useCallback(async () => {
    router.push('/login');
  }, [router]);

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div className="setup-outer">
      <div className="setup-card">
        <div className="setup-header">
          <div className="setup-logo">OLYMPUS</div>
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
                color: 'var(--copper)', margin: 0,
              }}>
                Set Admin Password
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                Choose a password to protect your Olympus dashboard.
                You'll use this to log in as admin.
              </p>
              <input
                type="password"
                placeholder="Minimum 8 characters"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
                className="setup-input"
                autoFocus
              />
              {passwordError && (
                <div style={{
                  fontSize: 11, color: '#ef4444', padding: '4px 8px',
                  background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                }}>
                  {passwordError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <Button variant="primary" size="md" onClick={handleSetPassword} loading={saving}>
                  Set Password <ArrowRightIcon />
                </Button>
              </div>
            </div>
          )}

          {step === 'image' && (
            <div style={{ display: 'grid', gap: 14 }}>
              <h2 style={{
                fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5,
                color: 'var(--copper)', margin: 0,
              }}>
                Agent Base Image
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                Olympus runs agents as Docker containers. The base image provides Node.js,
                OpenClaw, and all tooling agents need. It only needs to be built once.
              </p>

              {imageStatus.exists ? (
                <div style={{
                  padding: '10px 12px',
                  background: 'rgba(52,211,153,0.06)',
                  border: '1px solid rgba(52,211,153,0.15)',
                  fontSize: 12, color: 'var(--text)',
                }}>
                  ✅ Agent base image is ready.
                </div>
              ) : imageStatus.building ? (
                <div style={{
                  padding: '10px 12px',
                  background: 'rgba(96,165,250,0.06)',
                  border: '1px solid rgba(96,165,250,0.15)',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
                    Building image...
                  </div>
                  <div style={{
                    height: 4, background: 'var(--border)', overflow: 'hidden', marginBottom: 6,
                  }}>
                    <div style={{
                      height: 4,
                      background: 'linear-gradient(90deg, var(--copper), #60a5fa)',
                      animation: 'setup-progress 2s ease-in-out infinite',
                      width: '30%',
                    }} />
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', maxHeight: 80, overflowY: 'auto' }}>
                    {imageStatus.logs.map((l, i) => (
                      <div key={i} style={{ lineHeight: 1.5 }}>{l}</div>
                    ))}
                  </div>
                  {imageStatus.error && (
                    <div style={{ fontSize: 10, color: '#ef4444', marginTop: 4 }}>{imageStatus.error}</div>
                  )}
                </div>
              ) : (
                <div style={{
                  padding: '10px 12px',
                  background: 'rgba(96,165,250,0.06)',
                  border: '1px solid rgba(96,165,250,0.15)',
                }}>
                  <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: '0 0 8px' }}>
                    The image needs to be built. This pulls Node.js and installs OpenClaw packages.
                    Takes about 3-5 minutes the first time.
                  </p>
                  <Button variant="secondary" size="sm" onClick={buildImage}>
                    Build Image
                  </Button>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <Button variant="ghost" size="sm" onClick={() => setStep('done')}>
                  Skip for now
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => setStep('done')}
                  disabled={!imageStatus.exists && !imageStatus.error}
                >
                  Continue <ArrowRightIcon />
                </Button>
              </div>
            </div>
          )}

          {step === 'done' && (
            <div style={{ display: 'grid', gap: 14, textAlign: 'center' }}>
              <div style={{ margin: '0 auto', display: 'flex', justifyContent: 'center' }}>
                <CheckCircleIcon size={48} color="var(--copper)" />
              </div>
              <h2 style={{
                fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5,
                color: 'var(--copper)', margin: 0,
              }}>
                Ready to Go
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                The essentials are done. After logging in, the setup wizard
                will help you add your first provider and create your first agent.
              </p>
              <div style={{ display: 'grid', gap: 6, textAlign: 'left', padding: '10px 12px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                {[
                  'Set admin password',
                  imageStatus.exists ? 'Agent base image ready' : 'Agent image — build later',
                  'Next: add providers & agents in the wizard',
                ].map((t) => (
                  <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)' }}>
                    <span style={{ color: 'var(--copper)' }}>•</span> {t}
                  </div>
                ))}
              </div>
              <Button variant="primary" size="md" onClick={handleDone}>
                Start Using Olympus <ArrowRightIcon />
              </Button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .setup-outer {
          min-height: 100vh; min-height: 100dvh;
          display: flex; align-items: flex-start; justify-content: center;
          background: radial-gradient(circle at top, rgba(212,155,53,0.12), transparent 40%), var(--bg);
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
          color: var(--copper);
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
        .setup-step.done { background: var(--copper); opacity: 0.7; }
        .setup-step.active { background: var(--copper); opacity: 1; box-shadow: 0 0 6px rgba(212,155,53,0.5); }
        .setup-body { padding: 16px; }
        .setup-input {
          background: var(--bg); border: 1px solid var(--border);
          color: var(--text); padding: 8px 10px;
          font-size: 12px; font-family: var(--font-mono-stack);
          outline: none; width: 100%; box-sizing: border-box;
        }
        .setup-input:focus { border-color: var(--copper); }

        @keyframes setup-progress {
          0% { width: 0%; }
          50% { width: 60%; }
          100% { width: 0%; }
        }

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
