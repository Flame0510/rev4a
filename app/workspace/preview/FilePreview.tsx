'use client';

/**
 * Read-only previews for the Workspace page: highlighted code, pretty JSON, YAML, CSV/TSV tables
 * and .env files with masked values. See docs/FRONTEND-ARCHITECTURE.md (Workspace previews).
 *
 *   previewKindOf(name)      which preview a file gets, or null (the page keeps its textarea)
 *   <FilePreview name text/> the preview; renders nothing when the kind is null
 *   highlightCodeBlocks(el)  highlights fenced code in the Markdown preview
 */
import { useEffect, useMemo, useState } from 'react';
import { delimiterLabel, parseCsv, sniffDelimiter } from '@/lib/csv-parse';
import { highlightToHtml } from './highlight-loader';
import {
  CSV_MAX_COLS,
  ENV_MASK,
  JSON_MAX_DEPTH,
  JSON_MAX_PRETTY_CHARS,
  MAX_RENDER_LINES,
  capLines,
  jsonMaxDepth,
  isJsonLines,
  jsonErrorInfo,
  languageOf,
  numberedLinesHtml,
  parseEnvLines,
  plainLines,
  previewKindOf,
  splitHighlightedLines,
  type PreviewLang,
} from './preview-utils';

export { previewKindOf, PREVIEW_LANGS } from './preview-utils';
export type { PreviewKind } from './preview-utils';
export { highlightCodeBlocks } from './highlight-loader';

/** Above this many characters nothing is highlighted: the page stays fast. */
export const HIGHLIGHT_MAX_CHARS = 512 * 1024;
/** Data rows shown in a CSV/TSV table (the header row comes on top). */
export const CSV_MAX_ROWS = 1000;

export interface FilePreviewProps {
  name: string;
  text: string;
}

export default function FilePreview({ name, text }: FilePreviewProps) {
  const kind = previewKindOf(name);
  if (kind === null) return null;
  if (kind === 'csv' || kind === 'tsv') return <CsvPreview text={text} tsv={kind === 'tsv'} />;
  if (kind === 'env') return <EnvPreview text={text} />;
  if (kind === 'json') return <JsonPreview name={name} text={text} />;
  if (kind === 'yaml') return <CodePreview text={text} lang="yaml" />;
  return <CodePreview text={text} lang={languageOf(name)} />;
}

// ---------------------------------------------------------------------------------------------
// Code

