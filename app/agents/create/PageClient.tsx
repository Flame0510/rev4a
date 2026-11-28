'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, MemoryLimitPicker, Surface, TemplateOption, useDockerTotalMb } from '../../components/ui';
import { OpenControlUiButton, useControlUiPublicUrl } from '../BrowserAccessSection';
import { findAvailablePortBlock, validatePortInput } from '@/lib/agent-ports';
import { gb, memoryLimitPolicyError } from '@/lib/agent-resource-policy';
import type { AgentResourcePreview } from '@/lib/agent-resource-preflight';

interface TemplateInfo {
  id: string;
  files: string[];
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface Props {
  templates: TemplateInfo[];
  models: ModelInfo[];
  usedNames: string[];
  usedPorts: number[];
  /** The global default (Configuration page): only prefills the memory limit field. */
  defaultMemoryLimitMb?: number | null;
  openclawVersion: string | null;
}

type Step = 'template' | 'config' | 'creating' | 'done' | 'error';

const REV4A_PORT = 3740;


// ─── Toast ───
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      padding: '12px 20px', borderRadius: 0, fontSize: 13,
      background: type === 'success' ? '#1a3a1a' : '#3a1a1a',
      border: `1px solid ${type === 'success' ? '#22c55e' : '#ef4444'}`,
      color: type === 'success' ? '#bbf7d0' : '#fecaca',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      animation: 'fadeIn 0.3s ease',
      maxWidth: 400,
    }}>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      {type === 'success' ? '✓ ' : '✗ '}{message}
    </div>
  );
}

