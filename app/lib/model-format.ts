/**
 * Formatting shared by the Gateway model row and the details modal, so the same number
 * never reads two ways in the same page.
 */

/** "1.60T", "321.3B", "9.7B", "300M" — the size people actually ask about. */
export function formatParams(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return String(n);
}

/** USD per 1M tokens: "$0.15 / $0.50", or "Free", "Dynamic", "—". */
export function formatPrice(p: { input: number; output: number } | null | undefined): string {
  if (!p) return '—';
  if (p.input === -1 && p.output === -1) return 'Dynamic';
  if (p.input === 0 && p.output === 0) return 'Free';
  const f = (n: number) => (n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
  return `${f(p.input)} / ${f(p.output)}`;
}
