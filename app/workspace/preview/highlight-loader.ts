/**
 * Lazy highlight.js loader for the Workspace previews. highlight.js and its languages are
 * fetched on first use (one shared promise), so no other page pays for them. Any failure
 * resolves to null and the callers show plain text: a missing highlighter is never a crash.
 *
 * The only HTML this module produces is what `hljs.highlight(...).value` returns for text it was
 * given; highlight.js escapes that text. Never put file content into HTML any other way.
 */
import { fenceLanguage, type PreviewLang, hasOverlongLine } from './preview-utils';

type Hljs = typeof import('highlight.js/lib/core').default;

/** Markdown blocks above this size, or beyond this total per container, stay plain. */
export const BLOCK_MAX_CHARS = 64 * 1024;
export const BLOCKS_MAX_TOTAL_CHARS = 200 * 1024;

let loading: Promise<Hljs | null> | null = null;

// Static import paths, so the bundler can split them into one lazy chunk.
const LOADERS: Record<PreviewLang, () => Promise<{ default: unknown }>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  xml: () => import('highlight.js/lib/languages/xml'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  sql: () => import('highlight.js/lib/languages/sql'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  swift: () => import('highlight.js/lib/languages/swift'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  diff: () => import('highlight.js/lib/languages/diff'),
};

export function loadHighlighter(): Promise<Hljs | null> {
  if (!loading) {
    loading = (async () => {
      try {
        const core = (await import('highlight.js/lib/core')).default;
        const names = Object.keys(LOADERS) as PreviewLang[];
        const mods = await Promise.all(names.map((n) => LOADERS[n]()));
        names.forEach((n, i) => {
          const m = mods[i] as { default?: unknown };
          core.registerLanguage(n, (m.default ?? m) as Parameters<typeof core.registerLanguage>[1]);
        });
        return core;
      } catch {
        loading = null; // allow a retry on the next call
        return null;
      }
    })();
  }
  return loading;
}

/** Highlighted HTML (spans only) for `text` in `lang`, or null when highlighting is unavailable (or the text has an overlong line). */
export async function highlightToHtml(text: string, lang: PreviewLang): Promise<string | null> {
  if (hasOverlongLine(text)) return null;
  const hljs = await loadHighlighter();
  if (!hljs) return null;
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/**
 * Highlight the fenced code blocks (`pre code.language-x`) inside a rendered Markdown preview.
 * Call it after the Markdown HTML has been set. Blocks with an unknown language stay as they are.
 */
export async function highlightCodeBlocks(container: HTMLElement): Promise<void> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre code[class^="language-"]'));
  if (blocks.length === 0) return;
  const hljs = await loadHighlighter();
  if (!hljs || !container.isConnected) return;
  let budget = BLOCKS_MAX_TOTAL_CHARS;
  for (const code of blocks) {
    if (code.dataset.wsPvDone === '1') continue;
    const size = code.textContent?.length ?? 0;
    if (size > BLOCK_MAX_CHARS || size > budget || hasOverlongLine(code.textContent ?? '')) continue;
    const lang = fenceLanguage((code.className.match(/(?:^|\s)language-(\S+)/)?.[1]) ?? '');
    if (!lang) continue;
    try {
      const html = hljs.highlight(code.textContent ?? '', { language: lang, ignoreIllegals: true }).value;
      budget -= size;
      code.innerHTML = html;
      code.classList.add('hljs');
      code.dataset.wsPvDone = '1';
    } catch {
      // leave the block as plain text
    }
  }
}
