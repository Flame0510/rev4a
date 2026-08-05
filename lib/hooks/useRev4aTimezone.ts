'use client';

import { useEffect, useState } from 'react';
import {
  DEFAULT_REV4A_TIMEZONE,
  fetchRev4aTimezone,
  normalizeRev4aTimezone,
  setCachedRev4aTimezone,
} from '@/lib/timezone';

export function useRev4aTimezone(initialTimezone = DEFAULT_REV4A_TIMEZONE): string {
  const [timezone, setTimezone] = useState(normalizeRev4aTimezone(initialTimezone));

  useEffect(() => {
    setCachedRev4aTimezone(initialTimezone);
    let active = true;

    void fetchRev4aTimezone().then((resolvedTimezone) => {
      if (active) setTimezone(resolvedTimezone);
    });

    return () => {
      active = false;
    };
  }, [initialTimezone]);

  return timezone;
}
