'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { MEMORY_PRESETS_MB, formatLimit, mbToGbText, parseGbInput } from '@/lib/agent-memory-limit';
import { memoryLimitPolicyError, resourcePolicyFor } from '@/lib/agent-resource-policy';
import { Input } from './Input';
import { Select } from './Select';

const NONE = 'none';
const CUSTOM = 'custom';

export const MEMORY_LIMIT_HELP = 'If the agent goes over the limit, Docker kills the process that uses the most memory and the agent restarts if needed.';
export const MEMORY_LIMIT_WARNING = resourcePolicyFor(null).advice;

interface MemoryLimitPickerProps {
  /** The limit in MB the picker opens with; null for no limit. Read once, when the picker mounts. */
  value: number | null;
  /** Called on every change: the limit in MB (null for none) and an error text ('' when valid). */
  onChange: (mb: number | null, error: string) => void;
  label?: string;
  /** Docker's total memory in MB, when known: presets above it are not offered. */
  dockerTotalMb?: number | null;
  /** Actual target/runtime release; no version means general advice, never a new default. */
  openclawVersion?: string | null;
  /** Create validates the tested finite-limit floor. Editing an existing cap remains an explicit choice. */
  enforceVersionFloor?: boolean;
  disabled?: boolean;
  /** Extra lines under the shared helper text. */
  children?: React.ReactNode;
}

/**
 * Docker's total memory in MB from the latest container sample (`host.mem_total_mb` of
 * GET /api/metrics/containers); null until known, or when the daemon has no sample yet.
 */
export function useDockerTotalMb(): number | null {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/metrics/containers?range=1h', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { host?: { mem_total_mb?: number } | null } | null) => {
        const v = body?.host?.mem_total_mb;
        if (typeof v === 'number' && v > 0) setTotal(v);
      })
      .catch(() => { /* unknown total: every preset is offered */ });
    return () => controller.abort();
  }, []);
  return total;
}

/**
 * The memory limit of an agent: "No limit", a preset in GB (1 GB = 1024 MB) or a custom size
 * in GB. The value it reports stays in MB, as the API takes it. Opened with an existing
 * limit it selects the matching preset, or Custom with that limit in GB.
 */
export function MemoryLimitPicker({ value, onChange, label = 'Memory limit', dockerTotalMb = null, openclawVersion = null, enforceVersionFloor = false, disabled, children }: MemoryLimitPickerProps) {
  const [choice, setChoice] = useState<string>(() => {
    if (value === null) return NONE;
    return MEMORY_PRESETS_MB.includes(value) ? String(value) : CUSTOM;
  });
  const [gbText, setGbText] = useState<string>(() => (value !== null && !MEMORY_PRESETS_MB.includes(value) ? mbToGbText(value) : ''));

  const customResult = (text: string): { mb: number | null; error: string } => {
    try { return { mb: parseGbInput(text), error: '' }; } catch (e) { return { mb: null, error: (e as Error).message }; }
  };
  const custom = choice === CUSTOM ? customResult(gbText) : null;
  const mb: number | null = choice === NONE ? null : custom ? custom.mb : Number(choice);
  const policy = resourcePolicyFor(openclawVersion);
  const policyError = enforceVersionFloor ? memoryLimitPolicyError(openclawVersion, mb) : '';

  const presets = MEMORY_PRESETS_MB.filter((p) => dockerTotalMb === null || p <= dockerTotalMb || p === value);
  const options = [
    { value: NONE, label: 'No limit' },
    ...presets.map((p) => ({ value: String(p), label: formatLimit(p) })),
    { value: CUSTOM, label: 'Custom…' },
  ];

  const onSelect = (next: string) => {
    setChoice(next);
    if (next === NONE) { onChange(null, ''); return; }
    if (next === CUSTOM) {
      // Start from the size already chosen, so switching to Custom edits it instead of clearing it.
      const text = choice !== NONE && choice !== CUSTOM ? mbToGbText(Number(choice)) : gbText;
      setGbText(text);
      const r = customResult(text);
      onChange(r.mb, r.error);
      return;
    }
    onChange(Number(next), '');
  };

  const onGbChange = (text: string) => {
    setGbText(text);
    const r = customResult(text);
    onChange(r.mb, r.error);
  };

  return (
    <div>
      <Select label={label} value={choice} options={options} disabled={disabled} error={policyError} onChange={(e) => onSelect(e.target.value)} />
      {custom && (
        <div style={{ marginTop: 8 }}>
          <Input
            label="Custom size (GB)"
            type="text"
            inputMode="decimal"
            value={gbText}
            placeholder="2.5"
            disabled={disabled}
            onChange={(e) => onGbChange(e.target.value)}
            error={gbText.trim() ? custom.error : ''}
          />
          {custom.mb !== null && <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>= {custom.mb} MB</div>}
          {!gbText.trim() && <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{custom.error}</div>}
        </div>
      )}
      <div style={{ fontSize: 11, color: mb !== null && mb < policy.reserveMb ? 'var(--yellow)' : 'var(--text-dim)', marginTop: 6 }}>{policy.advice}</div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>{MEMORY_LIMIT_HELP} No limit still needs enough free Docker memory.</div>
      {children}
    </div>
  );
}
