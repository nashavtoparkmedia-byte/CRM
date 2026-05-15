/**
 * Send a plain-text message into an open Avito messenger dialog.
 *
 * Preconditions:
 *   - Playwright `Page` is already navigated to /profile/messenger/channel/<id>
 *   - The thread has rendered (caller has waited for message list via
 *     `waitForSelector('[data-marker="message"]')` or equivalent)
 *
 * Behaviour:
 *   - Locate the message input (contenteditable div or textarea in
 *     the channel-bottom-base area).
 *   - Click it to focus, wait a humanlike pause.
 *   - Fill the text.
 *   - Wait another humanlike pause.
 *   - Click the send button if present; fall back to pressing Enter.
 *   - Wait briefly for Avito to dispatch the send + render the new
 *     message, then return.
 *
 * Returns `{ ok: true }` on success (input cleared after send, which
 * is our proxy for "Avito accepted the message"), or
 * `{ ok: false, reason }` otherwise. Never throws.
 *
 * No selectors depend on tsx/esbuild-compiled callbacks — everything
 * uses Playwright's native Locator API, which is immune to the
 * `__name` serialisation issue that bit parse-messenger-list in B3.
 */
import type { Page } from 'playwright';

export type SendChatMessageResult = {
  ok: boolean;
  reason?: string;
};

// Human-like delays so the send pattern doesn't look like a bot
// firing at fixed intervals across many dialogs.
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function sendChatMessage(
  page: Page,
  text: string,
): Promise<SendChatMessageResult> {
  if (!text || !text.trim()) {
    return { ok: false, reason: 'empty_text' };
  }

  try {
    // Avito's input area. We try a few known markers / structural
    // selectors — exact class names shift across releases, but
    // contenteditable inside the channel-bottom-base container is
    // stable.
    const inputLocator = page
      .locator(
        [
          '[data-marker="channel-bottom-base"] [contenteditable="true"]',
          '[data-marker="channel-bottom-base"] textarea',
          '[data-marker*="message-input"]',
          '[data-marker*="input-message"]',
          'textarea[placeholder*="Введите"]',
          'textarea[placeholder*="Написать"]',
          '[role="textbox"][contenteditable="true"]',
        ].join(', '),
      )
      .first();

    const count = await inputLocator.count().catch(() => 0);
    if (count === 0) {
      return { ok: false, reason: 'input_not_found' };
    }

    await inputLocator.click({ timeout: 5_000 });
    await sleep(rand(250, 700));

    // Playwright's fill() handles both <textarea> and contenteditable
    // via the input protocol. Fall back to type() if fill rejects
    // (rare, but happens on some React-controlled editors).
    try {
      await inputLocator.fill(text, { timeout: 3_000 });
    } catch {
      try {
        await inputLocator.type(text, { delay: 20, timeout: 5_000 });
      } catch (err) {
        return {
          ok: false,
          reason: `input_fill_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }

    await sleep(rand(500, 1200));

    // Try to find a dedicated send button. If not present, Enter
    // is the canonical "send" key on Avito's desktop messenger.
    const sendBtn = page
      .locator(
        [
          '[data-marker="send-message-button"]',
          '[data-marker*="send-button"]',
          '[data-marker="channel-bottom-base"] button[type="submit"]',
          '[data-marker="channel-bottom-base"] button:has-text("Отправить")',
        ].join(', '),
      )
      .first();

    let clicked = false;
    const sendCount = await sendBtn.count().catch(() => 0);
    if (sendCount > 0) {
      try {
        await sendBtn.click({ timeout: 3_000 });
        clicked = true;
      } catch {
        /* fall through to Enter */
      }
    }
    if (!clicked) {
      try {
        await inputLocator.press('Enter', { timeout: 2_000 });
      } catch (err) {
        return {
          ok: false,
          reason: `send_trigger_failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }

    // Give Avito time to round-trip the send and render the new
    // message in the thread. 2s is generous; on fast networks send
    // usually completes in <500ms.
    await sleep(2_000);

    // Success heuristic: input field is empty after send. Avito
    // clears the input only after the server confirms receipt, so
    // this is a reasonable proxy for "message landed".
    const remaining = await inputLocator
      .textContent()
      .catch(() => '');
    if ((remaining ?? '').trim().length > 0) {
      return { ok: false, reason: 'input_still_has_text_after_send' };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `unexpected: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
