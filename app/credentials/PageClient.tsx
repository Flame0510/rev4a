'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Page, PageHeader, Button, Modal, Input, Pill, RemoveButton } from '@/app/components/ui';
import { CredentialCardsSkeleton, AgentSyncRowsSkeleton } from '@/app/components/Skeleton';
import type { CredentialProfile } from '@/lib/credentials/vault';
import type { CredentialProviderDef } from '@/lib/credentials/providers';
import type { CredentialAssignment } from '@/lib/credentials/assignments';
import { CODEX_NOTE } from '@/lib/credentials/native';

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

  // What is switched on for which agent. Read from the vault database, so it is instant
  // and never waits for detect.
  const [assignments, setAssignments] = useState<CredentialAssignment[]>([]);
  // Containers that exist (running or stopped): tells a stopped agent from a missing one.
  const [knownAgents, setKnownAgents] = useState<string[]>([]);

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
    /** The agent's default model runs on the ChatGPT (Codex) runtime. */
    codex?: boolean;
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
  // the page for the duration of any one switch.
  const [detectLoaded, setDetectLoaded] = useState(false);

  // Distinct from `detectLoaded`, which only records that the call finished.
  // A failed call finishes too, leaving `detectData` empty — indistinguishable
  // from a fleet that genuinely holds nothing, which is what unlocked Delete on
  // every credential the moment the session expired or Docker went down.
  const [detectFailed, setDetectFailed] = useState(false);

  // One key identifies the single mutation allowed in flight, e.g.
  // 'delete:cred_123' or 'on:cred_123:agent_ab'. Replaces the scattered
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
   * Apply a confirmed switch-on/off to the detected (old-way) state right away.
   *
   * The old-way label is driven by `matchedProfiles`, which only detect
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
      // switching on replaces it, switching off removes it outright.
      // So no sibling profile can survive either one, and filtering by profile id
      // left the previous holder still marked as installed — two rows showing a
      // green tick, each offering a Remove that would take the other's token.
      const without = (d.matchedProfiles ?? []).filter((m) => m.providerId !== profile.providerId);

      // `installedProviders` has to move together with `matchedProfiles`.
      // Updating only the latter left the row reading the two against each
      // other — provider still listed as installed, no profile accounting for
      // it — which is exactly the ◆ "unknown credential" state, held for the
      // whole seconds-long gap until detect answered and cleared it. The switch-off
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
  // Assignments are secondary: without them every row reads as off, but the cards still render.
  const loadAssignments = useCallback(async (signal?: AbortSignal) => {
    try {
      const a = await fetch('/api/credentials/assignments', { signal });
      if (!a.ok) return;
      const json = await a.json() as { assignments?: CredentialAssignment[]; knownAgents?: string[] };
      setAssignments(json.assignments ?? []);
      setKnownAgents(json.knownAgents ?? []);
    } catch (e: unknown) {
      if ((e as Error)?.name === 'AbortError') throw e;
    }
  }, []);

  const loadProfiles = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch('/api/credentials', { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setData(await res.json() as ApiData);
    await loadAssignments(signal);
  }, [loadAssignments]);

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

  /**
   * Switch a credential on or off for one agent. One busy key per switch, e.g.
   * 'on:cred_1:agent_a'. On success the new assignment is applied at once: the server
   * has confirmed it, and the detect refresh that follows only corroborates it.
   */
  const handleToggle = async (profile: CredentialProfile, container: string, label: string, enable: boolean, forget = false) => {
    if (!claimBusy(`${forget ? 'forget' : enable ? 'on' : 'off'}:${profile.id}:${container}`)) return;
    try {
      const res = await fetch(`/api/credentials/${profile.id}/assignments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forget ? { agent: container, forget: true } : { agent: container, enabled: enable, mode: 'env' }),
      });
      const json = await readMutation<{
        results?: { container: string; status: string; error?: string; warning?: string }[];
        agents?: { container: string; assignment: CredentialAssignment | null }[];
      }>(res);
      const result = json.results?.[0];
      // Every profile of the provider is re-read, not only this one: switching one on replaces
      // the other profile's assignment on that agent, and its row must say so.
      await loadAssignments();
      if (result?.status === 'ok') {
        // The old-way files for this provider are gone after either action.
        applyMatchLocally(profile, container, false);
        const done = forget ? `Forgot ${label}` : enable ? `Switched on for ${label}` : `Switched off for ${label}`;
        showToast(result.warning ? `${done} — ${result.warning}` : done);
      } else {
        showToast(result?.error ?? 'Failed');
      }
    } catch (e: unknown) {
      showToast((e as Error).message);
    } finally {
      releaseBusy();
    }
    // Outside the busy window, as before: detect takes seconds.
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
          description="Store third-party credentials once, switch them on for the agents that need them."
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
        description="Store third-party credentials once, switch them on for the agents that need them."
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
                            <span>delivered {formatRelative(p.lastSyncedAt)}</span>
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
                            && !detectData.some((d) => d.matchedProfiles?.some((m) => m.profileId === p.id))
                            && !assignments.some((a) => a.profileId === p.id && (a.enabled || a.pendingRemoval)) && (
                            <RemoveButton label={p.label ?? p.id} disabled={!!busy} onClick={() => setDeleteId(p.id)} />
                          )}
                        </div>
                      </div>
                      {/* Protected mode (secret kept out of the agent, egress proxy) is a separate decision. */}
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                        <span>Mode: environment variable</span>
                        <Button type="button" variant="ghost" size="sm" disabled title="Coming later">Protected — coming later</Button>
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
                              const assignment = assignments.find((a) => a.profileId === p.id && a.agentId === d.container);
                              const isOn = !!assignment?.enabled;
                              const failed = isOn && !!assignment?.lastError;
                              const native = isOn && !failed;
                              // A switch-off that failed: the token may still be on the agent.
                              const pending = !!assignment?.pendingRemoval;
                              // Another profile of this provider is on here; its entries took this one's place.
                              const replacer = !isOn && !pending
                                ? assignments.find((o) => o.enabled && o.agentId === d.container && o.profileId !== p.id
                                  && profiles.find((x) => x.id === o.profileId)?.providerId === p.providerId)
                                : undefined;
                              const replacedBy = replacer ? profiles.find((x) => x.id === replacer.profileId)?.label : undefined;
                              // Written by an earlier release (CLI config files + TOOLS.md row) and
                              // not yet moved: it keeps working until the operator switches it on.
                              const oldWay = !isOn && !pending && !!matchByProfile;
                              const heldByOther = !isOn && !pending && !replacedBy && !matchByProfile
                                ? (d.matchedProfiles ?? []).find((m) => m.providerId === p.providerId)
                                : undefined;
                              // Only gh, vercel and supabase have a CLI that could be missing from the
                              // image. The token still reaches the agent as an environment variable, so
                              // this is a note and never blocks the switch. Trello and Notion are used
                              // through their REST API, so nothing about a CLI applies to them.
                              const cliMissing = (isGithub && !d.githubCliInstalled)
                                || (isVercel && !d.vercelCliInstalled)
                                || (isSupabase && !d.supabaseCliInstalled);
                              const key = `${p.id}:${d.container}`;
                              const label = d.displayName || d.agentId;
                              const dim = { opacity: detectRefreshing ? 0.4 : 1, transition: 'opacity 0.15s' } as const;

                              return (
                                <div key={d.container || d.agentId} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{
                                      color: native ? 'var(--green)' : failed || pending ? 'var(--red)' : oldWay ? 'var(--yellow)' : 'var(--text-dim)',
                                      fontSize: 12, fontWeight: 700, ...dim,
                                    }}>
                                      {native ? '✓' : failed || pending ? '!' : oldWay ? '◆' : '○'}
                                    </span>
                                    <span style={{ color: 'var(--text-dim)', flex: 1, ...dim }}>
                                      {label}
                                      {native && (
                                        <span style={{ marginLeft: 6, color: 'var(--green)', fontSize: 10 }}>delivered natively</span>
                                      )}
                                      {oldWay && (
                                        <span style={{ marginLeft: 6, color: 'var(--yellow)', fontSize: 10 }}>
                                          Delivered the old way — re-sync to move to native
                                        </span>
                                      )}
                                      {replacedBy && (
                                        <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 10 }}>
                                          replaced by {replacedBy}
                                        </span>
                                      )}
                                      {heldByOther && (
                                        <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 10 }}>
                                          held by {heldByOther.label}
                                        </span>
                                      )}
                                      {cliMissing && (
                                        <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 10 }}>CLI not in this image</span>
                                      )}
                                    </span>
                                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                      {pending && (
                                        <Button
                                          variant='danger'
                                          size='sm'
                                          loading={busy === `off:${key}`}
                                          disabled={!!busy}
                                          onClick={() => handleToggle(p, d.container, label, false)}
                                        >
                                          {busy === `off:${key}` ? 'Retrying…' : 'Retry removal'}
                                        </Button>
                                      )}
                                      {(isOn || oldWay) && (
                                        <Button
                                          variant='danger'
                                          size='sm'
                                          loading={busy === `off:${key}`}
                                          disabled={!!busy}
                                          onClick={() => handleToggle(p, d.container, label, false)}
                                        >
                                          {busy === `off:${key}` ? 'Switching off…' : isOn ? 'Switch off' : 'Remove'}
                                        </Button>
                                      )}
                                      {!native && !pending && (
                                        <Button
                                          variant='primary'
                                          size='sm'
                                          loading={busy === `on:${key}`}
                                          disabled={!!busy}
                                          title={heldByOther
                                            ? `Replaces the credential from “${heldByOther.label}” on this agent`
                                            : undefined}
                                          onClick={() => handleToggle(p, d.container, label, true)}
                                        >
                                          {busy === `on:${key}`
                                            ? 'Switching on…'
                                            : failed ? 'Retry' : oldWay ? 'Move to native' : 'Switch on'}
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                  {(failed || pending) && assignment?.lastError && (
                                    <div style={{ marginLeft: 18, color: 'var(--red)', fontSize: 10 }}>
                                      {pending ? 'Removal failed — the token may still be on this agent. ' : ''}{assignment.lastError}
                                    </div>
                                  )}
                                  {isOn && d.codex && (
                                    <div style={{ marginLeft: 18, color: 'var(--text-dim)', fontSize: 10 }}>{CODEX_NOTE}</div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      {/* Assignments whose agent detect did not list: stopped (switch off runs when Rev4a
                          next applies the agent's config) or deleted (the row can only be forgotten). */}
                      {detectLoaded && assignments
                        .filter((a) => a.profileId === p.id && (a.enabled || a.pendingRemoval || a.lastError)
                          && !detectData.some((d) => d.container === a.agentId))
                        .map((a) => {
                          const exists = knownAgents.includes(a.agentId);
                          const k = `${p.id}:${a.agentId}`;
                          return (
                            <div key={a.agentId} style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                              <span style={{ color: 'var(--yellow)', fontWeight: 700 }}>◆</span>
                              <span style={{ color: 'var(--text-dim)', flex: 1 }}>
                                {a.agentId}
                                <span style={{ marginLeft: 6, fontSize: 10 }}>{exists ? 'not running' : 'no longer exists'}</span>
                                {a.lastError && <span style={{ marginLeft: 6, color: 'var(--red)', fontSize: 10 }}>{a.lastError}</span>}
                              </span>
                              {exists ? (
                                <Button variant='danger' size='sm' loading={busy === `off:${k}`} disabled={!!busy}
                                  onClick={() => handleToggle(p, a.agentId, a.agentId, false)}>
                                  {busy === `off:${k}` ? 'Switching off…' : a.pendingRemoval ? 'Retry removal' : 'Switch off'}
                                </Button>
                              ) : (
                                <Button variant='secondary' size='sm' loading={busy === `forget:${k}`} disabled={!!busy}
                                  onClick={() => handleToggle(p, a.agentId, a.agentId, false, true)}>
                                  {busy === `forget:${k}` ? 'Forgetting…' : 'Forget'}
                                </Button>
                              )}
                            </div>
                          );
                        })}
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
          onSaved={async (failed) => {
            await refreshAfterChange();
            setEditProfile(null);
            showToast(failed?.length ? `Credential updated, but not delivered to: ${failed.join(', ')}` : 'Credential updated');
          }}
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
  onSaved: (redeliveryFailed?: string[]) => void | Promise<void>;
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
    let failedAgents: string[] | undefined;
    try {
      if (isEdit && editProfile) {
        const res = await fetch(`/api/credentials/${editProfile.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label.trim(), secret: fields }),
        });
        const json = await readMutation<{ redeliveryFailed?: string[] }>(res);
        failedAgents = json.redeliveryFailed;
      } else {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId, label: label.trim(), secret: fields }),
        });
        await readMutation<{ id?: string }>(res);
      }
      await onSaved(failedAgents);
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
