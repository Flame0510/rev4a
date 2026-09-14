'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Page, PageHeader, Button, Modal, Input, Pill, RemoveButton } from '@/app/components/ui';
import { CredentialCardsSkeleton, AgentSyncRowsSkeleton } from '@/app/components/Skeleton';
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
  notion: '#050505',
};

/**
 * Read a mutation's JSON body, failing on anything that is not a 2xx.
 *
 * Testing `json.error` alone trusted the response to be JSON and to carry that
 * field. A proxy 502, or Next's own HTML error page, parses to `{}` — no
 * `error` — so the check passed and the caller announced a success for a
 * request that never happened. The credentials routes do return `{ error }` on
 * every path they control, which is exactly why this went unnoticed: the gap is
 * everything in front of them.
 */
async function readMutation<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  if (json.error) throw new Error(json.error);
  return json;
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
    displayName?: string;
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
    notionLoggedIn: boolean;
    matchedProfiles?: { profileId: string; providerId: string; label: string }[];
    installedProviders?: string[];
    /** Present instead of the fields above when the probe failed for this
     *  container. Every other property is absent, so it must be checked first. */
    error?: string;
  }[]>([]);

  const [configureProviderId, setConfigureProviderId] = useState<string | null>(null);
  const [editProfile, setEditProfile] = useState<CredentialProfile | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [detectRefreshing, setDetectRefreshing] = useState(false);

  // Whether detect has ever answered, success or failure. A one-way latch, and
  // deliberately not reset per call: every mutation fires a single page-wide
  // `loadDetect()`, so clearing it each time would hide every delete button on
  // the page for the duration of any one sync.
  const [detectLoaded, setDetectLoaded] = useState(false);

  // Distinct from `detectLoaded`, which only records that the call finished.
  // A failed call finishes too, leaving `detectData` empty — indistinguishable
  // from a fleet that genuinely holds nothing, which is what unlocked Delete on
  // every credential the moment the session expired or Docker went down.
  const [detectFailed, setDetectFailed] = useState(false);

  // One key identifies the single mutation allowed in flight, e.g.
  // 'delete:cred_123' or 'sync:cred_123:agent_ab'. Replaces the scattered
  // per-action booleans: the previous `syncingContainer` held only a container
  // name, but the per-agent rows are rendered once per profile, so syncing one
  // profile put every other profile's button for that container into a
  // spinner too. Including the profile id in the key removes that entirely.
  const [busy, setBusy] = useState<string | null>(null);

  // The ref is the authoritative guard, the state only drives rendering.
  // `busy` is read from the render that produced the click, so two clicks
  // landing before React commits the disabled button would both see null and
  // both fire. A ref is updated synchronously, so the second one cannot.
  const busyRef = useRef<string | null>(null);
  const claimBusy = (key: string): boolean => {
    if (busyRef.current) return false;
    busyRef.current = key;
    setBusy(key);
    return true;
  };
  const releaseBusy = () => {
    busyRef.current = null;
    setBusy(null);
  };

  // Held so a second message cannot be cleared by the first one's timer: two
  // syncs 2.5s apart left the later toast on screen for half a second before an
  // older, unowned timeout fired and wiped it.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /**
   * Apply a confirmed sync/de-sync to the detected state right away.
   *
   * The Sync / De-sync label is driven by `matchedProfiles`, which only detect
   * fills in — and detect takes seconds. Waiting for it left the button live
   * again but still showing the state from before the click, so it invited a
   * second, pointless press. This is not a guess: the server has already
   * confirmed the change, so the new state is known. The detect refresh that
   * follows just corroborates it.
   */
  const applyMatchLocally = (
    profile: CredentialProfile,
    container: string,
    matched: boolean,
  ) => {
    setDetectData((prev) => prev.map((d) => {
      if (d.container !== container) return d;
      // Keyed on the provider, not the profile. A container holds one credential
      // per provider, and both operations act on the provider as a whole:
      // delivery cleans it before writing, de-sync removes its config outright.
      // So no sibling profile can survive either one, and filtering by profile id
      // left the previous holder still marked as installed — two rows showing a
      // green tick, each offering a De-sync that would take the other's token.
      const without = (d.matchedProfiles ?? []).filter((m) => m.providerId !== profile.providerId);

      // `installedProviders` has to move together with `matchedProfiles`.
      // Updating only the latter left the row reading the two against each
      // other — provider still listed as installed, no profile accounting for
      // it — which is exactly the ◆ "unknown credential" state, held for the
      // whole seconds-long gap until detect answered and cleared it. The de-sync
      // path removes the provider's credential from the container outright, so
      // dropping it here is what the container actually looks like; the guard
      // keeps it if some other profile of the same provider is still matched.
      // `without` can no longer hold this provider, so there is nothing left to
      // check before dropping it: the guard that used to stand here was dead the
      // moment the filter above became provider-keyed.
      const installed = new Set(d.installedProviders ?? []);
      if (matched) installed.add(profile.providerId);
      else installed.delete(profile.providerId);

      return {
        ...d,
        matchedProfiles: matched
          ? [...without, { profileId: profile.id, providerId: profile.providerId, label: profile.label }]
          : without,
        installedProviders: [...installed],
      };
    }));
  };

  /**
   * The two endpoints are split because they cost wildly different amounts and
   * carry different things. /api/credentials is a single SQLite read (~3ms) and
   * holds everything the cards need; /api/credentials/detect shells into every
   * agent container and takes seconds, and only feeds the per-agent rows.
   *
   * Keeping them apart is what lets a create or a delete show up immediately:
   * the mutation paths refresh the cheap one and let the expensive one catch up
   * behind, instead of making the user wait on work their change did not need.
   */
  const loadProfiles = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch('/api/credentials', { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setData(await res.json() as ApiData);
  }, []);

  // Only the most recently started detect may apply its answer. Two can easily
  // overlap: a mutation fires one without awaiting it, then releases the lock
  // within milliseconds, so a second mutation starts another while the first is
  // still running. Whichever returned last used to win — often the older one,
  // which knows nothing of the newer change.
  const detectSeq = useRef(0);
  const detectAbortRef = useRef<AbortController | null>(null);

  const loadDetect = useCallback(async (signal?: AbortSignal) => {
    // Cancel any detect still running: it costs seconds of work inside every
    // agent container, and its answer would be discarded by the sequence guard
    // below anyway. The guard stays — abortion frees the work, the guard is what
    // makes a late reply harmless.
    detectAbortRef.current?.abort();
    const controller = new AbortController();
    detectAbortRef.current = controller;
    signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const seq = ++detectSeq.current;
    setDetectRefreshing(true);
    try {
      const res = await fetch('/api/credentials/detect', { signal: controller.signal });
      // An error response is still valid JSON, so without this check a 401 or a
      // 500 body flowed through `json.agents ?? []` and became an empty fleet —
      // reported as success. The page then stated, as fact, that no agent holds
      // any credential. Throwing here keeps whatever data was already on screen.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { agents?: unknown[] };
      if (seq === detectSeq.current) {
        setDetectData((json.agents ?? []) as typeof detectData);
        setDetectFailed(false);
      }
    } catch {
      // Only the newest call may report; a superseded one losing is not a
      // failure, and an abort is our own doing.
      if (seq === detectSeq.current && !controller.signal.aborted) setDetectFailed(true);
      // Best-effort: every card renders without this. Detect used to be awaited
      // inside the page-wide try, so one failure there blanked a page whose real
      // data had already arrived.
    } finally {
      if (!controller.signal.aborted) setDetectLoaded(true);
      // A superseded call must not clear the flag — the newer one is still
      // running, and the rows it feeds are still stale.
      if (seq === detectSeq.current && !controller.signal.aborted) setDetectRefreshing(false);
    }
  }, []);

  /**
   * Only the cheap call gates the first paint. Detect shells into every agent
   * container and takes seconds; awaiting it here held back the whole page —
   * cards, stored profiles, the Add buttons — for work none of them need. It is
   * started without being awaited, and the per-agent rows show a skeleton until
   * it lands.
   */
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      await loadProfiles(signal);
      setError(null);
    } catch (e: unknown) {
      if ((e as Error)?.name === 'AbortError') return;
      setError((e as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
    void loadDetect(signal);
  }, [loadProfiles, loadDetect]);

  /**
   * Refresh after a create, edit or delete.
   *
   * Awaits only the cheap call, so the caller can keep its button spinning for
   * the few milliseconds until the change is actually on screen, then closes.
   * Detect is deliberately not awaited.
   *
   * Never rejects. The mutation has already succeeded by the time this runs, so
   * letting a failed re-read propagate would surface as "save failed" on a saved
   * credential — and invite the user to create it a second time.
   */
  const refreshAfterChange = useCallback(async () => {
    try {
      await loadProfiles();
    } catch (e: unknown) {
      showToast(`Saved, but the list could not be refreshed: ${(e as Error).message}`);
    }
    void loadDetect();
  }, [loadProfiles, loadDetect]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleSyncOne = async (profile: CredentialProfile, container: string, label?: string) => {
    if (!claimBusy(`sync:${profile.id}:${container}`)) return;
    try {
      const res = await fetch(`/api/credentials/${profile.id}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containers: [container] }),
      });
      const json = await readMutation<{ results?: { container: string; status: string }[] }>(res);
      const ok = json.results?.[0]?.status === 'ok';
      if (ok) applyMatchLocally(profile, container, true);
      showToast(ok ? `Synced to ${label || container}` : 'Sync error');
    } catch (e: unknown) {
      showToast((e as Error).message);
    } finally {
      releaseBusy();
    }
    // Refreshed outside the busy window on purpose. Detect takes seconds, and
    // `disabled={!!busy}` is page-wide, so awaiting it here left every button
    // on the page dead for that whole time after each sync. The dimmed rows
    // already say the detected state is being re-read.
    void loadDetect();
  };

  const handleDeSyncOne = async (profile: CredentialProfile, container: string, label?: string) => {
    if (!claimBusy(`desync:${profile.id}:${container}`)) return;
    try {
      const res = await fetch(`/api/credentials/${profile.id}/sync`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container }),
      });
      await readMutation<{ ok?: boolean }>(res);
      applyMatchLocally(profile, container, false);
      showToast(`Removed from ${label || container}`);
    } catch (e: unknown) {
      showToast((e as Error).message);
    } finally {
      releaseBusy();
    }
    // Same reasoning as handleSyncOne above.
    void loadDetect();
  };

  const handleDelete = async (id: string) => {
    // Without this the confirm dialog stayed open and clickable for the whole
    // request — `setDeleteId(null)` ran only after the await — so the button
    // could be pressed repeatedly, firing a DELETE, a toast and a full reload
    // each time.
    if (!claimBusy(`delete:${id}`)) return;
    try {
      const res = await fetch(`/api/credentials/${id}`, { method: 'DELETE' });
      await readMutation<Record<string, never>>(res);
      setDeleteId(null);
      showToast('Credential deleted');
      await refreshAfterChange();
    } catch (e: unknown) {
      showToast((e as Error).message);
    } finally {
      releaseBusy();
    }
  };

  if (loading) {
    // The header carries the same description as the loaded state on purpose:
    // omitting it here made the title block grow by one line the moment the
    // data arrived, shifting the whole grid down.
    return (
      <Page>
        <PageHeader
          eyebrow=""
          title="Credentials"
          description="Store third-party credentials once, sync to all agent containers."
        />
        <CredentialCardsSkeleton />
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
        eyebrow=""
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
          const accentColor = PROVIDER_COLOR[provider.id] ?? 'var(--violet)';

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
                  <a href={provider.docsUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--violet)', marginLeft: 6, fontSize: 11 }}>
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
                    const isNotion = providerType === 'notion';

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
                          <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => setEditProfile(p)}>Edit</Button>
                          {/* Shown only once detect has actually answered AND reports no
                              match. `.some()` on an empty array is false, so before this
                              guard a fleet we simply had not heard from yet — or an error
                              response — read as "synced nowhere", offering a delete the UI
                              means to withhold for a credential that is in use. */}
                          {/* Withheld unless detect has answered for *every* agent and
                              none of them holds this credential. A container whose probe
                              failed reports no `matchedProfiles` at all, which read as
                              "not installed here" — so one unreachable agent was enough
                              to offer deleting a credential that may well be installed
                              on it, leaving it live in a container with no vault record. */}
                          {detectLoaded
                            && !detectFailed
                            && !detectData.some((d) => d.error)
                            && !detectData.some((d) => d.matchedProfiles?.some((m) => m.profileId === p.id)) && (
                            <RemoveButton label={p.label ?? p.id} disabled={!!busy} onClick={() => setDeleteId(p.id)} />
                          )}
                        </div>
                      </div>
                      {/* Agent detect status — all containers shown for every provider */}
                      {/* Three states, kept distinct on purpose: not answered
                          yet (skeleton), answered with no agents (nothing), and
                          answered with agents (the rows). Collapsing the first
                          two would present "no agent holds this credential" as
                          fact while we are still asking. */}
                      {!detectLoaded && <AgentSyncRowsSkeleton />}
                      {/* Said out loud rather than rendered as an empty fleet.
                          Silence here reads as "no agent holds this", which is
                          the one conclusion a failed probe cannot support. */}
                      {detectLoaded && detectFailed && (
                        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--red)' }}>
                          Agent status unavailable
                          {detectData.length > 0 ? ' — showing the last known state' : ''}
                        </div>
                      )}
                      {detectLoaded && detectData.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {detectData.map((d) => {
                              // Checked before anything else: on an error entry every other field is
                              // undefined, which made `cliOk` falsy and had the row announce "CLI not
                              // installed" — sending the user to rebuild a base image over what is
                              // really a container that did not answer.
                              if (d.error) {
                                return (
                                  <div key={d.container || d.agentId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                                    <span style={{ color: 'var(--red)', fontSize: 12, fontWeight: 700 }}>!</span>
                                    <span style={{ color: 'var(--text-dim)', flex: 1 }}>
                                      {d.displayName || d.agentId}
                                      <span style={{ marginLeft: 6, color: 'var(--red)', fontSize: 10 }}>unreachable</span>
                                    </span>
                                  </div>
                                );
                              }

                              const matchByProfile = d.matchedProfiles?.some((m) => m.profileId === p.id);
                              // A credential is installed for this provider, but it is not
                              // this profile's — and not any stored profile's either. It is
                              // what an edited-then-not-resynced credential looks like, and
                              // also a token installed by hand or left by a deleted profile.
                              // The slot holds someone else's credential. Syncing this
                              // profile evicts it, so the button has to say so — whether or
                              // not the vault can name the occupant.
                              const providerOccupied =
                                !matchByProfile
                                && (d.installedProviders?.includes(p.providerId) ?? false);
                              // The vault CAN name it: another stored profile of the same
                              // provider matches. Not foreign, just not this one.
                              const heldByOther = providerOccupied
                                ? (d.matchedProfiles ?? []).find((m) => m.providerId === p.providerId)
                                : undefined;
                              // Nobody accounts for it — the ◆ case, kept narrow.
                              const foreignCredential = providerOccupied && !heldByOther;

                              // Determine CLI installed status for this provider on this agent
                              const cliOk = isGithub
                                ? d.githubCliInstalled
                                : isVercel
                                  ? d.vercelCliInstalled
                                  : isSupabase
                                    ? d.supabaseCliInstalled
                                    // Trello and Notion are both used through their REST
                                    // API, so there is no CLI whose absence could block
                                    // them; `trelloCliInstalled` stays in the response for
                                    // shape compatibility but no longer gates anything.
                                    : true;

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
                                <div key={d.container || d.agentId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                                  {/* Only the detected state fades while detect is
                                      re-read — never the buttons. Dimming their
                                      ancestor made them read as disabled while they
                                      were still perfectly clickable. */}
                                  <span style={{
                                    color: matchByProfile
                                      ? 'var(--green)'
                                      : foreignCredential ? 'var(--yellow)' : 'var(--text-dim)',
                                    fontSize: 12, fontWeight: 700,
                                    opacity: detectRefreshing ? 0.4 : 1,
                                    transition: 'opacity 0.15s',
                                  }}>
                                    {matchByProfile ? '✓' : foreignCredential ? '◆' : '○'}
                                  </span>
                                  <span style={{
                                    color: 'var(--text-dim)', flex: 1,
                                    opacity: detectRefreshing ? 0.4 : 1,
                                    transition: 'opacity 0.15s',
                                  }}>
                                    {d.displayName || d.agentId}
                                    {extraInfo && (
                                      <span style={{ marginLeft: 6, color: 'var(--green)', fontSize: 10 }}>{extraInfo}</span>
                                    )}
                                    {foreignCredential && (
                                      <span style={{ marginLeft: 6, color: 'var(--yellow)', fontSize: 10 }}>
                                        unknown credential
                                      </span>
                                    )}
                                    {heldByOther && (
                                      <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 10 }}>
                                        held by {heldByOther.label}
                                      </span>
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
                                        loading={busy === `desync:${p.id}:${d.container}`}
                                        disabled={!!busy}
                                        onClick={() => handleDeSyncOne(p, d.container, d.displayName || d.agentId)}
                                      >
                                        {busy === `desync:${p.id}:${d.container}` ? 'Removing…' : 'De-sync'}
                                      </Button>
                                    ) : (
                                      <Button
                                        variant='primary'
                                        size='sm'
                                        loading={busy === `sync:${p.id}:${d.container}`}
                                        disabled={!!busy}
                                        title={heldByOther
                                          ? `Replaces the credential from “${heldByOther.label}” on this agent`
                                          : providerOccupied
                                            ? 'Replaces the credential currently installed on this agent'
                                            : undefined}
                                        onClick={() => handleSyncOne(p, d.container, d.displayName || d.agentId)}
                                      >
                                        {busy === `sync:${p.id}:${d.container}` ? 'Syncing…' : 'Sync'}
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
                  disabled={!!busy}
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
        onSaved={async () => { await refreshAfterChange(); setConfigureProviderId(null); showToast('Credential saved'); }}
      />

      {/* Edit Modal */}
      {editProfile && (
        <AddEditModal
          open
          providers={providers}
          editProfile={editProfile}
          onClose={() => setEditProfile(null)}
          onSaved={async () => { await refreshAfterChange(); setEditProfile(null); showToast('Credential updated'); }}
        />
      )}

      {/* Delete Confirm Modal */}
      <Modal open={!!deleteId} onClose={() => { if (!busy) setDeleteId(null); }} title="Delete Credential" maxWidth={440}>
        <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 20 }}>
          This will permanently delete the credential and its secret. This cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" size="sm" disabled={!!busy} onClick={() => setDeleteId(null)}>Cancel</Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            loading={busy === `delete:${deleteId}`}
            disabled={!!busy}
            onClick={() => { if (deleteId) void handleDelete(deleteId); }}
          >
            {busy === `delete:${deleteId}` ? 'Deleting…' : 'Delete'}
          </Button>
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
  /** May be async: the modal keeps its Save button spinning until it settles,
   *  so the dialog closes once the new data is on screen, not before. */
  onSaved: () => void | Promise<void>;
}

function AddEditModal({ open, providers, initialProviderId, editProfile, onClose, onSaved }: AddEditModalProps) {
  const isEdit = !!editProfile;
  const [label, setLabel] = useState(editProfile?.label ?? '');
  const [fields, setFields] = useState<FieldValues>({});
  const [saving, setSaving] = useState(false);
  // Rule 6a: `saving` is read from the render that produced the click, so two
  // clicks landing before React commits the disabled button both see false and
  // both POST — and `createProfile` mints a fresh id each time, so both persist.
  const savingRef = useRef(false);
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

    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (isEdit && editProfile) {
        const res = await fetch(`/api/credentials/${editProfile.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label.trim(), secret: fields }),
        });
        await readMutation<Record<string, never>>(res);
      } else {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId, label: label.trim(), secret: fields }),
        });
        await readMutation<{ id?: string }>(res);
      }
      await onSaved();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      savingRef.current = false;
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

        {provider?.fields.map((field) => {
          // Trello is the only provider whose second value is minted rather than
          // copied: the token comes back from an authorize URL built out of the
          // API key, so the control lives under the token field it fills, and
          // stays visible-but-disabled until the key it needs is there. Hiding
          // it until then made it appear out of nowhere, and left the token
          // field's hint pointing at a button that was not on screen.
          const isTrelloToken = provider.id === 'trello' && field.key === 'token';
          const apiKeyReady = (fields['apiKey'] ?? '').trim().length > 0;

          return (
            <div key={field.key}>
              <Input
                label={field.label}
                type={field.type}
                value={fields[field.key] ?? ''}
                onChange={(e) => setField(field.key, e.target.value)}
                placeholder={isEdit ? '(leave empty to keep current)' : field.placeholder}
                autoComplete="off"
              />
              {(field.hint || field.docsUrl) && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                  {field.hint}
                  {field.docsUrl && (
                    <a
                      href={field.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--violet)', marginLeft: field.hint ? 6 : 0 }}
                    >
                      {field.docsLabel ?? 'docs'} ↗
                    </a>
                  )}
                </div>
              )}
              {isTrelloToken && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={!apiKeyReady}
                    onClick={() =>
                      window.open(
                        `https://trello.com/1/authorize?key=${encodeURIComponent(fields['apiKey'] ?? '')}&response_type=token&scope=read,write&expiration=never&name=Rev4a`,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                  >
                    Generate Trello Token ↗
                  </Button>
                  {!apiKeyReady && (
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      {isEdit
                        ? 'Re-enter the API Key to generate a new token'
                        : 'Fill in the API Key first'}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {error && (
          <div style={{ fontSize: 12, color: 'var(--red)', padding: '6px 10px', border: '1px solid var(--red)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" size="sm" loading={saving} onClick={() => void handleSave()}>
            {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
