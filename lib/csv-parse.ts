/**
 * Small RFC 4180 parser for the Workspace CSV/TSV preview. Pure: no imports, runs in node tests
 * and in the browser the same way.
 *
 * Handles quoted fields, `""` as an escaped quote, CRLF / LF / CR row ends and newlines inside
 * quotes. A final line terminator does not add an empty row. Lenient where real files are sloppy:
 * a quote in the middle of an unquoted field is literal, text after a closing quote is kept, an
 * unterminated quote runs to the end of the text. Rows may have different lengths (ragged).
 */

export interface CsvResult {
  /** The first `maxRows` rows (all rows when `maxRows` is not given). */
  rows: string[][];
  /** Every row in the text, including the ones cut from `rows`. */
  total: number;
}

export function parseCsv(input: string, opts: { delimiter?: string; maxRows?: number } = {}): CsvResult {
  const delimiter = opts.delimiter ?? ',';
  const maxRows = opts.maxRows ?? Infinity;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false; // true once the current row has any content or delimiter
  const n = text.length;

  const endRow = () => {
    row.push(field);
    if (total < maxRows) rows.push(row);
    total++;
    row = [];
    field = '';
    fieldStarted = false;
  };

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' && (i === 0 || text[i - 1] === delimiter || text[i - 1] === '\n' || text[i - 1] === '\r')) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      if (i === n - 1) return { rows, total };
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  // Last row without a terminator.
  if (fieldStarted || field !== '' || row.length > 0) endRow();
  return { rows, total };
}

/** Candidate separators, in tie-break order. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Guess the separator of a CSV text from its first ~20 non-empty lines (quotes respected): the
 * candidate that gives the same field count (> 1) on the most lines wins; ties go in the order
 * `,` `;` tab `|`. Falls back to `,` (a single-column file, say).
 */
export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = 0;
  for (const d of CSV_DELIMITERS) {
    const counts = new Map<number, number>();
    let seen = 0;
    for (const r of parseCsv(sample, { delimiter: d, maxRows: 200 }).rows) {
      if (r.length === 1 && r[0] === '') continue; // blank line
      if (++seen > 20) break;
      if (r.length > 1) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    }
    const score = Math.max(0, ...counts.values());
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** Readable name of a separator for the UI. */
export function delimiterLabel(d: string): string {
  return d === '\t' ? 'Tab' : d;
}
