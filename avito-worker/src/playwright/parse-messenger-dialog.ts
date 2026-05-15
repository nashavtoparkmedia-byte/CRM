/**
 * Messenger dialog page parser.
 *
 * Reads https://www.avito.ru/profile/messenger/channel/<id> and extracts
 * the header + last-message details that the list preview alone can't
 * reliably separate (opponent human name vs item/vacancy title, full
 * last-message text, message timestamps).
 *
 * Same pattern as parse-messenger-list.ts — code is passed to
 * page.evaluate as a STRING to avoid the tsx/esbuild `__name` helper
 * being serialised into the browser. Never throws; returns null details
 * on any error and surfaces diagnostic info via `parseMessengerDialogMeta`.
 */
import type { Page } from 'playwright';

export type MessengerDialogDetails = {
  opponentName: string | null;
  itemTitle: string | null;
  itemUrl: string | null;
  lastMessageText: string | null;
  receivedAtIso: string | null;
  receivedAtRaw: string | null;
  messageCount: number;
};

type DialogRaw = {
  ok: boolean;
  err?: string;
  details: MessengerDialogDetails;
};

export const parseMessengerDialogMeta: {
  lastError?: string;
  lastDebug?: string;
} = {};

const DIALOG_DIAG_SOURCE = `(() => {
  try {
    var markerEls = Array.from(document.querySelectorAll('[data-marker]'));
    var interesting = [];
    for (var i = 0; i < markerEls.length && interesting.length < 30; i++) {
      var m = markerEls[i].getAttribute('data-marker') || '';
      // Keep only markers that look messenger/channel/message/header related —
      // skip global navbar chrome which we already know from the list page.
      if (/channel|message|opponent|header\\/|interlocutor|item/i.test(m) && !/^header\\//.test(m)) {
        var txt = ((markerEls[i].textContent || '').trim()).slice(0, 120);
        interesting.push({ marker: m, text: txt });
      }
    }
    var h1 = document.querySelector('h1');
    var h2 = document.querySelector('h2');
    var itemLink = document.querySelector('a[href*="/items/"], a[href*="/job/"], a[href*="/vacancy"]');
    return {
      markers: interesting,
      h1Text: h1 ? ((h1.textContent || '').trim()).slice(0, 200) : null,
      h2Text: h2 ? ((h2.textContent || '').trim()).slice(0, 200) : null,
      itemLinkHref: itemLink ? itemLink.getAttribute('href') : null,
      itemLinkText: itemLink ? ((itemLink.textContent || '').trim()).slice(0, 200) : null,
      bodyTextStart: ((document.body && document.body.innerText) || '').slice(0, 800),
    };
  } catch (e) {
    return { markers: [], error: (e && e.message) ? e.message : String(e) };
  }
})()`;

