'use client';

import { useState, useEffect, useCallback } from 'react';
import { Page, PageHeader, Button, Modal, Input, Pill } from '@/app/components/ui';
import type { CredentialProfile } from '@/lib/credentials/vault';
import type { CredentialProviderDef } from '@/lib/credentials/providers';

interface ApiData {
  profiles: CredentialProfile[];
  providers: CredentialProviderDef[];
}

type FieldValues = Record<string, string>;

const CATEGORY_LABEL: Record<string, string> = {
  vcs: 'Version Control',
  pm: 'Project Management',
  cloud: 'Cloud',
  db: 'Database',
};

const PROVIDER_COLOR: Record<string, string> = {
  'github-pat': '#24292e',
  trello: '#0052cc',
  vercel: '#000000',
  supabase: '#3ecf8e',
};

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, padding: '4px 0' }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ accentColor: 'var(--copper)' }} />
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{label}</span>
    </label>
  );
}

function formatRelative(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function CredentialsPageClient() {
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detectData, setDetectData] = useState<{
    container: string;
    agentId: string;
    githubLoggedIn: boolean;
    githubUser: string;
    githubCliInstalled: boolean;
    vercelLoggedIn: boolean;
    vercelUser: string;
    vercelTeam: string;
    vercelCliInstalled: boolean;
    supabaseLoggedIn: boolean;
    supabaseLinked: boolean;
    supabaseProjectRef: string;
    supabaseCliInstalled: boolean;
    trelloLoggedIn: boolean;
    trelloCliInstalled: boolean;
    matchedProfiles?: { profileId: string; providerId: string; label: string }[];
  }[]>([]);

  const [configureProviderId, setConfigureProviderId] = useState<string | null>(null);
  const [editProfile, setEditProfile] = useState<CredentialProfile | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [credsRes, detectRes] = await Promise.all([
        fetch('/api/credentials'),
        fetch('/api/credentials/detect'),
      ]);
      if (!credsRes.ok) throw new Error(`HTTP ${credsRes.status}`);
      const json = await credsRes.json() as ApiData;
      const detectJson = await detectRes.json() as { agents?: {
        container: string;
        agentId: string;
        githubLoggedIn: boolean;
        githubUser: string;
        githubCliInstalled: boolean;
        vercelLoggedIn: boolean;
        vercelUser: string;
        vercelTeam: string;
        vercelCliInstalled: boolean;
        supabaseLoggedIn: boolean;
        supabaseLinked: boolean;
        supabaseProjectRef: string;
        supabaseCliInstalled: boolean;
        trelloLoggedIn: boolean;
        trelloCliInstalled: boolean;
        matchedProfiles?: { profileId: string; providerId: string; label: string }[];
      }[] };
      setData(json);
      setDetectData(detectJson.agents ?? []);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refreshDetectOnly = async () => {
    try {
      const res = await fetch('/api/credentials/detect');
      const json = await res.json() as { agents?: unknown[] };
      setDetectData((json.agents ?? []) as typeof detectData);
    } catch { /* best-effort */ }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const [syncingContainer, setSyncingContainer] = useState<string | null>(null);

  const handleSyncOne = async (profileId: string, container: string) => {
    setSyncingContainer(container);
    try {
      const res = await fetch(`/api/credentials/${profileId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containers: [container] }),
      });
      const json = await res.json() as { results?: { container: string; status: string }[]; error?: string };
      if (json.error) throw new Error(json.error);
      showToast(json.results?.[0]?.status === 'ok' ? `Synced to ${container}` : 'Sync error');
      await refreshDetectOnly();
    } catch (e: unknown) {
      showToast((e as Error).message);
    } finally {
      setSyncingContainer(null);
    }
  };

  const handleDeSyncOne = async (profileId: string, container: string) => {
    setSyncingContainer(container);
    try {
      const res = await fetch(`/api/credentials/${profileId}/sync`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (json.error) throw new Error(json.error);
      showToast(`Removed from ${container}`);
      await refreshDetectOnly();
    } catch (e: unknown) {
      showToast((e as Error).message);
    } finally {
      setSyncingContainer(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/credentials/${id}`, { method: 'DELETE' });
      setDeleteId(null);
      showToast('Credential deleted');
      void load();
    } catch (e: unknown) {
      showToast((e as Error).message);
    }
  };

  if (loading) {
    return (
      <Page>
        <PageHeader eyebrow="OLYMPUS" title="Credentials" />
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading…</p>
      </Page>
    );
  }

  const profiles = data?.profiles ?? [];
  const providers = data?.providers ?? [];

  // Group profiles by provider
  const profilesByProvider = providers.reduce<Record<string, CredentialProfile[]>>((acc, prov) => {
    acc[prov.id] = profiles.filter((p) => p.providerId === prov.id);
    return acc;
  }, {});

  return (
    <Page>
      <PageHeader
        eyebrow="OLYMPUS"
        title="Credentials"
        description="Store third-party credentials once, sync to all agent containers."
      />

      {error && (
        <div style={{ padding: '10px 14px', background: 'var(--bg2)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 12, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'clamp(12px, 3vw, 16px)' }}>
        {providers.map((provider) => {
          const provProfiles = profilesByProvider[provider.id] ?? [];
          const isConfigured = provProfiles.length > 0;
          const accentColor = PROVIDER_COLOR[provider.id] ?? 'var(--copper)';

          return (
            <div
              key={provider.id}
              style={{
                background: 'var(--bg2)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                opacity: isConfigured ? 1 : 0.65,
                transition: 'opacity 0.15s',
              }}
            >
              {/* Card header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                <div style={{
                  width: 28, height: 28, background: accentColor, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: '0.02em',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {provider.label.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                    {provider.label}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    {CATEGORY_LABEL[provider.category] ?? provider.category}
                  </div>
                </div>
                {isConfigured ? (
                  <Pill tone="success">{provProfiles.length} configured</Pill>
                ) : (
                  <Pill tone="neutral">Not set up</Pill>
                )}
              </div>

              {/* Description */}
              <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}>
                {provider.description}
                {provider.docsUrl && (
                  <a href={provider.docsUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--copper)', marginLeft: 6, fontSize: 11 }}>
                    docs ↗
                  </a>
                )}
              </div>

              {/* Delivery method */}
              {provider.deliveryMethod && (
                <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                  {provider.deliveryMethod}
                </div>
              )}

              {/* Configured credentials list */}
              {provProfiles.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {provProfiles.map((p) => {
                    const providerType = p.providerId;
                    const isGithub = providerType === 'github-pat';
                    const isVercel = providerType === 'vercel';
                    const isSupabase = providerType === 'supabase';
                    const isTrello = providerType === 'trello';

                    return (
                    <div key={p.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500, marginBottom: 2 }}>{p.label}</div>
                          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                            <span>{p.secretMasked ?? '••••••••'}</span>
                            <span style={{ color: p.status === 'active' ? 'var(--green)' : 'var(--red)' }}>●</span>
                            <span>synced {formatRelative(p.lastSyncedAt)}</span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditProfile(p)}>Edit</Button>
                          {detectData.some((d) => d.matchedProfiles?.some((m) => m.profileId === p.id)) ? null : (
                            <Button type="button" variant="danger" size="sm" onClick={() => setDeleteId(p.id)}>×</Button>
                          )}
                        </div>
                      </div>
                      {/* Agent detect status — all containers shown for every provider */}
                      {detectData.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {detectData.map((d) => {
                              const matchByProfile = d.matchedProfiles?.some((m) => m.profileId === p.id);

                              // Determine CLI installed status for this provider on this agent
                              const cliOk = isGithub
                                ? d.githubCliInstalled
                                : isVercel
                                  ? d.vercelCliInstalled
                                  : isSupabase
                                    ? d.supabaseCliInstalled
                                    : d.trelloCliInstalled;

                              let extraInfo = '';
                              if (matchByProfile) {
                                if (isGithub && d.githubUser) {
                                  extraInfo = d.githubUser;
                                } else if (isVercel) {
                                  const parts = [];
                                  if (d.vercelUser) parts.push(d.vercelUser);
                                  if (d.vercelTeam) parts.push('@' + d.vercelTeam);
                                  extraInfo = parts.join(' ');
                                } else if (isSupabase) {
                                  const parts = [];
                                  if (d.supabaseLoggedIn) parts.push('logged in');
                                  if (d.supabaseLinked) parts.push('linked: ' + d.supabaseProjectRef);
                                  extraInfo = parts.join(', ');
                                } else if (isTrello) {
                                  extraInfo = '';
                                }
                              }

                              // Show CLI missing indicator when not matched and CLI is absent
                              const showCliMissing = !matchByProfile && !cliOk;

                              return (
                                <div key={d.container} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                                  <span style={{ color: matchByProfile ? 'var(--green)' : 'var(--text-dim)', fontSize: 12, fontWeight: 700 }}>
                                    {matchByProfile ? '✓' : '○'}
                                  </span>
                                  <span style={{ color: 'var(--text-dim)', flex: 1 }}>
                                    {d.agentId}
                                    {extraInfo && (
                                      <span style={{ marginLeft: 6, color: 'var(--green)', fontSize: 10 }}>{extraInfo}</span>
                                    )}
                                    {showCliMissing && (
                                      <span style={{ marginLeft: 6, color: 'var(--red)', fontSize: 10 }}>CLI not installed</span>
                                    )}
                                  </span>
                                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                    {showCliMissing ? (
                                      <span style={{ fontSize: 10, color: 'var(--text-dim)', padding: '4px 8px', border: '1px solid var(--border)' }}>
                                        Rebuild image
                                      </span>
                                    ) : matchByProfile ? (
                                      <Button
                                        variant='danger'
                                        size='sm'
                                        loading={syncingContainer === d.container}
                                        disabled={syncingContainer === d.container}
                                        onClick={() => handleDeSyncOne(p.id, d.container)}
                                      >
                                        De-sync
                                      </Button>
                                    ) : (
                                      <Button
                                        variant='primary'
                                        size='sm'
                                        loading={syncingContainer === d.container}
                                        disabled={syncingContainer === d.container}
                                        onClick={() => handleSyncOne(p.id, d.container)}
                                      >
                                        Sync
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                    </div>
                    );
                    })}
                </div>
              )}

              {/* Footer action */}
              <div style={{ padding: '10px 14px', marginTop: 'auto' }}>
                <Button
                  type="button"
                  variant={isConfigured ? 'ghost' : 'primary'}
                  size="sm"
                  onClick={() => setConfigureProviderId(provider.id)}
                >
                  {isConfigured ? '+ Add another' : 'Configure'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Configure / Add Modal */}
      <AddEditModal
        open={!!configureProviderId}
        providers={providers}
        initialProviderId={configureProviderId ?? undefined}
        onClose={() => setConfigureProviderId(null)}
        onSaved={() => { setConfigureProviderId(null); showToast('Credential saved'); void load(); }}
      />

      {/* Edit Modal */}
      {editProfile && (
        <AddEditModal
          open
          providers={providers}
          editProfile={editProfile}
          onClose={() => setEditProfile(null)}
          onSaved={() => { setEditProfile(null); showToast('Credential updated'); void load(); }}
        />
      )}

      {/* Delete Confirm Modal */}
      <Modal open={!!deleteId} onClose={() => setDeleteId(null)} title="Delete Credential" maxWidth={440}>
        <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 20 }}>
          This will permanently delete the credential and its secret. This cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" size="sm" onClick={() => setDeleteId(null)}>Cancel</Button>
          <Button type="button" variant="danger" size="sm" onClick={() => { if (deleteId) void handleDelete(deleteId); }}>Delete</Button>
        </div>
      </Modal>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, padding: '10px 16px',
          background: 'var(--bg2)', border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--text)', zIndex: 9999,
        }}>
          {toast}
        </div>
      )}
    </Page>
  );
}

interface AddEditModalProps {
  open: boolean;
  providers: CredentialProviderDef[];
  initialProviderId?: string;
  editProfile?: CredentialProfile | null;
  onClose: () => void;
  onSaved: () => void;
}

function AddEditModal({ open, providers, initialProviderId, editProfile, onClose, onSaved }: AddEditModalProps) {
  const isEdit = !!editProfile;
  const [label, setLabel] = useState(editProfile?.label ?? '');
  const [fields, setFields] = useState<FieldValues>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerId = editProfile?.providerId ?? initialProviderId ?? providers[0]?.id ?? '';
  const provider = providers.find((p) => p.id === providerId);

  useEffect(() => {
    if (open) {
      setLabel(editProfile?.label ?? '');
      setFields({});
      setError(null);
    }
  }, [open, editProfile]);

  const setField = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!provider) return;
    if (!label.trim()) { setError('Label is required'); return; }
    if (!isEdit) {
      const missingField = provider.fields.find((f) => !fields[f.key]?.trim());
      if (missingField) { setError(`${missingField.label} is required`); return; }
    }

    setSaving(true);
    setError(null);
    try {
      if (isEdit && editProfile) {
        const res = await fetch(`/api/credentials/${editProfile.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label.trim(), secret: fields }),
        });
        const json = await res.json() as { error?: string };
        if (json.error) throw new Error(json.error);
      } else {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId, label: label.trim(), secret: fields }),
        });
        const json = await res.json() as { error?: string };
        if (json.error) throw new Error(json.error);
      }
      onSaved();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const modalTitle = isEdit
    ? `Edit — ${provider?.label ?? providerId}`
    : `Configure — ${provider?.label ?? providerId}`;

  return (
    <Modal open={open} onClose={onClose} title={modalTitle} maxWidth={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {provider && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)' }}>
            {provider.description}
          </div>
        )}

        <Input
          label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={`e.g. Production ${provider?.label ?? ''}`}
        />

        {provider?.fields.map((field) => (
          <div key={field.key}>
            <Input
              label={field.label}
              type={field.type}
              value={fields[field.key] ?? ''}
              onChange={(e) => setField(field.key, e.target.value)}
              placeholder={isEdit ? '(leave empty to keep current)' : field.placeholder}
              autoComplete="off"
            />
            {field.hint && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{field.hint}</div>
            )}
            {provider.id === 'trello' && field.key === 'apiKey' && fields['apiKey'] && (
              <button
                onClick={() =>
                  window.open(
                    `https://trello.com/1/authorize?key=${encodeURIComponent(fields['apiKey'])}&response_type=token&scope=read,write&expiration=never&name=Olympus`,
                    '_blank',
                  )
                }
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  padding: '4px 10px',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                }}
              >
                Generate Trello Token
              </button>
            )}
          </div>
        ))}

        {error && (
          <div style={{ fontSize: 12, color: 'var(--red)', padding: '6px 10px', border: '1px solid var(--red)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" size="sm" loading={saving} onClick={() => void handleSave()}>
            {isEdit ? 'Save Changes' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
