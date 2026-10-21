'use client';

import type { AgentOption, FilterConfig } from '@/lib/types';
import { PERIODS } from '@/lib/types';

interface DashboardToolbarProps {
  filter: FilterConfig;
  onChange: (patch: Partial<FilterConfig>) => void;
  /** The containers to filter on; 'all' is always offered. */
  agents?: AgentOption[];
}

export default function DashboardToolbar({ filter, onChange, agents = [] }: DashboardToolbarProps) {
  return (
    <section className="toolbar">
      <span className="toolbar-label">AGENTS</span>

      <button
        type="button"
        className={`agent-btn ${filter.agent === 'all' ? 'active' : ''}`}
        aria-pressed={filter.agent === 'all'}
        onClick={() => onChange({ agent: 'all' })}
      >
        all
      </button>
      {agents.map((agent) => (
        <button
          key={agent.value}
          type="button"
          className={`agent-btn ${filter.agent === agent.value ? 'active' : ''}`}
          aria-pressed={filter.agent === agent.value}
          title={agent.running ? agent.value : `${agent.value} (stopped)`}
          onClick={() => onChange({ agent: agent.value })}
        >
          {agent.label}
          {!agent.running && <span className="agent-btn-stopped"> · stopped</span>}
        </button>
      ))}

      <span className="toolbar-sep">|</span>

      <button
        type="button"
        className={`agent-btn ${filter.showOnlyActive ? 'active' : ''}`}
        onClick={() => onChange({ showOnlyActive: !filter.showOnlyActive })}
      >
        active only
      </button>

      <button
        type="button"
        className={`agent-btn ${!filter.showCron ? 'active' : ''}`}
        onClick={() => onChange({ showCron: !filter.showCron })}
      >
        no cron
      </button>

      <span className="toolbar-sep">|</span>
      <span className="toolbar-label">PERIOD</span>

      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          className={`agent-btn ${filter.period === p ? 'active' : ''}`}
          onClick={() => onChange({ period: p })}
        >
          {p}
        </button>
      ))}
    </section>
  );
}
