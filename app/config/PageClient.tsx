'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { updateCachedRev4aTimezone } from '@/lib/timezone';
import { apiFetch } from '@/lib/apiFetch';
import { Button, Input, MemoryLimitPicker, Page, PageHeader, Surface, Pill, Modal, useDockerTotalMb } from '../components/ui';
import PasswordInput from '../components/PasswordInput';

interface EnvVars {
  [key: string]: string;
}

const ENV_METADATA: Record<
  string,
  { label: string; description: string; placeholder: string; sensitive?: boolean }
> = {
  REV4A_PASSWORD: {
    label: 'Login password',
    description: 'Password used to access the Rev4a dashboard',
    placeholder: 'Dashboard password',
    sensitive: true,
  },
  REV4A_TOKEN: {
    label: 'Internal Auth Token',
    description: 'Token for internal API authentication (skills API, JWT fallback)',
    placeholder: 'Internal auth token',
    sensitive: true,
  },
  REV4A_API_KEY: {
    label: 'Rev4a API Key',
    description: 'Master key for provider gateway — agents use this to authenticate when calling Rev4a as an LLM provider. Synced to Gateway.',
    placeholder: 'Gateway master key',
    sensitive: true,
  },
  REV4A_JWT_SECRET: {
    label: 'JWT Secret',
    description: 'Secret used to sign session JWT cookies for dashboard authentication',
    placeholder: 'At least 32 characters',
    sensitive: true,
  },
};

type SaveStatus = 'idle' | 'saving' | 'ok' | 'error';

