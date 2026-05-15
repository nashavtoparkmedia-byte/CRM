/**
 * stable-id extractor (Phase B)
 *
 * Single confirmed source: inline `window.__preloadedState__` → `.user.id`.
 * No fallback chain yet (no other reliable source in the current probe).
 *
 * Contract:
 *   - returns { value, source: 'page_state' } on success
 *   - returns null on any failure (not found / decode / parse / invalid)
 *   - never throws — caller decides what to do with null
 */
import type { Page } from 'playwright';

export type StableIdSource = 'page_state';

export interface StableIdResult {
  value: string;
  source: StableIdSource;
}

// Positive integer, no leading zero, 1..20 digits. Implicitly rejects
// JWT (dots), UUID (dashes), whitespace, empty, and all non-digit content.
const STABLE_ID_RX = /^[1-9]\d{0,19}$/;

// Explicit sentinels — regex already excludes them, kept for defensive clarity.
const SENTINEL_VALUES = new Set(['0', 'undefined', 'null']);

function canonicalize(v: unknown): string | null {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) {
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  return null;
}

function validateStableId(value: string): boolean {
  if (value.length < 1 || value.length > 20) return false;
  if (SENTINEL_VALUES.has(value)) return false;
  return STABLE_ID_RX.test(value);
}

function extractPreloadedStateRaw(text: string): string | null {
  if (!text.includes('__preloadedState__')) return null;
  const m =
    text.match(/__preloadedState__\s*=\s*"([^"]+)"/) ||
    text.match(/__preloadedState__\s*=\s*'([^']+)'/);
  return m && m[1] ? m[1] : null;
}

async function fromPageState(page: Page): Promise<string | null> {
  // Read full rendered HTML of the current page. <script> content is preserved
  // verbatim by the browser's HTML serializer, so we can regex it directly
  // — no browser-side evaluate needed, no DOM lib dependency, no tsx/__name risk.
  let html: string;
  try {
    html = await page.content();
  } catch {
    return null;
  }

  const raw = extractPreloadedStateRaw(html);
  if (!raw) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  const userId = (parsed as { user?: { id?: unknown } } | null)?.user?.id;
  const canonical = canonicalize(userId);
  if (!canonical) return null;
  if (!validateStableId(canonical)) return null;
  return canonical;
}

export async function extractStableId(
  page: Page,
): Promise<StableIdResult | null> {
  try {
    const value = await fromPageState(page);
    if (value) return { value, source: 'page_state' };
  } catch {
    // Extractor never throws. Caller decides on null.
  }
  return null;
}
