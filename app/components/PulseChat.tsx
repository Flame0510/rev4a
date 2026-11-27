'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useModels } from '../lib/models-context';
import Link from 'next/link';
import { Button } from './ui';

const STORAGE_KEY = 'rev4a_pulse_chat';
const MODEL_STORAGE_KEY = 'rev4a-pulse-model';

interface ModelOption {
  id: string;
  label: string;
}

interface ModelGroup {
  provider: string;
  emoji: string;
  models: ModelOption[];
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMessages(messages: Message[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // storage full or unavailable — silently ignore
  }
}

function renderContent(text: string) {
  const parts = text.split(/(\[([^\]]+)\]\(([^)]+)\))/g);
  const result: React.ReactNode[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part?.startsWith('[') && parts[i + 2]) {
      const label = parts[i + 1];
      const href = parts[i + 2];
      const isInternal = href?.startsWith('/');
      result.push(
        isInternal ? (
          <Link key={i} href={href!} style={{ color: 'var(--violet)', textDecoration: 'underline' }}>
            {label}
          </Link>
        ) : (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--violet)', textDecoration: 'underline' }}>
            {label}
          </a>
        ),
      );
      i += 3;
    } else {
      if (part) result.push(<span key={i}>{part}</span>);
      i += 1;
    }
  }
  return result;
}

export default function PulseChat() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  // The shared catalogue, not a private copy. It refreshes when the Gateway page
  // changes what is enabled, so this select cannot go stale mid-session.
  const { providers: modelGroups, loaded: modelsLoaded, failed: modelsFailed, refresh: refreshModels } = useModels();
  const modelsLoading = !modelsLoaded;
  // Only a catalogue that was really read and is empty: a failed read (401 before sign-in) is not one.
  const noModel = modelsLoaded && !modelsFailed && modelGroups.length === 0;
  // Nothing to send to: no selectable model (empty, still loading, or the last read failed).
  const noSelectableModel = !modelGroups.some((g) => g.models.length > 0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the choice valid against the current catalogue.
  //
  // Runs whenever the shared list changes, which includes the moment a model is
  // unchecked on the Gateway page: a selection that just became unavailable is
  // replaced rather than left to fail at send time. The saved preference is only
  // honoured while it is still on offer.
  useEffect(() => {
    if (!modelsLoaded) return;
    const allIds = modelGroups.flatMap((g) => g.models.map((m) => m.id));
    if (allIds.length === 0) { setSelectedModel(''); return; }
    if (selectedModel && allIds.includes(selectedModel)) return;

    let saved: string | null = null;
    try { saved = localStorage.getItem(MODEL_STORAGE_KEY); } catch { /* blocked */ }
    setSelectedModel(saved && allIds.includes(saved) ? saved : allIds[0]);
  }, [modelGroups, modelsLoaded, selectedModel]);

  // Save model preference on change. Not while empty: on mount the selection is ''
  // until the list arrives, and saving that erased the preference before it could
  // be read back.
  useEffect(() => {
    if (!selectedModel) return;
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    } catch {
      // ignore
    }
  }, [selectedModel]);

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [open, messages, noModel]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, messages]);

  // A read that failed (for instance before sign-in) is retried when the panel opens.
  const retried = useRef(false);
  useEffect(() => {
    if (!modelsFailed) { retried.current = false; return; }
    // One retry per failure, however often the panel is opened.
    if (open && !retried.current) {
      retried.current = true;
      refreshModels();
    }
  }, [open, modelsFailed, refreshModels]);

  const newSession = useCallback(() => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
    inputRef.current?.focus();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (noModel || noSelectableModel || !text || streaming) return;

    const userMsg: Message = { role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setStreaming(true);

    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages([...history, assistantMsg]);

    abortRef.current = new AbortController();

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          page: pathname,
          model: selectedModel,
          history: messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: `Error: ${err}` },
        ]);
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      if (!reader) return;

      // A network chunk can end in the middle of a `data:` line: keep the unfinished tail and join it
      // with the next chunk, or that piece of the answer is lost (words went missing mid-sentence).
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = done ? '' : lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              accumulated += delta;
              setMessages((prev) => [
                ...prev.slice(0, -1),
                { role: 'assistant', content: accumulated },
              ]);
            }
          } catch {
            // non-JSON SSE line, skip
          }
        }
        if (done) break;
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: 'Connection error. Try again.' },
        ]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, messages, noModel, noSelectableModel, pathname, selectedModel, streaming]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        className="ochat__trigger"
        aria-label="Pulse — Rev4a Assistant"
        onClick={() => setOpen((v) => !v)}
        title="Pulse — Rev4a Assistant"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {/* Chat panel */}
      {open && (
        <div className="ochat__panel">
          <div className="ochat__header">
            <span className="ochat__header-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--violet)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                <ellipse cx="12" cy="12" rx="10" ry="6" />
                <circle cx="12" cy="12" r="3" fill="var(--violet)" stroke="none" />
              </svg>
              PULSE
            </span>
            {/* No selectable model: an empty picker looks broken, so the header shows none. */}
            {!noSelectableModel && (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={modelsLoading}
                style={{
                  border: '1px solid var(--border)',
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-mono-stack)',
                  fontSize: 11,
                  borderRadius: 0,
                  padding: '1px 4px',
                  cursor: modelsLoading ? 'wait' : 'pointer',
                  outline: 'none',
                  opacity: modelsLoading ? 0.5 : 1,
                }}
                aria-label="Select model"
              >
                {modelsLoading ? (
                  <option value="">…</option>
                ) : (
                  modelGroups.map((group) => (
                    <optgroup key={group.provider} label={`${group.emoji} ${group.provider}`}>
                      {group.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {group.emoji} {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ))
                )}
              </select>
              )}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {messages.length > 0 && (
                <button
                  className="ochat__clear"
                  onClick={newSession}
                  title="New session"
                  aria-label="New session"
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <path d="M2 8h12M8 2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
              <button className="ochat__close" onClick={() => setOpen(false)} aria-label="Close">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          <div className="ochat__messages">
            {!noModel && messages.length === 0 && (
              <p className="ochat__empty">
                Hello! I'm <strong>Pulse</strong>, the oracle of Rev4a. Ask me about the dashboard, data, or the page you're looking at.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`ochat__msg ochat__msg--${m.role}`}>
                {m.role === 'assistant' ? renderContent(m.content) : m.content}
                {m.role === 'assistant' && streaming && i === messages.length - 1 && (
                  <span className="ochat__cursor" />
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {noModel && (
            <div className="ochat__notice" role="status">
              <div className="ochat__notice-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3 2 21h20L12 3z" /><path d="M12 10v5" /><path d="M12 18h.01" />
                </svg>
                Pulse needs a Gateway model
              </div>
              <p className="ochat__notice-text">
                Add a provider API key, or enable a model, on the Gateway page. Your subscriptions power your agents, not Pulse.
              </p>
              <Button type="button" variant="primary" size="sm" onClick={() => router.push('/gateway')}>
                Open Gateway
              </Button>
            </div>
          )}

          <div className="ochat__footer">
            <textarea
              ref={inputRef}
              className="ochat__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={noModel ? 'Add a provider API key in the Gateway to use Pulse' : 'Ask Pulse…'}
              rows={1}
              disabled={noModel || noSelectableModel || streaming}
            />
            <button
              type="button"
              className="ochat__send"
              onClick={send}
              disabled={noModel || noSelectableModel || !input.trim() || streaming}
              aria-label="Send"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
