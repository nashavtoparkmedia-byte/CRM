/**
 * Telegram notification helper (worker-side).
 *
 * One fire-and-forget POST to api.telegram.org. Errors are swallowed
 * and logged — a failed TG send must NEVER fail a collect job.
 *
 * We do NOT maintain a TG "client" or long-lived connection. Each
 * notification is one independent HTTP call. This keeps the helper
 * trivial to reason about, stateless, and consistent with the
 * project's constraint ("no new services, no queues").
 *
 * TG settings live in the existing `app_settings` k/v table:
 *   - telegram_bot_token
 *   - telegram_chat_id
 *   - notify_new_response   ('true' | 'false', default true)
 *   - notify_auto_pause     ('true' | 'false', default true)
 *   - notify_account_degraded ('true' | 'false', default true)
 *
 * The worker reads all five keys once per collect cycle (same time
 * it reads `auto_reply_default_text`) and passes them in. No caching
 * inside this helper.
 */
import { eq } from 'drizzle-orm';
import { appSettings, type Database } from '@avito/db';

export type TgSettings = {
  botToken: string | null;
  chatId: string | null;
  notifyNewResponse: boolean;
  notifyAutoPause: boolean;
  notifyAccountDegraded: boolean;
};

export type TgButton = { text: string; url: string };

export async function readTgSettings(db: Database): Promise<TgSettings> {
  try {
    const rows = await db.select().from(appSettings);
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const parseBool = (k: string, def: boolean): boolean => {
      const v = map.get(k);
      if (v === undefined) return def;
      return v === 'true';
    };
    const botToken = (map.get('telegram_bot_token') ?? '').trim() || null;
    const chatId = (map.get('telegram_chat_id') ?? '').trim() || null;
    return {
      botToken,
      chatId,
      notifyNewResponse: parseBool('notify_new_response', true),
      notifyAutoPause: parseBool('notify_auto_pause', true),
      notifyAccountDegraded: parseBool('notify_account_degraded', true),
    };
  } catch {
    return {
      botToken: null,
      chatId: null,
      notifyNewResponse: false,
      notifyAutoPause: false,
      notifyAccountDegraded: false,
    };
  }
}

// Strip everything except digits, then reattach a leading '+' (E.164
// compact form). '+7 922 215-57-50' → '+79222155750'. Operator asked
// for no spaces/dashes in TG messages.
export function normalizePhoneCompact(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

// Avito sometimes returns chat URLs as a path-only href ("/profile/messenger/..").
// Prepend the origin so TG shows an external link instead of a dead
// relative URL.
export function absoluteAvitoUrl(chatUrl: string | null | undefined): string | null {
  if (!chatUrl) return null;
  if (chatUrl.startsWith('http')) return chatUrl;
  if (chatUrl.startsWith('/')) return `https://www.avito.ru${chatUrl}`;
  return null;
}

/**
 * Send a Telegram message with optional inline keyboard (one row of URL
 * buttons). Returns the new message_id on success, `null` on any
 * failure. Never throws.
 *
 * Called fire-and-forget from collect-responses.handler: the caller
 * should `await` only to get the message_id (needed for later edit),
 * but a null return is fully tolerated.
 */
export async function sendTg(
  botToken: string,
  chatId: string,
  text: string,
  buttons?: TgButton[],
): Promise<number | null> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (buttons && buttons.length > 0) {
      body.reply_markup = {
        inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))],
      };
    }
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // Node 24 fetch supports AbortSignal.timeout — cap the wait so
        // a hanging TG doesn't stall the collect cycle.
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ok?: boolean;
      result?: { message_id?: number };
    };
    if (!json.ok || typeof json.result?.message_id !== 'number') return null;
    return json.result.message_id;
  } catch {
    return null;
  }
}
