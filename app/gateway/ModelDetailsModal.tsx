'use client';

/**
 * Everything known about one model: what it is, what it costs, what it can do and how it
 * scores. Opened from the Gateway's model row and **fetched when it opens**
 * (`GET /api/models/details`) — descriptions are long and one model is looked at at a
 * time, so inlining them in `/api/models` would weigh down every page poll.
 *
 * Absent data is not shown at all: no "n/a" blocks, and no number without its source.
 * Prices come from the owner of the model (`model-pricing.json`), specs, description and
 * OpenRouter benchmarks from the generated `model-details.json`, and anything else from
 * the catalogue's hand-written `info` block.
 */
import { useEffect, useState } from 'react';
import { Button, LoadingSpinner, Metric, Modal, ModalityIcons, Pill, PropertyList } from '../components/ui';
import { formatParams, formatPrice } from '../lib/model-format';

/** Mirrors lib/model-details.ts: a client component cannot import a module that reads files. */
interface DetailsView {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  modality?: string;
  enabled: boolean;
  deprecated: boolean;
  price: { input: number; output: number; source: 'openrouter' | 'vendor' } | null;
  details: {
    description?: string;
    created?: string;
    context?: number;
    providerContext?: number;
    maxOutput?: number;
    tokenizer?: string;
    instructType?: string;
    /** Total parameter count, from the model's Hugging Face card (open weights only). */
    params?: number;
    paramsSource?: string;
    /** Architecture facts from the model card (Hugging Face); open weights only. */
    hf?: {
      id: string;
      total?: number;
      byDtype?: Record<string, number>;
      family?: string;
      modelType?: string;
      moe?: { experts?: number; perToken?: number; shared?: number };
      layers?: number;
      hidden?: number;
      heads?: number;
      kvHeads?: number;
      vocab?: number;
      context?: number;
      vision?: boolean;
      quantization?: string;
      task?: string;
      languages?: string[];
      license?: string;
      licenseName?: string;
      published?: string;
      updated?: string;
      weightsBytes?: number;
      tags?: string[];
      downloads?: number;
      likes?: number;
    };
    knowledgeCutoff?: string;
    huggingFaceId?: string;
    canonicalSlug?: string;
    url?: string;
    reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[]; default_effort?: string };
    supportedParameters?: string[];
    moderated?: boolean;
    benchmarks?: {
      design_arena?: { arena?: string; category?: string; elo?: number; win_rate?: number; rank?: number }[];
      artificial_analysis?: Record<string, number>;
    };
  } | null;
  info: {
    params?: string;
    released?: string;
    docUrl?: string;
    knowledgeCutoff?: string;
    benchmarks?: { name: string; value: number; source: string; asOf?: string }[];
    notes?: string;
  } | null;
  asOf: string | null;
  detailsSource: 'openrouter' | 'none';
}

const count = (n?: number): string | undefined => (typeof n === 'number' ? n.toLocaleString('en-US') : undefined);