export default function ConfigPageClient() {
  const [env, setEnv] = useState<EnvVars>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'save' | 'restart' | null>(null);

  const loadEnv = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/config/env');
      const data = await res.json();
      if (data.env) setEnv(data.env);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEnv();
  }, [loadEnv]);

  const handleChange = (key: string, value: string) => {
    setEnv((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setStatus('saving');
    setStatusMsg('');
    try {
      const res = await fetch('/api/config/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env }),
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setStatus('ok');
        setStatusMsg('Environment variables saved. Restart Rev4a to apply them.');
      } else {
        setStatus('error');
        setStatusMsg(data.error || 'Error');
      }
    } catch (e: unknown) {
      setStatus('error');
      setStatusMsg(e instanceof Error ? e.message : 'Network error');
    }
  };



  // Sort keys: sensitive first, then alphabetical
  const sortedKeys = Object.entries(ENV_METADATA).sort(([, a], [, b]) => {
    if (a.sensitive && !b.sensitive) return -1;
    if (!a.sensitive && b.sensitive) return 1;
    return a.label.localeCompare(b.label);
  });

  return (
    <Page maxWidth={900}>
      <PageHeader
        eyebrow=""
        title="Configuration"
        description="Environment variables. Values are visible only to you."
      />

      {loading ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <Surface key={i}>
              <div
                style={{
                  height: 18,
                  background: 'rgba(255,255,255,0.04)',
                  borderRadius: 0,
                  marginBottom: 8,
                  width: '40%',
                }}
              />
              <div
                style={{
                  height: 40,
                  background: 'rgba(255,255,255,0.04)',
                  borderRadius: 0,
                }}
              />
            </Surface>
          ))}
        </div>
      ) : (
        <>
          <section style={{ display: 'grid', gap: 16, marginBottom: 20 }}>
            {sortedKeys.map(([key, meta]) => {
              const value = env[key] || '';
              return (
                <Surface key={key} variant="panel">
                  <div style={{ padding: '14px 16px', display: 'grid', gap: 8 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <label
                        style={{
                          fontWeight: 600,
                          fontSize: 13,
                          letterSpacing: '0.02em',
                        }}
                      >
                        {meta.label}
                      </label>
                      {meta.sensitive && <Pill tone="warning">Secret key</Pill>}
                      <code
                        style={{
                          fontSize: 10,
                          color: 'var(--text-dim)',
                          background: 'rgba(255,255,255,0.04)',
                          padding: '2px 6px',
                          borderRadius: 0,
                        }}
                      >
                        {key}
                      </code>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                      {meta.description}
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {meta.sensitive ? (
                        <PasswordInput
                          value={value}
                          onChange={(v) => handleChange(key, v)}
                          placeholder={meta.placeholder}
                          style={{ flex: 1 }}
                          showGenerate
                        />
                      ) : (
                        <div style={{ flex: 1 }}>
                          <Input
                            value={value}
                            onChange={(e) => handleChange(key, e.target.value)}
                            placeholder={meta.placeholder}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </Surface>
              );
            })}
          </section>

          <AgentDefaults />
          <TimezoneSettings />

          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              marginBottom: 20,
            }}
          >
            <Button
              variant="primary"
              size="md"
              loading={restarting}
              onClick={() => setConfirmAction('restart')}
            >
              {restarting ? 'Restarting...' : 'Save & Restart'}
            </Button>
          </div>

          {/* Confirm modal */}
          <Modal
            open={confirmAction !== null}
            onClose={() => setConfirmAction(null)}
            title={confirmAction === 'restart' ? 'Restart Rev4a' : 'Save configuration'}
          >
            <div style={{ display: 'grid', gap: 14 }}>
              <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5, margin: 0 }}>
                {confirmAction === 'restart'
                  ? 'This will save the current environment variables and restart the Rev4a server immediately. The dashboard will be unavailable for a few seconds.'
                  : 'Save the current environment variables. Changes will take effect after a restart.'}
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <Button variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={status === 'saving'}
                  onClick={async () => {
                    setStatus('saving');
                    setStatusMsg('');
                    try {
                      const saveRes = await fetch('/api/config/env', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ env }),
                      });
                      const saveData = await saveRes.json();
                      if (saveData.status !== 'ok') {
                        setStatus('error');
                        setStatusMsg(saveData.error || 'Save error');
                        setStatus('idle');
                        setConfirmAction(null);
                        return;
                      }
                      setStatus('ok');
                      setStatusMsg('Environment variables saved.');
                      if (confirmAction === 'restart') {
                        setRestarting(true);
                        await fetch('/api/config/restart', { method: 'POST' });
                        setTimeout(() => {
                          setRestarting(false);
                          setStatus('idle');
                          setStatusMsg('');
                        }, 4000);
                      }
                      setConfirmAction(null);
                    } catch {
                      setStatus('error');
                      setStatusMsg('Network error');
                      setStatus('idle');
                      setConfirmAction(null);
                    }
                  }}
                >
                  {confirmAction === 'restart' ? 'Save & Restart' : 'Save'}
                </Button>
              </div>
            </div>
          </Modal>
        </>
      )}
    </Page>
  );
}

/**
 * "Agent defaults": the memory limit the create wizard starts with. Empty by default and
 * only a prefill for new agents: no agent that exists is ever changed from here.
 * Saved on its own (GET/PUT /api/agent-defaults), not with the environment variables.
 */
