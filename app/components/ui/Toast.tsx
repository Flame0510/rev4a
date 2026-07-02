'use client';

import { useEffect, useState } from 'react';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;
const listeners: Set<(t: ToastItem) => void> = new Set();

export function showToast(message: string, type: ToastType = 'info') {
  const item: ToastItem = { id: nextId++, message, type };
  listeners.forEach((fn) => fn(item));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (t: ToastItem) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 4000);
    };
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  return (
    <div className="ui-toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`ui-toast ui-toast--${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
