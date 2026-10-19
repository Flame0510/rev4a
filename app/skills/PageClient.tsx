'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useResponsive } from '../design-system';
import { Button, Pill, LoadingSpinner, ListContainer, ListItem, ConfirmModal } from '../components/ui';

type BadgeColor = 'green' | 'red' | 'gray' | 'violet' | 'blue';

function Badge({ children, color }: { children: React.ReactNode; color: BadgeColor }) {
  const toneMap: Record<BadgeColor, 'success' | 'danger' | 'neutral' | 'accent' | 'info'> = {
    green: 'success', red: 'danger', gray: 'neutral', violet: 'accent', blue: 'info',
  };
  return <Pill tone={toneMap[color]}>{children}</Pill>;
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '10px 20px',
      fontSize: 10,
      letterSpacing: 2,
      color: 'var(--violet)',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg2)',
      textTransform: 'uppercase',
      flexShrink: 0,
      fontFamily: 'var(--font-mono-stack)',
    }}>
      {children}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
}

function ErrorState({ message }: { message: string }) {
  return <div className="error-state">⚠ {message}</div>;
}

function LoadingState() {
  return <LoadingSpinner label="LOADING" compact />;
}

// ─── Skill type ──────────────────────────────────────────────────────────────

interface Skill {
  name: string;
  type: 'shared' | 'workspace' | 'bundled';
  description?: string;
  version?: string;
  path?: string;
  skillMdPath?: string;
  agentId?: string;
  containerName?: string;
  /** The agent's display name (AGENT_NAME); null when it has none. */
  agentName?: string | null;
  /** Rev4a's own shared skill: read-only here. */
  managed?: boolean;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const isMobile = useResponsive('lg');
  const [mobileStep, setMobileStep] = useState(1);
  const [loadingContent, setLoadingContent] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [deleteModalSkill, setDeleteModalSkill] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const contentAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const mergedSignal = signal || controller.signal;
    try {
      const res = await fetch('/api/skills', { credentials: 'same-origin', signal: mergedSignal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!mergedSignal.aborted) setSkills(data.skills || []);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      if (!mergedSignal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const searchLower = search.toLowerCase();
  const filtered = skills.filter(s => {
    const typeMatch = filter === 'all' || s.type === filter;
    if (!typeMatch) return false;
    if (!searchLower) return true;
    return s.name.toLowerCase().includes(searchLower) ||
      (s.description && s.description.toLowerCase().includes(searchLower));
  });

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  };

  const handleSelect = async (skill: Skill) => {
    setSelected(skill);
    setEditMode(false);
    setSkillContent(null);
    if (isMobile) setMobileStep(2);
    contentAbortRef.current?.abort();
    if (skill.skillMdPath) {
      setLoadingContent(true);
      const controller = new AbortController();
      contentAbortRef.current = controller;
      try {
        const params = new URLSearchParams({ path: skill.skillMdPath });
        if (skill.containerName) params.set('containerName', skill.containerName);
        const res = await fetch(`/api/skills/save?${params.toString()}`, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const data = await res.json();
        setSkillContent(data.content || null);
      } catch {
        setSkillContent(null);
      } finally {
        setLoadingContent(false);
      }
    }
  };

  const handleSave = async () => {
    if (!selected?.skillMdPath) return;
    if (selected.type === 'bundled') {
      showToast('Read-only: bundled skills cannot be edited');
      return;
    }
    setSaving(true);
    try {
      const body: { skillPath: string; content: string; containerName?: string } = { skillPath: selected.skillMdPath, content: editText };
      if (selected.containerName) body.containerName = selected.containerName;
      const res = await fetch('/api/skills/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setSkillContent(editText);
        setEditMode(false);
        showToast('SKILL.md saved');
      } else {
        showToast(`Error: ${data.error}`);
      }
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteModalSkill) return;
    setDeleting(true);
    try {
      const body: { skillName: string; containerName?: string } = { skillName: deleteModalSkill.name };
      if (deleteModalSkill.type === 'workspace' && deleteModalSkill.containerName) {
        body.containerName = deleteModalSkill.containerName;
      }
      const res = await fetch('/api/skills/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        const label = deleteModalSkill.type === 'workspace' ? 'agent workspace' : 'shared skills';
        showToast(`Deleted "${deleteModalSkill.name}" from ${label}`);
        if (selected?.name === deleteModalSkill.name) setSelected(null);
        await load();
      } else {
        showToast(`Error: ${data.error}`);
      }
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`);
    } finally {
      setDeleting(false);
      setDeleteModalSkill(null);
    }
  };

  const handlePromote = async (skill: Skill) => {
    if (!skill.containerName) {
      showToast('Only agent workspace skills can be promoted');
      return;
    }
    setPromoting(skill.name);
    try {
      const res = await fetch('/api/skills/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ containerName: skill.containerName, skillName: skill.name }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Promoted "${skill.name}" to shared skills${data.overwritten ? ' (overwritten)' : ''}`);
        await load();
      } else {
        showToast(`Error: ${data.error}`);
      }
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`);
    } finally {
      setPromoting(null);
    }
  };

  const typeColor: Record<string, BadgeColor> = { shared: 'violet', workspace: 'green', bundled: 'blue' };

  const typeLabel = (s: Skill) => {
    if (s.agentId) return `agent:${s.agentName || s.agentId}`;
    return s.type;
  };

  const filters = ['all', 'shared', 'workspace', 'bundled'] as const;

  const filterCounts: Record<string, number> = {
    all: skills.length,
    shared: skills.filter(s => s.type === 'shared').length,
    workspace: skills.filter(s => s.type === 'workspace').length,
    bundled: skills.filter(s => s.type === 'bundled').length,
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      background: 'var(--bg)',
      color: 'var(--text)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        height: 48,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
        flexShrink: 0,
        boxSizing: 'border-box',
      }}>
        <span style={{ fontFamily: 'var(--font-serif-stack)', fontSize: '20px', letterSpacing: '4px', color: 'var(--violet)' }}>SKILLS</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {isMobile && (
          <div style={{ display: 'flex', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
            <Button variant={mobileStep === 1 ? 'primary' : 'ghost'} size="sm" onClick={() => setMobileStep(1)}>LIST</Button>
            <Button variant={mobileStep === 2 ? 'primary' : 'ghost'} size="sm" disabled={!selected} onClick={() => setMobileStep(2)}>EDITOR</Button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flex: 1, overflow: 'hidden' }}>
          {/* Side panel */}
          <ListContainer style={{
            width: isMobile ? '100%' : 320,
            borderRight: isMobile ? 'none' : '1px solid var(--border)',
            borderBottom: isMobile ? '1px solid var(--border)' : 'none',
            display: isMobile && mobileStep !== 1 ? 'none' : 'flex',
            flexDirection: 'column',
            flexShrink: 0,
          }}>
            <div className="ui-filter-bar" style={{ borderBottom: '1px solid var(--border)', padding: '8px 12px' }}>
              {filters.map(f => (
                <Button
                  key={f}
                  variant={filter === f ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setFilter(f)}
                >
                  {f.toUpperCase()} ({filterCounts[f] ?? 0})
                </Button>
              ))}
            </div>

            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <input
                type="text"
                placeholder="Search skills…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 0,
                  color: 'var(--text)',
                  fontFamily: 'var(--font-mono-stack)',
                  fontSize: 11,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading && <LoadingState />}
              {!loading && error && <ErrorState message={error} />}
              {!loading && !error && filtered.length === 0 && (
                <EmptyState message={search ? 'no skills match your search' : 'no skills found'} />
              )}
              {!loading && !error && filtered.map(s => (
                <ListItem
                  key={`${s.type}:${s.name}`}
                  active={selected?.name === s.name && selected?.type === s.type}
                  onClick={() => handleSelect(s)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </span>
                    <Badge color={typeColor[s.type] ?? 'gray'}>{typeLabel(s)}</Badge>
                  </div>
                  {s.description && (
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      {s.description}
                    </div>
                  )}
                </ListItem>
              ))}
            </div>
          </ListContainer>

          {/* Detail / Editor */}
          <div style={{ flex: 1, display: isMobile && mobileStep !== 2 ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {!selected ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontFamily: 'var(--font-mono-stack)', fontSize: 12, padding: '24px 16px' }}>
                ← select a skill
              </div>
            ) : (
              <>
                <PanelTitle>SKILL — {selected.name}</PanelTitle>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                  {selected.version && <div style={{ marginBottom: 8 }}><Badge color="gray">v{selected.version}</Badge></div>}
                  {selected.description && (
                    <div style={{ fontFamily: 'var(--font-mono-stack)', fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.5 }}>
                      {selected.description}
                    </div>
                  )}
                  {(selected.agentId || selected.containerName) && (
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {selected.agentId && <Badge color="green">agent:{selected.agentName || selected.agentId}</Badge>}
                      {selected.containerName && (
                        <span title="Container name" style={{ fontFamily: 'var(--font-mono-stack)', fontSize: 10, color: 'var(--text-dim)' }}>
                          {selected.containerName}
                        </span>
                      )}
                    </div>
                  )}
                  {selected.path && (
                    <div style={{ fontFamily: 'var(--font-mono-stack)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 10 }}>
                      {selected.path}
                    </div>
                  )}

                  {selected.managed && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>Managed by Rev4a</div>
                  )}

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {!editMode && selected.skillMdPath && selected.type !== 'bundled' && !selected.managed && (
                      <Button variant="secondary" size="sm" onClick={() => { setEditText(skillContent || ''); setEditMode(true); }}>
                        EDIT SKILL.MD
                      </Button>
                    )}
                    {editMode && (
                      <>
                        <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
                          {saving ? 'SAVING…' : 'SAVE'}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setEditMode(false)}>
                          CANCEL
                        </Button>
                      </>
                    )}
                    {selected.type === 'bundled' && selected.skillMdPath && (
                      <Badge color="gray">read-only (bundled)</Badge>
                    )}
                    {(selected.type === 'shared' || (selected.type === 'workspace' && selected.containerName)) && !selected.managed && !editMode && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => setDeleteModalSkill(selected)}
                      >
                        DELETE
                      </Button>
                    )}
                    {selected.type === 'workspace' && selected.containerName && !editMode && (
                      <Button
                        variant="primary"
                        size="sm"
                        loading={promoting === selected.name}
                        onClick={() => handlePromote(selected)}
                      >
                        {promoting === selected.name ? 'PROMOTING…' : 'PROMOTE TO SHARED'}
                      </Button>
                    )}
                  </div>
                </div>

                <ConfirmModal
                  open={deleteModalSkill !== null}
                  onClose={() => setDeleteModalSkill(null)}
                  onConfirm={handleDelete}
                  title={`Delete ${deleteModalSkill?.type === 'workspace' ? 'workspace' : 'shared'} skill`}
                  message={`Are you sure you want to delete "${deleteModalSkill?.name ?? ''}"?\n\n` + (deleteModalSkill?.type === 'workspace' ? 'This will remove the skill from the agent\'s workspace.' : 'This will remove the skill from shared skills.') + `\n\nThis action cannot be undone.`}
                  confirmLabel={deleting ? 'DELETING…' : 'DELETE'}
                  cancelLabel="Cancel"
                  tone="danger"
                />

                <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  {loadingContent && <LoadingState />}
                  {!loadingContent && editMode && (
                    <textarea
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      spellCheck={false}
                      style={{
                        flex: 1,
                        background: 'var(--bg)',
                        color: 'var(--text)',
                        fontFamily: 'var(--font-mono-stack)',
                        fontSize: 12,
                        border: 'none',
                        outline: 'none',
                        padding: 16,
                        resize: 'none',
                        lineHeight: 1.6,
                      }}
                    />
                  )}
                  {!loadingContent && !editMode && skillContent && (
                    <pre style={{
                      flex: 1,
                      overflowY: 'auto',
                      margin: 0,
                      padding: 16,
                      fontFamily: 'var(--font-mono-stack)',
                      fontSize: 11,
                      color: 'var(--text-dim)',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {skillContent}
                    </pre>
                  )}
                  {!loadingContent && !editMode && !skillContent && selected.skillMdPath && (
                    <EmptyState message="could not load SKILL.md" />
                  )}
                  {!loadingContent && !editMode && !selected.skillMdPath && (
                    <EmptyState message="no SKILL.md found for this skill" />
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {toastMsg && (
          <div style={{
            position: 'fixed', bottom: 24, right: 24,
            background: 'var(--bg2)', border: '1px solid var(--violet)',
            color: 'var(--text)', fontFamily: 'var(--font-mono-stack)',
            fontSize: 12, padding: '10px 18px', borderRadius: 0,
            zIndex: 1000,
          }}>
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  );
}
