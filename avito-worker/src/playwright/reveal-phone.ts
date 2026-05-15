/**
 * Phone reveal on an open Avito messenger dialog page.
 *
 * Usage: the caller navigates to /profile/messenger/channel/<id>,
 * waits for the thread to settle, calls `revealPhone(page)`. The
 * function handles both Avito patterns:
 *
 *   1. Classic ad: phone is hidden behind a "Показать телефон" button.
 *      We click, wait for a NEW phone to appear, then extract it.
 *   2. Job applicant response: the applicant's phone is delivered AS
 *      A MESSAGE in the thread itself (Avito renders it directly,
 *      no reveal button). We detect this by scanning body text for a
 *      phone number BEFORE attempting any click and short-circuit to
 *      success.
 *
 * Failure taxonomy maps 1:1 to phone_reveal_attempt_status enum:
 *   - success
 *   - blocked
 *   - no_phone_found
 *   - ui_changed
 *   - technical_error_before_click
 *   - technical_error_after_click
 *   - technical_error_unknown_state
 *
 * Phone normalisation: accepts `+7`, `8`, and parenthesised variants
 * like `+7 (908) 404-85-88`; returns canonical `+7XXXXXXXXXX`
 * (11 digits, leading `+`).
 */
import type { Page } from 'playwright';

export type RevealPhoneStatus =
  | 'success'
  | 'blocked'
  | 'no_phone_found'
  | 'ui_changed'
  | 'technical_error_before_click'
  | 'technical_error_after_click'
  | 'technical_error_unknown_state';

export type RevealPhoneResult = {
  status: RevealPhoneStatus;
  phone: string | null;
  reason: string | null;
  clickedReveal: boolean;
};

// Permissive Russian phone regex: accepts +7 / 7 / 8 prefixes and
// common separators (space, hyphen, parentheses). Post-match we
// normalise into canonical `+7XXXXXXXXXX`.
const PHONE_RX =
  /(?:\+?[78])[\s()\-]*\d{3}[\s()\-]*\d{3}[\s()\-]*\d{2}[\s()\-]*\d{2}/g;

// Avito wording when the account hits its reveal/contact quota or
// when the messenger surface indicates the contact is unavailable.
// Narrowed to multi-word phrases to avoid false positives on random
// message text containing single words like "лимит".
const BLOCK_RX =
  /дневной\s+лимит|лимит\s+на\s+сегодня|превышен\s+лимит|лимит\s+контактов|лимит\s+просмотра|контакт\s+(недоступен|скрыт)|телефон\s+(недоступен|скрыт)|попробуйте\s+(позже|завтра)|обратитесь\s+завтра|заблокирован(\s|$)/i;

function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    return '+7' + digits.slice(1);
  }
  if (digits.length === 11 && digits.startsWith('7')) {
    return '+' + digits;
  }
  if (digits.length === 10) {
    return '+7' + digits;
  }
  return raw.replace(/[\s()\-]/g, '');
}

function getBodyText(page: Page): Promise<string> {
  return page
    .evaluate('(() => (document.body && document.body.innerText) || "")()')
    .then((v) => (typeof v === 'string' ? v : ''))
    .catch(() => '');
}

export async function revealPhone(page: Page): Promise<RevealPhoneResult> {
  // Step 0: scan body text BEFORE any interaction. If a phone is
  // already visible in the dialog (e.g. applicant sent their number
  // as a message), we short-circuit to success — no click needed.
  const initialText = await getBodyText(page);
  const initialMatches: string[] = initialText.match(PHONE_RX) ?? [];

  // Locate the "Показать телефон" button. If missing, decide between
  // "already revealed", "blocked", or "ui_changed" based on body text.
  const button = page.getByText('Показать телефон', { exact: true }).first();
  let buttonCount = 0;
  try {
    buttonCount = await button.count();
  } catch (err) {
    // Before returning an error, still honour Step 0 — if the phone
    // was already there, that's a success even if button lookup broke.
    const already = initialMatches[0];
    if (already) {
      return {
        status: 'success',
        phone: normalisePhone(already),
        reason: 'phone visible in thread (button locator errored)',
        clickedReveal: false,
      };
    }
    return {
      status: 'technical_error_before_click',
      phone: null,
      reason: (err as Error)?.message || 'locator error',
      clickedReveal: false,
    };
  }

  if (buttonCount === 0) {
    // No button. Three sub-cases:
    const already = initialMatches[0];
    if (already) {
      return {
        status: 'success',
        phone: normalisePhone(already),
        reason: 'phone already visible in dialog thread (no reveal button)',
        clickedReveal: false,
      };
    }
    if (BLOCK_RX.test(initialText)) {
      return {
        status: 'blocked',
        phone: null,
        reason: 'button absent and block wording present',
        clickedReveal: false,
      };
    }
    return {
      status: 'ui_changed',
      phone: null,
      reason: 'Показать телефон button not found and no phone in thread',
      clickedReveal: false,
    };
  }

  // Button present. Click it.
  try {
    await button.click({ timeout: 5_000 });
  } catch (err) {
    return {
      status: 'technical_error_before_click',
      phone: null,
      reason: (err as Error)?.message || 'click error',
      clickedReveal: false,
    };
  }

  // Wait for a NEW phone match to appear. Uses string predicate to
  // avoid tsx/esbuild `__name` serialisation issue.
  const waitPredicate = `(() => {
    var bt = (document.body && document.body.innerText) || "";
    var m = bt.match(/(?:\\+?[78])[\\s()\\-]*\\d{3}[\\s()\\-]*\\d{3}[\\s()\\-]*\\d{2}[\\s()\\-]*\\d{2}/g) || [];
    return m.length > ${initialMatches.length};
  })()`;
  let phoneAppeared = false;
  try {
    await page.waitForFunction(waitPredicate, null, { timeout: 8_000 });
    phoneAppeared = true;
  } catch {
    phoneAppeared = false;
  }

  const afterText = await getBodyText(page);
  const afterMatches: string[] = afterText.match(PHONE_RX) ?? [];
  const newPhones: string[] = afterMatches.filter(
    (p) => !initialMatches.includes(p),
  );

  const newFirst = newPhones[0];
  if (newFirst) {
    return {
      status: 'success',
      phone: normalisePhone(newFirst),
      reason: phoneAppeared ? null : 'new phone appeared after click (late)',
      clickedReveal: true,
    };
  }
  // Same-number re-render race: predicate fired, but diff was empty.
  const anyFirst = afterMatches[0];
  if (phoneAppeared && anyFirst) {
    return {
      status: 'success',
      phone: normalisePhone(anyFirst),
      reason: 'phone re-rendered after click without diff',
      clickedReveal: true,
    };
  }
  if (BLOCK_RX.test(afterText)) {
    return {
      status: 'blocked',
      phone: null,
      reason: 'Avito block/quota wording present after click',
      clickedReveal: true,
    };
  }
  // Still nothing — emit a diag suffix so we can see post-click state.
  const afterSnippet = afterText.slice(0, 500).replace(/\s+/g, ' ');
  return {
    status: 'no_phone_found',
    phone: null,
    reason:
      'click completed but no new phone number appeared ' +
      `[diag: afterSnippet=${JSON.stringify(afterSnippet)}]`,
    clickedReveal: true,
  };
}
