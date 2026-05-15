/**
 * Messenger list parser.
 *
 * Reads the dialog list from https://www.avito.ru/profile/messenger
 * and returns one summary per visible dialog. Pure function over a
 * Playwright `Page` — no DB writes, no side effects.
 *
 * IMPORTANT: the browser-side logic is passed to `page.evaluate` as a
 * STRING, not as a function. Reason: `tsx` (our dev runner) uses esbuild
 * under the hood, and esbuild with `keepNames: true` (default) wraps
 * function expressions with a `__name(fn, "literalName")` helper whose
 * definition lives only in the Node module, not in the browser. When
 * Playwright calls `fn.toString()` on an arrow/function expression, the
 * serialised source references `__name`, which triggers
 * `ReferenceError: __name is not defined` inside the page context.
 * Passing the code as a plain string sidesteps esbuild entirely —
 * the browser just `eval`s it verbatim.
 *
 * Design notes:
 * - The function NEVER throws. Any selector / eval error returns an
 *   empty array plus a diagnostic message on `parseMessengerList.lastError`
 *   (attached as a property on the function itself) so the caller can
 *   log it without importing extra state.
 * - Selectors are intentionally broad. Avito changes markup often; we
 *   prefer `[data-marker]` + href-based heuristics over fragile class
 *   matching.
 * - External ID: extracted from the channel link path (pattern
 *   `/profile/messenger/channel/<id>`) — stable Avito identifier that
 *   survives re-renders.
 * - Unread detection: a dialog is unread if its subtree contains an
 *   element whose aria-label / data-marker / class hints unread state.
 *   Missed unread is preferred over false-positive phone reveal.
 * - `receivedAtRaw`: kept as the raw displayed string ("14 апр.",
 *   "Позавчера", "2 мин. назад"). Parsing into a timestamp is done one
 *   layer up where we have account locale context.
 */
import type { Page } from 'playwright';

export type MessengerDialogSummary = {
  externalId: string;
  chatHref: string | null;
  chatUrl: string | null;
  candidateName: string | null;
  vacancyTitle: string | null;
  preview: string | null;
  isUnread: boolean;
  receivedAtRaw: string | null;
};

export type MessengerDomDiagnostics = {
  anchorCount: number;
  anchorHrefs: string[];
  dataMarkerValues: string[];
  bodyTextSample: string;
  htmlSample: string;
};

type ParserRaw = {
  ok: boolean;
  err?: string;
  linkCount: number;
  result: MessengerDialogSummary[];
};

const PARSER_SOURCE = `(() => {
  var out = { ok: true, linkCount: 0, result: [] };
  try {
    var links = Array.from(document.querySelectorAll('a[href*="/profile/messenger/channel/"]'));
    out.linkCount = links.length;

    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.getAttribute('href') || '';
      var m = href.match(/\\/profile\\/messenger\\/channel\\/([^/?#]+)/);
      if (!m) continue;
      var externalId = m[1];

      // Walk up to the row container. Avito typically wraps each
      // dialog in a <div> with a descriptive class. We try a few
      // structural hints; fall back to the nearest common ancestor
      // with enough height to hold name + title + preview + date.
      var item = link.closest('[data-marker*="channel"]') ||
                 link.closest('[class*="channel"]') ||
                 link.closest('[class*="Channel"]') ||
                 link.closest('[role="listitem"]') ||
                 link.closest('li') ||
                 link.parentElement ||
                 link;

      function textOf(sel) {
        var el = item.querySelector(sel);
        if (!el) return null;
        var t = (el.textContent || '').trim();
        return t.length > 0 ? t : null;
      }

      function firstText(sels) {
        for (var j = 0; j < sels.length; j++) {
          var t = textOf(sels[j]);
          if (t) return t;
        }
        return null;
      }

      var candidateName = firstText([
        '[data-marker*="name"]',
        'h3',
        'h2',
        'strong',
      ]);

      var vacancyTitle = firstText([
        '[data-marker*="item-title"]',
        '[data-marker*="title"]',
        '[class*="itemTitle"]',
        '[class*="title"]',
      ]);

      var preview = firstText([
        '[data-marker*="last-message"]',
        '[data-marker*="message"]',
        '[class*="lastMessage"]',
        '[class*="preview"]',
      ]);

      var receivedAtRaw = firstText([
        '[data-marker*="date"]',
        '[class*="date"]',
        '[class*="time"]',
        'time',
      ]);

      var isUnread = false;
      if (item.querySelector('[aria-label*="Непрочитан"], [aria-label*="непрочитан"]')) {
        isUnread = true;
      } else if (item.querySelector('[data-marker*="unread"], [class*="unread"], [class*="Unread"]')) {
        isUnread = true;
      }

      var chatUrl = null;
      try {
        chatUrl = new URL(href, window.location.origin).toString();
      } catch (e) {
        chatUrl = null;
      }

      out.result.push({
        externalId: externalId,
        chatHref: href || null,
        chatUrl: chatUrl,
        candidateName: candidateName,
        vacancyTitle: vacancyTitle,
        preview: preview,
        isUnread: isUnread,
        receivedAtRaw: receivedAtRaw,
      });
    }
  } catch (e) {
    out.ok = false;
    out.err = (e && e.message) ? e.message : String(e);
  }
  return out;
})()`;

