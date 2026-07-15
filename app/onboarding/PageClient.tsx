'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '../components/ui';
import { useOnboarding, type ProviderKeys } from './useOnboarding';
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

export default function OnboardingPageClient() {
  const router = useRouter();
  const {
    step, stepIndex, saving, progress, providerKeys,
    setProviderKeys, goNext, skip, goToStep, completeAll, restart,
  } = useOnboarding();

  const handleComplete = async () => {
    await completeAll();
    router.push('/');
    router.refresh();
  };

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
      <h2 className="onboarding-title">Welcome to Olympus</h2>
      <p className="onboarding-text">
        Olympus is the control center for your OpenClaw agent ecosystem.
        Create, monitor, and manage AI agents running as Docker containers
        on your VPS — all from one dashboard.
      </p>
      <div className="onboarding-feature-box">
        <Feature icon={<DockerIcon />} title="Agent Dashboard" desc="View all running agents, their status, ports, and resource usage at a glance." />
        <Feature icon={<GatewayIcon />} title="Provider Gateway" desc="Configure LLM providers once — every agent gets automatic access through the Olympus proxy." />
        <Feature icon={<AgentIcon />} title="One-Click Deploy" desc="Create new agents from templates with a single click. No Docker expertise needed." />
      </div>
      <div className="onboarding-actions">
        <span className="onboarding-meta">3 steps · ~2 minutes</span>
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
      <h2 className="onboarding-title">Configure Providers</h2>
      <p className="onboarding-text">
        Add API keys for the LLM providers you want to use. At least one is required
        to create working agents. Keys are stored securely and never logged.
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {providers.map((p) => (
          <div key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{p.label}</span>
              {p.recommended && <span className="onboarding-badge">RECOMMENDED</span>}
            </div>
            <input
              type="password"
              placeholder={p.placeholder}
              value={keys[p.key]}
              onChange={(e) => onChange((prev) => ({ ...prev, [p.key]: e.target.value }))}
              className="onboarding-input"
            />
          </div>
        ))}
      </div>
      <div className="onboarding-actions">
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
      <h2 className="onboarding-title">Your First Agent</h2>
      <p className="onboarding-text">
        Agents are independent Docker containers, each with their own workspace,
        memory, and personality. You can create them from the Agents page.
        Mark this step as done when you&apos;re ready to move on.
      </p>
      <div className="onboarding-feature-box" style={{ borderColor: 'rgba(96,165,250,0.15)', background: 'rgba(96,165,250,0.06)' }}>
        <Feature icon={<TemplateIcon />} title="Pick a template" desc="Each template gives your agent a different role and skill set (Prometheus, Argus, Atlas…)" />
        <Feature icon={<LinkIcon />} title="Get a URL" desc="Your agent gets its own port — access its Control UI from the dashboard." />
        <Feature icon={<ConfigIcon />} title="Automatic config" desc="Provider keys, gateway sync, and model selection are handled for you." />
      </div>
      <div className="onboarding-actions">
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
        <CheckCircleIcon size={48} color="var(--copper)" />
      </div>
      <h2 className="onboarding-title">You&apos;re All Set</h2>
      <p className="onboarding-text">
        Olympus is ready. Here&apos;s a quick map of the key sections:
      </p>
      <div className="onboarding-feature-box" style={{ borderColor: 'rgba(52,211,153,0.15)', background: 'rgba(52,211,153,0.06)', textAlign: 'left' }}>
        {routes.map((r) => (
          <div key={r.route} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <CheckIcon size={14} />
            <Link href={r.route} className="onboarding-link">{r.route}</Link>
            <span style={{ color: 'var(--text-dim)' }}>– {r.desc}</span>
          </div>
        ))}
      </div>
      <div className="onboarding-actions" style={{ justifyContent: 'center', gap: 12 }}>
        <div className="onboarding-done-actions">
          <Button variant="secondary" size="md" onClick={onRestart}>
            Restart Wizard
          </Button>
          <Button variant="primary" size="md" onClick={onComplete} loading={saving}>
            Start Using Olympus <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared sub-components ──────────────────────────────────────────────

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="onboarding-feature">
      <span className="onboarding-feature-icon">{icon}</span>
      <div>
        <div className="onboarding-feature-title">{title}</div>
        <div className="onboarding-feature-desc">{desc}</div>
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
    <div className="onboarding-outer">
      <div className="onboarding-card">
        {/* Header */}
        <div className="onboarding-header">
          <div className="onboarding-logo">OLYMPUS</div>

          {/* Step indicators — compact on mobile, full labels on desktop */}
          <div className="onboarding-stepper">
            {steps.map((s, i) => {
              const isPast = i < stepIndex;
              const isCurrent = i === stepIndex;
              const clickable = isPast || isCurrent;

              return (
                <div key={s.key} className="onboarding-step">
                  <button
                    onClick={() => clickable && onStepClick(i)}
                    disabled={!clickable}
                    title={s.label}
                    className={`onboarding-step-dot${isPast ? ' done' : ''}${isCurrent ? ' active' : ''}${clickable ? ' clickable' : ''}`}
                  />
                  {/* Full label — hidden on mobile */}
                  <span className={`onboarding-step-label${isCurrent ? ' current' : ''}`}>
                    {s.label}
                  </span>
                  {/* Mobile-only compact label */}
                  <span className={`onboarding-step-mobile${isCurrent ? ' current' : ''}`}>
                    {s.labelMobile}
                  </span>
                  {i < steps.length - 1 && <div className={`onboarding-step-line${isPast ? ' done' : ''}`} />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="onboarding-body">{children}</div>

        {/* Footer */}
        <div className="onboarding-footer">
          You can return to this wizard anytime from the sidebar.
        </div>
      </div>

      {/* Mobile-first CSS */}
      <style>{`
        /* ── Base (mobile-first) ── */
        .onboarding-outer {
          min-height: 100vh; min-height: 100dvh;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          background: radial-gradient(circle at top, rgba(212,155,53,0.10), transparent 36%), var(--bg);
          font-family: var(--font-mono-stack);
          padding: 0;
        }
        .onboarding-card {
          width: 100%;
          background: var(--bg);
          overflow: hidden;
        }
        .onboarding-header {
          padding: 12px 14px 8px;
          border-bottom: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .onboarding-logo {
          font-family: var(--font-serif-stack);
          font-size: 18px;
          letter-spacing: 2px;
          color: var(--copper);
        }
        .onboarding-body {
          padding: 12px 14px 14px;
        }
        .onboarding-footer {
          padding: 0 14px 12px;
          text-align: center;
          font-size: 9px;
          color: var(--text-dim);
        }

        /* ── Stepper: compact mobile, full desktop ── */
        .onboarding-stepper {
          display: flex;
          gap: 2px;
          align-items: center;
          max-width: 100%;
          overflow-x: auto;
          padding-bottom: 2px;
        }
        .onboarding-step {
          display: flex;
          align-items: center;
          gap: 3px;
          flex-shrink: 0;
        }
        .onboarding-step-dot {
          width: 8px; min-width: 8px; height: 8px;
          border-radius: 50%;
          background: var(--border);
          opacity: 0.35;
          border: none;
          padding: 0;
          cursor: default;
          transition: all 0.2s;
        }
        .onboarding-step-dot.done { background: var(--copper); opacity: 0.7; }
        .onboarding-step-dot.active { background: var(--copper); opacity: 1; box-shadow: 0 0 5px rgba(212,155,53,0.4); }
        .onboarding-step-dot.clickable { cursor: pointer; }
        .onboarding-step-label {
          display: none; /* hidden on mobile */
          font-size: 10px;
          color: var(--text-dim);
          letter-spacing: 0.05em;
          white-space: nowrap;
        }
        .onboarding-step-label.current { color: var(--copper); font-weight: 700; }
        .onboarding-step-mobile {
          font-size: 10px;
          color: var(--text-dim);
          white-space: nowrap;
          font-weight: 500;
        }
        .onboarding-step-mobile.current { color: var(--copper); font-weight: 700; }
        .onboarding-step-line {
          width: 10px; min-width: 10px; height: 1px;
          background: var(--border);
          opacity: 0.2;
        }
        .onboarding-step-line.done { opacity: 0.5; }

        /* Restart icon */
        .onboarding-restart {
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
        .onboarding-restart:hover { opacity: 1; color: var(--copper); }

        /* ── Shared element styles ── */
        .onboarding-title {
          font-family: var(--font-serif-stack);
          font-size: 22px;
          letter-spacing: 1.5px;
          color: var(--copper);
          margin: 0;
        }
        .onboarding-text {
          font-size: 12px;
          color: var(--text-dim);
          line-height: 1.6;
          margin: 0;
        }
        .onboarding-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 6px;
        }
        .onboarding-meta {
          font-size: 10px;
          color: var(--text-dim);
        }
        .onboarding-badge {
          font-size: 8px;
          background: rgba(212,155,53,0.15);
          color: var(--copper);
          padding: 1px 5px;
        }
        .onboarding-input {
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
        .onboarding-input:focus { border-color: var(--copper); }
        .onboarding-feature-box {
          display: grid;
          gap: 8px;
          padding: 10px 12px;
          background: rgba(212,155,53,0.06);
          border: 1px solid rgba(212,155,53,0.15);
        }
        .onboarding-feature {
          display: flex;
          gap: 8px;
          align-items: flex-start;
        }
        .onboarding-feature-icon {
          flex-shrink: 0;
          color: var(--copper);
          margin-top: 1px;
        }
        .onboarding-feature-title {
          font-size: 11px;
          font-weight: 700;
          color: var(--text);
        }
        .onboarding-feature-desc {
          font-size: 10px;
          color: var(--text-dim);
          line-height: 1.5;
        }
        .onboarding-link {
          color: #60a5fa;
          text-decoration: underline;
          font-weight: 700;
        }

        .onboarding-done-actions {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: 100%;
          align-items: center;
        }

        /* ── Desktop breakpoint ── */
        @media (min-width: 481px) {
          .onboarding-outer {
            align-items: center;
            padding: 24px;
          }
          .onboarding-card {
            width: min(92vw, 480px);
            background: linear-gradient(180deg, rgba(18,18,18,0.98), rgba(12,12,12,0.98));
            border: 1px solid var(--border);
            box-shadow: 0 24px 64px rgba(0,0,0,0.42);
          }
          .onboarding-header { padding: 18px 24px 14px; gap: 10px; }
          .onboarding-logo { font-size: 20px; letter-spacing: 3px; }
          .onboarding-body { padding: 20px 24px 24px; }
          .onboarding-footer { padding: 0 24px 16px; font-size: 10px; }

          .onboarding-stepper { gap: 6px; }
          .onboarding-step { gap: 6px; }
          .onboarding-step-dot { width: 10px; min-width: 10px; height: 10px; }
          .onboarding-step-label { display: inline; } /* show full labels */
          .onboarding-step-mobile { display: none; } /* hide compact labels */
          .onboarding-step-line { width: 18px; }
          .onboarding-restart { margin-left: 8px; }

          .onboarding-title { font-size: 22px; }
          .onboarding-text { font-size: 13px; }

          .onboarding-done-actions {
            flex-direction: row;
            width: auto;
          }
        }
      `}</style>
    </div>
  );
}
