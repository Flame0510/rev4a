'use client';

/**
 * Model section of the agent detail panel.
 *
 * Primary model and fallbacks used to live on the Gateway page, which mixed two
 * unrelated jobs: provider keys and catalogue (system configuration) and
 * per-agent model assignment (one agent's configuration). This is the second.
 *
 * Fallbacks matter more than they look. The create wizard has never set them: it
 * holds `const [fallbacks] = useState<string[]>([])` and nothing writes to that
 * state. The only UI that could was the Gateway Agents tab this panel replaced,
 * and in practice no agent carries any. When a
 * model is disabled on the Gateway page while some agent still has it as
 * primary, that agent has nothing to fall back to and goes silent on its next
 * turn. This panel surfaces exactly that condition.
 *
 * `agents` is in OpenClaw's no-restart column, so saving applies immediately
 * with no container restart.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, RemoveButton, Select } from '../components/ui';
import SubscriptionLine, { type SubscriptionStatus } from './SubscriptionLine';

interface ModelOption {
  id: string;
  label: string;
  input: number | null;
  output: number | null;
  /** Upstream retired the name. It still answers, so this warns rather than blocks. */
  deprecated: boolean;
}

interface SubModel { key: string; name: string; contextWindow: number | null }

interface ProviderGroup {
  provider: string;
  emoji: string;
  models: ModelOption[];
}

interface AgentModel {
  reachable: boolean;
  primary: string | null;
  fallbacks: string[];
  resolvable: boolean | null;
  catalogueSize?: number;
  /** Server-side cause for a failing primary; absent on the unreachable branch. */
  primaryStatus?: 'offered' | 'disabled' | 'missing' | null;
}

/**
 * The form of a stored model reference used in this panel: the `rev4a/` prefix is stripped for
 * comparison with catalogue ids. A bare `openai/<id>` is a ChatGPT subscription model (see
 * lib/subscriptions.ts), not the Rev4a catalogue entry of the same name (stored as
 * `rev4a/openai/<id>`), so it carries the `subscription:` mark, which PUT /api/gateway/agent
 * understands and strips.
 */
const SUB_MARK = 'subscription:';
/** The character set PUT /api/gateway/agent accepts for a marked subscription reference. */
const SUB_MODEL_ID = /^[A-Za-z0-9._-]+$/;
const bare = (id: string) =>
  id.startsWith('rev4a/')
    ? id.slice('rev4a/'.length)
    : id.startsWith('openai/') && SUB_MODEL_ID.test(id.slice('openai/'.length))
      ? SUB_MARK + id
      : id;
const isSub = (id: string) => id.startsWith(SUB_MARK);
const shown = (id: string) => (isSub(id) ? id.slice(SUB_MARK.length) : id);

function priceLabel(m: ModelOption): string {
  if (m.input === null && m.output === null) return '';
  const fmt = (n: number | null) => (n === null ? '?' : `$${n}`);
  return `  ·  ${fmt(m.input)} / ${fmt(m.output)} per 1M`;
}

/**
 * A deprecated model is still selectable — it works — but picking one by accident
 * is exactly how an agent ends up on a name upstream no longer honours. The tag
 * sits next to the name it qualifies, not at the head of the row, so the
 * provider grouping stays scannable.
 */
function optionLabel(m: ModelOption): string {
  return `${m.label}${m.deprecated ? ' (deprecated)' : ''}${priceLabel(m)}`;
}

