'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../components/ui';
import { ArrowRightIcon, CheckCircleIcon, CheckIcon } from '../onboarding/icons';

type Step = 'password' | 'providers' | 'agent' | 'done';

const STEPS = [
  { key: 'password' as const,  label: 'Password' },
  { key: 'providers' as const, label: 'Providers' },
  { key: 'agent' as const,     label: 'Agent' },
  { key: 'done' as const,      label: 'Done' },
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

  // Provider state
  const [providerKey, setProviderKey] = useState('');
  const [providerName, setProviderName] = useState('deepseek');

  // Agent state
  const [agentName, setAgentName] = useState('');
  const [agentTemplate, setAgentTemplate] = useState('argus');
  const [agentModel, setAgentModel] = useState('deepseek/deepseek-v4-flash');

  // Image build state
  const [imageStatus, setImageStatus] = useState<ImageStatus>({
    exists: false, building: false, error: null, logs: [],
  });

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // Check if already configured on mount
  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d: { configured: boolean }) => {
        if (d.configured) {
          // Already configured — redirect to login
          router.replace('/login');
        }
      })
      .catch(() => {});
  }, [router]);

  // Check agent image status on mount
  useEffect(() => {
    fetch('/api/setup/agent-image')
      .then((r) => r.json())
      .then((d: { exists: boolean }) => setImageStatus((prev) => ({ ...prev, exists: d.exists })))
      .catch(() => {});
  }, []);

  // ─── Password step ─────────────────────────────────────────────────

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
        const data = await res.json();
        if (data.status === 'ok') {
          // Server is restarting — wait and redirect to login
          setSaving(false);
          // Poll until server is back
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const ping = await fetch('/api/auth/status');
              if (ping.ok) break;
            } catch { /* still restarting */ }
          }
          router.push('/login');
          return;
        }
      }

      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      setPasswordError(err.error || 'Failed to set password');
    } catch {
      setPasswordError('Network error — is the server restarting?');
    }
    setSaving(false);
  }, [password, router]);

  // ─── Provider step ─────────────────────────────────────────────────

  const handleSaveProvider = useCallback(async () => {
    if (!providerKey.trim()) return;
    setSaving(true);

    try {
      await fetch('/api/gateway/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerName, apiKey: providerKey.trim() }),
      });
      setStep('agent');
    } catch { /* non-fatal */ }
    setSaving(false);
  }, [providerKey, providerName]);

  // ─── Agent image build ──────────────────────────────────────────────

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
          } catch { /* skip unparseable */ }
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

  // ─── Create agent ───────────────────────────────────────────────────

  const handleCreateAgent = useCallback(async () => {
    if (!agentName.trim()) return;
    setSaving(true);

    try {
      const res = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: agentName.trim(),
          template: agentTemplate,
          model: agentModel,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setStep('done');
          setSaving(false);
          return;
        }
      }
    } catch { /* non-fatal */ }
    setSaving(false);
  }, [agentName, agentTemplate, agentModel]);

  const handleDone = useCallback(() => {
    router.push('/');
  }, [router]);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div className="setup-outer">
      <div className="setup-card">
        <div className="setup-header">
          <div className="setup-logo">OLYMPUS</div>
          <div className="setup-stepper">
            {STEPS.map((s, i) => (
              <div key={s.key} className={`setup-step${i < stepIndex ? ' done' : ''}${i === stepIndex ? ' active' : ''}`} />
            ))}
          </div>
        </div>

        <div className="setup-body">
          {step === 'password' && (
            <div style={{ display: 'grid', gap: 14 }}>
              <h2 style={{ fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5, color: 'var(--copper)', margin: 0 }}>
                Set Admin Password
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                Choose a password to protect your Olympus dashboard.
                You will use this to log in after setup is complete.
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
                <div style={{ fontSize: 11, color: '#ef4444', padding: '4px 8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
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

          {step === 'providers' && (
            <div style={{ display: 'grid', gap: 14 }}>
              <h2 style={{ fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5, color: 'var(--copper)', margin: 0 }}>
                Add a Provider
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                Your agents need an LLM provider to work. Add at least one API key.
                DeepSeek is recommended — free credits available.
              </p>
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>Provider</label>
                  <select
                    value={providerName}
                    onChange={(e) => setProviderName(e.target.value)}
                    className="setup-input"
                    style={{ appearance: 'auto' }}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="groq">Groq</option>
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>API Key</label>
                  <input
                    type="password"
                    placeholder={providerName === 'deepseek' ? 'sk-...' : providerName === 'groq' ? 'gsk_...' : 'sk-...'}
                    value={providerKey}
                    onChange={(e) => setProviderKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveProvider()}
                    className="setup-input"
                  />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <Button variant="ghost" size="sm" onClick={() => setStep('agent')}>Skip for now</Button>
                <Button variant="primary" size="md" onClick={handleSaveProvider} loading={saving}>
                  Save &amp; Continue <ArrowRightIcon />
                </Button>
              </div>
            </div>
          )}

          {step === 'agent' && (
            <div style={{ display: 'grid', gap: 14 }}>
              <h2 style={{ fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5, color: 'var(--copper)', margin: 0 }}>
                Create Your First Agent
              </h2>

              {/* Image build status */}
              {!imageStatus.exists && (
                <div style={{
                  padding: '10px 12px',
                  background: 'rgba(96,165,250,0.06)',
                  border: '1px solid rgba(96,165,250,0.15)',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
                    Agent base image {imageStatus.building ? 'building...' : 'needed'}
                  </div>
                  {!imageStatus.building && (
                    <Button variant="secondary" size="sm" onClick={buildImage}>
                      Build Image
                    </Button>
                  )}
                  {imageStatus.building && (
                    <div>
                      <div style={{
                        height: 4, background: 'var(--border)', borderRadius: 0, overflow: 'hidden', marginBottom: 6,
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
                    </div>
                  )}
                  {imageStatus.error && (
                    <div style={{ fontSize: 10, color: '#ef4444', marginTop: 4 }}>{imageStatus.error}</div>
                  )}
                </div>
              )}

              {imageStatus.exists && (
                <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                  Agent base image is ready. Choose a name and template for your first agent.
                </p>
              )}

              {!imageStatus.exists && !imageStatus.building && (
                <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                  First, build the agent base image. This pulls Node.js + installs OpenClaw — it takes a few minutes the first time.
                </p>
              )}

              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', opacity: imageStatus.exists ? 1 : 0.4 }}>
                    Agent Name
                  </label>
                  <input
                    type="text"
                    placeholder="my-agent"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    disabled={!imageStatus.exists}
                    className="setup-input"
                    style={{ opacity: imageStatus.exists ? 1 : 0.5 }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', opacity: imageStatus.exists ? 1 : 0.4 }}>
                    Template
                  </label>
                  <select
                    value={agentTemplate}
                    onChange={(e) => setAgentTemplate(e.target.value)}
                    disabled={!imageStatus.exists}
                    className="setup-input"
                    style={{ appearance: 'auto', opacity: imageStatus.exists ? 1 : 0.5 }}
                  >
                    <option value="argus">Argus (Ops Lead)</option>
                    <option value="atlas">Atlas (Research)</option>
                    <option value="prometheus">Prometheus</option>
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', opacity: imageStatus.exists ? 1 : 0.4 }}>
                    Model
                  </label>
                  <select
                    value={agentModel}
                    onChange={(e) => setAgentModel(e.target.value)}
                    disabled={!imageStatus.exists}
                    className="setup-input"
                    style={{ appearance: 'auto', opacity: imageStatus.exists ? 1 : 0.5 }}
                  >
                    <option value="deepseek/deepseek-v4-flash">DeepSeek V4 Flash</option>
                    <option value="deepseek/deepseek-v4-pro">DeepSeek V4 Pro</option>
                    <option value="deepseek/deepseek-r1-0528">DeepSeek R1 0528</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <Button variant="ghost" size="sm" onClick={() => setStep('done')}>
                  Skip for now
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleCreateAgent}
                  loading={saving}
                  disabled={!imageStatus.exists || !agentName.trim()}
                >
                  Create Agent <ArrowRightIcon />
                </Button>
              </div>
            </div>
          )}

          {step === 'done' && (
            <div style={{ display: 'grid', gap: 14, textAlign: 'center' }}>
              <div style={{ margin: '0 auto', display: 'flex', justifyContent: 'center' }}>
                <CheckCircleIcon size={48} color="var(--copper)" />
              </div>
              <h2 style={{ fontFamily: 'var(--font-serif-stack)', fontSize: 22, letterSpacing: 1.5, color: 'var(--copper)', margin: 0 }}>
                Setup Complete
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
                Olympus is configured and ready. You can always manage providers,
                create more agents, and adjust settings from the dashboard.
              </p>
              <div style={{ display: 'grid', gap: 6, textAlign: 'left', padding: '10px 12px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                {[
                  { label: 'Dashboard', desc: 'Monitor agents, costs, and system health' },
                  { label: 'Gateway', desc: 'Configure providers and sync models' },
                  { label: 'Agents', desc: 'Create, manage, backup, and restore agents' },
                  { label: 'Credentials', desc: 'Add GitHub, Trello, Vercel tokens' },
                ].map((r) => (
                  <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <CheckIcon size={14} />
                    <span style={{ fontWeight: 700, color: 'var(--text)' }}>{r.label}</span>
                    <span style={{ color: 'var(--text-dim)' }}>– {r.desc}</span>
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
