'use client';

import { useEffect, useState } from 'react';
import {
  fetchRev4aTimezone,
  getCachedRev4aTimezone,
  normalizeRev4aTimezone,
  subscribeRev4aTimezone,
} from '@/lib/timezone';

/**
 * The dashboard time zone. Starts with the cached value (or `initialTimezone` until one is
 * known), loads the real setting, and re-renders when it is saved or reset on the Config page.
 */
export function useRev4aTimezone(initialTimezone?: string): string {
  const [timezone, setTimezone] = useState(() => getCachedRev4aTimezone() ?? normalizeRev4aTimezone(initialTimezone));

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeRev4aTimezone((next) => {
      if (active) setTimezone(next);
    });
    void fetchRev4aTimezone().then((resolved) => {
      if (active) setTimezone(resolved);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return timezone;
}
