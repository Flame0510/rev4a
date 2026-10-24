'use strict';

/**
 * The one Telegram sender, shared by lib/alerts.ts (Next) and daemon.js (spend alarms). It reads
 * the same environment (REV4A_ALERTS_ENABLED, REV4A_TELEGRAM_BOT_TOKEN, REV4A_TELEGRAM_CHAT_ID)
 * and never puts the token in an error or a log: the bot token is part of the URL, so errors
 * carry only a status or a fixed phrase.
 */

function telegramConfig(env) {
  const e = env || process.env;
  return {
    enabled: e.REV4A_ALERTS_ENABLED === 'true',
    token: (e.REV4A_TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: (e.REV4A_TELEGRAM_CHAT_ID || '').trim(),
  };
}

/** Send one message. Throws an Error without the token in it. */
async function sendTelegramMessage(text, env) {
  const { token, chatId } = telegramConfig(env);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Telegram send failed (network)');
  }
  if (!response.ok) throw new Error(`Telegram send failed (${response.status})`);
}

module.exports = { telegramConfig, sendTelegramMessage };