function AgentDefaults() {
  // The default in MB (null for none), what is saved, and the picker's error text.
  const [value, setValue] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [pickError, setPickError] = useState('');
  const dockerTotalMb = useDockerTotalMb();
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const savingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    apiFetch('/api/agent-defaults', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Error ${res.status}`);
        return res.json();
      })
      .then((body: { memoryLimitMb?: number | null }) => {
        const v = body?.memoryLimitMb ? body.memoryLimitMb : null;
        setValue(v);
        setSaved(v);
        setLoaded(true);
        setMessage(null);
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setMessage({ ok: false, text: 'Could not load the agent defaults' });
      });
    return () => controller.abort();
  }, []);

  const parseError = pickError;

  const save = async () => {
    if (savingRef.current || parseError) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/agent-defaults', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoryLimitMb: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      const v = body.memoryLimitMb ? (body.memoryLimitMb as number) : null;
      setValue(v);
      setPickError('');
      setSaved(v);
      setMessage({ ok: true, text: 'Saved' });
    } catch (e: unknown) {
      setMessage({ ok: false, text: (e as Error).message || 'Could not save' });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Surface variant="panel">
      <div style={{ padding: '14px 16px', display: 'grid', gap: 8, marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, letterSpacing: '0.02em' }}>Agent defaults</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>
          No limit by default. This only prefills the memory limit when you create a new agent: it never changes an agent that exists.
        </div>
        {loaded && (
          <MemoryLimitPicker
            label="Default memory limit for new agents"
            value={saved}
            dockerTotalMb={dockerTotalMb}
            disabled={saving}
            onChange={(mb, error) => { setValue(mb); setPickError(error); setMessage(null); }}
          />
        )}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Button type="button" variant="primary" size="sm" loading={saving} disabled={!loaded || !!parseError || value === saved} onClick={save}>
            {saving ? 'Saving…' : 'Save default'}
          </Button>
          {message && <span style={{ fontSize: 12, color: message.ok ? 'var(--green)' : 'var(--red)' }}>{message.text}</span>}
        </div>
      </div>
    </Surface>
  );
}

/** Zone names for the datalist: this browser's list plus UTC. The server has the last word. */
function browserTimezones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
    return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    return ['UTC'];
  }
}

/**
 * "Time zone": the zone every page of the dashboard shows times in. Until one is saved it is the
 * server's own zone. Saved on its own (GET/PUT /api/settings), not with the environment variables.
 */
function TimezoneSettings() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<{ timezone: string; source: 'saved' | 'env' | 'server' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const savingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const zones = useMemo(browserTimezones, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    apiFetch('/api/settings', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Error ${res.status}`);
        return res.json();
      })
      .then((body: { timezone?: string; source?: 'saved' | 'env' | 'server' }) => {
        const timezone = body?.timezone || 'UTC';
        const source = body?.source === 'saved' ? 'saved' : body?.source === 'env' ? 'env' : 'server';
        setSaved({ timezone, source });
        setValue(source === 'saved' ? timezone : '');
        setMessage(null);
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setMessage({ ok: false, text: 'Could not load the time zone' });
      });
    return () => controller.abort();
  }, []);

  const trimmed = value.trim();
  const unchanged = !saved || trimmed === '' || (saved.source === 'saved' && trimmed === saved.timezone);

  const save = async () => {
    if (savingRef.current || unchanged) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: trimmed }),
        signal: abortRef.current?.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      updateCachedRev4aTimezone(body.timezone);
      setSaved({ timezone: body.timezone, source: 'saved' });
      setValue(body.timezone);
      setMessage({ ok: true, text: 'Saved' });
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') setMessage({ ok: false, text: (e as Error).message || 'Could not save' });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reset = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: null }),
        signal: abortRef.current?.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
      updateCachedRev4aTimezone(body.timezone);
      setSaved({ timezone: body.timezone, source: body.source === 'env' ? 'env' : 'server' });
      setValue('');
      setMessage({ ok: true, text: 'Using the server default' });
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') setMessage({ ok: false, text: (e as Error).message || 'Could not reset' });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Surface variant="panel">
      <div style={{ padding: '14px 16px', display: 'grid', gap: 8, marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, letterSpacing: '0.02em' }}>Time zone</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>
          The zone the dashboard shows times in (Costs, System, Crons, Memory and the header clock). Until you save one it follows the server.
        </div>
        <Input
          label="Time zone"
          list="rev4a-timezones"
          value={value}
          placeholder={saved ? (saved.source === 'saved' ? 'Time zone' : `Server default (${saved.timezone})`) : 'Loading…'}
          disabled={!saved || saving}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => { setValue(e.target.value); setMessage(null); }}
        />
        <datalist id="rev4a-timezones">
          {zones.map((z) => <option key={z} value={z} />)}
        </datalist>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Button type="button" variant="primary" size="sm" loading={saving} disabled={unchanged} onClick={save}>
            {saving ? 'Saving…' : 'Save time zone'}
          </Button>
          {saved?.source === 'saved' && (
            <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={reset}>
              Use server default
            </Button>
          )}
          {message && <span style={{ fontSize: 12, color: message.ok ? 'var(--green)' : 'var(--red)' }}>{message.text}</span>}
        </div>
      </div>
    </Surface>
  );
}
