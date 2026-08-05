'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '../components/ui';
import { useWizard, type ProviderKeys } from './useWizard';
import {
  ArrowRightIcon, CheckCircleIcon, CheckIcon,
  DockerIcon, GatewayIcon, AgentIcon,
  TemplateIcon, LinkIcon, ConfigIcon,
} from './icons';

// ─── Step order ─────────────────────────────────────────────────────────

const STEPS = [
  { key: 'welcome' as const,   labelMobile: '1', label: 'Welcome' },
  { key: 'providers' as const, labelMobile: '2', label: 'Providers' },
  { key: 'agents' as const,    labelMobile: '3', label: 'Agent' },
  { key: 'done' as const,      labelMobile: '✓', label: 'Ready' },
];

// ─── Main page ──────────────────────────────────────────────────────────

export default function WizardPageClient() {
  const router = useRouter();
  const {
    step, stepIndex, saving, complete, providerKeys,
    setProviderKeys, goNext, skip, goToStep, completeAll, restart, hydrated,
  } = useWizard();

  const handleComplete = async () => {
    await completeAll();
    router.push('/');
  };

  if (!hydrated) return null;

  return (
    <WizardFrame stepIndex={stepIndex} steps={STEPS} onStepClick={goToStep}>
      {step === 'welcome'   && <WelcomeStep onNext={goNext} />}
      {step === 'providers' && <ProvidersStep keys={providerKeys} onChange={setProviderKeys} onNext={goNext} onSkip={skip} saving={saving} />}
      {step === 'agents'    && <AgentsStep onNext={goNext} onSkip={skip} />}
      {step === 'done'      && <DoneStep onComplete={handleComplete} saving={saving} onRestart={restart} />}
    </WizardFrame>
  );
}

// ─── Step components ────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <h2 className="wizard-title">Welcome to Rev4a</h2>
      <p className="wizard-text">
        Rev4a is the control center for your OpenClaw agent ecosystem.
        Create, monitor, and manage AI agents running as Docker containers
        on your VPS — all from one dashboard.
      </p>
      <div className="wizard-feature-box">
        <Feature icon={<DockerIcon />} title="Agent Dashboard" desc="View all running agents, their status, ports, and resource usage at a glance." />
        <Feature icon={<GatewayIcon />} title="Provider Gateway" desc="Configure LLM providers once — every agent gets automatic access through the Rev4a proxy." />
        <Feature icon={<AgentIcon />} title="One-Click Deploy" desc="Create new agents from templates with a single click. No Docker expertise needed." />
      </div>
      <div className="wizard-actions">
        <span className="wizard-meta">3 steps · ~2 minutes</span>
        <Button variant="primary" size="md" onClick={onNext}>
          Get Started <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

