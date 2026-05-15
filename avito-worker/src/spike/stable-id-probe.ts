/// <reference lib="dom" />
/**
 * stable-id probe
 *
 * One-shot spike script. Opens an already-authenticated persistent profile
 * with system Chrome, navigates to /profile, and dumps candidate signals for
 * manual inspection.
 *
 * Usage:   pnpm spike:stable-id --account=<id>
 *
 * Preconditions:
 *   - Manual login for the given account has been performed (status=active).
 *   - No other Chrome window is currently holding the same profile
 *     (close the worker-launched "Open Login" window first).
 *
 * Output:  storage/html/stable-id-probe-<accountId>-<timestamp>.json
 *
 * Non-goals:
 *   - no extractor, no DB writes, no mutation of account state
 *   - does not perform additional authenticated API calls
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { STORAGE_DIRS, accountProfilePath } from '@avito/shared';

loadEnv({ path: path.resolve(__dirname, '..', '..', '..', '..', '.env') });

interface ProbePayload {
  meta: {
    accountId: number;
    profilePath: string;
    startedAt: string;
    finishedAt: string;
  };
  finalUrl: string;
  scripts: Array<{
    src: string | null;
    id: string | null;
    type: string | null;
    textLen: number;
    hasPreloadedState: boolean;
    text: string;
  }>;
  userLinks: Array<{ href: string | null; text: string }>;
  headerDataAttrs: Array<{ tag: string; name: string; value: string }>;
  localStorageEntries: Array<{
    key: string;
    valueSample: string;
    valueLen: number;
    masked: boolean;
  }>;
  preloadedState: {
    found: boolean;
    rawSample: string | null;
    decodedLen: number;
    decodedSample: string | null;
    parseError: string | null;
  };
  pageStateHints: Array<{ path: string; value: string; type: string }>;
}

function parseAccountId(argv: string[]): number {
  for (const arg of argv) {
    const m = arg.match(/^--account(?:=|\s+)(\d+)$/);
    if (m) return Number(m[1]);
  }
  // support: --account 1
  const idx = argv.indexOf('--account');
  if (idx >= 0 && argv[idx + 1] && /^\d+$/.test(argv[idx + 1]!)) {
    return Number(argv[idx + 1]);
  }
  throw new Error('Missing --account=<id> argument');
}

async function main() {
  const accountId = parseAccountId(process.argv.slice(2));
  const profilePath = accountProfilePath(accountId);

  // Sanity: profile directory must exist (Open flow creates it).
  try {
    await fs.stat(profilePath);
  } catch {
    throw new Error(
      `Profile dir not found: ${profilePath}. Run "Open Login" for account ${accountId} first.`,
    );
  }

  console.log(`[stable-id-probe] accountId=${accountId}`);
  console.log(`[stable-id-probe] profilePath=${profilePath}`);
  console.log(`[stable-id-probe] launching system Chrome (channel=chrome) ...`);

  const startedAt = new Date().toISOString();

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to launch persistent context (profile may be locked by another Chrome instance): ${msg}`,
    );
  }

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    console.log(`[stable-id-probe] navigating to https://www.avito.ru/profile ...`);
    await page.goto('https://www.avito.ru/profile', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page
      .waitForLoadState('networkidle', { timeout: 10_000 })
      .catch(() => {
        console.log(`[stable-id-probe] networkidle wait timed out (ok)`);
      });

    // tsx/esbuild transpiles inner arrow consts with __name(fn, "name") wrappers
    // to preserve fn.name. When page.evaluate serializes the callback, those
    // wrappers travel into the browser as-is and crash with "__name is not
    // defined". Prime a no-op __name on globalThis via a STRING evaluate —
    // string form bypasses tsx transformation.
    await page.evaluate(
      "globalThis.__name = globalThis.__name || function (fn) { return fn; };",
    );

    const payload = (await page.evaluate(() => {
      const MAX_SCRIPT_TEXT = 10_000;
      const MAX_LS_VALUE = 120;
      const MAX_ATTR_VALUE = 200;
      const MAX_LINK_TEXT = 80;
      const MAX_RAW_SAMPLE = 400;
      const MAX_DECODED_SAMPLE = 1500;
      const MAX_HINT_VALUE = 200;
      const MAX_HINTS = 200;

      const trunc = (s: string, n: number): string =>
        s.length > n ? s.slice(0, n) + `…[truncated, total ${s.length}]` : s;

      const isSensitiveKey = (k: string): boolean =>
        /token|auth|session|secret|jwt|password|refresh/i.test(k);
      const looksLikeJwt = (v: string): boolean =>
        /^eyJ[A-Za-z0-9_\-]{8,}\./.test(v);
      const looksLikeLongOpaque = (v: string): boolean =>
        v.length > 200 && /^[A-Za-z0-9_\-=+\/]+$/.test(v);

      // ---------- __preloadedState__ extraction ----------
      let preloadedRawSample: string | null = null;
      let preloadedDecodedLen = 0;
      let preloadedDecodedSample: string | null = null;
      let preloadedParsed: unknown = null;
      let preloadedParseError: string | null = null;

      for (const script of Array.from(document.querySelectorAll('script'))) {
        const text = script.textContent || '';
        if (!text.includes('__preloadedState__')) continue;
        const m =
          text.match(/__preloadedState__\s*=\s*"([^"]+)"/) ||
          text.match(/__preloadedState__\s*=\s*'([^']+)'/);
        if (!m || !m[1]) continue;
        const encoded = m[1];
        preloadedRawSample =
          encoded.length > MAX_RAW_SAMPLE
            ? encoded.slice(0, MAX_RAW_SAMPLE) + `…[truncated, total ${encoded.length}]`
            : encoded;
        try {
          const decoded = decodeURIComponent(encoded);
          preloadedDecodedLen = decoded.length;
          preloadedDecodedSample =
            decoded.length > MAX_DECODED_SAMPLE
              ? decoded.slice(0, MAX_DECODED_SAMPLE) + `…[truncated, total ${decoded.length}]`
              : decoded;
          try {
            preloadedParsed = JSON.parse(decoded);
          } catch (e) {
            preloadedParseError = 'JSON.parse: ' + String(e);
          }
        } catch (e) {
          preloadedParseError = 'decodeURIComponent: ' + String(e);
        }
        break;
      }

      // ---------- identity hints from parsed state ----------
      const PARENT_RX = /user|account|profile|seller|viewer|me|self/i;
      const LEAF_RX =
        /^(id|hash|uid|userId|user_id|userHash|user_hash|accountId|account_id|profileId|profile_id|sellerId|seller_id|login|phone|email|name)$/i;
      const pageStateHints: Array<{ path: string; value: string; type: string }> = [];

      const walk = (node: unknown, pathParts: string[], depth: number): void => {
        if (pageStateHints.length >= MAX_HINTS) return;
        if (depth > 8 || node === null || node === undefined) return;
        if (typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (let i = 0; i < Math.min(node.length, 20); i++) {
            walk(node[i], [...pathParts, `[${i}]`], depth + 1);
          }
          return;
        }
        const obj = node as Record<string, unknown>;
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          const newPath = [...pathParts, k];
          const parentMatches = pathParts.some((p) => PARENT_RX.test(p));
          if (
            LEAF_RX.test(k) &&
            (typeof v === 'string' || typeof v === 'number') &&
            parentMatches
          ) {
            pageStateHints.push({
              path: newPath.join('.'),
              value: String(v).slice(0, MAX_HINT_VALUE),
              type: typeof v,
            });
          }
          if (typeof v === 'object' && v !== null) {
            walk(v, newPath, depth + 1);
          }
        }
      };

      if (preloadedParsed) {
        try {
          walk(preloadedParsed, [], 0);
        } catch (e) {
          preloadedParseError =
            (preloadedParseError ? preloadedParseError + '; ' : '') +
            'walk: ' +
            String(e);
        }
      }

      // ---------- scripts (mentioning user|profile; full text if __preloadedState__) ----------
      const scripts = Array.from(document.querySelectorAll('script'))
        .map((s) => {
          const text = s.textContent ?? '';
          return {
            src: s.getAttribute('src'),
            id: s.getAttribute('id'),
            type: s.getAttribute('type'),
            text,
          };
        })
        .filter((s) => /user|profile/i.test(s.text))
        .map((s) => {
          const hasPreloadedState = s.text.includes('__preloadedState__');
          return {
            src: s.src,
            id: s.id,
            type: s.type,
            textLen: s.text.length,
            hasPreloadedState,
            text: hasPreloadedState ? s.text : trunc(s.text, MAX_SCRIPT_TEXT),
          };
        });

      // ---------- user links ----------
      const userLinks = Array.from(
        document.querySelectorAll('a[href*="/user/"]'),
      ).map((a) => ({
        href: a.getAttribute('href'),
        text: trunc((a.textContent || '').replace(/\s+/g, ' ').trim(), MAX_LINK_TEXT),
      }));

      // ---------- header / avatar / nav data-* attrs ----------
      const headerScopes = Array.from(
        document.querySelectorAll(
          'header, [class*="header" i], [class*="Header" i], [class*="avatar" i], [class*="Avatar" i], nav',
        ),
      );
      const seen = new Set<string>();
      const headerDataAttrs: Array<{ tag: string; name: string; value: string }> = [];
      for (const root of headerScopes) {
        const elements = [root, ...Array.from(root.querySelectorAll('*'))];
        for (const el of elements) {
          for (const attr of Array.from(el.attributes)) {
            if (!attr.name.startsWith('data-')) continue;
            const key = `${el.tagName}|${attr.name}|${attr.value}`;
            if (seen.has(key)) continue;
            seen.add(key);
            headerDataAttrs.push({
              tag: el.tagName.toLowerCase(),
              name: attr.name,
              value: trunc(attr.value, MAX_ATTR_VALUE),
            });
          }
        }
      }

      // ---------- localStorage (per-key try/catch, explicit masked flag) ----------
      const localStorageEntries: Array<{
        key: string;
        valueSample: string;
        valueLen: number;
        masked: boolean;
      }> = [];
      const lsKeys: string[] = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) lsKeys.push(k);
        }
      } catch {
        /* enumeration blocked — entries stay empty */
      }
      for (const k of lsKeys) {
        let raw = '';
        let accessFailed = false;
        try {
          const v = localStorage.getItem(k);
          raw = typeof v === 'string' ? v : '';
        } catch {
          accessFailed = true;
        }
        const valueLen = raw.length;
        const sensitive =
          isSensitiveKey(k) || looksLikeJwt(raw) || looksLikeLongOpaque(raw);
        let valueSample: string;
        if (accessFailed) {
          valueSample = '***ACCESS_ERROR***';
        } else if (sensitive) {
          valueSample = '***MASKED***';
        } else {
          valueSample = trunc(raw, MAX_LS_VALUE);
        }
        localStorageEntries.push({
          key: k,
          valueSample,
          valueLen,
          masked: sensitive || accessFailed,
        });
      }

      return {
        finalUrl: location.href,
        scripts,
        userLinks,
        headerDataAttrs,
        localStorageEntries,
        preloadedState: {
          found: preloadedRawSample !== null,
          rawSample: preloadedRawSample,
          decodedLen: preloadedDecodedLen,
          decodedSample: preloadedDecodedSample,
          parseError: preloadedParseError,
        },
        pageStateHints,
      };
    })) as Omit<ProbePayload, 'meta'>;

    const finishedAt = new Date().toISOString();
    const fullPayload: ProbePayload = {
      meta: { accountId, profilePath, startedAt, finishedAt },
      ...payload,
    };

    await fs.mkdir(STORAGE_DIRS.html, { recursive: true });
    const tsForName = finishedAt.replace(/[:.]/g, '-');
    const outPath = path.join(
      STORAGE_DIRS.html,
      `stable-id-probe-${accountId}-${tsForName}.json`,
    );
    await fs.writeFile(outPath, JSON.stringify(fullPayload, null, 2), 'utf-8');

    console.log(`\n[stable-id-probe] artifact saved: ${outPath}`);
    console.log(`[stable-id-probe] summary:`);
    console.log(`  finalUrl:                ${fullPayload.finalUrl}`);
    console.log(`  scripts (user|profile):  ${fullPayload.scripts.length}`);
    console.log(
      `  preloadedState:          ${
        fullPayload.preloadedState.found
          ? `found, decodedLen=${fullPayload.preloadedState.decodedLen}`
          : 'NOT FOUND'
      }${
        fullPayload.preloadedState.parseError
          ? ` (parseError: ${fullPayload.preloadedState.parseError})`
          : ''
      }`,
    );
    console.log(`  pageStateHints:          ${fullPayload.pageStateHints.length}`);
    console.log(`  userLinks:               ${fullPayload.userLinks.length}`);
    console.log(`  headerDataAttrs:         ${fullPayload.headerDataAttrs.length}`);
    console.log(`  localStorageEntries:     ${fullPayload.localStorageEntries.length}`);

    const looksLoggedOut =
      /\/login|\/auth|\/register/i.test(fullPayload.finalUrl);
    if (looksLoggedOut) {
      console.warn(
        `[stable-id-probe] WARNING: final URL looks like a login page. Account may not be authenticated in this profile.`,
      );
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[stable-id-probe] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