// Flags attached to the function itself so callers can surface the last
// run's diagnostic without importing a separate state object.
export const parseMessengerListMeta: {
  lastError?: string;
  lastDebug?: string;
} = {};

export async function parseMessengerList(
  page: Page,
): Promise<MessengerDialogSummary[]> {
  try {
    const raw = (await page.evaluate(PARSER_SOURCE)) as ParserRaw;
    if (!raw || typeof raw !== 'object') {
      parseMessengerListMeta.lastError = 'parser returned non-object';
      return [];
    }
    if (!raw.ok) {
      parseMessengerListMeta.lastError =
        `parser browser-side error (linkCount=${raw.linkCount}): ${raw.err}`;
      return [];
    }
    parseMessengerListMeta.lastError = undefined;
    parseMessengerListMeta.lastDebug =
      `linkCount=${raw.linkCount} resultCount=${raw.result.length}`;
    return raw.result;
  } catch (e) {
    parseMessengerListMeta.lastError =
      `parser outer error: ${(e as Error)?.message || String(e)}`;
    return [];
  }
}

const DIAG_SOURCE = `(() => {
  try {
    var anchors = Array.from(document.querySelectorAll('a'));
    var messengerAnchors = anchors.filter(function (a) {
      return (a.getAttribute('href') || '').toLowerCase().indexOf('messenger') !== -1;
    });
    var markerEls = Array.from(document.querySelectorAll('[data-marker]'));
    var uniqueMarkers = new Set();
    for (var i = 0; i < markerEls.length && i < 200; i++) {
      var m = markerEls[i].getAttribute('data-marker');
      if (m) uniqueMarkers.add(m);
    }
    var bodyText = ((document.body && document.body.innerText) || '').slice(0, 1500);
    var html = ((document.body && document.body.innerHTML) || '').slice(0, 3000);
    return {
      anchorCount: anchors.length,
      anchorHrefs: messengerAnchors.slice(0, 15).map(function (a) {
        return a.getAttribute('href') || '';
      }),
      dataMarkerValues: Array.from(uniqueMarkers).slice(0, 40),
      bodyTextSample: bodyText,
      htmlSample: html,
    };
  } catch (e) {
    return {
      anchorCount: 0,
      anchorHrefs: [],
      dataMarkerValues: [],
      bodyTextSample: '',
      htmlSample: (e && e.message) ? e.message : String(e),
    };
  }
})()`;

// Controlled scroll for the messenger list. Avito lazy-loads dialogs as
// the sidebar is scrolled down. We scroll the list container (or the
// main window as fallback) up to `maxIterations` times, waiting 500ms
// between attempts, and stop early if the scroll height stabilises —
// meaning no new content loaded. Pure DOM interaction, no network
// calls, never throws. Returns number of completed scroll iterations.
const SCROLL_SOURCE = `(async () => {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  try {
    var lastHeight = 0;
    var iterations = 0;
    var maxIterations = 3;
    while (iterations < maxIterations) {
      // Try to find a scrollable container around the list. Fallback to
      // the document scrolling element.
      var candidates = Array.from(document.querySelectorAll('*')).filter(function (el) {
        if (!(el instanceof HTMLElement)) return false;
        var cs = getComputedStyle(el);
        if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') return false;
        return el.scrollHeight > el.clientHeight + 50;
      });
      var target = candidates[0] || document.scrollingElement || document.body;
      var before = target.scrollTop;
      var height = target.scrollHeight;
      if (height === lastHeight && iterations > 0) break;
      lastHeight = height;
      target.scrollTop = height;
      // Also trigger window scroll for viewport-based virtualised lists.
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(500);
      iterations++;
      if (target.scrollTop === before && iterations > 1) break;
    }
    return iterations;
  } catch (e) {
    return 0;
  }
})()`;

export async function scrollMessengerList(page: Page): Promise<number> {
  try {
    const iters = (await page.evaluate(SCROLL_SOURCE)) as number;
    return typeof iters === 'number' ? iters : 0;
  } catch {
    return 0;
  }
}

export async function debugMessengerDom(
  page: Page,
): Promise<MessengerDomDiagnostics> {
  try {
    return (await page.evaluate(DIAG_SOURCE)) as MessengerDomDiagnostics;
  } catch {
    return {
      anchorCount: 0,
      anchorHrefs: [],
      dataMarkerValues: [],
      bodyTextSample: '',
      htmlSample: '',
    };
  }
}