function ProvidersStep({
  keys, onChange, onNext, onSkip, saving,
}: {
  keys: ProviderKeys;
  onChange: (fn: (prev: ProviderKeys) => ProviderKeys) => void;
  onNext: () => void;
  onSkip: () => void;
  saving: boolean;
}) {
  const providers = [
    { key: 'deepseek' as const, label: 'DeepSeek', placeholder: 'sk-...', recommended: true },
    { key: 'openai' as const, label: 'OpenAI', placeholder: 'sk-...', recommended: false },
    { key: 'openrouter' as const, label: 'OpenRouter', placeholder: 'sk-or-...', recommended: false },
    { key: 'groq' as const, label: 'Groq', placeholder: 'gsk_...', recommended: false },
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <h2 className="wizard-title">Configure Providers</h2>
      <p className="wizard-text">
        Add API keys for the LLM providers you want to use. At least one is required
        to create working agents. Keys are stored securely and never logged.
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {providers.map((p) => (
          <div key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{p.label}</span>
              {p.recommended && <span className="wizard-badge">RECOMMENDED</span>}
            </div>
            <input
              type="password"
              placeholder={p.placeholder}
              value={keys[p.key]}
              onChange={(e) => onChange((prev) => ({ ...prev, [p.key]: e.target.value }))}
              className="wizard-input"
            />
          </div>
        ))}
      </div>
      <div className="wizard-actions">
        <Button variant="ghost" size="sm" onClick={onSkip}>Skip for now</Button>
        <Button variant="primary" size="md" onClick={onNext} loading={saving}>
          Save &amp; Continue <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

function AgentsStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <h2 className="wizard-title">Your First Agent</h2>
      <p className="wizard-text">
        Agents are independent Docker containers, each with their own workspace,
        memory, and personality. You can create them from the Agents page.
        Mark this step as done when you&apos;re ready to move on.
      </p>
      <div className="wizard-feature-box" style={{ borderColor: 'rgba(96,165,250,0.15)', background: 'rgba(96,165,250,0.06)' }}>
        <Feature icon={<TemplateIcon />} title="Pick a template" desc="Each template gives your agent a different role and skill set (Prometheus, Argus, Atlas…)" />
        <Feature icon={<LinkIcon />} title="Get a URL" desc="Your agent gets its own port — access its Control UI from the dashboard." />
        <Feature icon={<ConfigIcon />} title="Automatic config" desc="Provider keys, gateway sync, and model selection are handled for you." />
      </div>
      <div className="wizard-actions">
        <Button variant="ghost" size="sm" onClick={onSkip}>Skip for now</Button>
        <Button variant="primary" size="md" onClick={onNext}>
          Done <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

function DoneStep({ onComplete, saving, onRestart }: { onComplete: () => void; saving: boolean; onRestart: () => void }) {
  const routes = [
    { route: '/agents', desc: 'Create and manage agents' },
    { route: '/gateway', desc: 'Configure providers and sync agent models' },
    { route: '/credentials', desc: 'Third-party credentials (GitHub, Trello, Vercel…)' },
    { route: '/config', desc: 'Environment variables and server restart' },
    { route: '/workspace', desc: 'Browse agent filesystems' },
  ];

  return (
    <div style={{ display: 'grid', gap: 14, textAlign: 'center' }}>
            <div style={{ margin: '0 auto', display: 'flex', justifyContent: 'center' }}>
        <CheckCircleIcon size={48} color="var(--violet)" />
      </div>
      <h2 className="wizard-title">You&apos;re All Set</h2>
      <p className="wizard-text">
        Rev4a is ready. Here&apos;s a quick map of the key sections:
      </p>
      <div className="wizard-feature-box" style={{ borderColor: 'rgba(52,211,153,0.15)', background: 'rgba(52,211,153,0.06)', textAlign: 'left' }}>
        {routes.map((r) => (
          <div key={r.route} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <CheckIcon size={14} />
            <Link href={r.route} className="wizard-link">{r.route}</Link>
            <span style={{ color: 'var(--text-dim)' }}>– {r.desc}</span>
          </div>
        ))}
      </div>
      <div className="wizard-actions" style={{ justifyContent: 'center', gap: 12 }}>
        <div className="wizard-done-actions">
          <Button variant="secondary" size="md" onClick={onRestart}>
            Restart Wizard
          </Button>
          <Button variant="primary" size="md" onClick={onComplete} loading={saving}>
            Start Using Rev4a <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared sub-components ──────────────────────────────────────────────

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="wizard-feature">
      <span className="wizard-feature-icon">{icon}</span>
      <div>
        <div className="wizard-feature-title">{title}</div>
        <div className="wizard-feature-desc">{desc}</div>
      </div>
    </div>
  );
}

// ─── Wizard shell ───────────────────────────────────────────────────────

function WizardFrame({
  stepIndex, steps, children, onStepClick,
}: {
  stepIndex: number;
  steps: { key: string; label: string; labelMobile: string }[];
  children: React.ReactNode;
  onStepClick: (index: number) => void;
}) {
  return (
    <div className="wizard-outer">
      <div className="wizard-card">
        {/* Header */}
        <div className="wizard-header">
          <div className="wizard-logo">REV4A</div>

          {/* Step indicators — compact on mobile, full labels on desktop */}
          <div className="wizard-stepper">
            {steps.map((s, i) => {
              const isPast = i < stepIndex;
              const isCurrent = i === stepIndex;
              const clickable = isPast || isCurrent;

              return (
                <div key={s.key} className="wizard-step">
                  <button
                    onClick={() => clickable && onStepClick(i)}
                    disabled={!clickable}
                    title={s.label}
                    className={`wizard-step-dot${isPast ? ' done' : ''}${isCurrent ? ' active' : ''}${clickable ? ' clickable' : ''}`}
                  />
                  {/* Full label — hidden on mobile */}
                  <span className={`wizard-step-label${isCurrent ? ' current' : ''}`}>
                    {s.label}
                  </span>
                  {/* Mobile-only compact label */}
                  <span className={`wizard-step-mobile${isCurrent ? ' current' : ''}`}>
                    {s.labelMobile}
                  </span>
                  {i < steps.length - 1 && <div className={`wizard-step-line${isPast ? ' done' : ''}`} />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="wizard-body">{children}</div>

        {/* Footer */}
        <div className="wizard-footer">
          You can return to this wizard anytime from the sidebar.
        </div>
      </div>

      {/* Mobile-first CSS */}
      <style>{`
        /* ── Base (mobile-first) ── */
        .wizard-outer {
          min-height: 100vh; min-height: 100dvh;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          background: radial-gradient(circle at top, rgba(167,139,250,0.10), transparent 36%), var(--bg);
          font-family: var(--font-mono-stack);
          padding: 0;
        }
        .wizard-card {
          width: 100%;
          background: var(--bg);
          overflow: hidden;
        }
        .wizard-header {
          padding: 12px 14px 8px;
          border-bottom: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .wizard-logo {
          font-family: var(--font-serif-stack);
          font-size: 18px;
          letter-spacing: 2px;
          color: var(--violet);
        }
        .wizard-body {
          padding: 12px 14px 14px;
        }
        .wizard-footer {
          padding: 0 14px 12px;
          text-align: center;
          font-size: 9px;
          color: var(--text-dim);
        }

        /* ── Stepper: compact mobile, full desktop ── */
        .wizard-stepper {
          display: flex;
          gap: 2px;
          align-items: center;
          max-width: 100%;
          overflow-x: auto;
          padding-bottom: 2px;
        }
        .wizard-step {
          display: flex;
          align-items: center;
          gap: 3px;
          flex-shrink: 0;
        }
        .wizard-step-dot {
          width: 8px; min-width: 8px; height: 8px;
          border-radius: 50%;
          background: var(--border);
          opacity: 0.35;
          border: none;
          padding: 0;
          cursor: default;
          transition: all 0.2s;
        }
        .wizard-step-dot.done { background: var(--violet); opacity: 0.7; }
        .wizard-step-dot.active { background: var(--violet); opacity: 1; box-shadow: 0 0 5px rgba(167,139,250,0.4); }
        .wizard-step-dot.clickable { cursor: pointer; }
        .wizard-step-label {
          display: none; /* hidden on mobile */
          font-size: 10px;
          color: var(--text-dim);
          letter-spacing: 0.05em;
          white-space: nowrap;
        }
        .wizard-step-label.current { color: var(--violet); font-weight: 700; }
        .wizard-step-mobile {
          font-size: 10px;
          color: var(--text-dim);
          white-space: nowrap;
          font-weight: 500;
        }
        .wizard-step-mobile.current { color: var(--violet); font-weight: 700; }
        .wizard-step-line {
          width: 10px; min-width: 10px; height: 1px;
          background: var(--border);
          opacity: 0.2;
        }
        .wizard-step-line.done { opacity: 0.5; }

        /* Restart icon */
        .wizard-restart {
          margin-left: 4px;
          background: none;
          border: none;
          color: var(--text-dim);
          cursor: pointer;
          padding: 2px;
          display: flex;
          align-items: center;
          opacity: 0.5;
          transition: opacity 0.2s;
          flex-shrink: 0;
        }
        .wizard-restart:hover { opacity: 1; color: var(--violet); }

        /* ── Shared element styles ── */
        .wizard-title {
          font-family: var(--font-serif-stack);
          font-size: 22px;
          letter-spacing: 1.5px;
          color: var(--violet);
          margin: 0;
        }
        .wizard-text {
          font-size: 12px;
          color: var(--text-dim);
          line-height: 1.6;
          margin: 0;
        }
        .wizard-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 6px;
        }
        .wizard-meta {
          font-size: 10px;
          color: var(--text-dim);
        }
        .wizard-badge {
          font-size: 8px;
          background: rgba(167,139,250,0.15);
          color: var(--violet);
          padding: 1px 5px;
        }
        .wizard-input {
          background: var(--bg);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 7px 10px;
          font-size: 11px;
          font-family: var(--font-mono-stack);
          outline: none;
          width: 100%;
          box-sizing: border-box;
        }
        .wizard-input:focus { border-color: var(--violet); }
        .wizard-feature-box {
          display: grid;
          gap: 8px;
          padding: 10px 12px;
          background: rgba(167,139,250,0.06);
          border: 1px solid rgba(167,139,250,0.15);
        }
        .wizard-feature {
          display: flex;
          gap: 8px;
          align-items: flex-start;
        }
        .wizard-feature-icon {
          flex-shrink: 0;
          color: var(--violet);
          margin-top: 1px;
        }
        .wizard-feature-title {
          font-size: 11px;
          font-weight: 700;
          color: var(--text);
        }
        .wizard-feature-desc {
          font-size: 10px;
          color: var(--text-dim);
          line-height: 1.5;
        }
        .wizard-link {
          color: #60a5fa;
          text-decoration: underline;
          font-weight: 700;
        }

        .wizard-done-actions {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: 100%;
          align-items: center;
        }

        /* ── Desktop breakpoint ── */
        @media (min-width: 481px) {
          .wizard-outer {
            align-items: center;
            padding: 24px;
          }
          .wizard-card {
            width: min(92vw, 480px);
            background: linear-gradient(180deg, rgba(18,18,18,0.98), rgba(12,12,12,0.98));
            border: 1px solid var(--border);
            box-shadow: 0 24px 64px rgba(0,0,0,0.42);
          }
          .wizard-header { padding: 18px 24px 14px; gap: 10px; }
          .wizard-logo { font-size: 20px; letter-spacing: 3px; }
          .wizard-body { padding: 20px 24px 24px; }
          .wizard-footer { padding: 0 24px 16px; font-size: 10px; }

          .wizard-stepper { gap: 6px; }
          .wizard-step { gap: 6px; }
          .wizard-step-dot { width: 10px; min-width: 10px; height: 10px; }
          .wizard-step-label { display: inline; } /* show full labels */
          .wizard-step-mobile { display: none; } /* hide compact labels */
          .wizard-step-line { width: 18px; }
          .wizard-restart { margin-left: 8px; }

          .wizard-title { font-size: 22px; }
          .wizard-text { font-size: 13px; }

          .wizard-done-actions {
            flex-direction: row;
            width: auto;
          }
        }
      `}</style>
    </div>
  );
}
