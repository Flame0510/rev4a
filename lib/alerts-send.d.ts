/** Types for the CommonJS Telegram sender shared by lib/alerts.ts and daemon.js. */
export interface TelegramConfig {
  enabled: boolean;
  token: string;
  chatId: string;
}
export function telegramConfig(env?: Record<string, string | undefined>): TelegramConfig;
export function sendTelegramMessage(text: string, env?: Record<string, string | undefined>): Promise<void>;