interface CodeProps {
  text: string;
  lang: PreviewLang | null;
  banner?: React.ReactNode;
  /** A neutral note shown above the code (why the raw text is shown, say). */
  note?: string;
  /** Extra class per row index (JSON Lines flags). */
  rowClass?: (index: number) => string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

function CodePreview({ text: fullText, lang, banner, note, rowClass }: CodeProps) {
  // Never render more than MAX_RENDER_LINES lines: a 2 MB file of short lines would freeze the tab.
  const capped = useMemo(() => capLines(fullText), [fullText]);
  const text = capped.text;
  const tooBig = text.length > HIGHLIGHT_MAX_CHARS;
  const [highlighted, setHighlighted] = useState<{ src: string; lang: PreviewLang; lines: string[] } | null>(null);

  useEffect(() => {
    if (!lang || tooBig) return;
    let cancelled = false;
    void highlightToHtml(text.replace(/\r\n?/g, '\n'), lang).then((html) => {
      if (!cancelled && html !== null) setHighlighted({ src: text, lang, lines: splitHighlightedLines(html) });
    });
    return () => { cancelled = true; };
  }, [text, lang, tooBig]);

  const plain = useMemo(() => plainLines(text), [text]);
  const lines = highlighted && highlighted.src === text && highlighted.lang === lang ? highlighted.lines : plain;
  const html = useMemo(() => numberedLinesHtml(lines, rowClass), [lines, rowClass]);

  return (
    <div className="ws-pv">
      {banner}
      {note && <div className="ws-pv-note">{note}</div>}
      {capped.cut && <div className="ws-pv-note">Showing the first {fmt(MAX_RENDER_LINES)} of {fmt(capped.total)} lines.</div>}
      {tooBig && <div className="ws-pv-note">Large file: syntax highlighting is off.</div>}
      {/* Safe: `html` holds only escaped text or the output of highlight.js for that text. */}
      <div className="ws-pv-code hljs" role="region" aria-label="File content" tabIndex={0} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// JSON

function JsonPreview({ name, text }: { name: string; text: string }) {
  if (isJsonLines(name)) return <JsonLinesPreview text={text} />;
  return <JsonDocPreview text={text} />;
}

function JsonDocPreview({ text }: { text: string }) {
  const result = useMemo(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { kind: 'invalid' as const, error: jsonErrorInfo(text, e) };
    }
    // Valid JSON. Pretty-print it unless that would be huge: deep nesting makes 2-space indentation grow quadratically.
    if (jsonMaxDepth(text) > JSON_MAX_DEPTH) return { kind: 'raw' as const, note: 'Too deeply nested to format. Showing the file as it is.' };
    try {
      const pretty = JSON.stringify(parsed, null, 2);
      if (pretty.length > JSON_MAX_PRETTY_CHARS) return { kind: 'raw' as const, note: 'Too large to format. Showing the file as it is.' };
      return { kind: 'ok' as const, pretty };
    } catch {
      return { kind: 'raw' as const, note: 'Too deeply nested to format. Showing the file as it is.' };
    }
  }, [text]);

  if (result.kind === 'ok') return <CodePreview text={result.pretty} lang="json" />;
  if (result.kind === 'raw') return <CodePreview text={text} lang="json" note={result.note} />;
  const { line, column, message } = result.error;
  return (
    <CodePreview
      text={text}
      lang="json"
      banner={<div className="ws-pv-banner is-error" role="alert">Invalid JSON at line {line}, column {column}: {message}</div>}
    />
  );
}

function JsonLinesPreview({ text }: { text: string }) {
  // Only the lines that are rendered are checked; the message is computed for the first bad line only.
  const check = useMemo(() => {
    const flagged = new Set<number>();
    let first = -1;
    let firstMessage = '';
    plainRaw(capLines(text).text).forEach((line, i) => {
      if (line.trim() === '') return;
      try { JSON.parse(line); } catch (e) {
        flagged.add(i);
        if (first < 0) { first = i; firstMessage = jsonErrorInfo(line, e).message; }
      }
    });
    return { flagged, first, firstMessage };
  }, [text]);
  const rowClass = useMemo(() => (i: number) => (check.flagged.has(i) ? 'is-invalid' : ''), [check]);
  const banner = check.flagged.size ? (
    <div className="ws-pv-banner is-error" role="alert">
      {fmt(check.flagged.size)} invalid {check.flagged.size === 1 ? 'line' : 'lines'}, the first at line {check.first + 1}: {check.firstMessage}
    </div>
  ) : null;
  return <CodePreview text={text} lang="json" banner={banner} rowClass={rowClass} />;
}

function plainRaw(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------------------------
// CSV / TSV

function CsvPreview({ text, tsv }: { text: string; tsv: boolean }) {
  const delimiter = useMemo(() => (tsv ? '\t' : sniffDelimiter(text)), [text, tsv]);
  const parsed = useMemo(() => parseCsv(text, { delimiter, maxRows: CSV_MAX_ROWS + 1 }), [text, delimiter]);
  const [header, ...body] = parsed.rows;
  if (!header) return <div className="ws-pv"><div className="ws-pv-note">This file is empty.</div></div>;

  const widest = parsed.rows.reduce((max, r) => Math.max(max, r.length), 0);
  const cols = Math.min(widest, CSV_MAX_COLS);
  const totalData = parsed.total - 1;
  const cut = totalData > body.length;
  const cell = (r: string[], c: number) => r[c] ?? '';

  return (
    <div className="ws-pv">
      <div className="ws-pv-scroll" role="region" aria-label="Table" tabIndex={0}>
        <table className="ws-pv-table">
          <thead>
            <tr>
              <th className="ws-pv-rownum">#</th>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} title={cell(header, c)}><span className="ws-pv-cell">{cell(header, c)}</span></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                <td className="ws-pv-rownum">{i + 1}</td>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c} title={cell(r, c)}><span className="ws-pv-cell">{cell(r, c)}</span></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {widest > cols && <div className="ws-pv-note">Showing the first {fmt(cols)} of {fmt(widest)} columns.</div>}
      <div className="ws-pv-note">
        Separator: {delimiterLabel(delimiter)} · {cut ? `Showing ${body.length.toLocaleString('en-US')} of ${totalData.toLocaleString('en-US')} rows` : `${totalData.toLocaleString('en-US')} ${totalData === 1 ? 'row' : 'rows'}`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// .env

function EnvPreview({ text }: { text: string }) {
  const [reveal, setReveal] = useState(false);
  const capped = useMemo(() => capLines(text), [text]);
  const lines = useMemo(() => parseEnvLines(capped.text), [capped]);

  return (
    <div className="ws-pv">
      <div className="ws-pv-banner">
        <span>Values are hidden.</span>
        <button type="button" className="ws-pv-toggle" aria-pressed={reveal} onClick={() => setReveal((v) => !v)}>
          {reveal ? 'Hide values' : 'Reveal values'}
        </button>
      </div>
      {capped.cut && <div className="ws-pv-note">Showing the first {fmt(MAX_RENDER_LINES)} of {fmt(capped.total)} lines.</div>}
      <div className="ws-pv-code" role="region" aria-label="Environment file" tabIndex={0}>
        {lines.map((l, i) => (
          <div key={i} className="ws-pv-line" data-ln={i + 1}>
            <span className="ws-pv-lc">
              {l.type === 'comment' && <span className="hljs-comment">{l.text}</span>}
              {l.type === 'pair' && (
                <>
                  {l.prefix}<span className="hljs-attr">{l.key}</span><span className="hljs-punctuation">=</span>
                  {l.value.trim() === '' ? null : reveal ? <span className="hljs-string">{l.value}</span> : <span className="ws-pv-masked">{ENV_MASK}</span>}
                </>
              )}
              {l.type === 'raw' && (reveal ? l.text : <span className="ws-pv-masked">{ENV_MASK}</span>)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