export default function ModelSection({
  agentId,
  onSaved,
  agentBusy,
}: {
  agentId: string;
  /** Called after a successful save so the agent list can refresh its chip. */
  onSaved?: () => void;
  /** A long operation is running on this agent: saving would race it. */
  agentBusy?: boolean;
}) {
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [current, setCurrent] = useState<AgentModel | null>(null);
  const [primary, setPrimary] = useState<string>('');
  const [fallbacks, setFallbacks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subModels, setSubModels] = useState<SubModel[] | null>(null);
  const [subKey, setSubKey] = useState(0);
  /** The previous primary, pre-filled as the first fallback when a subscription model was just chosen. */
  const [autoFallback, setAutoFallback] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const subAbortRef = useRef<AbortController | null>(null);
  const modelsAbortRef = useRef<AbortController | null>(null);

  // The agent's connection state (re-read after every save), then, only when it is connected,
  // the models its account offers. Both load apart from the catalogue: the pickers show the
  // Rev4a proxy group at once and the subscription group when it arrives.
  useEffect(() => {
    subAbortRef.current?.abort();
    const controller = new AbortController();
    subAbortRef.current = controller;
    setSubLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/subscriptions?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.agent) throw new Error('unavailable');
        setSub(json.agent as SubscriptionStatus);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        setSub(null);
      }
      if (subAbortRef.current === controller) setSubLoading(false);
    })();
    return () => controller.abort();
  }, [agentId, subKey]);

  const subConnected = !!sub?.connected && !sub.error;
  useEffect(() => {
    if (!subConnected) { setSubModels(null); return; }
    modelsAbortRef.current?.abort();
    const controller = new AbortController();
    modelsAbortRef.current = controller;
    (async () => {
      try {
        const res = await fetch('/api/subscriptions/models', { signal: controller.signal });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error('unavailable');
        setSubModels((json.models ?? []) as SubModel[]);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        setSubModels([]);
      }
    })();
    return () => controller.abort();
  }, [agentId, subConnected]);

  const load = useCallback(async () => {
    // Cancel any in-flight load: this fires on mount and after every save, and
    // a stale response arriving late would overwrite fresher state.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const [mRes, aRes] = await Promise.all([
        fetch('/api/models', { signal: controller.signal }),
        fetch(`/api/agents/${encodeURIComponent(agentId)}/model`, { signal: controller.signal }),
      ]);
      if (!mRes.ok || !aRes.ok) {
        // Say so. An empty picker with no message reads as "no models available",
        // which is a different problem with a different fix.
        setMsg({
          text: `Could not load model configuration (${!mRes.ok ? `catalogue HTTP ${mRes.status}` : `agent HTTP ${aRes.status}`})`,
          ok: false,
        });
      }
      if (mRes.ok) setGroups((await mRes.json()) as ProviderGroup[]);
      if (aRes.ok) {
        const data = (await aRes.json()) as AgentModel;
        setCurrent(data);
        setPrimary(data.primary ? bare(data.primary) : '');
        setFallbacks((data.fallbacks ?? []).map(bare));
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setMsg({ text: 'Could not load model configuration', ok: false });
    }
    // Only the load that is still current may end the loading state. A save
    // triggers a reload that aborts the previous one; the aborted request lands in
    // the catch above and used to switch off the spinner the new one had just
    // switched on.
    if (abortRef.current === controller) setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const allModels = groups.flatMap((g) => g.models);
  const byId = new Map(allModels.map((m) => [m.id, m]));
  const dirty =
    primary !== (current?.primary ? bare(current.primary) : '') ||
    fallbacks.join(',') !== (current?.fallbacks ?? []).map(bare).join(',');

  /** Return the form to what the container actually holds. */
  const reset = () => {
    setPrimary(current?.primary ? bare(current.primary) : '');
    setFallbacks((current?.fallbacks ?? []).map(bare));
    setAutoFallback(null);
    setMsg(null);
  };

  /**
   * Picking a subscription model while no fallback is set pre-fills the previous primary as the
   * first fallback, visibly and before saving: when the subscription reaches its usage limit
   * the agent would otherwise have nothing to fall back to. The operator can remove it.
   */
  const choosePrimary = (value: string) => {
    const oldPrimaryOffered = !!primary && !isSub(primary) && byId.has(primary);
    if (isSub(value) && !isSub(primary) && oldPrimaryOffered && fallbacks.length === 0 && value !== primary) {
      setFallbacks([primary]);
      setAutoFallback(primary);
    } else if (!isSub(value) && autoFallback !== null) {
      // Switched away from the subscription model: the pre-filled fallback, if still the untouched
      // auto entry, goes with it (no model as its own fallback, no dirty no-op).
      if (fallbacks.length === 1 && fallbacks[0] === autoFallback) setFallbacks([]);
      setAutoFallback(null);
    }
    setPrimary(value);
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/gateway/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName: agentId, model: primary, fallbacks }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success !== false) {
        setMsg({ text: 'Model saved. It applies immediately, no restart needed.', ok: true });
        setAutoFallback(null);
        await load();
        setSubKey((k) => k + 1);
        // The card in the list reads a separate summary endpoint; without this it
        // keeps showing the previous model until the next poll.
        onSaved?.();
      } else {
        setMsg({ text: data.error || 'Save failed', ok: false });
      }
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    }
    setSaving(false);
  };

  // The current primary may no longer be on offer: unchecked on the Gateway page,
  // or its provider key removed. A native select whose value matches no option
  // renders as though nothing were chosen, contradicting the warning above it.
  // Show the real value, disabled so it cannot be picked again. Guarded on a
  // loaded catalogue so a failed fetch does not flag every model.
  const primarySub = isSub(primary);
  const primaryUnavailable = !!primary && !primarySub && groups.length > 0 && !byId.has(primary);
  const options = [
    { value: '', label: '— select a model —' },
    ...(primarySub && !(subConnected && subModels?.some((m) => SUB_MARK + m.key === primary)) ? [{ value: primary, label: `${shown(primary)} (ChatGPT subscription)`, disabled: true }] : []),
    ...(primaryUnavailable ? [{ value: primary, label: `${primary} (${current?.primaryStatus === 'missing' ? 'no longer in catalogue' : 'not enabled'})`, disabled: true }] : []),
  ];
  const subOptions = (exclude: string[]) =>
    subConnected && subModels
      ? subModels.filter((m) => !exclude.includes(SUB_MARK + m.key)).map((m) => ({ value: SUB_MARK + m.key, label: m.name || m.key }))
      : [];
  const primaryGroups = [
    { label: 'Rev4a proxy', options: groups.flatMap((g) => g.models.map((m) => ({ value: m.id, label: `${g.provider} · ${optionLabel(m)}` }))) },
    { label: 'ChatGPT subscription', options: subOptions([]) },
  ];
  const fallbackGroups = [
    {
      label: 'Rev4a proxy',
      options: allModels.filter((m) => m.id !== primary && !fallbacks.includes(m.id)).map((m) => ({ value: m.id, label: optionLabel(m) })),
    },
    { label: 'ChatGPT subscription', options: subOptions([primary, ...fallbacks]) },
  ];

  // Two different failures, two different remedies. The panel used to show one
  // message for both and guess "disabled on the Gateway page" — wrong when the
  // model is enabled and a sync simply never reached this container, which is
  // exactly what a toggle made while Docker was stopped produces.
  // A subscription primary is not in the Rev4a catalogue on purpose: none of these apply to it.
  const containerLacksIt = !!current?.reachable && current.resolvable === false && !primarySub;
  // The server states the cause; the offered list is only a fallback for when it
  // did not, so the panel and the card chip cannot disagree about why.
  const status = primarySub ? null : current?.primaryStatus;
  const warnRemoved = status === 'missing';
  // A subscription primary on an agent that is not signed in fails on its next turn.
  const warnSubNotConnected = primarySub && !!sub && !sub.connected && !sub.error;
  const warnNotEnabled = status === 'disabled' || (status == null && primaryUnavailable);
  const warnNotSynced = containerLacksIt && (status === 'offered' || (status == null && groups.length > 0 && !primaryUnavailable));
  const warnUnknown = containerLacksIt && status == null && groups.length === 0;

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {loading && <div style={{ fontSize: 11, color: '#888' }}>Loading…</div>}

      {!loading && current && !current.reachable && (
        <div style={{ fontSize: 11, color: '#888' }}>
          Container not reachable — start the agent to read or change its model.
        </div>
      )}

      {!loading && current?.reachable && (
        <>
          {(warnRemoved || warnNotEnabled || warnNotSynced || warnUnknown || warnSubNotConnected) && (
            <div style={{
              border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.06)',
              padding: '8px 10px', fontSize: 11, color: '#ef4444', lineHeight: 1.5,
            }}>
              {warnSubNotConnected && (
                <>
                  <strong>This agent uses a subscription model but is not connected.</strong> It is set to{' '}
                  <code>{shown(primary)}</code>, which needs a signed-in ChatGPT account. Connect it on the{' '}
                  <a href="/subscriptions" style={{ color: 'inherit' }}>Subscriptions</a> page, or pick another model
                  below.
                </>
              )}
              {warnRemoved && (
                <>
                  <strong>This agent&rsquo;s model is no longer in the catalogue.</strong> It is
                  set to <code>{current.primary}</code>, which this version of Rev4a no longer
                  offers. The gateway refuses it, so the agent fails on its next turn. Pick a
                  model below.
                </>
              )}
              {warnNotEnabled && (
                <>
                  <strong>This agent&rsquo;s model is not enabled.</strong> It is set to{' '}
                  <code>{current.primary}</code>, which the Gateway does not offer — unchecked
                  there, or its provider has no key. The gateway refuses it, so the agent fails
                  on its next turn. Pick a model below.
                </>
              )}
              {warnNotSynced && (
                <>
                  <strong>This container is out of sync.</strong> Its model{' '}
                  <code>{current.primary}</code> is enabled on the Gateway but not among the{' '}
                  {current.catalogueSize} models synced to this container — a sync did not reach
                  it. Run <em>Sync All Agents</em> on the Gateway page; the model does not need to
                  change.
                </>
              )}
              {warnUnknown && (
                <>
                  <strong>This agent&rsquo;s model is not in its catalogue.</strong> It is set to{' '}
                  <code>{current.primary}</code>, which the {current.catalogueSize} models synced
                  to this container do not include. The model list could not be loaded, so the
                  cause is unknown.
                </>
              )}
            </div>
          )}

          <Select
            label="Primary model"
            options={options}
            groups={primaryGroups}
            value={primary}
            onChange={(e) => choosePrimary(e.target.value)}
          />

          <div>
            <div style={{ fontSize: 10, color: '#888', letterSpacing: '0.06em', marginBottom: 4 }}>
              FALLBACKS
            </div>
            {fallbacks.length === 0 && (
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                None set. Without a fallback, the agent goes silent if its primary
                becomes unavailable.
              </div>
            )}
            {fallbacks.map((f, i) => (
              <div key={`${f}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: '#666', minWidth: 12 }}>{i + 1}.</span>
                <span style={{ fontSize: 11, flex: 1, wordBreak: 'break-all' }}>
                  {shown(f)}
                  {isSub(f) && <span style={{ color: '#888' }}> (ChatGPT subscription)</span>}
                  {byId.get(f)?.deprecated && (
                    <span style={{ color: '#eab308' }}> (deprecated)</span>
                  )}
                  {groups.length > 0 && !isSub(f) && !byId.has(f) && (
                    <span style={{ color: '#ef4444' }}> (not enabled)</span>
                  )}
                </span>
                <RemoveButton
                  label={`fallback ${shown(f)}`}
                  title="Remove from the list — applied when you save"
                  onClick={() => setFallbacks(fallbacks.filter((_, j) => j !== i))}
                />
              </div>
            ))}
            <Select
              options={[{ value: '', label: '— add a fallback —' }]}
              groups={fallbackGroups}
              value=""
              onChange={(e) => { if (e.target.value) setFallbacks([...fallbacks, e.target.value]); }}
            />
            {autoFallback && fallbacks.includes(autoFallback) && (
              <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                Used when the ChatGPT subscription reaches its usage limit.
              </div>
            )}
          </div>

          <SubscriptionLine status={sub} loading={subLoading} modelsLoading={subConnected && subModels === null} />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="primary" size="sm" loading={saving} disabled={!dirty || !primary || primaryUnavailable || !!agentBusy} onClick={save}>
              {saving ? 'Saving…' : 'Save model'}
            </Button>
            {dirty && !saving && (
              <>
                <span style={{ fontSize: 11, color: '#eab308' }}>Unsaved changes</span>
                <Button variant="secondary" size="sm" onClick={reset}>Discard</Button>
              </>
            )}
            {msg && (
              <span style={{ fontSize: 11, color: msg.ok ? '#4ade80' : '#ef4444' }}>{msg.text}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