export async function debugMessengerDialog(
  page: Page,
): Promise<Record<string, unknown>> {
  try {
    return (await page.evaluate(DIALOG_DIAG_SOURCE)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Отметить диалог прочитанным в Avito.
 *
 * Ключевой момент: Avito messenger использует WebSocket и
 * Page Visibility API, чтобы решить когда послать "seen"-сигнал
 * серверу. В headless Playwright вкладка считается hidden, и
 * сигнал НЕ отправляется. Простой scrollTop тоже не помогает —
 * клиент Avito смотрит не на скролл, а на события пользовательского
 * взаимодействия + visibility.
 *
 * Стратегия (комбинируем, чтобы максимизировать шанс):
 *   1. Подменить `document.visibilityState = 'visible'` и сгенерить
 *      `visibilitychange` — клиент Avito думает что вкладка видна.
 *   2. Прокрутить ленту сообщений в самый низ + scrollIntoView на
 *      последнее сообщение.
 *   3. Реальный Playwright-клик (через locator, не element.click в JS)
 *      по последнему сообщению, чтобы пройти настоящий input pipeline.
 *   4. Фокус на поле ввода — Avito шлёт seen при фокусе.
 *   5. Подождать 3 секунды, чтобы WebSocket успел отправить seen.
 *
 * Best-effort: никогда не throws.
 */
const VISIBILITY_OVERRIDE_SOURCE = `(() => {
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: function () { return 'visible'; }
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true, get: function () { return false; }
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  } catch (e) { /* ignore */ }
})()`;

const SCROLL_TO_BOTTOM_SOURCE = `(() => {
  try {
    var list =
      document.querySelector('[data-marker="messagesHistory/list"]') ||
      document.querySelector('[data-marker="messagesHistory"]');
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
    window.scrollTo(0, document.body.scrollHeight);
  } catch (e) { /* ignore */ }
})()`;

export async function markDialogRead(page: Page): Promise<void> {
  try {
    // 1. Подменяем Page Visibility API — без этого клиент Avito
    //    считает вкладку hidden и не шлёт seen.
    await page.bringToFront().catch(() => undefined);
    await page.evaluate(VISIBILITY_OVERRIDE_SOURCE).catch(() => undefined);

    // 2. Scroll messages to the bottom (JS-способ).
    await page.evaluate(SCROLL_TO_BOTTOM_SOURCE).catch(() => undefined);

    // 3. Реальный Playwright-клик по последнему сообщению.
    const lastMsg = page.locator('[data-marker="message"]').last();
    const msgCount = await lastMsg.count().catch(() => 0);
    if (msgCount > 0) {
      await lastMsg
        .scrollIntoViewIfNeeded({ timeout: 3_000 })
        .catch(() => undefined);
      await lastMsg
        .click({ timeout: 2_000, force: true })
        .catch(() => undefined);
      // Дополнительно — hover над сообщением + mouse wheel scroll
      // симулирует реальное чтение (Avito клиент может слушать
      // wheel-events как триггер "пользователь читает").
      await lastMsg.hover({ timeout: 2_000 }).catch(() => undefined);
      await page.mouse.wheel(0, 300).catch(() => undefined);
      await page.mouse.wheel(0, -300).catch(() => undefined);
    }

    // 4. Клик + focus на поле ввода (без ввода текста). Avito шлёт
    //    seen при фокусе input'а — пользователь начал писать ответ.
    const input = page
      .locator(
        '[data-marker="channel-bottom-base"] [contenteditable="true"], ' +
          '[data-marker="channel-bottom-base"] textarea',
      )
      .first();
    const hasInput = (await input.count().catch(() => 0)) > 0;
    if (hasInput) {
      await input.click({ timeout: 2_000 }).catch(() => undefined);
      await input.focus({ timeout: 2_000 }).catch(() => undefined);
    }

    // 5. Повторный visibility event + wait 6с для WebSocket.
    //    Увеличено с 3 до 6 сек, т.к. в предыдущей версии после
    //    markDialogRead сразу шла навигация на следующий диалог и
    //    прерывала WebSocket до отправки seen.
    await page.evaluate(VISIBILITY_OVERRIDE_SOURCE).catch(() => undefined);
    await page.waitForTimeout(6_000);
  } catch {
    /* best-effort */
  }
}

// Dialog header structure as observed via debugMessengerDialog on live
// messenger pages: opponent name → rating (X,Y) → [reviews count] →
// item title → item price → phone-reveal button → messagesHistory.
// Avito doesn't expose data-markers for name/title, so we use a
// text-line heuristic anchored on the phone-reveal button or the
// weekday separator that starts the thread. The anchor LINE is the
// first one of these found in innerText, walking top-down.
//
// Heuristic:
//   anchor_line in {"Показать телефон", "<Weekday>, <day> <month>", ...}
//   Search backwards from anchor for a rating line (`X,Y` or `X.Y`).
//   Opponent name := line immediately before the rating.
//   Item title := first non-price, non-review-count line between
//                 rating and anchor.
// If no rating is found, fall back to: opponent name ≈ line (anchor-4),
// item title ≈ first non-price line before anchor.
const DIALOG_SOURCE = `(() => {
  var out = {
    ok: true,
    details: {
      opponentName: null,
      itemTitle: null,
      itemUrl: null,
      lastMessageText: null,
      receivedAtIso: null,
      receivedAtRaw: null,
      messageCount: 0,
    },
  };
  try {
    var bodyText = (document.body && document.body.innerText) || '';
    var lines = bodyText.split('\\n').map(function (s) {
      return s.trim();
    }).filter(function (s) {
      return s.length > 0;
    });

    // Anchor detection: find the phone-reveal / phone-hidden / weekday
    // separator line so we can triangulate the header above it.
    var anchorIdx = -1;
    var weekdayRx = /^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|сегодня|вчера|позавчера)(,|$)/i;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (
        ln === 'Показать телефон' ||
        /^\\+?\\d[\\d\\s()-]{6,}$/.test(ln) ||
        /^телефон\\s*скрыт$/i.test(ln) ||
        weekdayRx.test(ln)
      ) {
        anchorIdx = i;
        break;
      }
    }

    if (anchorIdx > 0) {
      var ratingRx = /^\\d+[,.]\\d+$/;
      var priceRx = /₽|руб(\\.|ль|ля|лей)?/i;
      var reviewsRx = /\\d+\\s*отзыв/i;

      var ratingIdx = -1;
      for (var j = anchorIdx - 1; j >= Math.max(0, anchorIdx - 15); j--) {
        if (ratingRx.test(lines[j])) { ratingIdx = j; break; }
      }

      // Noise filters for the opponent-name line. Each one causes the
      // candidate to be skipped so we walk further up the header.
      //
      //  - onlineRx: "в сети ...", "был(а) в сети ...", "онлайн",
      //    "offline", English "online"/"last seen".
      //  - callRx:   "Пропущенный вызов", leading "Вызов".
      //  - tooShort: less than 2 chars, can't be a real name.
      //  - digitsRx: contains any digit — names are almost never
      //    mixed with digits, but status labels ("в сети в 21:18")
      //    and raw timestamps ("21:18", "14:06") always are.
      //  - lowerStartRx: starts with a Cyrillic/Latin lowercase
      //    letter — real names/business names start with an uppercase
      //    letter or a quote/non-letter opener; Avito status labels
      //    ("в сети…", "онлайн…") start with lowercase. This was the
      //    root cause of the id=42 "в сети в 21:18" leak in B4.
      var onlineRx =
        /(^|\\s)(в\\s*сети|был(а)?\\s*в\\s*сети|онлайн|offline|online|last\\s*seen)/i;
      var callRx = /пропущенн|^вызов/i;
      var digitsRx = /\\d/;
      var lowerStartRx = /^[a-zа-яё]/;

      function looksLikeName(cand) {
        if (!cand) return false;
        if (cand.length < 2) return false;
        if (cand.length > 120) return false;
        if (onlineRx.test(cand)) return false;
        if (callRx.test(cand)) return false;
        if (digitsRx.test(cand)) return false;
        if (lowerStartRx.test(cand)) return false;
        return true;
      }

      if (ratingIdx > 0) {
        for (var n = ratingIdx - 1; n >= Math.max(0, ratingIdx - 6); n--) {
          if (looksLikeName(lines[n])) {
            out.details.opponentName = lines[n];
            break;
          }
        }
        for (var k = ratingIdx + 1; k < anchorIdx; k++) {
          var ln2 = lines[k];
          if (priceRx.test(ln2)) continue;
          if (reviewsRx.test(ln2)) continue;
          if (onlineRx.test(ln2)) continue;
          if (ln2.length < 3) continue;
          out.details.itemTitle = ln2;
          break;
        }
      } else {
        // Fallback: no rating line visible in the header (happens
        // when the opponent has no rating yet, or the header is a
        // different variant). Walk backwards from the anchor,
        // classifying each line.
        //
        // Ordering: we look for (item title) first, then (name),
        // because the item title is typically LAST in the header
        // (closest to the messages thread) and therefore CLOSEST to
        // the anchor. The name is further up. Filters match the
        // name-side heuristic above.
        for (var m = anchorIdx - 1; m >= Math.max(0, anchorIdx - 8); m--) {
          var ln3 = lines[m];
          if (!ln3) continue;
          if (priceRx.test(ln3)) continue;
          if (reviewsRx.test(ln3)) continue;
          if (onlineRx.test(ln3)) continue;
          if (callRx.test(ln3)) continue;
          if (!out.details.itemTitle) {
            // Accept anything plausible as title (ads often start
            // with lowercase / contain digits, so we do NOT apply
            // the strict name filter here).
            if (ln3.length >= 3) {
              out.details.itemTitle = ln3;
            }
            continue;
          }
          if (!out.details.opponentName && looksLikeName(ln3)) {
            out.details.opponentName = ln3;
            break;
          }
        }
      }
    }

    // Item URL: still try to find a canonical items link if present.
    var itemLink = document.querySelector(
      'a[href*="/items/"], a[href*="/vacancy"], a[href*="/job/"]'
    );
    if (itemLink) {
      var href = itemLink.getAttribute('href') || '';
      try {
        out.details.itemUrl = new URL(href, window.location.origin).toString();
      } catch (e) {
        out.details.itemUrl = href || null;
      }
    }

    // Message thread — Avito uses data-marker="message" for each
    // bubble (confirmed via DOM diag). Collect them and take the
    // text of the last one as the preview.
    var msgNodes = Array.from(
      document.querySelectorAll('[data-marker="message"]'),
    );
    if (msgNodes.length === 0) {
      msgNodes = Array.from(document.querySelectorAll(
        '[data-marker*="message"], [class*="messageBubble"]'
      ));
    }
    out.details.messageCount = msgNodes.length;
    if (msgNodes.length > 0) {
      var last = msgNodes[msgNodes.length - 1];
      var raw = (last.textContent || '').trim();
      out.details.lastMessageText = raw.length > 0 ? raw.slice(0, 2000) : null;
    }

    // Timestamp: most recent <time datetime> is (usually) the latest
    // message in the thread.
    var timeEls = Array.from(document.querySelectorAll('time[datetime]'));
    if (timeEls.length > 0) {
      var lastTime = timeEls[timeEls.length - 1];
      out.details.receivedAtIso = lastTime.getAttribute('datetime');
      out.details.receivedAtRaw = (lastTime.textContent || '').trim() || null;
    }
  } catch (e) {
    out.ok = false;
    out.err = (e && e.message) ? e.message : String(e);
  }
  return out;
})()`;

export async function parseMessengerDialog(
  page: Page,
): Promise<MessengerDialogDetails | null> {
  try {
    const raw = (await page.evaluate(DIALOG_SOURCE)) as DialogRaw;
    if (!raw || typeof raw !== 'object') {
      parseMessengerDialogMeta.lastError = 'dialog parser returned non-object';
      return null;
    }
    if (!raw.ok) {
      parseMessengerDialogMeta.lastError =
        `dialog parser browser-side error: ${raw.err}`;
      return null;
    }
    parseMessengerDialogMeta.lastError = undefined;
    parseMessengerDialogMeta.lastDebug =
      `messageCount=${raw.details.messageCount} hasName=${!!raw.details.opponentName} hasTitle=${!!raw.details.itemTitle} hasIso=${!!raw.details.receivedAtIso}`;
    return raw.details;
  } catch (e) {
    parseMessengerDialogMeta.lastError =
      `dialog parser outer error: ${(e as Error)?.message || String(e)}`;
    return null;
  }
}