export default function CreatePageClient({ templates, models, usedNames, usedPorts: initialUsedPorts, defaultMemoryLimitMb = null, openclawVersion }: Props) {
  const router = useRouter();

  const [step, setStep] = useState<Step>('template');
  // The create response is not streamed: after 60 s of waiting, say the start is slow, not stuck.
  const [slowCreate, setSlowCreate] = useState(false);
  useEffect(() => {
    if (step !== 'creating') { setSlowCreate(false); return; }
    const t = setTimeout(() => setSlowCreate(true), 60_000);
    return () => clearTimeout(t);
  }, [step]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [agentName, setAgentName] = useState('');
  const [portRange, setPortRange] = useState<string>('');
  // null means no limit. The picker opens on the global default, which is none unless set.
  const [memoryLimitMb, setMemoryLimitMb] = useState<number | null>(defaultMemoryLimitMb ?? null);
  const [memoryError, setMemoryError] = useState('');
  const dockerTotalMb = useDockerTotalMb();
  const [memoryCheck, setMemoryCheck] = useState<AgentResourcePreview | null>(null);
  const [checkingMemory, setCheckingMemory] = useState<'automatic' | 'retry' | null>('automatic');
  const [checkNonce, setCheckNonce] = useState(0);
  const memoryCheckAbort = useRef<AbortController | null>(null);
  const checkMemory = useCallback(async (limitMb: number | null, signal: AbortSignal) => {
    if (signal.aborted) return;
    const query = limitMb === null ? '' : `?limitMb=${limitMb}`;
    const checkError = 'Could not check Docker memory. Try again later.';
    try {
      const response = await fetch(`/api/agents/create/resources${query}`, { signal, cache: 'no-store' });
      const data: AgentResourcePreview | null = await response.json();
      if (signal.aborted) return;
      const validSuccess = data?.ok === true && Number.isFinite(data.breakdown?.requiredMb)
        && Number.isFinite(data.breakdown?.dockerTotalMb);
      if (response.ok && (data?.ok === false || validSuccess)) {
        setMemoryCheck(data);
      } else {
        setMemoryCheck({ ok: false, code: 'request-failed', error: (data?.ok === false && data.error) || checkError });
      }
    } catch (error) {
      if (!signal.aborted && (error as Error).name !== 'AbortError') {
        setMemoryCheck({ ok: false, code: 'request-failed', error: checkError });
      }
    } finally {
      if (!signal.aborted) setCheckingMemory(null);
    }
  }, []);

  useEffect(() => {
    if (memoryError) {
      setMemoryCheck(null);
      return;
    }
    const controller = new AbortController();
    memoryCheckAbort.current = controller;
    setCheckingMemory('automatic');
    const timer = setTimeout(() => void checkMemory(memoryLimitMb, controller.signal), 400);
    return () => {
      clearTimeout(timer);
      memoryCheckAbort.current?.abort();
    };
  }, [checkMemory, memoryLimitMb, memoryError, checkNonce]);

  const checkMemoryAgain = () => {
    memoryCheckAbort.current?.abort();
    const controller = new AbortController();
    memoryCheckAbort.current = controller;
    setCheckingMemory('retry');
    void checkMemory(memoryLimitMb, controller.signal);
  };

  const memoryRefusal = memoryCheck?.ok === false && memoryCheck.code === 'insufficient-host' ? memoryCheck.breakdown : undefined;
  // The picker remounts when the step is revisited and opens on the chosen size (none if it was invalid): drop the stale error.
  useEffect(() => { if (step !== 'config') setMemoryError(''); }, [step]);
  // The server render seeds this; the same endpoint the Edit panel uses refreshes it, so
  // both flows validate against the same numbers (every container, running or stopped).
  const [usedPorts, setUsedPorts] = useState<number[]>(initialUsedPorts);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/agents/ports', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ports?: number[] } | null) => {
        if (data && Array.isArray(data.ports)) setUsedPorts(data.ports);
      })
      .catch(() => { /* the server still validates on submit */ });
    return () => controller.abort();
  }, []);
  const [selectedModel, setSelectedModel] = useState<string>(
    models.length > 0 ? models[0].id : ''
  );
  const [fallbacks] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState<{ containerName: string; displayName: string; containerId: string; port: number; noModel: boolean } | null>(null);
  const publicUrl = useControlUiPublicUrl(result?.noModel ? undefined : result?.containerName);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplate(id);
    setAgentName('');
    // Auto-assign port block: find first free 10-port block
    if (usedPorts.length === 0) {
      setPortRange('3700-3709');
    } else {
      // Same block finder as the server: the first free 10-port block.
      const block = findAvailablePortBlock(new Set(usedPorts));
      setPortRange(block ? `${block}-${block + 9}` : '');
    }
  };

  const nameError = useMemo(() => {
    if (!agentName) return '';
    if (agentName.length > 128) return 'Name too long (max 128 chars)';
    if (usedNames.includes(agentName)) return 'Name is already in use by another agent';
    return '';
  }, [agentName, usedNames]);

  const portError = useMemo(() => {
    if (!portRange.trim()) return '';
    const res = validatePortInput(portRange, new Set(usedPorts));
    return res.valid ? '' : res.error;
  }, [portRange, usedPorts]);

  const canProceed = (): boolean => {
    if (step === 'template') return selectedTemplate !== '';
    if (step === 'config') return agentName.length > 0 && !nameError && !portError && !memoryError && !memoryLimitPolicyError(openclawVersion, memoryLimitMb);
    return false;
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setStep('creating');
    setErrorMsg('');

    try {
      const body: Record<string, unknown> = {
        name: agentName,
        template: selectedTemplate,
      };
      if (portRange.trim()) body.portRange = portRange.trim();
      if (models.length === 0) {
        body.noModel = true;
      } else {
        if (selectedModel) body.model = selectedModel;
        if (fallbacks.length > 0) body.fallbacks = fallbacks;
      }
      if (memoryLimitMb !== null) body.memoryLimitMb = memoryLimitMb;

      const res = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        if (res.status === 409 && data.resources) {
          memoryCheckAbort.current?.abort();
          setCheckingMemory(null);
          setMemoryCheck({ ok: false, code: data.code, error: data.error, breakdown: data.resources });
          setStep('config');
          setSubmitting(false);
          return;
        }
        setErrorMsg(data.error || 'Unknown error');
        setStep('error');
        setSubmitting(false);
        return;
      }

      setSubmitting(false);
      setResult(data);
      setStep('done');
      setToast({ message: `Agent "${agentName}" deployed successfully`, type: 'success' });
    } catch (e: unknown) {
      setErrorMsg((e as Error).message || 'Network error');
      setStep('error');
    }
  };

  // Template description helper
  const templateDescription = (id: string): string => {
    const descs: Record<string, string> = {
      atlas: 'General-purpose agent. Trello discipline, code review, git workflow.',
      argus: 'Security & audit agent. Strict protocol, delegation, lineage tracking.',
      prometheus: 'Client-facing agent. Project delivery, repo discipline, documentation.',
      custom: 'Blank slate. No preset identity — the agent will introduce itself and you define everything together.',
    };
    return descs[id] || 'Custom agent template';
  };

  return (
    <div style={{ minHeight: '100dvh', overflowY: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 72, boxSizing: 'border-box' }}>
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <h1 style={{ fontSize: 20, fontWeight: 500, marginBottom: 24, color: 'var(--violet)' }}>
        Create Agent
      </h1>

      {/* ─── Step: Template ─── */}
      {step === 'template' && (
        <div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 16, letterSpacing: '0.05em' }}>
            STEP 1 OF 2 &middot; SELECT TEMPLATE
          </div>

          {/* ── Custom: blank slate ── */}
          <div style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase',
              letterSpacing: '0.08em', marginBottom: 8,
            }}>
              Start from scratch
            </div>
            <button
              type="button"
              onClick={() => handleSelectTemplate('custom')}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                width: '100%',
                padding: '16px',
                textAlign: 'left',
                fontSize: 14,
                fontFamily: 'var(--font-mono-stack)',
                color: 'var(--text)',
                cursor: 'pointer',
                outline: 'none',
                transition: 'background 0.1s, border-color 0.1s',
                background: selectedTemplate === 'custom' ? 'var(--violet-bg)' : 'transparent',
                border: `1px solid ${selectedTemplate === 'custom' ? 'var(--violet)' : 'var(--border)'}`,
              }}
            >
              <span style={{
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: selectedTemplate === 'custom' ? 'var(--violet)' : 'var(--border)',
                color: selectedTemplate === 'custom' ? '#111' : '#666',
                fontSize: 14,
                fontWeight: 600,
                flexShrink: 0,
              }}>
                +
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>Custom Agent</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                  Blank slate. No preset identity &mdash; the agent will introduce itself and you define everything together.
                </div>
              </div>
            </button>
          </div>

          {/* ── Pre-built templates ── */}
          <div style={{
            fontSize: 10, color: '#888', textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 8,
          }}>
            Pre-built templates
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {templates.filter(t => t.id !== 'custom').map((t) => (
              <TemplateOption
                key={t.id}
                id={t.id}
                selected={selectedTemplate === t.id}
                description={templateDescription(t.id)}
                onClick={() => handleSelectTemplate(t.id)}
                badge={undefined}
              />
            ))}
          </div>

          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
            <Button variant="ghost" size="md" onClick={() => router.push('/agents')}>
              Cancel
            </Button>
            <Button variant="primary" size="md" onClick={() => setStep('config')} disabled={!canProceed()}>
              Next
            </Button>
          </div>
        </div>
      )}

      {/* ─── Step: Config ─── */}
      {step === 'config' && (
        <div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 16, letterSpacing: '0.05em' }}>
            STEP 2 OF 2 &middot; CONFIGURE AGENT
          </div>

          {/* Name */}
          <div style={{ marginBottom: 16 }}>
            <Input
              label="Agent Name"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="My Agent 🤖"
              error={nameError}
            />
          </div>

          {/* Template info */}
          <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 0, padding: '10px 14px', background: 'var(--bg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>TEMPLATE</div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{selectedTemplate}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setStep('template')}>
                Change
              </Button>
            </div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>{templateDescription(selectedTemplate)}</div>
          </div>

          {/* Port */}
          <div style={{ marginBottom: 16 }}>
            <Input
              label="Host Port"
              value={portRange}
              onChange={(e) => setPortRange(e.target.value.replace(/[^0-9-]/g, '').slice(0, 11))}
              placeholder="3700-3709"
              error={portError}
            />
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
              Port range (e.g. 3700-3709) or single port (e.g. 3700). Default: 10-port block. Port 3740 is reserved.
            </div>
          </div>

          {/* Memory limit */}
          <div style={{ marginBottom: 16 }}>
            <MemoryLimitPicker
              value={memoryLimitMb}
              dockerTotalMb={dockerTotalMb}
              openclawVersion={openclawVersion}
              enforceVersionFloor
              onChange={(mb, error) => { setMemoryLimitMb(mb); setMemoryError(error); }}
            />
          </div>

          <section aria-labelledby="create-memory-check" className="ui-text-small" style={{ marginBottom: 16, overflowWrap: 'anywhere' }}>
            <div id="create-memory-check" style={{ marginBottom: 6 }}>Memory check</div>
            <div aria-live="polite">
              {memoryError && <div className="ui-muted">Fix the memory limit to check memory.</div>}
              {!memoryError && checkingMemory && <div className="ui-muted">Checking memory…</div>}
              {!memoryError && checkingMemory !== 'automatic' && memoryCheck && (
                memoryCheck.ok ? (
                  <div className="ui-muted">
                    Memory: needs {gb(memoryCheck.breakdown.requiredMb, false)} of {gb(memoryCheck.breakdown.dockerTotalMb)} available in Docker.
                  </div>
                ) : memoryRefusal ? (
                  <Surface tone="danger" compact>
                    <div>{memoryCheck.error}</div>
                    <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                      <li>New agent · {gb(memoryRefusal.target.reserveMb)}</li>
                      {memoryRefusal.others.map((entry, index) => (
                        <li key={index}>
                          {entry.name || entry.agentId || 'Container'} · {gb(entry.reservedMb)}
                          {entry.basis === 'claim' && ' (in-flight reservation)'}
                        </li>
                      ))}
                      <li>Kept free · {gb(memoryRefusal.headroomMb)}</li>
                      <li>Total · {gb(memoryRefusal.requiredMb)} needed of {gb(memoryRefusal.dockerTotalMb)} available in Docker</li>
                    </ul>
                    <Button type="button" size="sm" onClick={checkMemoryAgain} loading={checkingMemory === 'retry'}>
                      {checkingMemory === 'retry' ? 'Checking…' : 'Check again'}
                    </Button>
                  </Surface>
                ) : (
                  <div className="ui-muted">Memory check unavailable: {memoryCheck.error}</div>
                )
              )}
            </div>
          </section>

          {/* Model */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 6 }}>Model (optional)</label>
            {models.length === 0 ? (
              <Surface compact>
                No model available yet. After creating the agent, connect your ChatGPT or Claude subscription, or add an API key in the Gateway.
              </Surface>
            ) : (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 0, border: '1px solid var(--border)',
                  background: 'var(--bg)', color: 'var(--text)', fontSize: 14, outline: 'none',
                }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.provider})</option>
                ))}
              </select>
            )}
          </div>

          {/* Buttons */}
          <div style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'space-between' }}>
            <Button variant="ghost" size="md" onClick={() => setStep('template')}>
              Back
            </Button>
            <Button variant="primary" size="md" onClick={handleSubmit} disabled={!canProceed() || submitting} loading={submitting}>
              Deploy Agent
            </Button>
          </div>
        </div>
      )}

      {/* ─── Step: Creating ─── */}
      {step === 'creating' && (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 16 }}>Creating agent container...</div>
          {slowCreate && (
            <div style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
              Still starting: the first start can take a few minutes (up to 5 when the agent image runs emulated on this machine).
            </div>
          )}
          <div style={{
            width: 32, height: 32, border: '2px solid var(--border)', borderTopColor: 'var(--violet)',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ─── Step: Done ─── */}
      {step === 'done' && result && (
        <div>
          <div style={{
            border: '1px solid #22c55e', borderRadius: 0, padding: 20, background: 'rgba(34,197,94,0.06)', marginBottom: 20,
          }}>
            <div style={{ color: '#22c55e', fontSize: 16, fontWeight: 500, marginBottom: 8 }}>✓ Agent deployed</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>
              Container: <span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono-stack)' }}>{result.containerId}</span>
            </div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>
              Name: <span style={{ color: 'var(--text)' }}>{result.displayName || result.containerName}</span>
            </div>
            <div style={{ marginTop: 8 }}>
              {result.noModel ? (
                <Button type="button" variant="primary" onClick={() => router.push(`/agents?agent=${encodeURIComponent(result.containerName)}&setup=1`)}>
                  Set up the model
                </Button>
              ) : (
                <OpenControlUiButton agentId={result.containerName} publicUrl={publicUrl} label="Open Control UI ↗" />
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Button variant="ghost" size="md" onClick={() => { setToast(null); router.push('/agents'); }} style={{ flex: 1 }}>
              View All Agents
            </Button>
            <Button variant="primary" size="md" onClick={() => {
              memoryCheckAbort.current?.abort();
              setMemoryCheck(null);
              setCheckingMemory('automatic');
              setCheckNonce((nonce) => nonce + 1);
              setToast(null);
              setStep('template');
              setSelectedTemplate('');
              setAgentName('');
              setPortRange('');
              setSelectedModel('');
              setResult(null);
            }} style={{ flex: 1 }}>
              Create Another
            </Button>
          </div>
        </div>
      )}

      {/* ─── Step: Error ─── */}
      {step === 'error' && (
        <div>
          <div style={{
            border: '1px solid #ef4444', borderRadius: 0, padding: 20, background: 'rgba(239,68,68,0.06)', marginBottom: 20,
          }}>
            <div style={{ color: '#ef4444', fontSize: 16, fontWeight: 500, marginBottom: 8 }}>Failed to create agent</div>
            <div style={{ fontSize: 13, color: '#f87171', fontFamily: 'var(--font-mono-stack)', wordBreak: 'break-word' }}>
              {errorMsg}
            </div>
          </div>
          <Button variant="ghost" size="md" onClick={() => setStep('config')}>
            Back to Config
          </Button>
        </div>
      )}
    </div>
    </div>
  );
}