/** "1,048,576" is unreadable in a small metric: 1.05M reads at a glance. */
function compactCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** "BF16 6.9B · FP8 314.4B" — the weights' precision mix, biggest first. */
function dtypeMix(byDtype: Record<string, number>): string {
  return Object.entries(byDtype)
    .filter(([, n]) => n > 1e6)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k.replace('F8_E4M3', 'FP8').replace('F32', 'FP32')} ${formatParams(n)}`)
    .join(' · ');
}
/** `parallel_tool_calls` reads better as words in a chip. */
const human = (p: string): string => p.replace(/_/g, ' ');

export default function ModelDetailsModal({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const [view, setView] = useState<DetailsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullDescription, setFullDescription] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError(null);
    fetch(`/api/models/details?id=${encodeURIComponent(modelId)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `HTTP ${res.status}`);
        return data as DetailsView;
      })
      .then(setView)
      .catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') setError((e as Error).message); });
    return () => controller.abort();
  }, [modelId]);

  const d = view?.details ?? null;
  const info = view?.info ?? null;
  const hf = d?.hf ?? null;
  const reasoning = d?.reasoning;
  const arenas = d?.benchmarks?.design_arena ?? [];
  const aa = d?.benchmarks?.artificial_analysis;
  const released = info?.released ?? hf?.published ?? d?.created;

  return (
    <Modal open onClose={onClose} title={view ? view.name : modelId} maxWidth={720}>
      {error ? (
        <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>
      ) : !view ? (
        <LoadingSpinner label="Loading model details…" />
      ) : (
        <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          {/* Identity */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Pill>{view.provider}</Pill>
            {view.deprecated && <Pill tone="warning">deprecated</Pill>}
            {view.enabled ? <Pill tone="success">enabled</Pill> : <Pill>disabled</Pill>}
            {view.modality && <ModalityIcons modality={view.modality} />}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>
            {view.id}
          </div>

          {d?.description && (
            <div style={{ margin: '8px 0 0' }}>
              <p style={{
                fontSize: 12, lineHeight: 1.5, color: 'var(--text)', margin: 0,
                ...(fullDescription ? {} : { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }),
              }}>{d.description}</p>
              {d.description.length > 340 && (
                <Button variant="ghost" size="sm" onClick={() => setFullDescription(!fullDescription)}>
                  {fullDescription ? 'Show less' : 'Show more'}
                </Button>
              )}
            </div>
          )}

          {(info?.notes || view.deprecated) && (
            <>
              <div style={{ fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Status</div>
              <div style={{ fontSize: 11, color: 'var(--yellow)' }}>
                {info?.notes ?? 'Upstream has retired this id: it still answers, but is redirected.'}
              </div>
            </>
          )}

          {/* Price */}
          <div style={{ fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Price</div>
          <PropertyList rows={[
            { label: 'Input / output', value: formatPrice(view.price) },
            ...(view.price ? [{ label: 'Per 1M tokens, from', value: view.providerLabel, dim: true }] : []),
          ]} />

          {/* Architecture: the factory facts from the model card, open weights only */}
          {hf && (hf.total || hf.moe || hf.layers) ? (
            <>
              <div style={{ fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Architecture</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))', gap: 8, marginBottom: 8 }}>
                {hf.total ? <Metric size="sm" title="Parameters" value={formatParams(hf.total)} /> : null}
                {hf.moe ? <Metric size="sm" title="Experts" value={`${count(hf.moe.experts) ?? '?'}${hf.moe.perToken ? ` · ${hf.moe.perToken}/tok` : ''}`} /> : null}
                {hf.layers ? <Metric size="sm" title="Layers" value={hf.layers} /> : null}
                {hf.context ? <Metric size="sm" title="Max context" value={`${compactCount(hf.context)} tok`} /> : null}
              </div>
              <PropertyList rows={[
                ...(hf.family ? [{ label: 'Family', value: hf.family }] : []),
                ...(hf.modelType ? [{ label: 'Model type', value: hf.modelType, dim: true }] : []),
                ...(hf.hidden ? [{ label: 'Hidden size', value: count(hf.hidden) ?? '' }] : []),
                ...(hf.heads ? [{ label: 'Attention heads', value: `${hf.heads}${hf.kvHeads && hf.kvHeads !== hf.heads ? ` (${hf.kvHeads} KV)` : ''}` }] : []),
                ...(hf.vocab ? [{ label: 'Vocabulary', value: count(hf.vocab) ?? '' }] : []),
                ...(hf.vision ? [{ label: 'Vision encoder', value: 'yes (multimodal)' }] : []),
                ...(hf.quantization ? [{ label: 'Precision', value: hf.quantization.toUpperCase() }] : []),
                ...(hf.weightsBytes ? [{ label: 'Weights on disk', value: `~${hf.weightsBytes >= 1e12 ? `${(hf.weightsBytes / 1e12).toFixed(1)} TB` : `${Math.round(hf.weightsBytes / 1e9)} GB`}` }] : []),
                ...(hf.license ? [{ label: 'Licence', value: hf.license === 'other' ? 'custom — see the model card' : `${hf.license.toUpperCase()}${hf.licenseName ? ` (${hf.licenseName})` : ''}` }] : []),
                ...(hf.byDtype ? [{ label: 'Weights by dtype', value: dtypeMix(hf.byDtype), dim: true }] : []),
                ...(hf.task ? [{ label: 'Task', value: human(hf.task) }] : []),
                ...(hf.languages?.length ? [{ label: 'Languages', value: hf.languages.join(', ') }] : []),
                ...(hf.downloads || hf.likes ? [{ label: 'Popularity', value: `${count(hf.downloads) ?? '—'} downloads · ${count(hf.likes) ?? '—'} likes`, dim: true }] : []),
              ]} />
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
                From the model card on Hugging Face ({hf.id}).
              </div>
            </>
          ) : null}

          {/* Specs */}
          <div style={{ fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Specs</div>
          <PropertyList rows={[
            ...(released ? [{ label: 'Released', value: released }] : []),
            ...(hf?.updated && hf.updated !== released ? [{ label: 'Card updated', value: hf.updated, dim: true }] : []),
            ...(count(d?.context) ? [{ label: 'Context', value: `${count(d?.context)} tokens` }] : []),
            ...(d?.providerContext && d.providerContext !== d.context ? [{ label: 'Provider limit', value: `${count(d.providerContext)} tokens`, dim: true }] : []),
            ...(count(d?.maxOutput) ? [{ label: 'Max output', value: `${count(d?.maxOutput)} tokens` }] : []),
            // The curated value can be more precise than the card (MoE total vs active);
            // when there is none, the Hugging Face count is the honest number we have.
            ...(info?.params
              // The vendor's own framing (total/active), next to the card's total below:
              // labelled, or the two numbers read as a contradiction.
              ? [{ label: 'Parameters (vendor)', value: info.params }]
              : []),
            ...(info?.knowledgeCutoff || d?.knowledgeCutoff ? [{ label: 'Knowledge cutoff', value: info?.knowledgeCutoff ?? d?.knowledgeCutoff ?? '' }] : []),
            ...(d?.tokenizer ? [{ label: 'Tokenizer', value: d.tokenizer, dim: true }] : []),
            ...(d?.instructType ? [{ label: 'Instruct type', value: d.instructType, dim: true }] : []),
            ...(d?.moderated ? [{ label: 'Moderated', value: 'yes' }] : []),
          ]} />

          {/* Reasoning */}
          {reasoning && (
            <>
              <div style={{ fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Reasoning</div>
              <PropertyList rows={[
                { label: 'Mode', value: reasoning.mandatory ? 'always reasons' : reasoning.default_enabled ? 'on by default' : 'optional' },
                ...(reasoning.default_effort ? [{ label: 'Default effort', value: reasoning.default_effort }] : []),
                ...(reasoning.supported_efforts?.length ? [{ label: 'Efforts', value: reasoning.supported_efforts.join(', ') }] : []),
              ]} />
            </>
          )}

          {/* Capabilities */}
          {(d?.supportedParameters?.length || hf?.tags?.length) ? (
            <>
              <div style={{ fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 6px' }}>Capabilities</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {[...new Set([...(d?.supportedParameters ?? []), ...(hf?.tags ?? [])])].map((c) => <Pill key={c}>{human(c)}</Pill>)}
              </div>
            </>
          ) : null}

          {/* Benchmarks: OpenRouter's, then the curated ones */}
          {aa || arenas.length > 0 || info?.benchmarks?.length ? (
            <>
              <div style={{ fontSize: 10, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '14px 0 6px' }}>Benchmarks</div>
              {aa && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 8 }}>
                  {Object.entries(aa).map(([k, v]) => <Metric key={k} title={human(k)} value={v} />)}
                </div>
              )}
              {arenas.length > 0 && (
                <div style={{ display: 'grid', gap: 2 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 50px 60px', gap: 6, fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <span>Design arena</span><span style={{ textAlign: 'right' }}>Elo</span><span style={{ textAlign: 'right' }}>Rank</span><span style={{ textAlign: 'right' }}>Win rate</span>
                  </div>
                  {arenas.map((a, i) => (
                    <div key={`${a.category ?? i}`} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 50px 60px', gap: 6, fontSize: 11 }}>
                      <span>{human(String(a.category ?? a.arena ?? '—'))}</span>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{a.elo ?? '—'}</span>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{a.rank ? `#${a.rank}` : '—'}</span>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{a.win_rate !== undefined ? `${a.win_rate}%` : '—'}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>OpenRouter arenas (community votes), as of the file's date below.</div>
                </div>
              )}
              {info?.benchmarks?.length ? (
                <div style={{ display: 'grid', gap: 3, marginTop: 8 }}>
                  {info.benchmarks.map((b) => (
                    <div key={b.name} style={{ fontSize: 11 }}>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{b.value}</span>
                      <span style={{ marginLeft: 6 }}>{b.name}</span>
                      <a href={b.source} target="_blank" rel="noreferrer" style={{ marginLeft: 6, color: 'var(--violet)', fontSize: 10 }}>source</a>
                      {b.asOf && <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 10 }}>({b.asOf})</span>}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {/* Links + provenance */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 14, fontSize: 10, color: 'var(--text-dim)' }}>
            {d?.url && <a href={d.url} target="_blank" rel="noreferrer" style={{ color: 'var(--violet)' }}>OpenRouter page</a>}
            {d?.huggingFaceId && <span>HF: {d.huggingFaceId}</span>}
            {info?.docUrl && <a href={info.docUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--violet)' }}>Vendor docs</a>}
          </div>
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-dim)' }}>
            {view.detailsSource === 'openrouter'
              ? `Specs and benchmarks via OpenRouter${d?.paramsSource === 'huggingface' ? ', size via Hugging Face' : ''}`
              : 'No generated details for this model'}
            {view.asOf ? ` · data as of ${view.asOf.slice(0, 10)}` : ''}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
