'use client';

/**
 * The model list, fetched once and shared by every client that needs it.
 *
 * There used to be two independent copies: this provider, and a private fetch
 * inside PulseChat. Both ran on mount with an empty dependency list, and neither
 * component ever unmounts — so unchecking a model on the Gateway page left the
 * chat panel offering it for the rest of the session, and only a full page reload
 * cleared it.
 *
 * The fix is not to refetch more often. It is to refetch when the answer
 * changes: `refresh()` is called by whoever changes it — the Gateway page after a
 * model toggle, a key save or removal, and a sync; the first-run wizard after
 * saving keys. Everything else just reads.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface ProviderEntry {
  provider: string;
  emoji: string;
  models: { id: string; label: string }[];
}

interface ModelsContextValue {
  providers: ProviderEntry[];
  loaded: boolean;
  /** Re-read the catalogue. Call after changing which models are enabled. */
  refresh: () => void;
}

const ModelsContext = createContext<ModelsContextValue>({
  providers: [],
  loaded: false,
  refresh: () => {},
});

export function ModelsProvider({ children }: { children: React.ReactNode }) {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Refreshes can overlap — two quick toggles — and responses can arrive out of
  // order. Only the most recent request may write.
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++seq.current;
    fetch('/api/models')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (mine !== seq.current) return;
        // An empty array is a real answer — every model disabled, or no provider
        // key — so it must replace the list rather than be discarded as a failure.
        if (Array.isArray(data)) setProviders(data);
        setLoaded(true);
      })
      .catch(() => {
        // Keep the previous list: a failed refresh is not an empty catalogue.
        if (mine === seq.current) setLoaded(true);
      });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <ModelsContext.Provider value={{ providers, loaded, refresh }}>
      {children}
    </ModelsContext.Provider>
  );
}

export function useModels() {
  return useContext(ModelsContext);
}
