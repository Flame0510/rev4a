export const CLAUDE_CLI_PROVIDER: 'claude-cli';
export const CREATE_TABLE_SQL: string;
export interface ClaudeCliInterval {
  since_date: string;
  until_date: string | null;
  last_on_date?: string | null;
}
/** true / false for a readable openclaw.json; null when the text is empty or not JSON (state unknown). */
export function claudeRuleFromConfigText(text: unknown): boolean | null;
export interface IntervalChange {
  open: string | null;
  reopen: string | null;
  touch: string | null;
  close: string | null;
  closeAt: string | null;
}
export function planIntervalChange(intervals: readonly ClaudeCliInterval[], state: boolean | null, today: string): IntervalChange;
export function dateInIntervals(date: string, intervals: readonly ClaudeCliInterval[]): boolean;
/** `anthropic` becomes `claude-cli` on a day the rule was on, unless the row's cost is above 0. */
export function labelProvider<T extends string | null | undefined>(provider: T, date: string | null | undefined, intervals: readonly ClaudeCliInterval[], cost?: number | null): T | 'claude-cli';
export function relabelSessionRows<T extends { provider?: string | null; updated_at?: number | null; cost_usd?: number | null }>(rows: T[], intervals: readonly ClaudeCliInterval[]): T[];
export interface ModelDailyRow { date: string; provider: string; model: string; tokens: number; cost: number; calls: number }
export function labelModelDaily(rows: readonly ModelDailyRow[], intervals: readonly ClaudeCliInterval[]): ModelDailyRow[];
export const ADD_LAST_ON_COLUMN_SQL: string;
