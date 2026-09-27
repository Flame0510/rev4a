/**
 * The check against the bill: what each vendor charged, next to what the agents' OpenClaw
 * priced, over the same interval. daemon.js writes `vendor_balance` rows in costs.db, each
 * holding the vendor's figure and the agents' cumulative priced total for that vendor's
 * models, read at the same moment. Between two rows:
 *
 * - billed — DeepSeek: the balance drops (a rise is a top-up, counted apart);
 *   OpenRouter: the growth of its lifetime usage.
 * - priced — the growth of the agents' total.
 *
 * A difference is expected when the same key serves more than the agents (the assistant,
 * clients outside Rev4a), when a vendor bills late, and from DeepSeek's balance being
 * given to the cent. Nothing here corrects either side.
 */
import type Database from 'better-sqlite3';

export interface Reconciliation {
  vendor: string;
  currency: string | null;
  /** Unix ms of the two readings compared; null when there are not two yet. */
  from: number | null;
  to: number | null;
  billed: number | null;
  priced: number | null;
  /** Balance rises between the readings (DeepSeek): money added, not spent. */
  topUps: number;
  readings: number;
  /** False when the vendor's figure is in another currency than the agents' dollars. */
  comparable: boolean;
}

interface Row { ts: number; vendor: string; currency: string | null; balance: number | null; usage: number | null; agents_cost: number }

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function readReconciliation(db: Database.Database, startDate: string, endDate: string): Reconciliation[] {
  const hasTable = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'vendor_balance'")
    .get() as { n: number };
  if (!hasTable.n) return [];
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`) + 86_400_000;
  const vendors = (db.prepare('SELECT DISTINCT vendor FROM vendor_balance ORDER BY vendor').all() as { vendor: string }[]).map((v) => v.vendor);

  return vendors.map((vendor) => {
    // The reading at or just before the start of the range, else the first inside it.
    const before = db.prepare('SELECT * FROM vendor_balance WHERE vendor = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(vendor, start) as Row | undefined;
    const inside = db.prepare('SELECT * FROM vendor_balance WHERE vendor = ? AND ts > ? AND ts < ? ORDER BY ts').all(vendor, start, end) as Row[];
    const rows = before ? [before, ...inside] : inside;
    const currency = rows[rows.length - 1]?.currency ?? null;
    const empty: Reconciliation = {
      vendor, currency, from: rows[0]?.ts ?? null, to: null, billed: null, priced: null, topUps: 0,
      readings: rows.length, comparable: currency === 'USD',
    };
    if (rows.length < 2) return empty;

    const a = rows[0];
    const b = rows[rows.length - 1];
    let billed = 0;
    let topUps = 0;
    if (vendor === 'openrouter') {
      billed = (b.usage ?? 0) - (a.usage ?? 0);
    } else {
      for (let i = 1; i < rows.length; i++) {
        const delta = (rows[i - 1].balance ?? 0) - (rows[i].balance ?? 0);
        if (delta >= 0) billed += delta;
        else topUps += -delta;
      }
    }
    return {
      ...empty,
      to: b.ts,
      billed: round(billed),
      priced: round(b.agents_cost - a.agents_cost),
      topUps: round(topUps),
    };
  });
}
